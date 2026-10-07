/**
 * Analytics export (requirements.md FR-7.1): shapes token-usage data into
 * flat, partitioned rows written to S3 as newline-delimited JSON for Athena
 * to query and QuickSight to visualize.
 *
 * Cost is NOT derived here. Cost comes from CUR 2.0 (billed dollars per
 * team, straight from the AWS bill). This export covers token usage for
 * enforcement monitoring and the enforcement-audit / blocked-state views.
 */
import { ModelRegistry } from './pricing/modelRegistry';
import { Endpoint } from './pricing/types';
import { Team, UsageDay } from './types';

/** A Usage_Aggregation item as stored (per-token-type counters + endpoint). */
export interface UsageAggregationItem {
  team: Team;
  model: string;
  usageDay: UsageDay;
  endpoint?: Endpoint;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** A flat token-usage row (one per team/model/day/endpoint) for Athena/QuickSight. */
export interface UsageTokenRow {
  team: Team;
  model: string;
  usageDay: UsageDay;
  endpoint: Endpoint;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface BuildRowOptions {
  /** Resolves a model's endpoint when the item itself does not carry one (legacy items). */
  registry?: ModelRegistry;
}

function resolveEndpoint(item: UsageAggregationItem, registry?: ModelRegistry): Endpoint {
  if (item.endpoint) {
    return item.endpoint;
  }
  return registry?.endpointFor(item.model) ?? Endpoint.BedrockRuntime;
}

/**
 * Builds a token-usage analytics row from a usage item. No pricing — cost
 * comes from CUR 2.0 separately.
 */
export function buildUsageTokenRow(item: UsageAggregationItem, options: BuildRowOptions): UsageTokenRow {
  const inputTokens = item.inputTokens ?? 0;
  const outputTokens = item.outputTokens ?? 0;
  const cacheReadTokens = item.cacheReadTokens ?? 0;
  const cacheWriteTokens = item.cacheWriteTokens ?? 0;

  return {
    team: item.team,
    model: item.model,
    usageDay: item.usageDay,
    endpoint: resolveEndpoint(item, options.registry),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  };
}

/** Serializes any array of flat rows as newline-delimited JSON for Athena. */
export function serializeJsonl(rows: object[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n');
}

/** A flat enforcement-audit row for the admin "recent enforcement activity" view. */
export interface EnforcementAuditRow {
  team: Team;
  model: string;
  roleArn: string;
  action: string;
  runningTotalTokens: number;
  dailyTokenQuota: number | null;
  timestamp: string;
}

/** A flat currently-blocked row for the admin "currently blocked" view. */
export interface BlockedStateRow {
  team: Team;
  model: string;
  status: string;
  endpoint: string;
  blockedUsageDay: string;
  blockedAt: string;
}

/**
 * Builds the Hive-style partitioned S3 key for a day's export, e.g.
 * `token-usage/dt=2025-01-15/part-0.json`. Partitioning by `dt` lets Athena
 * prune by date efficiently.
 */
export function buildExportKey(prefix: string, usageDay: UsageDay, part = 0): string {
  const cleanPrefix = prefix.replace(/\/+$/, '');
  return `${cleanPrefix}/dt=${usageDay}/part-${part}.json`;
}
