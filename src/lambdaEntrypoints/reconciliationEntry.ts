/**
 * Lambda entry-point adapter for the periodic Team_Role_Cache
 * reconciliation process: wired to an EventBridge scheduled rule (every 15
 * minutes), per design.md's Error Handling table row on `TeamIndex` drift.
 *
 * Delegates entirely to `reconcileTeamRoleCache` in `../reconciliation.ts`
 * (task 19.1).
 */
import { ENV_VAR_NAMES, requiredEnv } from '../envConfig';
import { reconcileTeamRoleCache, ReconcileTeamRoleCacheResult } from '../reconciliation';

export async function handler(): Promise<ReconcileTeamRoleCacheResult> {
  return reconcileTeamRoleCache({
    teamTagKey: requiredEnv(ENV_VAR_NAMES.TEAM_TAG_KEY),
    teamRoleCacheTableName: requiredEnv(ENV_VAR_NAMES.TEAM_ROLE_CACHE_TABLE_NAME),
  });
}
