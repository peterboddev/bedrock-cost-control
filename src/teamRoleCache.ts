/**
 * Team_Role_Cache: resolves the Team associated with an IAM Role ARN,
 * caching the result in DynamoDB to avoid repeated IAM API calls
 * (which are subject to account-wide throttling limits).
 *
 * See design.md "Team_Role_Cache" and "Team_Role_Cache (DynamoDB)".
 *
 * Table key schema:
 *   PK = `ROLE#<roleArn>`
 *   GSI `TeamIndex` PK = `team`  (used by listRolesForTeam)
 *
 * All DynamoDB access here is a targeted GetItem/PutItem keyed on the known
 * partition key `ROLE#<roleArn>`, or (for listRolesForTeam) a bounded,
 * single-partition Query against the `TeamIndex` GSI — never a table Scan.
 */
import { deleteItem, getItem, putItem, query } from "./clients/dynamoDbClient";
import { getRole, listRoleTags } from "./clients/iamClient";
import { retryWithBackoff, RetryOptions } from "./retry";
import { Team, UNMAPPED_ROLE } from "./types";

/** Name of the GSI used by listRolesForTeam; partition key is `team`. */
const TEAM_INDEX_NAME = "TeamIndex";

/** Default cache TTL for resolved role -> team mappings, per design.md's 15 minute default. */
const DEFAULT_CACHE_TTL_SECONDS = 15 * 60;

export interface ResolveTeamOptions {
  /** The single configured IAM tag key that identifies a role's Team (Requirement 1.1). */
  teamTagKey: string;
  /** Name of the DynamoDB table backing the Team_Role_Cache. */
  tableName: string;
  /** Cache TTL in seconds; defaults to 15 minutes per design.md. */
  cacheTtlSeconds?: number;
  /** Injectable clock, primarily for tests. */
  now?: () => Date;
  /**
   * Retry options for the `iam:GetRole`/`iam:ListRoleTags` calls, per
   * design.md's Error Handling table ("IAM GetRole/ListRoleTags throttled
   * or fails during Team resolution"). Defaults to `retryWithBackoff`'s
   * own defaults (3 attempts) when omitted.
   */
  retryOptions?: RetryOptions;
  /**
   * When true, skips a fresh-cache-hit short-circuit and always re-resolves
   * the role's tags directly against IAM, upserting the cache table
   * regardless of the existing entry's TTL. Used by the periodic
   * reconciliation process (see `src/reconciliation.ts`, design.md's Error
   * Handling table row on `TeamIndex` drift) to correct a stale reverse
   * index even when a role's cache entry has not yet expired (e.g. its tag
   * was changed directly in IAM outside the normal invocation flow).
   */
  forceRefresh?: boolean;
}

export interface ListRolesForTeamOptions {
  /** Name of the DynamoDB table backing the Team_Role_Cache. */
  tableName: string;
}

interface TeamRoleCacheItem {
  PK: string;
  team: Team;
  cachedAt: string;
  /**
   * Expiry (epoch seconds) for `resolveTeam`'s IAM-lookup cache entries.
   * **Omitted for authoritative mappings** written by `cacheRoleTeam`
   * (TagRole warming / `mapRoleToTeam` / reconcile): those are durable facts,
   * not a throttling cache, and must not expire — Mantle enforcement has no
   * per-request path to re-warm an expired entry. See
   * MANTLE_ENFORCEMENT_PROPOSAL.md Finding B.
   */
  ttl?: number;
  /**
   * Constant partition value for the `RoleListIndex` GSI. Every cached item
   * carries this on a dedicated attribute so that all role→team mappings live
   * in one GSI partition and can be enumerated with a single Scan-free Query
   * (listTeamRoleMappings / listDiscoveredTeams), mirroring the TeamListIndex
   * pattern on Quota_Configuration.
   */
  roleListPk: string;
}

/**
 * Constant partition-key value for the `RoleListIndex` GSI (see
 * `TeamRoleCacheItem.roleListPk`).
 */
