/**
 * Quota_Enforcer: breach-attach path (Trigger 1 — Usage change).
 *
 * Triggered by DynamoDB Streams `INSERT`/`MODIFY` events on the
 * Usage_Aggregation table. For each changed `(Team, Model, UsageDay)`
 * record whose `UsageDay` is the current Usage_Day: reads the configured
 * Daily_Token_Quota, and if the running total meets or exceeds the quota
 * and the Team is not already in Blocked_State for that Model, attaches a
 * Model_Deny_Policy to every IAM_Role mapped to the Team, records
 * Blocked_State, writes an Audit_Log entry per role, and publishes a
 * "blocked" Notification_Channel message.
 *
 * See design.md's "Quota_Enforcer" component ("Trigger 1 — Usage change",
 * steps 1-2), the "Model_Deny_Policy" JSON structure, the "Blocked_State
 * (DynamoDB)" data model, and the "Quota Enforcement (Breach)" sequence
 * diagram.
 *
 * This module implements the breach-attach path and the remove-on-
 * config-change path (design.md step 3). The `TagRole`/`UntagRole`
 * newly-tagged-role handling is implemented separately.
 *
 * _Requirements: 5.1, 5.2, 5.3, 4.3, 5.6, 6.3_
 */
import { createHash } from 'crypto';

import { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

import { writeAuditEntry } from './auditLog';
import { deleteItem, getItem, putItem } from './clients/dynamoDbClient';
import { deleteRolePolicy, putRolePolicy } from './clients/iamClient';
import { extractRoleNameFromArn } from './arnResolver';
import { publishNotification } from './notifications';
import { getQuota } from './quotaConfigStore';
import { RetryOptions, retryWithBackoff } from './retry';
import { listRolesForTeam } from './teamRoleCache';
import { Model, Team, UsageDay } from './types';

/** IAM actions denied by a Model_Deny_Policy, per design.md's JSON structure. */
const DENIED_BEDROCK_ACTIONS = [
  'bedrock:InvokeModel',
  'bedrock:InvokeModelWithResponseStream',
  'bedrock:Converse',
  'bedrock:ConverseStream',
];

/** Prefix for the deterministic, per-model inline policy name. */
const DENY_POLICY_NAME_PREFIX = 'bedrock-quota-deny-';

/** The IAM inline policy document shape attached to a blocked Team's IAM_Role. */
export interface ModelDenyPolicyDocument {
  Version: '2012-10-17';
  Statement: [
    {
      Sid: 'BedrockTeamTokenQuotaDeny';
      Effect: 'Deny';
      Action: string[];
      Resource: string;
    },
  ];
}

/**
 * Builds the Resource ARN a Model_Deny_Policy is scoped to. If `model` is
 * already an ARN (e.g. an inference profile ARN, per the Model glossary
 * entry), it is used as-is; otherwise it is treated as a foundation model
 * ID and wrapped into the Bedrock foundation-model ARN form shown in
 * design.md's Model_Deny_Policy JSON structure.
 */
function buildModelResourceArn(model: Model): string {
  return model.startsWith('arn:') ? model : `arn:aws:bedrock:*::foundation-model/${model}`;
}

/**
 * Builds the Model_Deny_Policy document for a specific Model: denies the
 * four Bedrock invocation actions, scoped to that Model's Resource only
 * (Requirements 5.1, 5.2, 5.3).
 *
 * Validates: Requirements 5.2, 5.3
 */
export function buildModelDenyPolicyDocument(model: Model): ModelDenyPolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'BedrockTeamTokenQuotaDeny',
        Effect: 'Deny',
        Action: [...DENIED_BEDROCK_ACTIONS],
        Resource: buildModelResourceArn(model),
      },
    ],
  };
}

/**
 * Builds a deterministic inline policy name for a given Model, so the
 * Model_Deny_Policy for one Model can be attached/removed idempotently
 * without colliding with (or affecting) the deny policy for any other
 * Model on the same IAM_Role (Requirement 5.3, design.md's Model_Deny_Policy
 * section).
 */
export function buildModelDenyPolicyName(model: Model): string {
  const hash = createHash('sha256').update(model).digest('hex').slice(0, 32);
  return `${DENY_POLICY_NAME_PREFIX}${hash}`;
}

/** The two statuses a Blocked_State entry can hold, per design.md's Data Models. */
export type BlockedStateStatus = 'BLOCKED' | 'PENDING_RESET';

