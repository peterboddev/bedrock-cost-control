/**
 * Admin API client for the budget UI.
 *
 * The Admin API (API Gateway, POST /admin) is protected by IAM authorization,
 * so every request is SigV4-signed with the operator's AWS credentials via
 * aws4fetch. The request/response contract matches the Lambda:
 *   request  : { operation, payload }
 *   response : { ok: true, data } | { ok: false, error }
 */
import { AwsClient } from "aws4fetch";

export interface AdminConnection {
  /** Full Admin API endpoint, e.g. https://xxxx.execute-api.us-east-2.amazonaws.com/prod/admin */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Required for temporary (STS/SSO) credentials. */
  sessionToken?: string;
}

export type AdminResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface QuotaEntry {
  model: string;
  dailyTokenQuota: number;
}

export interface ModelRegistryEntry {
  modelId: string;
  endpoint: string;
  provider: string;
  scope?: string;
  region?: string;
}

function awsClient(conn: AdminConnection): AwsClient {
  return new AwsClient({
    accessKeyId: conn.accessKeyId,
    secretAccessKey: conn.secretAccessKey,
    sessionToken: conn.sessionToken || undefined,
    service: "execute-api",
    region: conn.region,
  });
}

async function call<T>(
  conn: AdminConnection,
  operation: string,
  payload?: Record<string, unknown>
): Promise<AdminResult<T>> {
  let res: Response;
  try {
    const aws = awsClient(conn);
    res = await aws.fetch(conn.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ? { operation, payload } : { operation }),
    });
  } catch (e) {
    return { ok: false, error: `Network/CORS error: ${(e as Error).message}` };
  }

  const text = await res.text();
  if (!res.ok) {
    // API Gateway IAM auth failures return { message: "..." }.
    try {
      const j = JSON.parse(text) as { message?: string; error?: string };
      return { ok: false, error: j.message || j.error || `HTTP ${res.status}` };
    } catch {
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
  }
  try {
    return JSON.parse(text) as AdminResult<T>;
  } catch {
    return { ok: false, error: `Unexpected response: ${text.slice(0, 200)}` };
  }
}

export const listTeams = (conn: AdminConnection) =>
  call<string[]>(conn, "listTeams");

export const listQuotas = (conn: AdminConnection, team: string) =>
  call<QuotaEntry[]>(conn, "listQuotas", { team });

export const putQuota = (
  conn: AdminConnection,
  team: string,
  model: string,
  dailyTokenQuota: number
) => call<void>(conn, "putQuota", { team, model, dailyTokenQuota, updatedBy: "budget-ui" });

export const listModelRegistry = (conn: AdminConnection) =>
  call<ModelRegistryEntry[]>(conn, "listModelRegistry");

/** One available foundation model from the live Bedrock catalog. */
export type ModelScope = "regional" | "cross-region" | "global";

/** One selectable catalog entry from the live Bedrock catalog for one endpoint+region. */
export interface CatalogModel {
  /** The exact id a request names (bare model id, or an inference-profile id). */
  id: string;
  /** Inference scope (bedrock-runtime only; Mantle is always "regional"). */
  scope: ModelScope;
  provider: string;
}

/**
 * Lists the live Bedrock catalog for an endpoint + region, split by inference
 * scope. Runtime returns regional ids + cross-region/global inference profiles;
 * Mantle returns the endpoint's own model list (all regional).
 */
export const listModelCatalog = (conn: AdminConnection, endpoint: string, region: string) =>
  call<CatalogModel[]>(conn, "listModelCatalog", { endpoint, region });

/** Whitelists a model on an endpoint+region (adds it to the Model_Registry allow-list). */
export const putModelRegistryEntry = (
  conn: AdminConnection,
  entry: { modelId: string; endpoint: string; provider: string; scope?: string; region?: string }
) => call<void>(conn, "putModelRegistryEntry", entry);

/** Un-whitelists a model on one endpoint+region (other entries, if any, remain). */
export const deleteModelRegistryEntry = (
  conn: AdminConnection,
  modelId: string,
  endpoint: string,
  region?: string
) => call<void>(conn, "deleteModelRegistryEntry", { modelId, endpoint, ...(region ? { region } : {}) });

/** Returned when a reconciliation job is started — the id to poll. */
export interface StartReconcileResult {
  jobId: string;
}

export type ReconcileJobStatus = "running" | "complete" | "failed";

/** A reconciliation job's live status, as returned by getReconcileJob. */
export interface ReconcileJob {
  jobId: string;
  status: ReconcileJobStatus;
  rolesProcessed: number;
  pageCount: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
}

/**
 * Starts a background IAM-role reconciliation and returns a jobId immediately.
 * The server enqueues an SQS fan-out; a concurrency-1 worker walks every
 * iam:ListRoles page and updates the job row. Poll `getReconcileJob(jobId)` to
 * watch progress and detect completion.
 */
export const reconcileTeamRoles = (conn: AdminConnection) =>
  call<StartReconcileResult>(conn, "reconcileTeamRoles");

/** Reads the live status of a reconciliation job for polling. */
export const getReconcileJob = (conn: AdminConnection, jobId: string) =>
  call<ReconcileJob>(conn, "getReconcileJob", { jobId });

/** Directly maps one IAM role ARN to a team (no IAM scan). */
export const mapRoleToTeam = (conn: AdminConnection, roleArn: string, team: string) =>
  call<void>(conn, "mapRoleToTeam", { roleArn, team });

/** A single role→team mapping currently in the Team_Role_Cache. */
export interface TeamRoleMapping {
  roleArn: string;
  team: string;
}

/** Lists every role→team mapping the system currently knows (reconcile output + on-use/tag). */
export const listTeamRoleMappings = (conn: AdminConnection) =>
  call<TeamRoleMapping[]>(conn, "listTeamRoleMappings");
