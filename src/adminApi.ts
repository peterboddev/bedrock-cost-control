/**
 * Administrative API handlers: a thin, request-validated Lambda-handler
 * layer wiring the Quota_Configuration_Store (`putQuota`/`listQuotas`),
 * Audit_Log (`listAuditEntries`), and Daily_Reset's manual override
 * (`removeDenyPolicy`) operations behind a single administrative
 * interface, per design.md's "Quota_Configuration_Store" ("exposed via an
 * administrative interface (Lambda handlers behind an internal API or CLI
 * wrapper)") and "Daily_Reset" ("Manual override") sections.
 *
 * Each handler here validates the shape of its incoming request (required
 * fields present, correct types) *before* calling the underlying
 * store/operation function, and always returns a structured
 * `AdminApiResult` rather than throwing — including when the underlying
 * operation itself rejects the input (e.g. `putQuota`'s non-positive-
 * integer validation, per Requirement 4.4) or fails unexpectedly.
 *
 * _Requirements: 4.1, 4.4, 4.5, 6.4, 8.3_
 */
import { AuditLogEntry, listAuditEntries } from './auditLog';
import { removeDenyPolicy as removeDenyPolicyOperation } from './dailyReset';
import { ModelRegistryEntry } from './pricing/modelRegistry';
import {
  loadModelRegistry,
  putModelRegistryEntry,
  removeModelRegistryEntry,
} from './pricing/modelRegistryStore';
import { Endpoint } from './pricing/types';
import { ModelScope } from './pricing/modelRegistry';
import { listFoundationModels, listInferenceProfiles } from './clients/bedrockClient';
import { listMantleModels } from './clients/mantleModelsClient';
import { QuotaEntry, listQuotas, listTeams, putQuota } from './quotaConfigStore';
import { ReconcileJob, createReconcileJob, getReconcileJob } from './reconcileJobStore';
import type { ReconcileQueueMessage } from './reconcileWorker';
import { sendMessage } from './clients/sqsClient';
import {
  TeamRoleMapping,
  cacheRoleTeam,
  listDiscoveredTeams,
  listTeamRoleMappings,
} from './teamRoleCache';
import { randomUUID } from 'crypto';
import { RetryOptions } from './retry';
import {
  TeamProjectMapping,
  listTeamProjectMappings,
  putTeamProjectMapping,
} from './teamProjectMapping';
import { Model, Team } from './types';

/** A successful administrative API result, carrying the operation's return value. */
export interface AdminApiSuccess<T> {
  ok: true;
  data: T;
}

/** A failed administrative API result, carrying a descriptive error message. */
export interface AdminApiFailure {
  ok: false;
  error: string;
}

/** The structured result returned by every administrative API handler. */
export type AdminApiResult<T> = AdminApiSuccess<T> | AdminApiFailure;

function success<T>(data: T): AdminApiSuccess<T> {
  return { ok: true, data };
}

function failure(error: string): AdminApiFailure {
  return { ok: false, error };
}

