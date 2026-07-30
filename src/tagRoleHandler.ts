/**
 * Quota_Enforcer: newly-tagged-role handling (tag-change trigger).
 *
 * See design.md's "Quota_Enforcer" section, "Trigger 2 — Role newly tagged
 * into a blocked team", and the "Newly Mapped Role Inherits Existing
 * Block" sequence diagram.
 *
 * Triggered by an EventBridge rule matching CloudTrail `TagRole`/
 * `UntagRole` events for `iam.amazonaws.com`. On a `TagRole` event whose
 * new tags include the configured Team_Tag_Key, resolves the new Team for
 * the role directly from the event's own `requestParameters.tags` (no IAM
 * call needed — the CloudTrail event already carries the full tag set
 * being applied), queries Blocked_State for that Team via a targeted
 * `Query` on `PK = TEAM#<team>` (never a Scan), and attaches the
 * Model_Deny_Policy for every currently blocked Model to the newly tagged
 * role.
 *
 * All DynamoDB access here is a targeted Query keyed on the known
 * partition key `TEAM#<team>` — never a Scan.
 */
import { query } from './clients/dynamoDbClient';
import { putRolePolicy } from './clients/iamClient';
import { buildModelDenyPolicyDocument, buildModelDenyPolicyName } from './quotaEnforcer';
import { retryWithBackoff, RetryOptions } from './retry';
import { Model, Team } from './types';

/** A single tag key/value pair as carried in a CloudTrail `TagRole` event. */
export interface CloudTrailTag {
  key: string;
  value: string;
}

/** The `requestParameters` shape of a CloudTrail `TagRole`/`UntagRole` event. */
export interface TagRoleRequestParameters {
  roleName: string;
  tags?: CloudTrailTag[];
}

/** The `detail` shape of an EventBridge CloudTrail `TagRole`/`UntagRole` event. */
export interface TagRoleEventDetail {
  eventName: 'TagRole' | 'UntagRole' | string;
  eventSource?: string;
  recipientAccountId: string;
  requestParameters: TagRoleRequestParameters;
}

/** The EventBridge event envelope delivered to the handler. */
export interface TagRoleEvent {
  detail: TagRoleEventDetail;
}

export interface TagRoleHandlerOptions {
  /** The single configured IAM tag key that identifies a role's Team (Requirement 1.1). */
  teamTagKey: string;
  /** Name of the DynamoDB table backing the Blocked_State store. */
  blockedStateTableName: string;
  /** Retry options for the `iam:PutRolePolicy` calls (Requirement 5.5). */
  retryOptions?: RetryOptions;
}

interface BlockedStateItem {
  PK: string;
  SK: string;
  status: 'BLOCKED' | 'PENDING_RESET';
}

function buildBlockedStatePartitionKey(team: Team): string {
  return `TEAM#${team}`;
}

const MODEL_SORT_KEY_PREFIX = 'MODEL#';

function extractModelFromSortKey(sortKey: string): Model {
  return sortKey.startsWith(MODEL_SORT_KEY_PREFIX)
    ? sortKey.slice(MODEL_SORT_KEY_PREFIX.length)
    : sortKey;
}

/**
 * Queries every Model currently in Blocked_State for a given Team via a
 * targeted `Query` on `PK = TEAM#<team>` — never a Scan. Only entries with
 * status `BLOCKED` are returned; a `PENDING_RESET` entry has already been
 * un-enforced from every previously mapped role and should not be
 * re-attached to a newly mapped role.
 *
 * Pagination: DynamoDB `Query` may return a partial page with a
 * `LastEvaluatedKey`; this function follows `LastEvaluatedKey` until
 * exhausted so callers always receive the complete set of blocked Models.
 */
async function listBlockedModelsForTeam(team: Team, tableName: string): Promise<Model[]> {
  const models: Model[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const response = await query({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': buildBlockedStatePartitionKey(team) },
      ExclusiveStartKey: exclusiveStartKey,
    });

    const items = (response.Items ?? []) as BlockedStateItem[];
    for (const item of items) {
      if (item.status === 'BLOCKED') {
        models.push(extractModelFromSortKey(item.SK));
      }
    }

    exclusiveStartKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return models;
}

/**
 * Resolves the Team_Tag_Key value from a CloudTrail `TagRole` event's own
 * `requestParameters.tags` array. The event already carries the full set
 * of tags being applied, so no additional IAM call is required
 * (Requirement 5.4).
 */
function resolveTeamFromEventTags(
  tags: CloudTrailTag[] | undefined,
  teamTagKey: string
): Team | undefined {
  const matchingTag = (tags ?? []).find((tag) => tag.key === teamTagKey);
  return matchingTag?.value;
}

/** Builds the IAM role ARN for the tagged role from the event's account ID and role name. */
function buildRoleArn(accountId: string, roleName: string): string {
  return `arn:aws:iam::${accountId}:role/${roleName}`;
}

/**
 * EventBridge handler entry point for the Quota_Enforcer's
 * newly-tagged-role trigger (design.md's "Trigger 2 — Role newly tagged
 * into a blocked team").
 *
 * On a `TagRole` event whose new tags include the configured
 * Team_Tag_Key, resolves the Team directly from the event's own tags,
 * looks up every Model currently in Blocked_State for that Team, and
 * attaches the corresponding Model_Deny_Policy to the newly tagged role
 * for each one.
 *
 * `UntagRole` events, and `TagRole` events whose tags do not include the
 * configured Team_Tag_Key, are no-ops: there is no newly mapped Team to
 * inherit a block from.
 *
 * Validates: Requirements 5.4
 */
export async function handleTagRoleEvent(
  event: TagRoleEvent,
  options: TagRoleHandlerOptions
): Promise<string> {
  const { detail } = event;

  if (detail.eventName !== 'TagRole') {
    return buildRoleArn(detail.recipientAccountId, detail.requestParameters.roleName);
  }

  const roleArn = buildRoleArn(detail.recipientAccountId, detail.requestParameters.roleName);

  const team = resolveTeamFromEventTags(detail.requestParameters.tags, options.teamTagKey);
  if (team === undefined) {
    return roleArn;
  }

  const blockedModels = await listBlockedModelsForTeam(team, options.blockedStateTableName);
  if (blockedModels.length === 0) {
    return roleArn;
  }

  const roleName = detail.requestParameters.roleName;

  for (const model of blockedModels) {
    const policyName = buildModelDenyPolicyName(model);
    const policyDocument = JSON.stringify(buildModelDenyPolicyDocument(model));

    await retryWithBackoff(
      () =>
        putRolePolicy({
          RoleName: roleName,
          PolicyName: policyName,
          PolicyDocument: policyDocument,
        }),
      options.retryOptions
    );
  }

  return roleArn;
}
