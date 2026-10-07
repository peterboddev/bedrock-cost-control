/**
 * Reconcile_Job_Store: tracks the status of an on-demand Team_Role_Cache
 * reconciliation run so the budget UI can poll "running -> complete/failed"
 * after firing a background job, rather than holding an HTTP request open for
 * the whole (potentially multi-minute) sweep.
 *
 * The reconcile run itself is an SQS fan-out: the Admin API enqueues a
 * starter message and returns a `jobId` immediately; a concurrency-1 worker
 * Lambda processes one `iam:ListRoles` page per invocation, updates this job
 * row's counters, and re-enqueues itself until every page is done. This store
 * is the shared progress record both sides write/read.
 *
 * Table key schema:
 *   PK = `JOB#<jobId>`
 *
 * A TTL attribute auto-expires finished job rows so the table never grows
 * unbounded. All access here is a targeted GetItem/PutItem/UpdateItem keyed
 * on the known partition key `JOB#<jobId>` — never a Scan.
 */
import { getItem, putItem, updateItem } from './clients/dynamoDbClient';

/** Lifecycle state of a reconciliation job. */
export type ReconcileJobStatus = 'running' | 'complete' | 'failed';

/** Public shape of a reconciliation job's progress, returned to the UI. */
export interface ReconcileJob {
  jobId: string;
  status: ReconcileJobStatus;
  /** Total roles reconciled across every page processed so far. */
  rolesProcessed: number;
  /** Total IAM `ListRoles` pages processed so far. */
  pageCount: number;
  /** ISO-8601 timestamp when the job was created. */
  startedAt: string;
  /** ISO-8601 timestamp of the most recent progress update. */
  updatedAt: string;
  /** ISO-8601 timestamp when the job reached a terminal state, if it has. */
  completedAt?: string;
  /** Human-readable error message when `status === 'failed'`. */
  error?: string;
}

/** Default TTL for a job row (24h) — long enough for the UI to read the final state. */
const DEFAULT_JOB_TTL_SECONDS = 24 * 60 * 60;

const JOB_PARTITION_KEY_PREFIX = 'JOB#';

function buildPartitionKey(jobId: string): string {
  return `${JOB_PARTITION_KEY_PREFIX}${jobId}`;
}

interface ReconcileJobItem {
  PK: string;
  jobId: string;
  status: ReconcileJobStatus;
  rolesProcessed: number;
  pageCount: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  ttl: number;
}

export interface ReconcileJobStoreOptions {
  /** Name of the DynamoDB table backing the Reconcile_Job_Store. */
  tableName: string;
  /** Row TTL in seconds; defaults to 24 hours. */
  jobTtlSeconds?: number;
  /** Injectable clock, primarily for tests. */
  now?: () => Date;
}

/**
 * Creates a brand-new job row in the `running` state with zeroed counters.
 * Called by the Admin API starter the instant a reconcile is requested.
 */
export async function createReconcileJob(
  jobId: string,
  options: ReconcileJobStoreOptions
): Promise<ReconcileJob> {
  const now = (options.now ?? (() => new Date()))();
  const iso = now.toISOString();
  const ttlSeconds = options.jobTtlSeconds ?? DEFAULT_JOB_TTL_SECONDS;

  const item: ReconcileJobItem = {
    PK: buildPartitionKey(jobId),
    jobId,
    status: 'running',
    rolesProcessed: 0,
    pageCount: 0,
    startedAt: iso,
    updatedAt: iso,
    ttl: Math.floor(now.getTime() / 1000) + ttlSeconds,
  };

  await putItem({ TableName: options.tableName, Item: item });
  return toReconcileJob(item);
}

/**
 * Atomically adds this invocation's page/role counts to the job row and
 * bumps `updatedAt`. Used by the worker after processing one IAM page while
 * more pages remain (job stays `running`).
 */
export async function recordReconcileProgress(
  jobId: string,
  increment: { rolesProcessed: number; pageCount: number },
  options: ReconcileJobStoreOptions
): Promise<void> {
  const now = (options.now ?? (() => new Date()))();
  await updateItem({
    TableName: options.tableName,
    Key: { PK: buildPartitionKey(jobId) },
    UpdateExpression:
      'ADD rolesProcessed :roles, pageCount :pages SET updatedAt = :updatedAt',
    ExpressionAttributeValues: {
      ':roles': increment.rolesProcessed,
      ':pages': increment.pageCount,
      ':updatedAt': now.toISOString(),
    },
  });
}

/**
 * Adds the final page's counts and transitions the job to `complete`.
 * Used by the worker after processing the last IAM page.
 */
export async function completeReconcileJob(
  jobId: string,
  increment: { rolesProcessed: number; pageCount: number },
  options: ReconcileJobStoreOptions
): Promise<void> {
  const now = (options.now ?? (() => new Date()))();
  const iso = now.toISOString();
  await updateItem({
    TableName: options.tableName,
    Key: { PK: buildPartitionKey(jobId) },
    UpdateExpression:
      'ADD rolesProcessed :roles, pageCount :pages SET #status = :status, updatedAt = :updatedAt, completedAt = :completedAt',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':roles': increment.rolesProcessed,
      ':pages': increment.pageCount,
      ':status': 'complete' satisfies ReconcileJobStatus,
      ':updatedAt': iso,
      ':completedAt': iso,
    },
  });
}

/**
 * Transitions the job to `failed` with a human-readable message. Used by the
 * worker when a page fails irrecoverably so the UI stops showing "running".
 */
export async function failReconcileJob(
  jobId: string,
  error: string,
  options: ReconcileJobStoreOptions
): Promise<void> {
  const now = (options.now ?? (() => new Date()))();
  const iso = now.toISOString();
  await updateItem({
    TableName: options.tableName,
    Key: { PK: buildPartitionKey(jobId) },
    UpdateExpression:
      'SET #status = :status, #error = :error, updatedAt = :updatedAt, completedAt = :completedAt',
    ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
    ExpressionAttributeValues: {
      ':status': 'failed' satisfies ReconcileJobStatus,
      ':error': error,
      ':updatedAt': iso,
      ':completedAt': iso,
    },
  });
}

/**
 * Reads a job row for UI polling. Returns `undefined` when no such job exists
 * (unknown/expired jobId) — a targeted GetItem on `JOB#<jobId>`, never a Scan.
 */
export async function getReconcileJob(
  jobId: string,
  options: ReconcileJobStoreOptions
): Promise<ReconcileJob | undefined> {
  const result = await getItem({
    TableName: options.tableName,
    Key: { PK: buildPartitionKey(jobId) },
  });
  const item = result.Item as ReconcileJobItem | undefined;
  return item ? toReconcileJob(item) : undefined;
}

function toReconcileJob(item: ReconcileJobItem): ReconcileJob {
  return {
    jobId: item.jobId,
    status: item.status,
    rolesProcessed: item.rolesProcessed,
    pageCount: item.pageCount,
    startedAt: item.startedAt,
    updatedAt: item.updatedAt,
    completedAt: item.completedAt,
    error: item.error,
  };
}