/** Raised when an incoming request fails shape/type validation. */
class RequestValidationError extends Error {}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RequestValidationError(`'${fieldName}' is required and must be a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RequestValidationError(`'${fieldName}' is required and must be a number`);
  }
  return value;
}

function requireOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new RequestValidationError(`'${fieldName}' must be a string when provided`);
  }
  return value;
}

function requireOneOf<T extends string>(value: unknown, fieldName: string, allowed: readonly T[]): T {
  const s = requireNonEmptyString(value, fieldName);
  if (!(allowed as readonly string[]).includes(s)) {
    throw new RequestValidationError(`'${fieldName}' must be one of: ${allowed.join(', ')}`);
  }
  return s as T;
}

/** Requires an AdminApiOptions table-name option to be configured for the operation. */
function requireConfiguredTable(value: string | undefined, optionName: string): string {
  if (!value) {
    throw new RequestValidationError(
      `admin API is not configured for this operation: '${optionName}' is unset`
    );
  }
  return value;
}

const ENDPOINTS: readonly Endpoint[] = [Endpoint.BedrockRuntime, Endpoint.BedrockMantle];

/**
 * Runs `handler`, converting any thrown error (a `RequestValidationError`
 * from this module's own request-shape checks, a validation error thrown
 * by an underlying store function such as `putQuota`, or any other
 * unexpected error) into a structured `AdminApiFailure` instead of
 * propagating it.
 */
async function runHandler<T>(handler: () => Promise<T>): Promise<AdminApiResult<T>> {
  try {
    const data = await handler();
    return success(data);
  } catch (error) {
    // Validation errors (from this module or from underlying store functions)
    // carry human-readable messages safe to return to authenticated callers.
    // Unexpected errors (SDK failures, etc.) are logged server-side but not
    // forwarded — their messages can include table names, regions, request
    // IDs, and other internal details.
    if (error instanceof RequestValidationError || error instanceof Error && error.message.includes('dailyTokenQuota')) {
      return failure(error.message);
    }
    console.error('Unexpected admin API error:', error);
    return failure('Internal error processing request');
  }
}

/** Options required by every administrative API handler defined in this module. */
export interface AdminApiOptions {
  /** Name of the DynamoDB table backing the Quota_Configuration store. */
  quotaConfigTableName: string;
  /** Name of the DynamoDB table backing the Audit_Log. */
  auditLogTableName: string;
  /** Name of the DynamoDB table backing the Blocked_State store. */
  blockedStateTableName: string;
  /** Name of the DynamoDB table backing the Team_Role_Cache. */
  teamRoleCacheTableName: string;
  /** The IAM tag key that identifies a role's Team (Requirement 1.1). Needed by reconcileTeamRoles. */
  teamTagKey?: string;
  /** URL of the SQS queue the reconcile fan-out starter enqueues onto. Needed by reconcileTeamRoles. */
  reconcileQueueUrl?: string;
  /** Name of the DynamoDB table backing the Reconcile_Job_Store. Needed by reconcileTeamRoles/getReconcileJob. */
  reconcileJobTableName?: string;
  /** ARN of the configured Notification_Channel SNS topic, if any. */
  notificationTopicArn?: string;
  /** Name of the DynamoDB table backing the Model_Registry (requirements.md FR-6.1). */
  modelRegistryTableName?: string;
  /** Name of the DynamoDB table backing the Team_Project_Mapping (requirements.md FR-6.2). */
  teamProjectMappingTableName?: string;
  /** Retry options for the `iam:DeleteRolePolicy` call used by `removeDenyPolicy`. */
  retryOptions?: RetryOptions;
  /** Injectable clock, primarily for tests. */
  now?: () => Date;
}

/** Request shape for `handlePutQuota`. */
export interface PutQuotaRequest {
  team: unknown;
  model: unknown;
  dailyTokenQuota: unknown;
  updatedBy?: unknown;
}

/**
 * Validates a `putQuota` request (required fields present, correct types)
 * and, if valid, persists the Daily_Token_Quota via
 * `quotaConfigStore.putQuota`.
 *
 * Request-shape validation happens here (Requirements 4.1); the
 * positive-integer validation of `dailyTokenQuota`'s *value* (Requirement
 * 4.4) is delegated to `putQuota` itself and its thrown error is surfaced
 * as an `AdminApiFailure`.
 *
 * Validates: Requirements 4.1, 4.4
 */
export async function handlePutQuota(
  request: PutQuotaRequest,
  options: AdminApiOptions
): Promise<AdminApiResult<void>> {
  return runHandler(async () => {
    const team: Team = requireNonEmptyString(request.team, 'team');
    const model: Model = requireNonEmptyString(request.model, 'model');
    const dailyTokenQuota = requireNumber(request.dailyTokenQuota, 'dailyTokenQuota');
    const updatedBy = requireOptionalString(request.updatedBy, 'updatedBy');

    await putQuota(team, model, dailyTokenQuota, {
      tableName: options.quotaConfigTableName,
      updatedBy,
      now: options.now,
    });
  });
}

/** Request shape for `handleListQuotas`. */
export interface ListQuotasRequest {
  team: unknown;
}

/**
 * Validates a `listQuotas` request and, if valid, lists every
 * (Model, Daily_Token_Quota) pair configured for the given Team via
 * `quotaConfigStore.listQuotas`.
 *
 * Validates: Requirements 4.5
 */
export async function handleListQuotas(
  request: ListQuotasRequest,
  options: AdminApiOptions
): Promise<AdminApiResult<QuotaEntry[]>> {
  return runHandler(async () => {
    const team: Team = requireNonEmptyString(request.team, 'team');
    return listQuotas(team, { tableName: options.quotaConfigTableName });
  });
}

/**
 * Lists the distinct set of teams known to the system, for the budget UI's
 * team picker. This is the UNION of:
 *   - teams that have at least one budget configured (`quotaConfigStore.listTeams`,
 *     a Scan-free Query over the TeamListIndex GSI), and
 *   - teams discovered from IAM role tags (`listDiscoveredTeams`, a Scan-free
 *     Query over the Team_Role_Cache RoleListIndex GSI).
 *
 * Unioning both means a team found by the reconcile sweep (or by a role calling
 * Bedrock) appears in the picker so an admin can set its first budget, even
 * before any quota exists for it — closing the gap where a freshly reconciled
 * team was invisible until it had a quota. Both sources are Scan-free; the
 * result is deduplicated and sorted.
 */
export async function handleListTeams(
  options: AdminApiOptions
): Promise<AdminApiResult<Team[]>> {
  return runHandler(async () => {
    const [budgetedTeams, discoveredTeams] = await Promise.all([
      listTeams({ tableName: options.quotaConfigTableName }),
      listDiscoveredTeams({ tableName: options.teamRoleCacheTableName }),
    ]);
    const union = new Set<Team>([...budgetedTeams, ...discoveredTeams]);
    return [...union].sort((a, b) => a.localeCompare(b));
  });
}

/**
 * Lists every role→team mapping currently in the Team_Role_Cache (the output
 * of the reconcile sweep, plus roles cached on use/tag). Powers the admin UI's
 * read-only "discovered mappings" view so an operator can see exactly what a
 * reconcile found. Scan-free Query over the RoleListIndex GSI.
 */
export async function handleListTeamRoleMappings(
  options: AdminApiOptions
): Promise<AdminApiResult<TeamRoleMapping[]>> {
  return runHandler(async () => {
    return listTeamRoleMappings({ tableName: options.teamRoleCacheTableName });
  });
}

// ---------------------------------------------------------------------------
// Team <-> IAM role mapping (two approaches)
// ---------------------------------------------------------------------------

/** Request shape for `handleReconcileTeamRoles` (no fields — it just starts a job). */
export type ReconcileTeamRolesRequest = Record<string, never>;

/** Result shape returned when a reconciliation job is started: the id to poll. */
export interface StartReconcileResult {
  /** The id of the newly started job. Poll `getReconcileJob` with this to track progress. */
  jobId: string;
}

/**
 * Approach 1 (bulk, on-demand): refreshes the Team_Role_Cache from every IAM
 * role's `team` tag. This STARTS a background job and returns immediately with
 * a `jobId` — it does NOT block on the (potentially multi-minute) IAM sweep.
 *
 * The actual work runs as an SQS fan-out: this handler enqueues one starter
 * message and creates a `running` job row; a concurrency-1 worker Lambda then
 * processes one `iam:ListRoles` page per invocation and re-enqueues itself
 * until every page is done, updating the job row as it goes. The UI polls
 * `getReconcileJob(jobId)` to watch progress and detect completion. This keeps
 * the HTTP request sub-second regardless of how many thousands of roles the
 * account has, and stays gentle on IAM's read rate limits (serial pages).
 *
 * There is no automatic schedule; the operator triggers this deliberately
 * (e.g. after editing a role's `team` tag directly in IAM).
 */
export async function handleReconcileTeamRoles(
  _request: ReconcileTeamRolesRequest,
  options: AdminApiOptions
): Promise<AdminApiResult<StartReconcileResult>> {
  return runHandler(async () => {
    const queueUrl = requireConfiguredTable(options.reconcileQueueUrl, 'reconcileQueueUrl');
    const jobTableName = requireConfiguredTable(
      options.reconcileJobTableName,
      'reconcileJobTableName'
    );
    // teamTagKey isn't used here (the worker reads it from its own env), but a
    // reconcile is meaningless without it configured — fail fast if it's unset.
    requireConfiguredTable(options.teamTagKey, 'teamTagKey');

    const jobId = randomUUID();

    // Create the status row FIRST so a poll immediately after this returns
    // sees `running`, then enqueue the starter message (marker omitted = start
    // from the first IAM page).
    await createReconcileJob(jobId, { tableName: jobTableName, now: options.now });
    await sendMessage({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ jobId } satisfies ReconcileQueueMessage),
    });

    return { jobId };
  });
}

/** Request shape for `handleGetReconcileJob`. */
export interface GetReconcileJobRequest {
  jobId: unknown;
}

/**
 * Reads the status of a reconciliation job started by `handleReconcileTeamRoles`,
 * for the UI to poll. Returns the job's `status` (`running` | `complete` |
 * `failed`), roles/pages processed so far, and timestamps. Fails if the job id
 * is unknown or expired (job rows TTL out after 24h).
 */
export async function handleGetReconcileJob(
  request: GetReconcileJobRequest,
  options: AdminApiOptions
): Promise<AdminApiResult<ReconcileJob>> {
  return runHandler(async () => {
    const jobTableName = requireConfiguredTable(
      options.reconcileJobTableName,
      'reconcileJobTableName'
    );
    const jobId = requireNonEmptyString(request.jobId, 'jobId');
    const job = await getReconcileJob(jobId, { tableName: jobTableName, now: options.now });
    if (!job) {
      throw new RequestValidationError(`No reconciliation job found with id '${jobId}'`);
    }
    return job;
  });
}

/** Request shape for `handleMapRoleToTeam`. */
export interface MapRoleToTeamRequest {
  roleArn: unknown;
  team: unknown;
}

/**
 * Approach 2 (direct, no IAM scan): maps a single IAM role ARN to a team by
 * writing the Team_Role_Cache entry directly. For customers who prefer not to
 * run the bulk IAM reconciliation (or who manage roles explicitly), this
 * registers one role → team mapping with a single targeted write and no IAM
 * API calls. Enforcement can immediately resolve that team's roles.
 *
 * Note: this is a cache write, not an IAM tag change — it tells the system
 * which team a role belongs to. The role should still carry the matching
 * `team` tag for CUR cost attribution (CUR reads the tag, not this cache).
 */
export async function handleMapRoleToTeam(
  request: MapRoleToTeamRequest,
  options: AdminApiOptions
): Promise<AdminApiResult<void>> {
  return runHandler(async () => {
    const roleArn = requireNonEmptyString(request.roleArn, 'roleArn');
    const team: Team = requireNonEmptyString(request.team, 'team');
    if (!roleArn.includes(':role/')) {
      throw new RequestValidationError(`'roleArn' must be an IAM role ARN (got: ${roleArn})`);
    }
    await cacheRoleTeam(roleArn, team, { tableName: options.teamRoleCacheTableName, now: options.now });
  });
}

/** Request shape for `handleListAuditEntries`. */
export interface ListAuditEntriesRequest {
  team: unknown;
  startDate: unknown;
  endDate: unknown;
}

/**
 * Validates a `listAuditEntries` request and, if valid, retrieves the
 * Audit_Log entries for the given Team whose timestamp falls within the
 * requested date range via `auditLog.listAuditEntries`.
 *
 * Validates: Requirements 8.3
 */
export async function handleListAuditEntries(
  request: ListAuditEntriesRequest,
  options: AdminApiOptions
): Promise<AdminApiResult<AuditLogEntry[]>> {
  return runHandler(async () => {
    const team: Team = requireNonEmptyString(request.team, 'team');
    const startDate = requireNonEmptyString(request.startDate, 'startDate');
    const endDate = requireNonEmptyString(request.endDate, 'endDate');

    return listAuditEntries(team, startDate, endDate, { tableName: options.auditLogTableName });
  });
}

/** Request shape for `handleRemoveDenyPolicy`. */
export interface RemoveDenyPolicyRequest {
  team: unknown;
  model: unknown;
}

/**
 * Validates a `removeDenyPolicy` request and, if valid, manually removes
 * the Model_Deny_Policy for the given Team and Model from every mapped
 * IAM_Role immediately, independent of the scheduled Daily_Reset, via
 * `dailyReset.removeDenyPolicy` (design.md's "Daily_Reset" section,
 * "Manual override" paragraph).
 *
 * Validates: Requirements 6.4
 */
export async function handleRemoveDenyPolicy(
  request: RemoveDenyPolicyRequest,
  options: AdminApiOptions
): Promise<AdminApiResult<void>> {
  return runHandler(async () => {
    const team: Team = requireNonEmptyString(request.team, 'team');
    const model: Model = requireNonEmptyString(request.model, 'model');

    await removeDenyPolicyOperation(team, model, {
      blockedStateTableName: options.blockedStateTableName,
      teamRoleCacheTableName: options.teamRoleCacheTableName,
      auditLogTableName: options.auditLogTableName,
      notificationTopicArn: options.notificationTopicArn,
      retryOptions: options.retryOptions,
      now: options.now,
    });
  });
}

// ---------------------------------------------------------------------------
// Model registry management (requirements.md FR-1, FR-6.1)
// ---------------------------------------------------------------------------

/** Allowed inference-scope values for a whitelist entry. */
const SCOPES: readonly ModelScope[] = ['regional', 'cross-region', 'global'];

/** Request shape for `handlePutModelRegistryEntry`. */
export interface PutModelRegistryEntryRequest {
  modelId: unknown;
  endpoint: unknown;
  provider: unknown;
  scope?: unknown;
  region?: unknown;
}

/**
 * Validates and upserts a model -> endpoint allow-list entry into the
 * Model_Registry. `endpoint` must be `bedrock-runtime` or `bedrock-mantle`;
 * `scope` (optional) is `regional` | `cross-region` | `global`; `region`
 * (optional) is the AWS region the id was chosen for. Both are stored for
 * display/identity — the `modelId` itself already encodes the invocation
 * target.
 */
export async function handlePutModelRegistryEntry(
  request: PutModelRegistryEntryRequest,
  options: AdminApiOptions
): Promise<AdminApiResult<void>> {
  return runHandler(async () => {
    const tableName = requireConfiguredTable(options.modelRegistryTableName, 'modelRegistryTableName');
    const scope =
      request.scope === undefined ? undefined : requireOneOf(request.scope, 'scope', SCOPES);
    const region = requireOptionalString(request.region, 'region');
    const entry: ModelRegistryEntry = {
      modelId: requireNonEmptyString(request.modelId, 'modelId'),
      endpoint: requireOneOf(request.endpoint, 'endpoint', ENDPOINTS),
      provider: requireNonEmptyString(request.provider, 'provider'),
      ...(scope !== undefined ? { scope } : {}),
      ...(region !== undefined ? { region } : {}),
    };
    await putModelRegistryEntry(entry, { tableName });
  });
}

/** Lists every model registry entry (the allow-list). */
export async function handleListModelRegistry(
  options: AdminApiOptions
): Promise<AdminApiResult<ModelRegistryEntry[]>> {
  return runHandler(async () => {
    const tableName = requireConfiguredTable(options.modelRegistryTableName, 'modelRegistryTableName');
    const registry = await loadModelRegistry({ tableName });
    return registry.list();
  });
}

/** Request shape for `handleDeleteModelRegistryEntry`. */
export interface DeleteModelRegistryEntryRequest {
  modelId: unknown;
  endpoint: unknown;
  region?: unknown;
}

/**
 * Removes a model from the allow-list for one endpoint+region (un-whitelists
 * it). The model can remain allowed on the other endpoint, or in another
 * region, if a separate entry exists. `endpoint` must be `bedrock-runtime` or
 * `bedrock-mantle`.
 */
export async function handleDeleteModelRegistryEntry(
  request: DeleteModelRegistryEntryRequest,
  options: AdminApiOptions
): Promise<AdminApiResult<void>> {
  return runHandler(async () => {
    const tableName = requireConfiguredTable(options.modelRegistryTableName, 'modelRegistryTableName');
    const modelId = requireNonEmptyString(request.modelId, 'modelId');
    const endpoint = requireOneOf(request.endpoint, 'endpoint', ENDPOINTS);
    const region = requireOptionalString(request.region, 'region');
    await removeModelRegistryEntry(modelId, endpoint, { tableName }, region);
  });
}

/** One selectable catalog entry for the admin "Allowed models" picker. */
export interface CatalogModel {
  /** The exact id a request would name (bare model id, or an inference-profile id). */
  id: string;
  /** Inference scope of `id` (bedrock-runtime only; Mantle is always `regional`). */
  scope: ModelScope;
  /** Provider label, best-effort. */
  provider: string;
}

/** Request shape for `handleListModelCatalog`. */
export interface ListModelCatalogRequest {
  endpoint: unknown;
  region: unknown;
}

/**
 * Infers a provider label from a model/profile id. Inference-profile ids are
 * `<geo>.<provider>.<model>` (e.g. `us.anthropic.claude...`); foundation-model
 * ids are `<provider>.<model>`. Falls back to the first dotted segment.
 */
function providerFromId(id: string, geoPrefixes: readonly string[]): string {
  const parts = id.split('.');
  if (parts.length >= 3 && geoPrefixes.includes(parts[0])) {
    return parts[1];
  }
  return parts[0] ?? '';
}

// Inference-profile id prefixes that are NOT the provider: geographic scopes
// (`us`/`eu`/`apac`/`us-gov`) and the `global` scope. When an id starts with
// one of these, the provider is the SECOND segment.
const GEO_PREFIXES = ['us', 'eu', 'apac', 'us-gov', 'global'] as const;

/**
 * Lists the live Bedrock catalog for one endpoint, split by inference scope,
 * for the admin "Allowed models" picker (deployed region only — the Bedrock
 * client runs in the Lambda's region, which is where this stack enforces).
 *
 * - **Converse (`bedrock-runtime`)**: cross-region inference applies, so the
 *   invocation id depends on scope. We merge:
 *     - `ListFoundationModels` → scope `regional` (bare `provider.model` id).
 *     - `ListInferenceProfiles` (SYSTEM_DEFINED) → scope `cross-region` for a
 *       geographic prefix (`us.`/`eu.`/`apac.`/`us-gov.`), `global` for a
 *       `global.` prefix. Per AWS docs, closed-weight OpenAI GPT models REQUIRE
 *       a profile id here, so these are the ids a team actually names.
 * - **Mantle (`bedrock-mantle`)**: cross-region inference does not apply; the
 *   request names the plain model id, so only `ListFoundationModels` is used
 *   and every entry is `regional`.
 *
 * The admin whitelists the exact `id` returned here; usage is attributed to
 * that id, so enforcement keys on the same string.
 */
export async function handleListModelCatalog(
  request: ListModelCatalogRequest,
  _options: AdminApiOptions
): Promise<AdminApiResult<CatalogModel[]>> {
  return runHandler(async () => {
    const endpoint = requireOneOf(request.endpoint, 'endpoint', ENDPOINTS);
    const region = requireNonEmptyString(request.region, 'region');

    // Mantle: the authoritative list is the endpoint's own OpenAI-compatible
    // GET /v1/models (control-plane ListFoundationModels is the region catalog,
    // not the Mantle surface). Every Mantle id is a plain `regional` id — no
    // cross-region/global profiles (that is a bedrock-runtime capability).
    if (endpoint === Endpoint.BedrockMantle) {
      const ids = await listMantleModels(region);
      return ids
        .map((id) => ({
          id,
          scope: 'regional' as ModelScope,
          provider: providerFromId(id, GEO_PREFIXES),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }

    // Converse (bedrock-runtime): foundation models (regional) + system-defined
    // inference profiles classified by prefix (geo = cross-region, global.).
    const [fm, ip] = await Promise.all([
      listFoundationModels({}, region),
      listInferenceProfiles({ typeEquals: 'SYSTEM_DEFINED' }, region),
    ]);

    // A foundation model is a true *regional* (bare-id) call only when it
    // supports ON_DEMAND inference in this region. Models whose only supported
    // inference type is INFERENCE_PROFILE (e.g. anthropic.claude-sonnet-5-5 in
    // eu-central-1) are NOT invokable by bare id — they must be called through
    // an eu./global. inference profile — so they must not appear under the
    // Regional scope. They still surface via the profile list below under
    // Cross-region/Global. Omitting the inference-type array (older/edge
    // responses) is treated as on-demand-capable to avoid hiding valid models.
    const base: CatalogModel[] = (fm.modelSummaries ?? [])
      .filter((m) => {
        const types = m.inferenceTypesSupported;
        return !types || types.length === 0 || types.includes('ON_DEMAND');
      })
      .map((m) => m.modelId ?? '')
      .filter((id) => id.length > 0)
      .map((id) => ({ id, scope: 'regional' as ModelScope, provider: providerFromId(id, GEO_PREFIXES) }));

    const profiles: CatalogModel[] = (ip.inferenceProfileSummaries ?? [])
      .map((p) => p.inferenceProfileId ?? '')
      .filter((id) => id.length > 0)
      .map((id) => {
        const prefix = id.split('.')[0];
        const scope: ModelScope = prefix === 'global' ? 'global' : 'cross-region';
        return { id, scope, provider: providerFromId(id, GEO_PREFIXES) };
      });

    return [...base, ...profiles].sort(
      (a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id)
    );
  });
}

// ---------------------------------------------------------------------------
// Team <-> Mantle project mapping management (requirements.md FR-3.1, FR-6.2)
// ---------------------------------------------------------------------------

/** Request shape for `handlePutTeamProjectMapping`. */
export interface PutTeamProjectMappingRequest {
  projectId: unknown;
  team: unknown;
}

/** Validates and upserts a Mantle project -> team mapping. */
export async function handlePutTeamProjectMapping(
  request: PutTeamProjectMappingRequest,
  options: AdminApiOptions
): Promise<AdminApiResult<void>> {
  return runHandler(async () => {
    const tableName = requireConfiguredTable(
      options.teamProjectMappingTableName,
      'teamProjectMappingTableName'
    );
    const projectId = requireNonEmptyString(request.projectId, 'projectId');
    const team: Team = requireNonEmptyString(request.team, 'team');
    await putTeamProjectMapping(projectId, team, { tableName });
  });
}

/** Lists every team <-> project mapping. */
export async function handleListTeamProjectMappings(
  options: AdminApiOptions
): Promise<AdminApiResult<TeamProjectMapping[]>> {
  return runHandler(async () => {
    const tableName = requireConfiguredTable(
      options.teamProjectMappingTableName,
      'teamProjectMappingTableName'
    );
    return listTeamProjectMappings({ tableName });
  });
}
