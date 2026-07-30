/**
 * Team_Role_Cache reconciliation: periodically corrects `TeamIndex` reverse
 * index drift by driving from the IAM-side role list rather than the
 * DynamoDB cache table.
 *
 * See design.md's Error Handling table, row "Team_Role_Cache reverse index
 * (`TeamIndex`) drifts from actual IAM tag state": a periodic reconciliation
 * Lambda paginates `iam:ListRoles` directly against IAM and, for each role,
 * re-resolves its tags via `resolveTeam` and upserts the cache table with a
 * targeted `PutItem`/`UpdateItem`. The DynamoDB Team_Role_Cache table itself
 * is never scanned — reconciliation drives from the IAM-side role list, not
 * from a table scan.
 *
 * Validates: Requirements 1.5
 */
import { listRoles } from './clients/iamClient';
import { resolveTeam } from './teamRoleCache';
import { RetryOptions } from './retry';
import { Team } from './types';

export interface ReconcileTeamRoleCacheOptions {
  /** The single configured IAM tag key that identifies a role's Team (Requirement 1.1). */
  teamTagKey: string;
  /** Name of the DynamoDB table backing the Team_Role_Cache. */
  teamRoleCacheTableName: string;
  /** Cache TTL in seconds to apply when upserting each re-resolved entry; defaults to teamRoleCache's own default (15 minutes) when omitted. */
  cacheTtlSeconds?: number;
  /** Injectable clock, primarily for tests. */
  now?: () => Date;
  /** Retry options forwarded to `resolveTeam`'s IAM calls for each role. */
  teamResolutionRetryOptions?: RetryOptions;
  /**
   * Optional path prefix forwarded to `iam:ListRoles`, to scope
   * reconciliation to a subset of roles (e.g. in tests or narrowly scoped
   * deployments). Defaults to listing every role (`/`).
   */
  pathPrefix?: string;
}

/** The outcome of reconciling a single IAM role's cache entry. */
export interface ReconciledRole {
  roleArn: string;
  team: Team;
}

export interface ReconcileTeamRoleCacheResult {
  /** Every role that was paginated through and re-resolved, with its resulting Team. */
  reconciledRoles: ReconciledRole[];
  /** Total number of IAM `ListRoles` pages fetched, for observability. */
  pageCount: number;
}

/**
 * Paginates `iam:ListRoles` (following its `Marker`/`IsTruncated`
 * pagination, an IAM API — not a DynamoDB `Scan`) and, for every role
 * found, re-resolves its Team via `resolveTeam` with `forceRefresh: true`,
 * upserting the Team_Role_Cache table with a targeted write per role. This
 * corrects `TeamIndex` reverse-index drift even for roles whose cache entry
 * has not yet expired (e.g. a tag changed directly in IAM outside the
 * normal invocation flow).
 *
 * The DynamoDB Team_Role_Cache table itself is never scanned: this handler
 * only ever issues the targeted `GetItem`/`PutItem` calls made internally
 * by `resolveTeam`, driven entirely by the IAM-side role list.
 *
 * Validates: Requirements 1.5
 */
export async function reconcileTeamRoleCache(
  options: ReconcileTeamRoleCacheOptions
): Promise<ReconcileTeamRoleCacheResult> {
  const reconciledRoles: ReconciledRole[] = [];
  let marker: string | undefined;
  let pageCount = 0;

  do {
    const response = await listRoles({
      PathPrefix: options.pathPrefix,
      Marker: marker,
    });
    pageCount += 1;

    const roles = response.Roles ?? [];
    for (const role of roles) {
      const roleArn = role.Arn;
      if (!roleArn) {
        continue;
      }

      const team = await resolveTeam(roleArn, {
        teamTagKey: options.teamTagKey,
        tableName: options.teamRoleCacheTableName,
        cacheTtlSeconds: options.cacheTtlSeconds,
        now: options.now,
        retryOptions: options.teamResolutionRetryOptions,
        forceRefresh: true,
      });

      reconciledRoles.push({ roleArn, team });
    }

    marker = response.IsTruncated ? response.Marker : undefined;
  } while (marker !== undefined);

  return { reconciledRoles, pageCount };
}
