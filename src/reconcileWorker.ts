/**
 * Reconcile worker: the per-page unit of the SQS fan-out that drives an
 * on-demand Team_Role_Cache reconciliation.
 *
 * Each invocation processes EXACTLY ONE `iam:ListRoles` page (resolving every
 * role on that page's `team` tag and upserting the Team_Role_Cache), records
 * the page's progress on the shared job row, and then:
 *   - if IAM returned a continuation marker, re-enqueues a message carrying
 *     the next marker so the NEXT worker invocation picks up where this one
 *     left off, and leaves the job `running`; or
 *   - if that was the last page, transitions the job to `complete`.
 *
 * Because every invocation is bounded to a single page it always finishes
 * well under the Lambda timeout regardless of how many thousands of roles the
 * account has — the queue + worker concurrency of 1 turn an unbounded sweep
 * into a serial chain of short, timeout-safe runs that is gentle on IAM's
 * read rate limits.
 *
 * This module never issues a DynamoDB `Scan`: it drives entirely off the
 * IAM-side role list and writes targeted cache + job-row updates.
 */
import { reconcileTeamRoleCache } from './reconciliation';
import {
  completeReconcileJob,
  failReconcileJob,
  recordReconcileProgress,
} from './reconcileJobStore';
import { sendMessage } from './clients/sqsClient';

/**
 * Body of an SQS message driving the reconcile chain. The starter enqueues
 * one with `marker` omitted; each worker re-enqueues the next marker until
 * IAM pagination is exhausted.
 */
export interface ReconcileQueueMessage {
  /** Correlates every message/invocation in one run to a single job row. */
  jobId: string;
  /**
   * The `iam:ListRoles` continuation marker to resume from. Omitted/undefined
   * on the very first message (start from the first page).
   */
  marker?: string;
}

export interface ReconcileWorkerOptions {
  /** The IAM tag key that identifies a role's Team (Requirement 1.1). */
  teamTagKey: string;
  /** Name of the DynamoDB table backing the Team_Role_Cache. */
  teamRoleCacheTableName: string;
  /** Name of the DynamoDB table backing the Reconcile_Job_Store. */
  reconcileJobTableName: string;
  /** URL of the SQS queue to re-enqueue continuation messages onto. */
  reconcileQueueUrl: string;
  /** Injectable clock, primarily for tests. */
  now?: () => Date;
}

/**
 * Processes a single reconcile-queue message: one IAM page, a job-row update,
 * and (if more pages remain) a re-enqueue of the next marker.
 *
 * Throws on failure AFTER marking the job `failed`, so the SQS event source
 * still surfaces the error (message goes back to the queue / DLQ per the
 * queue's redrive policy) while the UI immediately sees a terminal state.
 */
export async function processReconcileMessage(
  message: ReconcileQueueMessage,
  options: ReconcileWorkerOptions
): Promise<void> {
  const jobStoreOptions = {
    tableName: options.reconcileJobTableName,
    now: options.now,
  };

  try {
    // Process exactly one page: maxPages=1 bounds this invocation to a single
    // `iam:ListRoles` call + its page of per-role tag lookups.
    const result = await reconcileTeamRoleCache({
      teamTagKey: options.teamTagKey,
      teamRoleCacheTableName: options.teamRoleCacheTableName,
      startMarker: message.marker,
      maxPages: 1,
      now: options.now,
    });

    const increment = {
      rolesProcessed: result.reconciledRoles.length,
      pageCount: result.pageCount,
    };

    if (!result.complete && result.nextMarker !== undefined) {
      // More pages remain: record progress (job stays `running`) and hand the
      // baton to the next worker invocation by enqueuing the next marker.
      await recordReconcileProgress(message.jobId, increment, jobStoreOptions);
      await sendMessage({
        QueueUrl: options.reconcileQueueUrl,
        MessageBody: JSON.stringify({
          jobId: message.jobId,
          marker: result.nextMarker,
        } satisfies ReconcileQueueMessage),
      });
      return;
    }

    // Last page: fold in its counts and flip the job to `complete`.
    await completeReconcileJob(message.jobId, increment, jobStoreOptions);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await failReconcileJob(message.jobId, errorMessage, jobStoreOptions);
    throw error;
  }
}
