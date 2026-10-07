/**
 * Mantle usage collector (requirements.md FR-3).
 *
 * The `bedrock-mantle` endpoint emits no per-request invocation log, so
 * usage is pulled from `AWS/BedrockMantle` CloudWatch metrics
 * (`TotalInputTokens`/`TotalOutputTokens`, dimensioned by `Project` and
 * `ModelId`) and attributed to a Team via the Team<->Project mapping.
 *
 * Unlike the Converse per-request path (which ADDs increments and
 * deduplicates by requestId), this path is AGGREGATE: each run pulls the
 * day's total for every (project, model) and writes it as an ABSOLUTE
 * value (SET, not ADD). Re-pulling the same day is therefore idempotent
 * (FR-3.5) — no requestId, no double counting across overlapping windows.
 */
import { updateItem } from './clients/dynamoDbClient';
import { Endpoint } from './pricing/types';
import { computeTtl } from './ttl';
import { Team, UNMAPPED_ROLE, UsageDay } from './types';

/** A single (project, model, day) token total pulled from CloudWatch. */
export interface MantleMetricPoint {
  projectId: string;
  modelId: string;
  usageDay: UsageDay;
  totalInputTokens: number;
  totalOutputTokens: number;
}

/** A Mantle usage record attributed to a Team, ready to persist. */
export interface MantleUsageRecord {
  team: Team;
  modelId: string;
  usageDay: UsageDay;
  inputTokens: number;
  outputTokens: number;
}

/** Default retention for Mantle usage records (matches Converse: 90 days). */
const USAGE_AGGREGATION_MIN_RETENTION_DAYS = 90;

/**
 * Attributes raw per-project metric points to teams using the
 * project -> team lookup. A project with no mapping is attributed to the
 * `UNMAPPED` sentinel team rather than dropped, so usage (and therefore
 * cost) is never silently lost (NFR-2.7 fail-closed; FR-3.4 default-project
 * misconfiguration still surfaces as UNMAPPED rather than vanishing).
 */
export function attributeMantleUsage(
  points: MantleMetricPoint[],
  projectToTeam: Map<string, Team>
): MantleUsageRecord[] {
  return points.map((p) => ({
    team: projectToTeam.get(p.projectId) ?? UNMAPPED_ROLE,
    modelId: p.modelId,
    usageDay: p.usageDay,
    inputTokens: p.totalInputTokens,
    outputTokens: p.totalOutputTokens,
  }));
}

function buildPartitionKey(team: Team, modelId: string): string {
  return `TEAM#${team}#MODEL#${modelId}`;
}

function buildSortKey(usageDay: UsageDay): string {
  return `DAY#${usageDay}`;
}

export interface WriteMantleUsageOptions {
  usageAggregationTableName: string;
  now?: () => Date;
}

/**
 * Persists a Mantle usage record into the shared Usage_Aggregation table as
 * ABSOLUTE daily totals (SET), tagged with `endpoint = bedrock-mantle`.
 * Idempotent: writing the same (team, model, day) again overwrites rather
 * than accumulates.
 */
export async function writeMantleUsage(
  record: MantleUsageRecord,
  options: WriteMantleUsageOptions
): Promise<void> {
  const now = (options.now ?? (() => new Date()))();

  await updateItem({
    TableName: options.usageAggregationTableName,
    Key: {
      PK: buildPartitionKey(record.team, record.modelId),
      SK: buildSortKey(record.usageDay),
    },
    // SET (absolute), not ADD: Mantle metrics give the day's running total,
    // so each pull overwrites. `runningTotalTokens` kept in sync for the
    // enforcement breach decision (input + output).
    UpdateExpression:
      'SET #usageDay = :usageDay, #team = :team, #model = :model, #endpoint = :endpoint, #lastUpdatedAt = :now, #ttl = :ttl, ' +
      '#runningTotalTokens = :runningTotal, #inputTokens = :inputTokens, #outputTokens = :outputTokens',
    ExpressionAttributeNames: {
      '#usageDay': 'usageDay',
      '#team': 'team',
      '#model': 'model',
      '#endpoint': 'endpoint',
      '#lastUpdatedAt': 'lastUpdatedAt',
      '#ttl': 'ttl',
      '#runningTotalTokens': 'runningTotalTokens',
      '#inputTokens': 'inputTokens',
      '#outputTokens': 'outputTokens',
    },
    ExpressionAttributeValues: {
      ':usageDay': record.usageDay,
      ':team': record.team,
      ':model': record.modelId,
      ':endpoint': Endpoint.BedrockMantle,
      ':now': now.toISOString(),
      ':ttl': computeTtl(record.usageDay, USAGE_AGGREGATION_MIN_RETENTION_DAYS),
      ':runningTotal': record.inputTokens + record.outputTokens,
      ':inputTokens': record.inputTokens,
      ':outputTokens': record.outputTokens,
    },
  });
}

export interface CollectMantleUsageOptions extends WriteMantleUsageOptions {
  projectToTeam: Map<string, Team>;
}

/**
 * Orchestrates attribution + persistence for a batch of metric points.
 * Returns the attributed records (useful for tests and logging).
 */
export async function collectMantleUsage(
  points: MantleMetricPoint[],
  options: CollectMantleUsageOptions
): Promise<MantleUsageRecord[]> {
  const records = attributeMantleUsage(points, options.projectToTeam);
  for (const record of records) {
    await writeMantleUsage(record, options);
  }
  return records;
}
