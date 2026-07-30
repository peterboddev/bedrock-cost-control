/**
 * Lambda entry-point adapter for the Quota_Enforcer's Trigger 1 (usage
 * change): wired to a DynamoDB Streams event source mapping on the
 * Usage_Aggregation table (design.md's "Quota_Enforcer" component,
 * "Trigger 1 - Usage change").
 *
 * Delegates entirely to `handleUsageAggregationStreamEvent` in
 * `../quotaEnforcer.ts` (tasks 14.1, 14.4).
 */
import { ENV_VAR_NAMES, optionalEnv, requiredEnv } from '../envConfig';
import { handleUsageAggregationStreamEvent, UsageAggregationStreamEvent } from '../quotaEnforcer';

export async function handler(event: UsageAggregationStreamEvent): Promise<void> {
  await handleUsageAggregationStreamEvent(event, {
    quotaConfigTableName: requiredEnv(ENV_VAR_NAMES.QUOTA_CONFIGURATION_TABLE_NAME),
    blockedStateTableName: requiredEnv(ENV_VAR_NAMES.BLOCKED_STATE_TABLE_NAME),
    teamRoleCacheTableName: requiredEnv(ENV_VAR_NAMES.TEAM_ROLE_CACHE_TABLE_NAME),
    auditLogTableName: requiredEnv(ENV_VAR_NAMES.AUDIT_LOG_TABLE_NAME),
    notificationTopicArn: optionalEnv(ENV_VAR_NAMES.NOTIFICATION_TOPIC_ARN),
  });
}
