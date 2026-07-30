/**
 * Lambda entry-point adapter for the Quota_Enforcer's Trigger 2 (role
 * newly tagged into a blocked team): wired to an EventBridge rule matching
 * CloudTrail `TagRole`/`UntagRole` events (design.md's "Quota_Enforcer"
 * component, "Trigger 2 - Role newly tagged into a blocked team").
 *
 * Delegates entirely to `handleTagRoleEvent` in `../tagRoleHandler.ts`
 * (task 15.1).
 */
import { ENV_VAR_NAMES, requiredEnv } from '../envConfig';
import { handleTagRoleEvent, TagRoleEvent } from '../tagRoleHandler';

export async function handler(event: TagRoleEvent): Promise<string> {
  return handleTagRoleEvent(event, {
    teamTagKey: requiredEnv(ENV_VAR_NAMES.TEAM_TAG_KEY),
    blockedStateTableName: requiredEnv(ENV_VAR_NAMES.BLOCKED_STATE_TABLE_NAME),
  });
}
