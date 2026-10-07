/**
 * Lambda entry-point adapter for the analytics/token-usage export
 * (requirements.md FR-7.1). Wired to an EventBridge schedule. For each
 * target usage day it:
 *
 *  1. queries the Usage_Aggregation table's UsageDayIndex GSI for every
 *     (team, model) bucket on that day (a bounded single-partition Query,
 *     never a Scan),
 *  2. writes token-usage rows as newline-delimited JSON to the analytics S3
 *     bucket under a Hive-partitioned `dt=<day>` prefix for Athena/QuickSight.
 *
 * Cost is NOT computed here — cost comes from CUR 2.0 (actual billed
 * dollars per team). This export covers token usage plus the enforcement-
 * audit and currently-blocked views.
 */
import {
  BlockedStateRow,
  EnforcementAuditRow,
  UsageAggregationItem,
  buildExportKey,
  buildUsageTokenRow,
  serializeJsonl,
} from '../analyticsExport';
import { listAuditEntriesByDay } from '../auditLog';
import { listAllActiveBlocks } from '../blockedStateQuery';
import { query } from '../clients/dynamoDbClient';
import { putObject } from '../clients/s3Client';
import { ENV_VAR_NAMES, optionalEnv, requiredEnv } from '../envConfig';
import { loadModelRegistry } from '../pricing/modelRegistryStore';
import { UsageDay } from '../types';

function usageDay(date: Date): UsageDay {
  return date.toISOString().slice(0, 10);
}

function targetUsageDays(now: Date): UsageDay[] {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return [usageDay(yesterday), usageDay(now)];
}

async function queryDayBuckets(
  tableName: string,
  indexName: string,
  day: UsageDay
): Promise<UsageAggregationItem[]> {
  const items: UsageAggregationItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const response = await query({
      TableName: tableName,
      IndexName: indexName,
      KeyConditionExpression: '#usageDay = :day',
      ExpressionAttributeNames: { '#usageDay': 'usageDay' },
      ExpressionAttributeValues: { ':day': day },
      ExclusiveStartKey: exclusiveStartKey,
    });
    for (const item of (response.Items ?? []) as UsageAggregationItem[]) {
      items.push(item);
    }
    exclusiveStartKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return items;
}

export async function handler(): Promise<void> {
  const usageAggregationTableName = requiredEnv(ENV_VAR_NAMES.USAGE_AGGREGATION_TABLE_NAME);
  const usageDayIndexName = requiredEnv(ENV_VAR_NAMES.USAGE_DAY_INDEX_NAME);
  const modelRegistryTableName = requiredEnv(ENV_VAR_NAMES.MODEL_REGISTRY_TABLE_NAME);
  const bucketName = requiredEnv(ENV_VAR_NAMES.ANALYTICS_EXPORT_BUCKET_NAME);
  const prefix = optionalEnv(ENV_VAR_NAMES.ANALYTICS_EXPORT_PREFIX) ?? 'token-usage';
  const auditLogTableName = requiredEnv(ENV_VAR_NAMES.AUDIT_LOG_TABLE_NAME);
  const auditDayIndexName = requiredEnv(ENV_VAR_NAMES.AUDIT_DAY_INDEX_NAME);
  const blockedStateTableName = requiredEnv(ENV_VAR_NAMES.BLOCKED_STATE_TABLE_NAME);
  const blockedStatusIndexName = requiredEnv(ENV_VAR_NAMES.BLOCKED_STATUS_INDEX_NAME);

  const registry = await loadModelRegistry({ tableName: modelRegistryTableName });

  const days = targetUsageDays(new Date());

  // 1. Token-usage rows (per team/model/day/endpoint).
  for (const day of days) {
    const items = await queryDayBuckets(usageAggregationTableName, usageDayIndexName, day);
    if (items.length === 0) {
      continue;
    }
    const rows = items.map((item) => buildUsageTokenRow(item, { registry }));
    await putObject({
      Bucket: bucketName,
      Key: buildExportKey(prefix, day),
      Body: serializeJsonl(rows),
      ContentType: 'application/x-ndjson',
    });
  }

  // 2. Enforcement audit activity (ATTACH_DENY/REMOVE_DENY etc.) per day,
  //    across all teams, for the admin enforcement view.
  for (const day of days) {
    const entries = await listAuditEntriesByDay(day, {
      tableName: auditLogTableName,
      indexName: auditDayIndexName,
    });
    if (entries.length === 0) {
      continue;
    }
    const rows: EnforcementAuditRow[] = entries.map((e) => ({
      team: e.team,
      model: e.model,
      roleArn: e.roleArn,
      action: e.action,
      runningTotalTokens: e.runningTotalTokens,
      dailyTokenQuota: e.dailyTokenQuota,
      timestamp: e.timestamp,
    }));
    await putObject({
      Bucket: bucketName,
      Key: buildExportKey('enforcement-audit', day),
      Body: serializeJsonl(rows),
      ContentType: 'application/x-ndjson',
    });
  }

  // 3. Currently-blocked snapshot (all teams), written under today's
  //    partition so the admin "currently blocked" view reflects live state.
  const activeBlocks = await listAllActiveBlocks({
    tableName: blockedStateTableName,
    indexName: blockedStatusIndexName,
  });
  const today = days[days.length - 1];
  const blockedRows: BlockedStateRow[] = activeBlocks.map((b) => ({
    team: b.team,
    model: b.model,
    status: b.status,
    endpoint: b.endpoint,
    blockedUsageDay: b.blockedUsageDay,
    blockedAt: b.blockedAt,
  }));
  await putObject({
    Bucket: bucketName,
    Key: buildExportKey('blocked-state', today),
    Body: serializeJsonl(blockedRows),
    ContentType: 'application/x-ndjson',
  });
}