const ROLE_LIST_PARTITION = "ROLE";

/** Name of the GSI used to enumerate every role→team mapping. Must match infra/stack.ts. */
export const ROLE_LIST_INDEX_NAME = "RoleListIndex";

function buildPartitionKey(roleArn: string): string {
  return `ROLE#${roleArn}`;
}

const ROLE_PARTITION_KEY_PREFIX = "ROLE#";

function extractRoleArnFromPartitionKey(partitionKey: string): string {
  return partitionKey.startsWith(ROLE_PARTITION_KEY_PREFIX)
    ? partitionKey.slice(ROLE_PARTITION_KEY_PREFIX.length)
    : partitionKey;
}

function isFresh(item: TeamRoleCacheItem, now: Date): boolean {
  // Authoritative mappings carry no `ttl` and never expire (durable); only
  // `resolveTeam`'s IAM-lookup entries have a `ttl` and age out for freshness.
  if (item.ttl === undefined) {
    return true;
  }
  const nowEpochSeconds = Math.floor(now.getTime() / 1000);
  return item.ttl > nowEpochSeconds;
}

/**
 * Resolves the Team for a given IAM Role ARN.
 *
 * - Cache hit (non-expired entry): returns the cached Team without calling IAM.
 * - Cache miss or expired entry: calls `iam:GetRole` (to confirm the role exists)
 *   and `iam:ListRoleTags`, extracts the value of the configured Team_Tag_Key,
 *   classifies as `Unmapped_Role` (UNMAPPED_ROLE) when the tag is absent, writes
 *   the resolved value back to the cache with a fresh TTL, and returns it.
 * - IAM throttled/failing on every retry attempt (design.md Error Handling):
 *   falls back to the last-known cached value if one exists (even if
 *   expired), otherwise classifies as `Unmapped_Role`, without writing
 *   anything back to the cache (the fallback value is not itself a fresh
 *   resolution and should not overwrite the cache with a possibly stale
 *   TTL-refreshed entry; the role remains a candidate for reconciliation).
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 */
export async function resolveTeam(
  roleArn: string,
  options: ResolveTeamOptions
): Promise<Team> {
  const now = (options.now ?? (() => new Date()))();
  const partitionKey = buildPartitionKey(roleArn);

  const cached = await getItem({
    TableName: options.tableName,
    Key: { PK: partitionKey },
  });

  const cachedItem = cached.Item as TeamRoleCacheItem | undefined;
  if (!options.forceRefresh && cachedItem && isFresh(cachedItem, now)) {
    return cachedItem.team;
  }

  let team: Team;
  try {
    team = await retryWithBackoff(
      () => resolveTeamFromIam(roleArn, options.teamTagKey),
      options.retryOptions
    );
  } catch {
    // IAM retries exhausted (design.md Error Handling: "IAM GetRole/ListRoleTags
    // throttled or fails during Team resolution"): fall back to the last-known
    // cached value if one exists (even if expired), otherwise Unmapped_Role.
    return cachedItem ? cachedItem.team : UNMAPPED_ROLE;
  }

  const ttlSeconds = options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
  const freshItem: TeamRoleCacheItem = {
    PK: partitionKey,
    team,
    cachedAt: now.toISOString(),
    ttl: Math.floor(now.getTime() / 1000) + ttlSeconds,
    roleListPk: ROLE_LIST_PARTITION,
  };

  await putItem({
    TableName: options.tableName,
    Item: freshItem,
  });

  return team;
}

/**
 * Calls `iam:GetRole` and `iam:ListRoleTags` for the given role ARN and
 * extracts the value of the configured Team_Tag_Key, returning UNMAPPED_ROLE
 * when the tag is absent.
 *
 * Exported for the reconciliation sweep (`src/reconciliation.ts`), which needs
 * to read a role's team straight from IAM *without* the cache-write side
 * effect that `resolveTeam` performs — the sweep decides for itself whether to
 * upsert (role has a team) or delete (role has no team) the cache row, so it
 * must not blindly cache an `UNMAPPED` negative result for every unrelated
 * role in the account.
 */
