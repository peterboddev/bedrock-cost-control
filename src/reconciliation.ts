/**
 * Team_Role_Cache reconciliation: periodically corrects `TeamIndex` reverse
 * index drift by driving from the IAM-side role list rather than the
 * DynamoDB cache table.
 *
 * See design.md's Error Handling table, row "Team_Role_Cache reverse index
 * (`TeamIndex`) drifts from actual IAM tag state": the reconciliation
 * paginates `iam:ListRoles` directly against IAM and, for each role, reads its
 * `team` tag straight from IAM (`resolveTeamFromIam`) and then:
 *   - if the role HAS a `team` tag, upserts the cache row (`cacheRoleTeam`);
 *   - if the role has NO `team` tag, DELETES any existing cache row
 *     (`deleteRoleTeam`) rather than caching an `UNMAPPED` sentinel.
 *
 * The delete-on-untag branch is what keeps the cache meaningful: a full
 * account sweep touches every role (service-linked roles, etc.), the vast
 * majority of which have no `team` tag and will never call Bedrock. Writing
 * `UNMAPPED` for all of them would bloat the table with noise and buys nothing
 * (those roles aren't making requests, so no IAM lookup is being saved). The
 * sweep therefore leaves behind rows ONLY for genuinely team-mapped roles,
 * while still correcting drift in both directions — a tag added/changed
 * (upsert) or a tag removed (delete). The per-request `resolveTeam` path is
 * unchanged and still negative-caches `UNMAPPED` for roles that actually
 * invoke Bedrock, which is where that negative cache earns its keep.
 *
 * The DynamoDB Team_Role_Cache table itself is never scanned — reconciliation
 * drives from the IAM-side role list, not from a table scan.
 *
 * Validates: Requirements 1.5
 */
import { listRoles } from './clients/iamClient';
import { cacheRoleTeam, deleteRoleTeam, resolveTeamFromIam } from './teamRoleCache';
import { retryWithBackoff, RetryOptions } from './retry';
import { Team, UNMAPPED_ROLE } from './types';

export interface ReconcileTeamRoleCacheOptions {
  /** The single configured IAM tag key that identifies a role's Team (Requirement 1.1). */
  teamTagKey: string;
  /** Name of the DynamoDB table backing the Team_Role_Cache. */
  teamRoleCacheTableName: string;
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
  /**
   * Resume token from a previous chunked run (the `nextMarker` it returned).
   * When provided, pagination resumes from this `iam:ListRoles` marker rather
   * than starting over. Omit to start a fresh run from the first page.
   */
  startMarker?: string;
  /**
   * Maximum number of `iam:ListRoles` pages to process in this invocation.
   * Bounds the IAM call volume and runtime per invocation so a single run
   * never exceeds the Lambda timeout on accounts with very many roles.
   * When the limit is hit before IAM pagination is exhausted, the result's
   * `nextMarker` is set so the caller can resume. Omit for no page limit
   * (process every page in one invocation — only safe for small accounts).
   */
  maxPages?: number;
  /**
   * How many roles within a page to resolve in parallel (bounded concurrency
   * for the per-role IAM tag lookups). Higher = faster wall-clock per page,
   * bounded by IAM read rate limits. Defaults to 25.
   */
  concurrency?: number;
}

/** The outcome of reconciling a single IAM role's cache entry. */
export interface ReconciledRole {
  roleArn: string;
  team: Team;
}

export interface ReconcileTeamRoleCacheResult {
  /** Every role that was paginated through and re-resolved, with its resulting Team. */
  reconciledRoles: ReconciledRole[];
  /** Total number of IAM `ListRoles` pages fetched in this invocation, for observability. */
  pageCount: number;
  /**
   * When set, the run was stopped early because `maxPages` was reached and
   * more roles remain. Pass this value back as `startMarker` on the next
   * invocation to resume. `undefined` means the run completed (all roles
   * processed).
   */
  nextMarker?: string;
  /** True when every role has been processed (no `nextMarker`). */
  complete: boolean;
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
  let marker: string | undefined = options.startMarker;
  let pageCount = 0;

  do {
    const response = await listRoles({
      PathPrefix: options.pathPrefix,
      Marker: marker,
    });
    pageCount += 1;

    const roleArns = (response.Roles ?? [])
      .map((role) => role.Arn)
      .filter((arn): arn is string => Boolean(arn));

    // Resolve the page's roles with bounded concurrency rather than strictly
    // serially. Each role needs IAM tag lookups, so a 100-role page done
    // one-at-a-time takes tens of seconds and blows the API Gateway 29s limit
    // (the symptom that motivated this). A wider concurrency window brings a
    // full 100-role page down to a few seconds of wall-clock while staying
    // within IAM's (generous) read request-rate limits. Tunable via the
    // `concurrency` option; defaults to 25.
    const CONCURRENCY = options.concurrency ?? 25;
    for (let i = 0; i < roleArns.length; i += CONCURRENCY) {
      const batch = roleArns.slice(i, i + CONCURRENCY);
      const resolved = await Promise.all(
        batch.map(async (roleArn) => {
          // Resolve the role's team straight from IAM (no cache-write side
          // effect — unlike resolveTeam). The sweep then decides what to
          // persist based on the result.
          const team = await retryWithBackoff(
            () => resolveTeamFromIam(roleArn, options.teamTagKey),
            options.teamResolutionRetryOptions
          );

          if (team === UNMAPPED_ROLE) {
            // Role carries no `team` tag. Do NOT cache an `UNMAPPED` sentinel —
            // that would store a useless row for every unrelated role in the
            // account (service-linked roles, etc.). Instead delete any existing
            // cache entry, which corrects drift when a role's `team` tag was
            // REMOVED directly in IAM (was mapped, now shouldn't be).
            await deleteRoleTeam(roleArn, {
              tableName: options.teamRoleCacheTableName,
            });
          } else {
            // Role has a `team` tag: upsert the durable mapping. This corrects
            // drift when a tag was added or changed directly in IAM, and the
            // entry persists (no TTL) so enforcement can always resolve it.
            await cacheRoleTeam(roleArn, team, {
              tableName: options.teamRoleCacheTableName,
              now: options.now,
            });
          }

          return { roleArn, team };
        })
      );
      // Only roles that actually resolved to a team are "reconciled" in the
      // reported sense (what the sweep persisted). Untagged roles are counted
      // toward progress via pageCount but excluded from reconciledRoles so the
      // job's rolesProcessed reflects genuine mappings, not account noise.
      reconciledRoles.push(...resolved.filter((r) => r.team !== UNMAPPED_ROLE));
    }

    marker = response.IsTruncated ? response.Marker : undefined;

    // Stop early if we've hit the per-invocation page budget and more
    // pages remain — the caller resumes by passing `nextMarker` back as
    // `startMarker`. This bounds IAM call volume + runtime per invocation
    // so huge accounts never exceed the Lambda timeout.
    if (options.maxPages !== undefined && pageCount >= options.maxPages && marker !== undefined) {
      return { reconciledRoles, pageCount, nextMarker: marker, complete: false };
    }
  } while (marker !== undefined);

  return { reconciledRoles, pageCount, complete: true };
}
