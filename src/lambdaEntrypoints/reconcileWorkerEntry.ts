/**
 * Lambda entry-point adapter for the reconcile worker (`../reconcileWorker.ts`).
 *
 * Wired to the reconcile SQS queue as its event source with a batch size of
 * 1, so each invocation handles exactly one message = one `iam:ListRoles`
 * page. The worker re-enqueues a continuation message when more pages remain,
 * forming a serial chain (queue + worker reserved-concurrency 1) that walks
 * every page without ever risking a Lambda timeout, however large the account.
 *
 * Reads its table names, team tag key, and the queue URL (to re-enqueue onto)
 * from the environment variables the stack sets on this function. On a
 * processing failure the worker has already flipped the job row to `failed`;
 * rethrowing here lets the SQS event source apply the queue's redrive policy
 * (retry, then DLQ).
 */
import type { SQSEvent } from 'aws-lambda';

import { ReconcileQueueMessage, processReconcileMessage } from '../reconcileWorker';
import { ENV_VAR_NAMES, requiredEnv } from '../envConfig';

export async function handler(event: SQSEvent): Promise<void> {
  const options = {
    teamTagKey: requiredEnv(ENV_VAR_NAMES.TEAM_TAG_KEY),
    teamRoleCacheTableName: requiredEnv(ENV_VAR_NAMES.TEAM_ROLE_CACHE_TABLE_NAME),
    reconcileJobTableName: requiredEnv(ENV_VAR_NAMES.RECONCILE_JOB_TABLE_NAME),
    reconcileQueueUrl: requiredEnv(ENV_VAR_NAMES.RECONCILE_QUEUE_URL),
  };

  // batchSize is 1 (see infra/stack.ts), so there is normally a single
  // record; iterate defensively in case the event source ever delivers more.
  for (const record of event.Records) {
    const message = JSON.parse(record.body) as ReconcileQueueMessage;
    await processReconcileMessage(message, options);
  }
}
