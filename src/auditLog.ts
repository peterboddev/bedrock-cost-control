/**
 * Audit_Log: persists a record of every Quota_Enforcer/Daily_Reset
 * enforcement action for later retrieval (Requirement 8.3).
 *
 * See design.md "Audit_Log" and "Audit_Log (DynamoDB)".
 *
 * Table key schema:
 *   PK = `TEAM#<team>`
 *   SK = `TS#<isoTimestamp>#<uuid>`
 *
 * All DynamoDB access here is a targeted PutItem keyed on the known
 * partition key `TEAM#<team>` — never a Scan.
 */
import { randomUUID } from 'crypto';

import { putItem, query } from './clients/dynamoDbClient';
import { computeTtl } from './ttl';
import { Model, Team } from './types';

/** Minimum retention for Audit_Log entries, per Requirement 8.2. */
const DEFAULT_MIN_RETENTION_DAYS = 90;

/** The set of enforcement actions an Audit_Log entry can record. */
export type AuditAction = 'ATTACH_DENY' | 'REMOVE_DENY' | 'ATTACH_DENY_FAILED' | 'REMOVE_DENY_FAILED';

export interface WriteAuditEntryOptions {
  /** Name of the DynamoDB table backing the Audit_Log. */
  tableName: string;
  /** Minimum retention in days before the entry's ttl is reached; defaults to 90 (Requirement 8.2). */
  minRetentionDays?: number;
  /** Injectable unique id generator, primarily for tests; defaults to `crypto.randomUUID`. */
  uuid?: () => string;
}

interface AuditLogItem {
  PK: string;
  SK: string;
  model: Model;
  roleArn: string;
  action: AuditAction;
  runningTotalTokens: number;
  dailyTokenQuota: number | null;
  timestamp: string;
  ttl: number;
}

function buildPartitionKey(team: Team): string {
  return `TEAM#${team}`;
}

function buildSortKey(timestamp: string, id: string): string {
  return `TS#${timestamp}#${id}`;
}

/**
 * A single Audit_Log entry as returned by `listAuditEntries`.
 */
export interface AuditLogEntry {
  team: Team;
  model: Model;
  roleArn: string;
  action: AuditAction;
  runningTotalTokens: number;
  dailyTokenQuota: number | null;
  timestamp: string;
}

export interface ListAuditEntriesOptions {
  /** Name of the DynamoDB table backing the Audit_Log. */
  tableName: string;
}

/**
 * Persists an Audit_Log entry recording a single Quota_Enforcer/Daily_Reset
 * enforcement action.
 *
 * The entry's `ttl` is computed via `computeTtl` so it is retained for at
 * least `minRetentionDays` (90 by default) after `timestamp`.
 *
 * Validates: Requirements 8.1, 8.2
 */
export async function writeAuditEntry(
  team: Team,
  model: Model,
  roleArn: string,
  action: AuditAction,
  runningTotal: number,
  dailyTokenQuota: number | null | undefined,
  timestamp: string,
  options: WriteAuditEntryOptions
): Promise<void> {
  const id = (options.uuid ?? randomUUID)();
  const ttl = computeTtl(timestamp, options.minRetentionDays ?? DEFAULT_MIN_RETENTION_DAYS);

  const item: AuditLogItem = {
    PK: buildPartitionKey(team),
    SK: buildSortKey(timestamp, id),
    model,
    roleArn,
    action,
    runningTotalTokens: runningTotal,
    dailyTokenQuota: dailyTokenQuota ?? null,
    timestamp,
    ttl,
  };

  await putItem({
    TableName: options.tableName,
    Item: item,
  });
}

/**
 * Retrieves the Audit_Log entries for a given Team whose timestamp falls
 * within the specified date range (inclusive of both endpoints).
 *
 * Implemented as a `Query` on `PK = TEAM#<team>` with an `SK BETWEEN
 * TS#<startDate> AND TS#<endDate>\uFFFF` range condition — never a Scan.
 * The `\uFFFF` suffix on the upper bound ensures every sort key beginning
 * with `TS#<endDate>` (regardless of the trailing `#<uuid>` suffix) is
 * included, since `TS#<endDate>#<uuid>` otherwise sorts after the bare
 * `TS#<endDate>` string.
 *
 * Pagination: DynamoDB `Query` may return a partial page with a
 * `LastEvaluatedKey`; this function follows `LastEvaluatedKey` until
 * exhausted so callers always receive the complete set of matching entries.
 *
 * Validates: Requirements 8.3
 */
export async function listAuditEntries(
  team: Team,
  startDate: string,
  endDate: string,
  options: ListAuditEntriesOptions
): Promise<AuditLogEntry[]> {
  const partitionKey = buildPartitionKey(team);
  const lowerBound = `TS#${startDate}`;
  const upperBound = `TS#${endDate}\uFFFF`;

  const entries: AuditLogEntry[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const response = await query({
      TableName: options.tableName,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lower AND :upper',
      ExpressionAttributeValues: {
        ':pk': partitionKey,
        ':lower': lowerBound,
        ':upper': upperBound,
      },
      ExclusiveStartKey: exclusiveStartKey,
    });

    const items = (response.Items ?? []) as AuditLogItem[];
    for (const item of items) {
      entries.push({
        team,
        model: item.model,
        roleArn: item.roleArn,
        action: item.action,
        runningTotalTokens: item.runningTotalTokens,
        dailyTokenQuota: item.dailyTokenQuota,
        timestamp: item.timestamp,
      });
    }

    exclusiveStartKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return entries;
}
