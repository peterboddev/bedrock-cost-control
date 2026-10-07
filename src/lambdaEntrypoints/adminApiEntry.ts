/**
 * Lambda entry-point adapter for the administrative API handlers in
 * `../adminApi.ts`.
 *
 * This single function serves TWO invocation styles:
 *  1. Direct SDK `Invoke` with a `{ operation, payload }` body — returns the
 *     raw `AdminApiResult`.
 *  2. Amazon API Gateway (REST) Lambda-proxy integration — parses the JSON
 *     request body, dispatches, and returns an `APIGatewayProxyResult` with
 *     security headers. API Gateway enforces IAM (SigV4) authorization, so
 *     the HTTP surface is not unauthenticated (requirements.md NFR-2.3,
 *     SECURITY-08).
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
  AdminApiOptions,
  AdminApiResult,
  handleListAuditEntries,
  handleListModelRegistry,
  handleListQuotas,
  handleDeleteModelRegistryEntry,
  handleGetReconcileJob,
  handleListModelCatalog,
  handleListTeams,
  handleListTeamRoleMappings,
  handleListTeamProjectMappings,
  handleMapRoleToTeam,
  handlePutModelRegistryEntry,
  handlePutQuota,
  handlePutTeamProjectMapping,
  handleReconcileTeamRoles,
  handleRemoveDenyPolicy,
} from '../adminApi';
import { ENV_VAR_NAMES, optionalEnv, requiredEnv } from '../envConfig';

export type AdminApiOperation =
  | 'putQuota'
  | 'listQuotas'
  | 'listTeams'
  | 'listAuditEntries'
  | 'removeDenyPolicy'
  | 'putModelRegistryEntry'
  | 'listModelRegistry'
  | 'deleteModelRegistryEntry'
  | 'listModelCatalog'
  | 'putTeamProjectMapping'
  | 'listTeamProjectMappings'
  | 'reconcileTeamRoles'
  | 'getReconcileJob'
  | 'mapRoleToTeam'
  | 'listTeamRoleMappings';

export interface AdminApiLambdaRequest {
  operation: AdminApiOperation;
  payload?: Record<string, unknown>;
}

/** Security headers applied to every HTTP response (SECURITY-04, adapted for a JSON API). */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cache-Control': 'no-store',
  // Mirrors the API Gateway OPTIONS preflight so the browser accepts the POST
  // response from the budget UI. SigV4 auth travels in headers, not cookies,
  // so a wildcard origin does not permit credentialed cross-origin reads.
  'Access-Control-Allow-Origin': '*',
};

function buildOptions(): AdminApiOptions {
  return {
    quotaConfigTableName: requiredEnv(ENV_VAR_NAMES.QUOTA_CONFIGURATION_TABLE_NAME),
    auditLogTableName: requiredEnv(ENV_VAR_NAMES.AUDIT_LOG_TABLE_NAME),
    blockedStateTableName: requiredEnv(ENV_VAR_NAMES.BLOCKED_STATE_TABLE_NAME),
    teamRoleCacheTableName: requiredEnv(ENV_VAR_NAMES.TEAM_ROLE_CACHE_TABLE_NAME),
    teamTagKey: optionalEnv(ENV_VAR_NAMES.TEAM_TAG_KEY),
    reconcileQueueUrl: optionalEnv(ENV_VAR_NAMES.RECONCILE_QUEUE_URL),
    reconcileJobTableName: optionalEnv(ENV_VAR_NAMES.RECONCILE_JOB_TABLE_NAME),
    notificationTopicArn: optionalEnv(ENV_VAR_NAMES.NOTIFICATION_TOPIC_ARN),
    modelRegistryTableName: optionalEnv(ENV_VAR_NAMES.MODEL_REGISTRY_TABLE_NAME),
    teamProjectMappingTableName: optionalEnv(ENV_VAR_NAMES.TEAM_PROJECT_MAPPING_TABLE_NAME),
  };
}

/** Dispatches a validated `{ operation, payload }` request to the right handler. */
export async function dispatch(
  request: AdminApiLambdaRequest
): Promise<AdminApiResult<unknown>> {
  const options = buildOptions();
  const payload = request.payload ?? {};

  switch (request.operation) {
    case 'putQuota':
      return handlePutQuota(payload as never, options);
    case 'listQuotas':
      return handleListQuotas(payload as never, options);
    case 'listTeams':
      return handleListTeams(options);
    case 'listAuditEntries':
      return handleListAuditEntries(payload as never, options);
    case 'removeDenyPolicy':
      return handleRemoveDenyPolicy(payload as never, options);
    case 'putModelRegistryEntry':
      return handlePutModelRegistryEntry(payload as never, options);
    case 'listModelRegistry':
      return handleListModelRegistry(options);
    case 'deleteModelRegistryEntry':
      return handleDeleteModelRegistryEntry(payload as never, options);
    case 'listModelCatalog':
      return handleListModelCatalog(payload as never, options);
    case 'putTeamProjectMapping':
      return handlePutTeamProjectMapping(payload as never, options);
    case 'listTeamProjectMappings':
      return handleListTeamProjectMappings(options);
    case 'reconcileTeamRoles':
      return handleReconcileTeamRoles(payload as never, options);
    case 'getReconcileJob':
      return handleGetReconcileJob(payload as never, options);
    case 'mapRoleToTeam':
      return handleMapRoleToTeam(payload as never, options);
    case 'listTeamRoleMappings':
      return handleListTeamRoleMappings(options);
    default:
      return { ok: false, error: `Unknown operation: ${String(request.operation)}` };
  }
}

/** True when the event looks like an API Gateway (REST) Lambda-proxy event. */
function isHttpEvent(event: unknown): event is APIGatewayProxyEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    ('httpMethod' in event || 'requestContext' in event) &&
    'body' in event
  );
}

function httpResponse(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: SECURITY_HEADERS, body: JSON.stringify(body) };
}

async function handleHttp(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  let parsed: unknown;
  try {
    parsed = event.body ? JSON.parse(event.body) : {};
  } catch {
    return httpResponse(400, { ok: false, error: 'Request body must be valid JSON' });
  }

  const request = parsed as Partial<AdminApiLambdaRequest>;
  if (typeof request.operation !== 'string') {
    return httpResponse(400, { ok: false, error: "'operation' is required" });
  }

  const result = await dispatch({
    operation: request.operation as AdminApiOperation,
    payload: request.payload,
  });
  // Validation / not-found style failures map to 400; successes to 200.
  return httpResponse(result.ok ? 200 : 400, result);
}

export async function handler(
  event: AdminApiLambdaRequest | APIGatewayProxyEvent
): Promise<AdminApiResult<unknown> | APIGatewayProxyResult> {
  if (isHttpEvent(event)) {
    return handleHttp(event);
  }
  return dispatch(event as AdminApiLambdaRequest);
}
