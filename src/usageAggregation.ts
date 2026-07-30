/**
 * Usage_Aggregation (read path): retrieves the current running total for a
 * specific Team, Model, and Usage_Day.
 *
 * See design.md "Usage_Aggregation (read path)" and "Data Models" >
 * "Usage_Aggregation (DynamoDB)".
 *
 * Table key schema:
 *   PK = `TEAM#<team>#MODEL#<model>`
 *   SK = `DAY#<usageDay>`
 *
 * All DynamoDB access here is a targeted GetItem keyed on the known primary
 * key — never a Scan.
 */
import { getItem } from './clients/dynamoDbClient';
import { Model, Team, UsageDay } from './types';

export interface GetRunningTotalOptions {
  /** Name of the DynamoDB table backing the Usage_Aggregation store. */
  tableName: string;
}

interface UsageAggregationItem {
  PK: string;
  SK: string;
  runningTotalTokens: number;
  usageDay: string;
  team: string;
  model: string;
  lastUpdatedAt: string;
  ttl: number;
}

function buildPartitionKey(team: Team, model: Model): string {
  return `TEAM#${team}#MODEL#${model}`;
}

function buildSortKey(usageDay: UsageDay): string {
  return `DAY#${usageDay}`;
}

/**
 * Retrieves the current running total tokens for a given Team, Model, and
 * Usage_Day via a direct `GetItem` against the Usage_Aggregation table.
 *
 * Returns `0` if no item exists yet for that Team, Model, and Usage_Day
 * (i.e. no usage has been recorded).
 *
 * Validates: Requirements 3.4
 */
export async function getRunningTotal(
  team: Team,
  model: Model,
  usageDay: UsageDay,
  options: GetRunningTotalOptions
): Promise<number> {
  const response = await getItem({
    TableName: options.tableName,
    Key: {
      PK: buildPartitionKey(team, model),
      SK: buildSortKey(usageDay),
    },
  });

  const item = response.Item as UsageAggregationItem | undefined;
  return item?.runningTotalTokens ?? 0;
}
