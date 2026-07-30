/**
 * Daily_Reset: removes every Model_Deny_Policy that was attached because
 * of the previous Usage_Day's quota breach, restoring each affected
 * Team's access at the start of a new Usage_Day.
 *
 * See design.md's "Daily_Reset" section, the "Blocked_State (DynamoDB)"
 * schema (`StatusDayIndex` GSI on `statusDay`), and the "Daily Reset"
 * sequence.
 *
 * All DynamoDB access here is either a targeted GetItem/PutItem/DeleteItem
 * keyed on the known primary key `TEAM#<team>` / `MODEL#<model>`, or a
 * bounded, single-partition `Query` against the `StatusDayIndex` GSI —
 * never a table `Scan`.
 */
import { extractRoleNameFromArn } from './arnResolver';
import { writeAuditEntry } from './auditLog';
import { deleteItem, putItem, query } from './clients/dynamoDbClient';
import { deleteRolePolicy } from './clients/iamClient';
import { publishNotification } from './notifications';
import { BlockedStateStatus, buildModelDenyPolicyName, getBlockedState } from './quotaEnforcer';
import { retryWithBackoff, RetryOptions } from './retry';
import { listRolesForTeam } from './teamRoleCache';
import { Model, Team, UsageDay } from './types';
import { computeUsageDay } from './usageCollector';

/** Name of the GSI queried to find Blocked_State pairs needing a reset. */
const STATUS_DAY_INDEX_NAME = 'StatusDayIndex';

function buildBlockedStatePartitionKey(team: Team): string {
  return `TEAM#${team}`;
}

function buildBlockedStateSortKey(model: Model): string {
  return `MODEL#${model}`;
}

const TEAM_PARTITION_KEY_PREFIX = 'TEAM#';
const MODEL_SORT_KEY_PREFIX = 'MODEL#';

function extractTeamFromPartitionKey(partitionKey: string): Team {
  return partitionKey.startsWith(TEAM_PARTITION_KEY_PREFIX)
    ? partitionKey.slice(TEAM_PARTITION_KEY_PREFIX.length)
    : partitionKey;
}

function extractModelFromSortKey(sortKey: string): Model {
  return sortKey.startsWith(MODEL_SORT_KEY_PREFIX)
    ? sortKey.slice(MODEL_SORT_KEY_PREFIX.length)
    : sortKey;
}

interface BlockedStateItem {
  PK: string;
  SK: string;
  blockedUsageDay: UsageDay;
  blockedAt: string;
  status: BlockedStateStatus;
  statusDay: string;
}

/** Prefix used for the `PENDING_RESET` `status`/`statusDay` value, per design.md's Blocked_State schema. */
const PENDING_RESET_STATUS: BlockedStateStatus = 'PENDING_RESET';

/** A single (Team, Model) pair found via the `StatusDayIndex` GSI, needing a reset. */
interface BlockedStatePairToReset {
  team: Team;
  model: Model;
  /** The Usage_Day whose quota breach caused the original block, preserved across retries. */
  blockedUsageDay: UsageDay;
}

/**
 * Computes the previous Usage_Day (UTC calendar date) relative to `now`,
 * i.e. the Usage_Day that just ended at the 00:00 UTC boundary that
 * triggered this Daily_Reset invocation.
 */
function computePreviousUsageDay(now: Date): UsageDay {
  const oneDayMs = 24 * 60 * 60 * 1000;
  const previousInstant = new Date(now.getTime() - oneDayMs);
  return computeUsageDay(previousInstant.toISOString());
}

/**
 * Queries the Blocked_State table's `StatusDayIndex` GSI for every item
 * whose `statusDay` equals the given value (e.g. `BLOCKED#2025-01-15` or
 * `PENDING_RESET#2025-01-15`) — a bounded, single-partition `Query`, never
 * a table `Scan`. Follows `LastEvaluatedKey` until exhausted so callers
 * always receive the complete set of matching pairs.
 */
