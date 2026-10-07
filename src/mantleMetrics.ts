/**
 * Pure helpers to build `GetMetricData` queries for the `AWS/BedrockMantle`
 * namespace and parse the results into {@link MantleMetricPoint}s
 * (requirements.md FR-3.2). Kept SDK-call-free so it is fully unit-testable;
 * the actual CloudWatch call lives in the collector entrypoint.
 */
import type { MetricDataQuery, MetricDataResult } from '@aws-sdk/client-cloudwatch';

import { MantleMetricPoint } from './mantleUsageCollector';
import { UsageDay } from './types';

export const MANTLE_NAMESPACE = 'AWS/BedrockMantle';
export const METRIC_TOTAL_INPUT_TOKENS = 'TotalInputTokens';
export const METRIC_TOTAL_OUTPUT_TOKENS = 'TotalOutputTokens';

const DAY_SECONDS = 24 * 60 * 60;

/** One (project, model) pair to query usage for. */
export interface MantleMetricQuerySpec {
  projectId: string;
  modelId: string;
}

interface QueryIndexEntry {
  projectId: string;
  modelId: string;
  tokenType: 'input' | 'output';
}

export interface BuiltMantleQueries {
  queries: MetricDataQuery[];
  index: Map<string, QueryIndexEntry>;
  startTime: Date;
  endTime: Date;
}

/** The UTC start instant (00:00:00Z) for a usage day. */
export function usageDayStart(usageDay: UsageDay): Date {
  return new Date(`${usageDay}T00:00:00.000Z`);
}

/** The UTC end instant (exclusive, start of next day) for a usage day. */
export function usageDayEnd(usageDay: UsageDay): Date {
  return new Date(usageDayStart(usageDay).getTime() + DAY_SECONDS * 1000);
}

/**
 * Builds the GetMetricData queries for the given (project, model) specs on a
 * single usage day — two queries per spec (input + output), Stat=Sum,
 * Period = whole day. Query ids are deterministic (`m<index>i` / `m<index>o`)
 * and mapped back to their spec via the returned index.
 */
export function buildMantleMetricQueries(
  specs: MantleMetricQuerySpec[],
  usageDay: UsageDay
): BuiltMantleQueries {
  const queries: MetricDataQuery[] = [];
  const index = new Map<string, QueryIndexEntry>();

  specs.forEach((spec, i) => {
    const inputId = `m${i}i`;
    const outputId = `m${i}o`;
    index.set(inputId, { projectId: spec.projectId, modelId: spec.modelId, tokenType: 'input' });
    index.set(outputId, { projectId: spec.projectId, modelId: spec.modelId, tokenType: 'output' });

    const dimensions = [
      { Name: 'Project', Value: spec.projectId },
      { Name: 'ModelId', Value: spec.modelId },
    ];

    queries.push({
      Id: inputId,
      MetricStat: {
        Metric: { Namespace: MANTLE_NAMESPACE, MetricName: METRIC_TOTAL_INPUT_TOKENS, Dimensions: dimensions },
        Period: DAY_SECONDS,
        Stat: 'Sum',
      },
      ReturnData: true,
    });
    queries.push({
      Id: outputId,
      MetricStat: {
        Metric: { Namespace: MANTLE_NAMESPACE, MetricName: METRIC_TOTAL_OUTPUT_TOKENS, Dimensions: dimensions },
        Period: DAY_SECONDS,
        Stat: 'Sum',
      },
      ReturnData: true,
    });
  });

  return { queries, index, startTime: usageDayStart(usageDay), endTime: usageDayEnd(usageDay) };
}

function sumValues(values: number[] | undefined): number {
  return (values ?? []).reduce((a, b) => a + b, 0);
}

/**
 * Parses GetMetricData results back into per-(project, model) usage points
 * for the given day. Projects/models with no datapoints are omitted.
 */
export function parseMantleMetricResults(
  results: MetricDataResult[],
  index: Map<string, QueryIndexEntry>,
  usageDay: UsageDay
): MantleMetricPoint[] {
  // Accumulate per (project, model).
  const byKey = new Map<string, MantleMetricPoint>();

  for (const result of results) {
    const id = result.Id;
    if (!id) {
      continue;
    }
    const entry = index.get(id);
    if (!entry) {
      continue;
    }
    const total = sumValues(result.Values as number[] | undefined);
    const key = `${entry.projectId}\u0000${entry.modelId}`;
    const point =
      byKey.get(key) ??
      {
        projectId: entry.projectId,
        modelId: entry.modelId,
        usageDay,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      };
    if (entry.tokenType === 'input') {
      point.totalInputTokens += total;
    } else {
      point.totalOutputTokens += total;
    }
    byKey.set(key, point);
  }

  // Drop points with zero usage on both axes (no activity that day).
  return [...byKey.values()].filter(
    (p) => p.totalInputTokens > 0 || p.totalOutputTokens > 0
  );
}