export async function resolveTeamFromIam(roleArn: string, teamTagKey: string): Promise<Team> {
  const roleName = extractRoleNameFromArn(roleArn);

  await getRole({ RoleName: roleName });
  const tagsResponse = await listRoleTags({ RoleName: roleName });

  const tags = tagsResponse.Tags ?? [];
  const matchingTag = tags.find((tag) => tag.Key === teamTagKey);

  if (matchingTag && matchingTag.Value !== undefined) {
    return matchingTag.Value;
  }

  return UNMAPPED_ROLE;
}

export interface CacheRoleTeamOptions {
  /** Name of the DynamoDB table backing the Team_Role_Cache. */
  tableName: string;
  /** Injectable clock, primarily for tests. */
  now?: () => Date;
}

/**
 * Upserts a role -> team mapping into the Team_Role_Cache directly, without
 * an IAM call. Used by the TagRole handler to warm the cache the instant a
 * role is tagged into a team (the CloudTrail event already carries the team
 * tag value), so enforcement can resolve the team's roles via
 * `listRolesForTeam` immediately — closing the window where a newly tagged
 * (e.g. Mantle-only) team's roles would otherwise be invisible to
 * enforcement until the next periodic reconciliation sweep.
 */
export async function cacheRoleTeam(
  roleArn: string,
  team: Team,
  options: CacheRoleTeamOptions
): Promise<void> {
  const now = (options.now ?? (() => new Date()))();
  const item: TeamRoleCacheItem = {
    PK: buildPartitionKey(roleArn),
    team,
    cachedAt: now.toISOString(),
    // Deliberately NO `ttl`: this is an authoritative mapping, so it must
    // persist for enforcement. A TTL here would silently disable Mantle
    // enforcement ~15 min after a role is tagged/mapped (Mantle has no
    // per-request path to re-warm the cache). Tag changes are corrected by a
    // fresh TagRole event (re-tag) or the on-demand reconcile sweep (which
    // deletes the entry when a role's `team` tag is removed). See
    // MANTLE_ENFORCEMENT_PROPOSAL.md Finding B.
    roleListPk: ROLE_LIST_PARTITION,
  };
  await putItem({ TableName: options.tableName, Item: item });
}

export interface DeleteRoleTeamOptions {
  /** Name of the DynamoDB table backing the Team_Role_Cache. */
  tableName: string;
}

/**
 * Removes a role's Team_Role_Cache entry entirely (targeted DeleteItem on
 * `ROLE#<roleArn>`). Used by the reconciliation sweep when a role no longer
 * carries a `team` tag: rather than caching an `UNMAPPED` sentinel for a role
 * that is not exercising the system, the sweep deletes any stale mapping so
 * the cache holds only genuinely team-mapped roles. Deleting a non-existent
 * key is a harmless no-op, so this is safe to call unconditionally for every
 * untagged role.
 */
export async function deleteRoleTeam(
  roleArn: string,
  options: DeleteRoleTeamOptions
): Promise<void> {
  await deleteItem({
    TableName: options.tableName,
    Key: { PK: buildPartitionKey(roleArn) },
  });
}

/**
 * Lists every IAM Role ARN currently mapped to the given Team.
 *
 * Queries the `TeamIndex` GSI (partition key `team`) on the Team_Role_Cache
 * table — a bounded, single-partition `Query`, never a table `Scan`. The
 * reverse index itself requires no separate maintenance step: `resolveTeam`
 * writes each role's resolved `team` value onto the same item whose primary
 * key is `ROLE#<roleArn>`, and the `TeamIndex` GSI simply projects that
 * `team` attribute, so every role resolution keeps this index up to date
 * automatically as a side effect of the existing `putItem` write.
 *
 * Pagination: DynamoDB `Query` may return a partial page with a
 * `LastEvaluatedKey`; this function follows `LastEvaluatedKey` until
 * exhausted so callers always receive the complete set of mapped roles.
 *
 * Validates: Requirements 1.5
 */