async function queryPairsByStatusDay(
  statusDay: string,
  tableName: string
): Promise<BlockedStatePairToReset[]> {
  const pairs: BlockedStatePairToReset[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const response = await query({
      TableName: tableName,
      IndexName: STATUS_DAY_INDEX_NAME,
      KeyConditionExpression: 'statusDay = :statusDay',
      ExpressionAttributeValues: { ':statusDay': statusDay },
      ExclusiveStartKey: exclusiveStartKey,
    });

    const items = (response.Items ?? []) as BlockedStateItem[];
    for (const item of items) {
      pairs.push({
        team: extractTeamFromPartitionKey(item.PK),
        model: extractModelFromSortKey(item.SK),
        blockedUsageDay: item.blockedUsageDay,
      });
    }

    exclusiveStartKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return pairs;
}

export interface DailyResetOptions {
  /** Name of the DynamoDB table backing the Blocked_State store. */
  blockedStateTableName: string;
  /** Name of the DynamoDB table backing the Team_Role_Cache (for `listRolesForTeam`). */
  teamRoleCacheTableName: string;
  /** Name of the DynamoDB table backing the Audit_Log. */
  auditLogTableName: string;
  /** ARN of the configured Notification_Channel SNS topic; omitted/empty means unconfigured. */
  notificationTopicArn?: string;
  /** Retry options for the `iam:DeleteRolePolicy` calls (Requirement 6.2). */
  retryOptions?: RetryOptions;
  /** Injectable clock, primarily for tests. */
  now?: () => Date;
}

/**
 * Removes the Model_Deny_Policy for a single (Team, Model) pair from every
 * IAM_Role currently mapped to the Team, clears Blocked_State on success,
 * writes a `REMOVE_DENY`/`REMOVE_DENY_FAILED` Audit_Log entry per role, and
 * publishes a "restored" notification once every role has been cleared.
 *
 * If removal fails for any mapped role (after exhausting the retry
 * budget), the pair's `status`/`statusDay` is rewritten to `PENDING_RESET`
 * so a later Daily_Reset invocation finds it again (via the
 * `PENDING_RESET#<usageDay>` `StatusDayIndex` partition) and retries it —
 * indefinitely, with no abandonment (Requirement 6.2).
 */
async function resetBlockedStatePair(
  pair: BlockedStatePairToReset,
  timestamp: string,
  options: DailyResetOptions
): Promise<void> {
  const roleArns = await listRolesForTeam(pair.team, { tableName: options.teamRoleCacheTableName });
  const policyName = buildModelDenyPolicyName(pair.model);

  let anyRoleFailed = false;

  for (const roleArn of roleArns) {
    try {
      await retryWithBackoff(
        () =>
          deleteRolePolicy({
            RoleName: extractRoleNameFromArn(roleArn),
            PolicyName: policyName,
          }),
        options.retryOptions
      );
      await writeAuditEntry(
        pair.team,
        pair.model,
        roleArn,
        'REMOVE_DENY',
        0,
        null,
        timestamp,
        { tableName: options.auditLogTableName }
      );
    } catch {
      anyRoleFailed = true;
      await writeAuditEntry(
        pair.team,
        pair.model,
        roleArn,
        'REMOVE_DENY_FAILED',
        0,
        null,
        timestamp,
        { tableName: options.auditLogTableName }
      );
    }
  }

  if (anyRoleFailed) {
    // Mark the pair PENDING_RESET (rewriting `statusDay` so it is found by
    // the `StatusDayIndex` query for `PENDING_RESET#<blockedUsageDay>`
    // instead of `BLOCKED#<blockedUsageDay>`) so a subsequent Daily_Reset
    // invocation retries it again — never abandoning it (Requirement 6.2).
    await putItem({
      TableName: options.blockedStateTableName,
      Item: {
        PK: buildBlockedStatePartitionKey(pair.team),
        SK: buildBlockedStateSortKey(pair.model),
        blockedUsageDay: pair.blockedUsageDay,
        blockedAt: timestamp,
        status: PENDING_RESET_STATUS,
        statusDay: `${PENDING_RESET_STATUS}#${pair.blockedUsageDay}`,
      } as BlockedStateItem,
    });
    return;
  }

  await deleteItem({
    TableName: options.blockedStateTableName,
    Key: {
      PK: buildBlockedStatePartitionKey(pair.team),
      SK: buildBlockedStateSortKey(pair.model),
    },
  });

  await publishNotification('restored', pair.team, pair.model, undefined, {
    topicArn: options.notificationTopicArn,
    retryOptions: options.retryOptions,
  });
}

/**
 * Entry point for the Daily_Reset scheduled handler (EventBridge scheduled
 * rule at 00:00 UTC, per design.md's "Daily_Reset" section).
 *
 * Finds every (Team, Model) pair currently recorded in Blocked_State for
 * the previous Usage_Day — via a `Query` on the Blocked_State table's
 * `StatusDayIndex` GSI for `statusDay = BLOCKED#<previousUsageDay>`, and
 * separately for `statusDay = PENDING_RESET#<previousUsageDay>` — and
 * removes the Model_Deny_Policy for each pair from every mapped IAM_Role,
 * clearing Blocked_State on success.
 *
 * Validates: Requirements 6.1, 6.3
 */
export async function runDailyReset(options: DailyResetOptions): Promise<void> {
  const now = (options.now ?? (() => new Date()))();
  const previousUsageDay = computePreviousUsageDay(now);
  const timestamp = now.toISOString();

  const [blockedPairs, pendingResetPairs] = await Promise.all([
    queryPairsByStatusDay(`BLOCKED#${previousUsageDay}`, options.blockedStateTableName),
    queryPairsByStatusDay(`PENDING_RESET#${previousUsageDay}`, options.blockedStateTableName),
  ]);

  const pairs = [...blockedPairs, ...pendingResetPairs];

  for (const pair of pairs) {
    await resetBlockedStatePair(pair, timestamp, options);
  }
}

/**
 * Manual administrative override (design.md's "Daily_Reset" section,
 * "Manual override" paragraph): removes the Model_Deny_Policy for a given
 * Team and Model from every mapped IAM_Role immediately, independent of
 * the scheduled reset, and writes an Audit_Log entry.
 *
 * Reuses the same per-role removal, Blocked_State clearing, Audit_Log
 * writing, and "restored" notification logic as the scheduled reset path
 * (`resetBlockedStatePair`), but is callable synchronously/on-demand for a
 * single specified pair rather than being driven by the `StatusDayIndex`
 * GSI query: if removal fails for any mapped role after exhausting the
 * retry budget, the pair is left/rewritten as `PENDING_RESET` (via
 * `resetBlockedStatePair`'s existing retry-marking logic) so a later
 * Daily_Reset invocation, or another manual call, can retry it.
 *
 * The pair's `blockedUsageDay` is taken from its current Blocked_State
 * entry (via a targeted `GetItem` — never a Scan) so a retry-marked entry
 * still reflects the Usage_Day whose breach originally caused the block;
 * if no Blocked_State entry exists for the pair (e.g. it was already
 * cleared, or an administrator is removing a stray policy pre-emptively),
 * today's Usage_Day is used instead.
 *
 * Validates: Requirements 6.4
 */
export async function removeDenyPolicy(
  team: Team,
  model: Model,
  options: DailyResetOptions
): Promise<void> {
  const now = (options.now ?? (() => new Date()))();

  const existing = await getBlockedState(team, model, options.blockedStateTableName);
  const blockedUsageDay = existing?.blockedUsageDay ?? computeUsageDay(now.toISOString());

  await resetBlockedStatePair({ team, model, blockedUsageDay }, now.toISOString(), options);
}
