/**
 * Reads Lambda environment variable configuration shared by every Lambda
 * entry-point adapter (`handler` export) in this package. Centralizing the
 * env var *names* here keeps `infra/stack.ts` (which sets these variables
 * on each Lambda) and the handler adapters in each `src/*.ts` module (which
 * read them at invocation time) in agreement.
 */

/** Names of every environment variable read by a Lambda handler adapter in this package. */
export const ENV_VAR_NAMES = {
  TEAM_TAG_KEY: 'TEAM_TAG_KEY',
  TEAM_ROLE_CACHE_TABLE_NAME: 'TEAM_ROLE_CACHE_TABLE_NAME',
  USAGE_AGGREGATION_TABLE_NAME: 'USAGE_AGGREGATION_TABLE_NAME',
  PROCESSED_REQUESTS_TABLE_NAME: 'PROCESSED_REQUESTS_TABLE_NAME',
  QUOTA_CONFIGURATION_TABLE_NAME: 'QUOTA_CONFIGURATION_TABLE_NAME',
  BLOCKED_STATE_TABLE_NAME: 'BLOCKED_STATE_TABLE_NAME',
  AUDIT_LOG_TABLE_NAME: 'AUDIT_LOG_TABLE_NAME',
  NOTIFICATION_TOPIC_ARN: 'NOTIFICATION_TOPIC_ARN',
} as const;

/**
 * Reads a required environment variable, throwing a descriptive error if it
 * is unset/empty rather than silently proceeding with `undefined`.
 */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Reads an optional environment variable, returning `undefined` when unset
 * or empty (e.g. the Notification_Channel topic ARN, which is legitimately
 * absent when no Notification_Channel is configured).
 */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}
