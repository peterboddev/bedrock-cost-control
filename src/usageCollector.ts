/**
 * Usage_Collector: parses Amazon Bedrock Model Invocation Log entries into
 * normalized records, and writes the deduplicated, aggregated result to
 * DynamoDB. See design.md's "Usage_Collector" component, steps 1-7 of its
 * Processing section.
 */

import { resolveUnderlyingRoleArn } from './arnResolver';
import { transactWrite } from './clients/dynamoDbClient';
import { resolveTeam } from './teamRoleCache';
import { computeTtl } from './ttl';
import { RetryOptions } from './retry';
import { Model, UsageDay } from './types';

/**
 * The fields extracted from a single Bedrock Model Invocation Log entry,
 * prior to IAM role ARN resolution (see arnResolver.ts) and Team resolution
 * (see teamRoleCache.ts), which happen in later processing steps.
 */
export interface ParsedInvocationLogEntry {
  requestId: string;
  /** The raw invoking principal ARN (`identity.arn`), not yet resolved to an underlying IAM role ARN. */
  roleArn: string;
  modelId: Model;
  inputTokenCount: number;
  outputTokenCount: number;
  timestamp: string;
}

/**
 * Parses a raw Bedrock `ModelInvocationLog` entry (of unknown/untrusted shape,
 * as delivered via S3 or CloudWatch Logs) into a `ParsedInvocationLogEntry`.
 *
 * Returns `null` for entries that do not represent a successful, billable
 * invocation: the Bedrock Model Invocation Logging pipeline only emits
 * entries for calls that produced a response (Requirement 2.3), so an entry
 * lacking token counts is treated as non-billable/non-successful and is
 * skipped, as is any entry missing other required fields (malformed/partial
 * entries).
 *
 * _Requirements: 2.1, 2.3_
 */
export function parseInvocationLogEntry(rawEntry: unknown): ParsedInvocationLogEntry | null {
  if (typeof rawEntry !== 'object' || rawEntry === null) {
    return null;
  }

  const entry = rawEntry as Record<string, unknown>;

  const requestId = entry.requestId;
  const identity = entry.identity;
  const roleArn =
    typeof identity === 'object' && identity !== null
      ? (identity as Record<string, unknown>).arn
      : undefined;
  const modelId = entry.modelId;
  const timestamp = entry.timestamp;

  const input = entry.input;
  const inputTokenCount =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>).inputTokenCount
      : undefined;

  const output = entry.output;
  const outputTokenCount =
    typeof output === 'object' && output !== null
      ? (output as Record<string, unknown>).outputTokenCount
      : undefined;

  if (
    typeof requestId !== 'string' ||
    requestId.length === 0 ||
    typeof roleArn !== 'string' ||
    roleArn.length === 0 ||
    typeof modelId !== 'string' ||
    modelId.length === 0 ||
    typeof timestamp !== 'string' ||
    timestamp.length === 0 ||
    typeof inputTokenCount !== 'number' ||
    !Number.isFinite(inputTokenCount) ||
    typeof outputTokenCount !== 'number' ||
    !Number.isFinite(outputTokenCount)
  ) {
    return null;
  }

  return {
    requestId,
    roleArn,
    modelId,
    inputTokenCount,
    outputTokenCount,
    timestamp,
  };
}

/**
 * Computes the UTC calendar date (`Usage_Day`) for a given ISO-8601
 * timestamp string, e.g. `"2025-01-15T23:59:59.999Z"` -> `"2025-01-15"`.
 *
 * Validates: Requirements 3.3
 */
export function computeUsageDay(timestamp: string): UsageDay {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`timestamp could not be parsed as a valid date: ${timestamp}`);
  }
  return date.toISOString().slice(0, 10);
}

/** Default retention for a dedup record in the Processed_Requests table, per design.md's Data Models section. */
const PROCESSED_REQUEST_MIN_RETENTION_DAYS = 7;

/** Default retention for a Usage_Aggregation record, per Requirement 3.5. */
const USAGE_AGGREGATION_MIN_RETENTION_DAYS = 90;

export interface ProcessInvocationLogEntryOptions {
  /** The single configured IAM tag key that identifies a role's Team (Requirement 1.1). */
  teamTagKey: string;
  /** Name of the DynamoDB table backing the Team_Role_Cache, passed through to `resolveTeam`. */
  teamRoleCacheTableName: string;
  /** Name of the DynamoDB table backing the Usage_Aggregation running totals. */
  usageAggregationTableName: string;
  /** Name of the DynamoDB table (or table region) backing the Processed_Requests dedup index. */
  processedRequestsTableName: string;
  /** Injectable clock, primarily for tests. */
  now?: () => Date;
  /** Retry options forwarded to `resolveTeam`'s IAM calls. */
  teamResolutionRetryOptions?: RetryOptions;
}