interface BlockedStateItem {
  PK: string;
  SK: string;
  blockedUsageDay: UsageDay;
  blockedAt: string;
  status: BlockedStateStatus;
  statusDay: string;
}

function buildBlockedStatePartitionKey(team: Team): string {
  return `TEAM#${team}`;
}

function buildBlockedStateSortKey(model: Model): string {
  return `MODEL#${model}`;
}

/**
 * Reads the Blocked_State entry for a given Team and Model, via a targeted
 * `GetItem` on the Blocked_State table's primary key — never a Scan.
 * Returns `undefined` when the Team is not currently Blocked_State for
 * that Model.
 */
export async function getBlockedState(
  team: Team,
  model: Model,
  tableName: string
): Promise<BlockedStateItem | undefined> {
  const response = await getItem({
    TableName: tableName,
    Key: {
      PK: buildBlockedStatePartitionKey(team),
      SK: buildBlockedStateSortKey(model),
    },
  });

  return response.Item as BlockedStateItem | undefined;
}

/**
 * Records Blocked_State for a given Team and Model via a targeted
 * `PutItem` on the Blocked_State table's primary key.
 */
async function putBlockedState(
  team: Team,
  model: Model,
  blockedUsageDay: UsageDay,
  now: Date,
  tableName: string
): Promise<void> {
  const item: BlockedStateItem = {
    PK: buildBlockedStatePartitionKey(team),
    SK: buildBlockedStateSortKey(model),
    blockedUsageDay,
    blockedAt: now.toISOString(),
    status: 'BLOCKED',
    statusDay: `BLOCKED#${blockedUsageDay}`,
  };

  await putItem({
    TableName: tableName,
    Item: item,
  });
}

/**
 * Clears Blocked_State for a given Team and Model via a targeted
 * `DeleteItem` on the Blocked_State table's primary key — never a Scan.
 */
async function clearBlockedState(team: Team, model: Model, tableName: string): Promise<void> {
  await deleteItem({
    TableName: tableName,
    Key: {
      PK: buildBlockedStatePartitionKey(team),
      SK: buildBlockedStateSortKey(model),
    },
  });
}

/**
 * Attaches the Model_Deny_Policy for `model` to the given IAM_Role, via
 * `iam:PutRolePolicy` (idempotent — attaching the same policy document
 * under the same deterministic name is a no-op if already present).
 */
async function attachModelDenyPolicy(roleArn: string, model: Model): Promise<void> {
  await putRolePolicy({
    RoleName: extractRoleNameFromArn(roleArn),
    PolicyName: buildModelDenyPolicyName(model),
    PolicyDocument: JSON.stringify(buildModelDenyPolicyDocument(model)),
  });
}

/**
 * Removes the Model_Deny_Policy for `model` from the given IAM_Role, via
 * `iam:DeleteRolePolicy` — scoped by the deterministic per-model policy
 * name (Requirement 6.3), so it never affects the deny policy for any
 * other Model attached to the same role.
 */
async function removeModelDenyPolicy(roleArn: string, model: Model): Promise<void> {
  await deleteRolePolicy({
    RoleName: extractRoleNameFromArn(roleArn),
    PolicyName: buildModelDenyPolicyName(model),
  });
}

export interface EvaluateUsageAggregationChangeOptions {
  /** Name of the DynamoDB table backing the Quota_Configuration store. */
  quotaConfigTableName: string;
  /** Name of the DynamoDB table backing Blocked_State. */
  blockedStateTableName: string;
  /** Name of the DynamoDB table backing the Team_Role_Cache. */
  teamRoleCacheTableName: string;
  /** Name of the DynamoDB table backing the Audit_Log. */
  auditLogTableName: string;
  /** ARN of the configured Notification_Channel SNS topic, if any. */
  notificationTopicArn?: string;
  /** Retry options for the `iam:PutRolePolicy` calls (Requirement 5.5). */
  retryOptions?: RetryOptions;
  /** Injectable clock, primarily for tests. */
  now?: () => Date;
}

