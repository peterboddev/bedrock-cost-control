/**
 * Lambda entry-point adapter for Daily_Reset: wired to an EventBridge
 * scheduled rule at `cron(0 0 * * ? *)` (00:00 UTC), per design.md's
 * "Daily_Reset" component "Trigger" paragraph.
 *
 * Delegates entirely to `runDailyReset` in `../dailyReset.ts` (task 17.1).
 */
import { ENV_VAR_NAMES, optionalEnv, requiredEnv } from '../envConfig';
import { runDailyReset } from '../dailyReset';

export async function handler(): Promise<void> {
  await runDailyReset({
    blockedStateTableName: requiredEnv(ENV_VAR_NAMES.BLOCKED_STATE_TABLE_NAME),
    teamRoleCacheTableName: requiredEnv(ENV_VAR_NAMES.TEAM_ROLE_CACHE_TABLE_NAME),
    auditLogTableName: requiredEnv(ENV_VAR_NAMES.AUDIT_LOG_TABLE_NAME),
    notificationTopicArn: optionalEnv(ENV_VAR_NAMES.NOTIFICATION_TOPIC_ARN),
  });
}