/** The outcome of processing a single parsed log entry through the write path. */
export interface ProcessInvocationLogEntryResult {
  /** The resolved Team (or `UNMAPPED_ROLE`) the entry was attributed to. */
  team: string;
  /** The resolved underlying IAM role ARN. */
  roleArn: string;
  /** The UTC calendar date the entry's tokens were bucketed into. */
  usageDay: UsageDay;
  /**
   * `true` when this `requestId` had already been processed and the write
   * was discarded as a harmless duplicate (Requirement 2.5); `false` when
   * this call produced the first, aggregation-affecting write for the
   * `requestId`.
   */
  duplicate: boolean;
}

function buildUsageAggregationPartitionKey(team: string, model: Model): string {
  return `TEAM#${team}#MODEL#${model}`;
}

function buildUsageAggregationSortKey(usageDay: UsageDay): string {
  return `DAY#${usageDay}`;
}

function buildProcessedRequestPartitionKey(requestId: string): string {
  return `REQ#${requestId}`;
}

/**
 * Returns `true` if `error` is a DynamoDB `TransactWriteItems` cancellation
 * caused by the dedup record's `attribute_not_exists` condition failing
 * (i.e. this `requestId` has already been processed), which is the
 * harmless-duplicate-discard case (Requirement 2.5).
 */
function isConditionalCheckFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const err = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  if (err.name !== 'TransactionCanceledException') {
    return false;
  }

  const reasons = err.CancellationReasons ?? [];
  return reasons.some((reason) => reason?.Code === 'ConditionalCheckFailed');
}

/**
 * Processes a single parsed Bedrock Model Invocation Log entry through the
 * Usage_Collector's write path (design.md's Processing steps 3-7):
 *
 * 1. Resolves the entry's raw principal ARN to the underlying IAM role ARN
 *    (collapsing assumed-role session ARNs).
 * 2. Resolves the Team for that role ARN (via the Team_Role_Cache),
 *    classifying as `Unmapped_Role` when the role has no matching
 *    Team_Tag_Key tag rather than discarding the entry.
 * 3. Computes the `Usage_Day` (UTC calendar date) from the entry's
 *    timestamp.
 * 4. Issues a single `TransactWriteItems` call containing:
 *    - a conditional `Put` on the dedup record (`attribute_not_exists`) in
 *      the Processed_Requests table, keyed by `requestId`
 *    - an `UpdateItem ... ADD` on the running total for
 *      `(Team, Model, Usage_Day)` in the Usage_Aggregation table
 *
 * If the dedup record's condition fails (this `requestId` was already
 * processed), the entire transaction is atomically rolled back — so the
 * aggregation increment is *not* applied a second time — and this is
 * treated as a harmless discard rather than an error (Requirement 2.5).
 *
 * Validates: Requirements 1.4, 2.5, 3.1, 3.2, 3.3
 */
export async function processInvocationLogEntry(
  entry: ParsedInvocationLogEntry,
  options: ProcessInvocationLogEntryOptions
): Promise<ProcessInvocationLogEntryResult> {
  const now = (options.now ?? (() => new Date()))();

  const roleArn = resolveUnderlyingRoleArn(entry.roleArn);
  const team = await resolveTeam(roleArn, {
    teamTagKey: options.teamTagKey,
    tableName: options.teamRoleCacheTableName,
    now: options.now,
    retryOptions: options.teamResolutionRetryOptions,
  });
  const usageDay = computeUsageDay(entry.timestamp);

  const incrementAmount = entry.inputTokenCount + entry.outputTokenCount;

  try {
    await transactWrite({
      TransactItems: [
        {
          Put: {
            TableName: options.processedRequestsTableName,
            Item: {
              PK: buildProcessedRequestPartitionKey(entry.requestId),
              processedAt: now.toISOString(),
              ttl: computeTtl(now, PROCESSED_REQUEST_MIN_RETENTION_DAYS),
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Update: {
            TableName: options.usageAggregationTableName,
            Key: {
              PK: buildUsageAggregationPartitionKey(team, entry.modelId),
              SK: buildUsageAggregationSortKey(usageDay),
            },
            UpdateExpression:
              'SET #usageDay = :usageDay, #team = :team, #model = :model, #lastUpdatedAt = :now, #ttl = :ttl ADD #runningTotalTokens :increment',
            ExpressionAttributeNames: {
              '#usageDay': 'usageDay',
              '#team': 'team',
              '#model': 'model',
              '#lastUpdatedAt': 'lastUpdatedAt',
              '#ttl': 'ttl',
              '#runningTotalTokens': 'runningTotalTokens',
            },
            ExpressionAttributeValues: {
              ':usageDay': usageDay,
              ':team': team,
              ':model': entry.modelId,
              ':now': now.toISOString(),
              ':ttl': computeTtl(usageDay, USAGE_AGGREGATION_MIN_RETENTION_DAYS),
              ':increment': incrementAmount,
            },
          },
        },
      ],
    });
  } catch (error) {
    if (isConditionalCheckFailure(error)) {
      return { team, roleArn, usageDay, duplicate: true };
    }
    throw error;
  }

  return { team, roleArn, usageDay, duplicate: false };
}