/**
 * Evaluates a single `(Team, Model, UsageDay)` running-total change and, if
 * it represents a new quota breach, attaches the Model_Deny_Policy to every
 * IAM_Role mapped to the Team.
 *
 * 1. Reads the Daily_Token_Quota for `(team, model)`. If absent or zero,
 *    the Team is unrestricted for that Model (Requirements 4.3, 5.6): if
 *    the Team is currently recorded as Blocked_State for that Model, this
 *    is treated as a signal to remove the existing Model_Deny_Policy (see
 *    step 3 below); otherwise no action is taken.
 * 2. If `runningTotalTokens < quota` and the Team is already recorded as
 *    Blocked_State for that Model, this is also treated as a
 *    remove-on-config-change signal (step 3) — the running total dropped
 *    below the quota, most likely because an administrator raised it. If
 *    the Team is not Blocked_State, no action is taken.
 * 3. Remove-on-config-change: looks up every IAM_Role mapped to the Team
 *    and, for each, removes the Model_Deny_Policy via `retryWithBackoff`
 *    around `iam:DeleteRolePolicy`. Each removal's outcome is recorded as
 *    its own Audit_Log entry (`REMOVE_DENY`/`REMOVE_DENY_FAILED`). If every
 *    role's removal succeeds, Blocked_State is cleared and a "restored"
 *    notification is published; if any role's removal permanently fails
 *    after retries are exhausted, Blocked_State is left in place (not
 *    this function's concern to retry further — that is Daily_Reset's
 *    `Pending_Reset` retry loop, task 17) and no "restored" notification
 *    is published, since the Team may still be denied on that role.
 * 4. If `runningTotalTokens >= quota` and the Team is already recorded as
 *    Blocked_State for that Model, no action is taken (already enforced).
 * 5. Otherwise (a new breach): looks up every IAM_Role mapped to the Team
 *    (`listRolesForTeam`) and, for each, attaches the Model_Deny_Policy via
 *    `retryWithBackoff` around `iam:PutRolePolicy`. Each attachment's
 *    outcome (success or permanent failure after retries are exhausted) is
 *    recorded as its own Audit_Log entry. After processing every role,
 *    Blocked_State is recorded and a "blocked" notification is published —
 *    unconditionally, matching design.md's "Quota Enforcement (Breach)"
 *    sequence diagram, in which the Blocked_State write and notification
 *    happen once after the per-role loop regardless of individual role
 *    outcomes.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 4.3, 5.6, 6.3
 */
export async function evaluateUsageAggregationChange(
  team: Team,
  model: Model,
  usageDay: UsageDay,
  runningTotalTokens: number,
  options: EvaluateUsageAggregationChangeOptions
): Promise<void> {
  const now = (options.now ?? (() => new Date()))();

  const quota = await getQuota(team, model, { tableName: options.quotaConfigTableName });

  if (quota === undefined || quota === 0 || runningTotalTokens < quota) {
    // Unrestricted (no quota, or quota is zero), or the running total has
    // dropped back below the quota: if the Team is currently Blocked_State
    // for this Model, remove the existing Model_Deny_Policy from every
    // mapped role (design.md's "Quota_Enforcer" Trigger 1, step 3).
    // Otherwise this is a no-op.
    await removeDenyForConfigChange(team, model, runningTotalTokens, quota ?? null, options, now);
    return;
  }

  const alreadyBlocked = await getBlockedState(team, model, options.blockedStateTableName);
  if (alreadyBlocked) {
    return;
  }

  const roleArns = await listRolesForTeam(team, { tableName: options.teamRoleCacheTableName });

  for (const roleArn of roleArns) {
    try {
      await retryWithBackoff(() => attachModelDenyPolicy(roleArn, model), options.retryOptions);
      await writeAuditEntry(
        team,
        model,
        roleArn,
        'ATTACH_DENY',
        runningTotalTokens,
        quota,
        now.toISOString(),
        { tableName: options.auditLogTableName }
      );
    } catch {
      await writeAuditEntry(
        team,
        model,
        roleArn,
        'ATTACH_DENY_FAILED',
        runningTotalTokens,
        quota,
        now.toISOString(),
        { tableName: options.auditLogTableName }
      );
    }
  }

  await putBlockedState(team, model, usageDay, now, options.blockedStateTableName);

  await publishNotification('blocked', team, model, quota, {
    topicArn: options.notificationTopicArn,
  });
}

/**
 * Handles the "remove-on-config-change" path (design.md's "Quota_Enforcer"
 * Trigger 1, step 3): when the quota is absent/zero, or the running total
 * has dropped below the quota, and the Team is currently recorded as
 * Blocked_State for that Model, removes the Model_Deny_Policy from every
 * IAM_Role mapped to the Team, clears Blocked_State, writes an Audit_Log
 * entry per role (`REMOVE_DENY`/`REMOVE_DENY_FAILED`), and publishes a
 * "restored" notification.
 *
 * If the Team is not currently Blocked_State for that Model, this is a
 * no-op (idempotent with respect to repeated stream events).
 *
 * Per the Error Handling table's "PutRolePolicy / DeleteRolePolicy fails"
 * row: `iam:DeleteRolePolicy` failures are retried with backoff via
 * `retryWithBackoff`, then recorded as a `REMOVE_DENY_FAILED` Audit_Log
 * entry. A removal failure is not treated as a permanent failure here —
 * Blocked_State is left in place (not cleared) so a later Daily_Reset /
 * `PENDING_RESET` retry (task 17) can pick it back up; that retry loop is
 * out of scope for this function.
 *
 * Validates: Requirements 4.3, 5.6, 6.3
 */
