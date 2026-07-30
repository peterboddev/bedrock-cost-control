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
import { QuotaEntry, listQuotas, putQuota } from './quotaConfigStore';
import { RetryOptions } from './retry';
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
    const message = error instanceof Error ? error.message : String(error);
    return failure(message);
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
  /** ARN of the configured Notification_Channel SNS topic, if any. */
  notificationTopicArn?: string;
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
