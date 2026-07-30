/**
 * Quota_Configuration_Store: persists Daily_Token_Quota values keyed by
 * Team and Model, with input validation.
 *
 * See design.md "Quota_Configuration_Store" and "Quota_Configuration (DynamoDB)".
 *
 * Table key schema:
 *   PK = `TEAM#<team>`
 *   SK = `MODEL#<model>`
 *
 * All DynamoDB access here is a targeted PutItem/GetItem/Query keyed on the
 * known partition key `TEAM#<team>` — never a Scan.
 */
import { getItem, putItem, query } from './clients/dynamoDbClient';
import { Model, Team } from './types';

export interface GetQuotaOptions {
  /** Name of the DynamoDB table backing the Quota_Configuration store. */
  tableName: string;
}

export interface PutQuotaOptions {
  /** Name of the DynamoDB table backing the Quota_Configuration store. */
  tableName: string;
  /** Identity of the administrator making the change, recorded on the item. */
  updatedBy?: string;
  /** Injectable clock, primarily for tests. */
  now?: () => Date;
}

export interface ListQuotasOptions {
  /** Name of the DynamoDB table backing the Quota_Configuration store. */
  tableName: string;
}

/** A single (Model, Daily_Token_Quota) pair returned by `listQuotas`. */
export interface QuotaEntry {
  model: Model;
  dailyTokenQuota: number;
}

interface QuotaConfigurationItem {
  PK: string;
  SK: string;
  dailyTokenQuota: number;
  updatedAt: string;
  updatedBy?: string;
}

function buildPartitionKey(team: Team): string {
  return `TEAM#${team}`;
}

function buildSortKey(model: Model): string {
  return `MODEL#${model}`;
}

const MODEL_SORT_KEY_PREFIX = 'MODEL#';

function extractModelFromSortKey(sortKey: string): Model {
  return sortKey.startsWith(MODEL_SORT_KEY_PREFIX)
    ? sortKey.slice(MODEL_SORT_KEY_PREFIX.length)
    : sortKey;
}

/**
 * Validates that `dailyTokenQuota` is a positive integer, throwing a
 * descriptive `Error` otherwise.
 *
 * Validates: Requirements 4.4
 */
function validateDailyTokenQuota(dailyTokenQuota: number): void {
  if (typeof dailyTokenQuota !== 'number' || !Number.isFinite(dailyTokenQuota)) {
    throw new Error(
      `dailyTokenQuota must be a positive integer; received a non-numeric value: ${dailyTokenQuota}`
    );
  }

  if (!Number.isInteger(dailyTokenQuota)) {
    throw new Error(
      `dailyTokenQuota must be a positive integer; received a non-integer value: ${dailyTokenQuota}`
    );
  }

  if (dailyTokenQuota <= 0) {
    throw new Error(
      `dailyTokenQuota must be a positive integer; received a non-positive value: ${dailyTokenQuota}`
    );
  }
}

/**
 * Persists a Daily_Token_Quota value for the given Team and Model pair.
 *
 * Validates that `dailyTokenQuota` is a positive integer before writing;
 * rejects zero, negative, and non-integer values with a descriptive error
 * without persisting them.
 *
 * Validates: Requirements 4.1, 4.4
 */
export async function putQuota(
  team: Team,
  model: Model,
  dailyTokenQuota: number,
  options: PutQuotaOptions
): Promise<void> {
  validateDailyTokenQuota(dailyTokenQuota);

  const now = (options.now ?? (() => new Date()))();

  const item: QuotaConfigurationItem = {
    PK: buildPartitionKey(team),
    SK: buildSortKey(model),
    dailyTokenQuota,
    updatedAt: now.toISOString(),
    ...(options.updatedBy !== undefined ? { updatedBy: options.updatedBy } : {}),
  };

  await putItem({
    TableName: options.tableName,
    Item: item,
  });
}

/**
 * Retrieves the Daily_Token_Quota configured for a given Team and Model
 * pair via a targeted `GetItem` against the Quota_Configuration table.
 *
 * Returns `undefined` when no Daily_Token_Quota is configured for that
 * pair, which callers (Quota_Enforcer) treat as the Team being
 * unrestricted for that Model (Requirement 4.3).
 *
 * Validates: Requirements 4.3
 */
export async function getQuota(
  team: Team,
  model: Model,
  options: GetQuotaOptions
): Promise<number | undefined> {
  const response = await getItem({
    TableName: options.tableName,
    Key: {
      PK: buildPartitionKey(team),
      SK: buildSortKey(model),
    },
  });

  const item = response.Item as QuotaConfigurationItem | undefined;
  return item?.dailyTokenQuota;
}

/**
 * Lists every (Model, Daily_Token_Quota) pair configured for the given Team.
 *
 * Queries the known partition key `TEAM#<team>` — a bounded, single-partition
 * `Query`, never a table `Scan`. Since every item under that partition
 * belongs to the queried Team by construction (the partition key itself
 * encodes the Team), the result contains exactly that Team's entries: no
 * entries from other Teams, and no omissions.
 *
 * Pagination: DynamoDB `Query` may return a partial page with a
 * `LastEvaluatedKey`; this function follows `LastEvaluatedKey` until
 * exhausted so callers always receive the complete set of configured quotas.
 *
 * Validates: Requirements 4.5
 */
export async function listQuotas(team: Team, options: ListQuotasOptions): Promise<QuotaEntry[]> {
  const entries: QuotaEntry[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const response = await query({
      TableName: options.tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': buildPartitionKey(team) },
      ExclusiveStartKey: exclusiveStartKey,
    });

    const items = (response.Items ?? []) as QuotaConfigurationItem[];
    for (const item of items) {
      entries.push({
        model: extractModelFromSortKey(item.SK),
        dailyTokenQuota: item.dailyTokenQuota,
      });
    }

    exclusiveStartKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return entries;
}
