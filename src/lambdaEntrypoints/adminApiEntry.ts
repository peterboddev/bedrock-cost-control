/**
 * Lambda entry-point adapter for the administrative API handlers in
 * `../adminApi.ts` (task 20.1). Not wired to an API Gateway route in this
 * task (task 21.2 only covers the S3/Streams/EventBridge/SNS wiring
 * called out in its description) - this Lambda is deployed so it is
 * invokable directly (e.g. via SDK `Invoke`, or wired to an internal API
 * Gateway/CLI in a future task) with a minimal JSON request/response
 * contract: `{ "operation": "putQuota" | "listQuotas" | "listAuditEntries"
 * | "removeDenyPolicy", "payload": {...} }`.
 */
import {
  AdminApiOptions,
  AdminApiResult,
  handleListAuditEntries,
  handleListQuotas,
  handlePutQuota,
  handleRemoveDenyPolicy,
} from '../adminApi';
import { ENV_VAR_NAMES, optionalEnv, requiredEnv } from '../envConfig';

export interface AdminApiLambdaRequest {
  operation: 'putQuota' | 'listQuotas' | 'listAuditEntries' | 'removeDenyPolicy';
  payload: Record<string, unknown>;
}

function buildOptions(): AdminApiOptions {
  return {
    quotaConfigTableName: requiredEnv(ENV_VAR_NAMES.QUOTA_CONFIGURATION_TABLE_NAME),
    auditLogTableName: requiredEnv(ENV_VAR_NAMES.AUDIT_LOG_TABLE_NAME),
    blockedStateTableName: requiredEnv(ENV_VAR_NAMES.BLOCKED_STATE_TABLE_NAME),
    teamRoleCacheTableName: requiredEnv(ENV_VAR_NAMES.TEAM_ROLE_CACHE_TABLE_NAME),
    notificationTopicArn: optionalEnv(ENV_VAR_NAMES.NOTIFICATION_TOPIC_ARN),
  };
}

export async function handler(
  request: AdminApiLambdaRequest
): Promise<AdminApiResult<unknown>> {
  const options = buildOptions();

  switch (request.operation) {
    case 'putQuota':
      return handlePutQuota(request.payload as never, options);
    case 'listQuotas':
      return handleListQuotas(request.payload as never, options);
    case 'listAuditEntries':
      return handleListAuditEntries(request.payload as never, options);
    case 'removeDenyPolicy':
      return handleRemoveDenyPolicy(request.payload as never, options);
    default:
      return { ok: false, error: `Unknown operation: ${String(request.operation)}` };
  }
}
