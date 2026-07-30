/**
 * Polls the deployed Usage_Aggregation and Blocked_State tables directly
 * (reusing the same read functions the production Lambdas use, so the test
 * tool is reading through the exact same code path - never a
 * hand-rolled duplicate query) to show the operator live progress toward
 * the quota and whether/when enforcement has kicked in.
 *
 * Runs under the *operator's* own AWS credentials (whoever is running the
 * CLI tool), not the assumed Bedrock_Test_Role - the test role is
 * deliberately scoped to Bedrock invocation only and has no DynamoDB read
 * access (see infra/stack.ts's Bedrock_Test_Role least-privilege comment).
 */
import { getRunningTotal } from '../../src/usageAggregation';
import { getBlockedState } from '../../src/quotaEnforcer';
import { Model, Team, UsageDay } from '../../src/types';

export function computeCurrentUsageDay(): UsageDay {
  return new Date().toISOString().slice(0, 10);
}

export interface UsageStatus {
  runningTotalTokens: number;
  isBlocked: boolean;
}

export async function getUsageStatus(
  team: Team,
  model: Model,
  usageAggregationTableName: string,
  blockedStateTableName: string
): Promise<UsageStatus> {
  const usageDay = computeCurrentUsageDay();

  const [runningTotalTokens, blockedState] = await Promise.all([
    getRunningTotal(team, model, usageDay, { tableName: usageAggregationTableName }),
    getBlockedState(team, model, blockedStateTableName),
  ]);

  return {
    runningTotalTokens,
    isBlocked: blockedState?.status === 'BLOCKED',
  };
}