async function removeDenyForConfigChange(
  team: Team,
  model: Model,
  runningTotalTokens: number,
  quota: number | null,
  options: EvaluateUsageAggregationChangeOptions,
  now: Date
): Promise<void> {
  const existing = await getBlockedState(team, model, options.blockedStateTableName);
  if (existing?.status !== 'BLOCKED') {
    // Not currently blocked for this Model: nothing to remove.
    return;
  }

  const roleArns = await listRolesForTeam(team, { tableName: options.teamRoleCacheTableName });

  let anyFailure = false;

  for (const roleArn of roleArns) {
    try {
      await retryWithBackoff(() => removeModelDenyPolicy(roleArn, model), options.retryOptions);
      await writeAuditEntry(
        team,
        model,
        roleArn,
        'REMOVE_DENY',
        runningTotalTokens,
        quota,
        now.toISOString(),
        { tableName: options.auditLogTableName }
      );
    } catch {
      anyFailure = true;
      await writeAuditEntry(
        team,
        model,
        roleArn,
        'REMOVE_DENY_FAILED',
        runningTotalTokens,
        quota,
        now.toISOString(),
        { tableName: options.auditLogTableName }
      );
    }
  }

  if (anyFailure) {
    // At least one role's Model_Deny_Policy could not be removed: leave
    // Blocked_State in place so a later retry (Daily_Reset/PENDING_RESET,
    // task 17) can pick it back up. Do not publish "restored" while the
    // Team may still be denied on some role.
    return;
  }

  await clearBlockedState(team, model, options.blockedStateTableName);

  await publishNotification('restored', team, model, undefined, {
    topicArn: options.notificationTopicArn,
  });
}

/** A single DynamoDB Streams record for the Usage_Aggregation table, as delivered to the Lambda handler. */
export interface UsageAggregationStreamRecord {
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE';
  dynamodb?: {
    NewImage?: Record<string, AttributeValue>;
  };
}

/** The event shape Lambda passes to a handler for a DynamoDB Streams event source. */
export interface UsageAggregationStreamEvent {
  Records: UsageAggregationStreamRecord[];
}

interface UnmarshalledUsageAggregationItem {
  team?: unknown;
  model?: unknown;
  usageDay?: unknown;
  runningTotalTokens?: unknown;
}

/**
 * DynamoDB Streams handler for the Usage_Aggregation table: processes
 * `INSERT`/`MODIFY` records whose `usageDay` is the current Usage_Day, and
 * evaluates each for a quota breach via `evaluateUsageAggregationChange`.
 *
 * `REMOVE` events, records missing a `NewImage`, records with an
 * unexpected/malformed shape, and records for a `usageDay` other than
 * today are skipped without error — the enforcer only reacts to the
 * current day's running totals (design.md's "On INSERT/MODIFY of a
 * current-day Usage_Aggregation record").
 *
 * Validates: Requirements 5.1
 */
export async function handleUsageAggregationStreamEvent(
  event: UsageAggregationStreamEvent,
  options: EvaluateUsageAggregationChangeOptions
): Promise<void> {
  const now = (options.now ?? (() => new Date()))();
  const currentUsageDay = now.toISOString().slice(0, 10);

  for (const record of event.Records) {
    if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') {
      continue;
    }

    const newImage = record.dynamodb?.NewImage;
    if (!newImage) {
      continue;
    }

    const item = unmarshall(newImage) as UnmarshalledUsageAggregationItem;

    if (
      typeof item.team !== 'string' ||
      typeof item.model !== 'string' ||
      typeof item.usageDay !== 'string' ||
      typeof item.runningTotalTokens !== 'number'
    ) {
      continue;
    }

    if (item.usageDay !== currentUsageDay) {
      continue;
    }

    await evaluateUsageAggregationChange(
      item.team,
      item.model,
      item.usageDay,
      item.runningTotalTokens,
      options
    );
  }
}
