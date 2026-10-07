/**
 * Lambda entry-point adapter for the Mantle usage collector (requirements.md
 * FR-3). Wired to an EventBridge schedule. On each run it:
 *
 *  1. loads the team<->Mantle-project mappings,
 *  2. loads the Mantle models from the model registry,
 *  3. pulls `AWS/BedrockMantle` TotalInputTokens/TotalOutputTokens by
 *     (Project, ModelId) for the target usage day(s) via GetMetricData,
 *  4. attributes them to teams and writes absolute daily totals into the
 *     shared Usage_Aggregation table (endpoint = bedrock-mantle).
 *
 * It processes both "today" and "yesterday" so late-arriving metric
 * datapoints near the UTC day boundary are not missed; the SET-based write
 * makes re-processing a day idempotent.
 */
import { getMetricData } from '../clients/cloudWatchClient';
import { collectMantleUsage } from '../mantleUsageCollector';
import {
  MantleMetricQuerySpec,
  buildMantleMetricQueries,
  parseMantleMetricResults,
} from '../mantleMetrics';
import { Endpoint } from '../pricing/types';
import { loadModelRegistry } from '../pricing/modelRegistryStore';
import { ENV_VAR_NAMES, requiredEnv } from '../envConfig';
import { listTeamProjectMappings, toProjectTeamLookup } from '../teamProjectMapping';
import { UsageDay } from '../types';

function usageDay(date: Date): UsageDay {
  return date.toISOString().slice(0, 10);
}

function targetUsageDays(now: Date): UsageDay[] {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return [usageDay(yesterday), usageDay(now)];
}

export async function handler(): Promise<void> {
  const usageAggregationTableName = requiredEnv(ENV_VAR_NAMES.USAGE_AGGREGATION_TABLE_NAME);
  const teamProjectMappingTableName = requiredEnv(ENV_VAR_NAMES.TEAM_PROJECT_MAPPING_TABLE_NAME);
  const modelRegistryTableName = requiredEnv(ENV_VAR_NAMES.MODEL_REGISTRY_TABLE_NAME);

  const mappings = await listTeamProjectMappings({ tableName: teamProjectMappingTableName });
  if (mappings.length === 0) {
    return;
  }
  const projectToTeam = toProjectTeamLookup(mappings);

  const registry = await loadModelRegistry({ tableName: modelRegistryTableName });
  const mantleModels = registry.list().filter((m) => m.endpoint === Endpoint.BedrockMantle);
  if (mantleModels.length === 0) {
    return;
  }

  // One (project, model) spec per combination of mapped project and Mantle model.
  const specs: MantleMetricQuerySpec[] = [];
  for (const mapping of mappings) {
    for (const model of mantleModels) {
      specs.push({ projectId: mapping.projectId, modelId: model.modelId });
    }
  }

  for (const day of targetUsageDays(new Date())) {
    const { queries, index, startTime, endTime } = buildMantleMetricQueries(specs, day);

    // GetMetricData accepts up to 500 queries per call; chunk to stay within limits.
    const CHUNK = 450;
    const allResults = [];
    for (let i = 0; i < queries.length; i += CHUNK) {
      const chunk = queries.slice(i, i + CHUNK);
      let nextToken: string | undefined;
      do {
        const response = await getMetricData({
          MetricDataQueries: chunk,
          StartTime: startTime,
          EndTime: endTime,
          NextToken: nextToken,
        });
        allResults.push(...(response.MetricDataResults ?? []));
        nextToken = response.NextToken;
      } while (nextToken);
    }

    const points = parseMantleMetricResults(allResults, index, day);
    if (points.length > 0) {
      await collectMantleUsage(points, { projectToTeam, usageAggregationTableName });
    }
  }
}