export async function listRolesForTeam(
  team: Team,
  options: ListRolesForTeamOptions
): Promise<string[]> {
  const roleArns: string[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const response = await query({
      TableName: options.tableName,
      IndexName: TEAM_INDEX_NAME,
      KeyConditionExpression: "#team = :team",
      ExpressionAttributeNames: { "#team": "team" },
      ExpressionAttributeValues: { ":team": team },
      ExclusiveStartKey: exclusiveStartKey,
    });

    const items = (response.Items ?? []) as TeamRoleCacheItem[];
    for (const item of items) {
      roleArns.push(extractRoleArnFromPartitionKey(item.PK));
    }

    exclusiveStartKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return roleArns;
}

/** A single role→team mapping row from the Team_Role_Cache. */
export interface TeamRoleMapping {
  roleArn: string;
  team: Team;
}

export interface ListTeamRoleMappingsOptions {
  /** Name of the DynamoDB table backing the Team_Role_Cache. */
  tableName: string;
}

/**
 * Lists every role→team mapping currently in the Team_Role_Cache.
 *
 * Queries the `RoleListIndex` GSI on its single constant partition
 * (`ROLE_LIST_PARTITION`) — a bounded, single-partition `Query`, never a table
 * `Scan` — following `LastEvaluatedKey` until exhausted. Powers the admin UI's
 * read-only "discovered mappings" view and `listDiscoveredTeams` below.
 *
 * Note this reflects the cache's current contents: roles that have called
 * Bedrock, been tagged, or been found by the reconcile sweep. Untagged roles
 * are not present (the sweep deletes rather than caches them), so this is the
 * set of genuinely team-mapped roles, not every role in the account.
 */
export async function listTeamRoleMappings(
  options: ListTeamRoleMappingsOptions
): Promise<TeamRoleMapping[]> {
  const mappings: TeamRoleMapping[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const response = await query({
      TableName: options.tableName,
      IndexName: ROLE_LIST_INDEX_NAME,
      KeyConditionExpression: "roleListPk = :pk",
      ExpressionAttributeValues: { ":pk": ROLE_LIST_PARTITION },
      ExclusiveStartKey: exclusiveStartKey,
    });

    const items = (response.Items ?? []) as TeamRoleCacheItem[];
    for (const item of items) {
      mappings.push({ roleArn: extractRoleArnFromPartitionKey(item.PK), team: item.team });
    }

    exclusiveStartKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return mappings;
}

/**
 * Lists the distinct set of teams currently represented in the Team_Role_Cache
 * (i.e. teams that have at least one mapped role), deduplicated and sorted.
 * Driven by the same Scan-free `RoleListIndex` Query as `listTeamRoleMappings`.
 *
 * Used (unioned with the teams that have budgets configured) to populate the
 * admin UI's team picker, so a team discovered by the reconcile sweep shows up
 * for budgeting even before it has any quota set.
 */
export async function listDiscoveredTeams(
  options: ListTeamRoleMappingsOptions
): Promise<Team[]> {
  const mappings = await listTeamRoleMappings(options);
  const teams = new Set<Team>();
  for (const mapping of mappings) {
    teams.add(mapping.team);
  }
  return [...teams].sort((a, b) => a.localeCompare(b));
}

/**
 * Extracts the role name from an IAM role ARN of the form
 * `arn:aws:iam::<account>:role/<RoleName>` (including roles with a path,
 * e.g. `arn:aws:iam::<account>:role/path/to/<RoleName>`).
 */
function extractRoleNameFromArn(roleArn: string): string {
  const marker = ":role/";
  const markerIndex = roleArn.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Not an IAM role ARN: ${roleArn}`);
  }
  const afterMarker = roleArn.slice(markerIndex + marker.length);
  const lastSlashIndex = afterMarker.lastIndexOf("/");
  return lastSlashIndex === -1 ? afterMarker : afterMarker.slice(lastSlashIndex + 1);
}
