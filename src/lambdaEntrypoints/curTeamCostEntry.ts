/**
 * Lambda entry-point: CUR 2.0 Per-Team Billed Cost (scheduled).
 *
 * Queries CUR 2.0 via Athena for per-team Bedrock billed cost, using the
 * `team` cost-allocation tag (IAM principal tag on the calling role). Writes
 * the result to the analytics S3 bucket under `cur-team-cost/dt=<day>/` so
 * it's queryable via Athena/QuickSight.
 *
 * This is the ONLY source of dollar-denominated cost in the system. The
 * token pipeline (Usage_Aggregation) tracks tokens for enforcement; this
 * Lambda provides the actual billed dollars from the AWS bill.
 */
import { executeAthenaQuery, AthenaRow } from '../clients/athenaClient';
import { putObject } from '../clients/s3Client';
import { ENV_VAR_NAMES, optionalEnv, requiredEnv } from '../envConfig';
import {
  billingPeriodForDate,
  buildPerTeamCostQuery,
} from '../cur/curAthenaQueries';
import { parseUsageType } from '../cur/curUsageTypeParser';
import { usageAmountToTokens } from '../cur/curTokenUnits';
import { buildExportKey, serializeJsonl } from '../analyticsExport';

interface PerTeamCurRow {
  team: string;
  model: string;
  endpoint: string;
  tokenType: string;
  billedCost: number;
  tokenCount: number;
}

function parsePerTeamRows(rows: AthenaRow[]): PerTeamCurRow[] {
  const result: PerTeamCurRow[] = [];
  for (const r of rows) {
    const team = r.team || 'UNTAGGED';
    const parsed = parseUsageType(r.line_item_usage_type ?? '');
    if (!parsed) continue;
    result.push({
      team,
      model: parsed.curModelName,
      endpoint: parsed.endpoint,
      tokenType: parsed.tokenType,
      billedCost: parseFloat(r.total_unblended_cost ?? '0'),
      // CUR reports usage in the row's pricing_unit ("1K tokens"); convert to
      // absolute tokens and round so the Glue bigint column keeps the value.
      tokenCount: Math.round(
        usageAmountToTokens(parseFloat(r.total_usage_amount ?? '0'), r.pricing_unit)
      ),
    });
  }
  return result;
}

/** Per-team cost export row (written to S3 for Athena/QuickSight). */
interface TeamCostExportRow {
  team: string;
  model: string;
  endpoint: string;
  billedCost: number;
  totalTokens: number;
  currency: 'USD';
  billingPeriod: string;
}

/** Aggregate per-team rows into (team, model, endpoint) → billedCost + tokens. */
function aggregatePerTeamCost(rows: PerTeamCurRow[], billingPeriod: string): TeamCostExportRow[] {
  const map = new Map<string, TeamCostExportRow>();
  for (const r of rows) {
    const key = `${r.team}|${r.model}|${r.endpoint}`;
    const existing = map.get(key);
    if (existing) {
      existing.billedCost += r.billedCost;
      existing.totalTokens += r.tokenCount;
    } else {
      map.set(key, {
        team: r.team,
        model: r.model,
        endpoint: r.endpoint,
        billedCost: r.billedCost,
        totalTokens: r.tokenCount,
        currency: 'USD',
        billingPeriod,
      });
    }
  }
  return [...map.values()].sort((a, b) =>
    a.team.localeCompare(b.team) || a.model.localeCompare(b.model)
  );
}

export async function handler(): Promise<void> {
  const curDatabase = requiredEnv(ENV_VAR_NAMES.CUR_DATABASE_NAME);
  const curTableName = requiredEnv(ENV_VAR_NAMES.CUR_TABLE_NAME);
  const workGroup = requiredEnv(ENV_VAR_NAMES.CUR_ATHENA_WORKGROUP);
  const bucketName = requiredEnv(ENV_VAR_NAMES.ANALYTICS_EXPORT_BUCKET_NAME);
  const teamTagKey = optionalEnv(ENV_VAR_NAMES.CUR_TEAM_TAG_KEY) ?? 'team';

  const curTable = `${curDatabase}.${curTableName}`;
  const now = new Date();
  const billingPeriod = billingPeriodForDate(now);
  const today = now.toISOString().slice(0, 10);

  console.log(`CUR per-team cost: querying ${curTable} for billing_period=${billingPeriod}, tag=${teamTagKey}`);

  const teamSql = buildPerTeamCostQuery(curTable, billingPeriod, teamTagKey);
  const teamAthenaRows = await executeAthenaQuery(teamSql, { workGroup, timeoutSeconds: 120 });
  const perTeamRows = parsePerTeamRows(teamAthenaRows);
  const aggregated = aggregatePerTeamCost(perTeamRows, billingPeriod);

  if (aggregated.length > 0) {
    await putObject({
      Bucket: bucketName,
      Key: buildExportKey('cur-team-cost', today),
      Body: serializeJsonl(aggregated),
      ContentType: 'application/x-ndjson',
    });
    console.log(`Per-team CUR cost: ${aggregated.length} rows written to cur-team-cost/dt=${today}/`);
  } else {
    console.log('No per-team CUR cost data (team tag may not be activated as a cost allocation tag)');
  }
}
