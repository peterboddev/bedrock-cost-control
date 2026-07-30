/**
 * Reads the bedrock-team-token-quota stack's CloudFormation outputs (see
 * infra/stack.ts's "Stack outputs" section), so the interactive CLI test
 * tool never has to hardcode table names, function names, or ARNs -
 * everything it needs is discovered from the deployed stack itself.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export interface StackOutputs {
  testRoleArn: string;
  testRoleTeam: string;
  usageAggregationTableName: string;
  quotaConfigurationTableName: string;
  blockedStateTableName: string;
  auditLogTableName: string;
  adminApiFunctionName: string;
  modelInvocationLogBucketName: string;
}

const OUTPUT_KEY_MAP: Record<keyof StackOutputs, string> = {
  testRoleArn: 'TestRoleArnOutput',
  testRoleTeam: 'TestRoleTeamOutput',
  usageAggregationTableName: 'UsageAggregationTableNameOutput',
  quotaConfigurationTableName: 'QuotaConfigurationTableNameOutput',
  blockedStateTableName: 'BlockedStateTableNameOutput',
  auditLogTableName: 'AuditLogTableNameOutput',
  adminApiFunctionName: 'AdminApiFunctionNameOutput',
  modelInvocationLogBucketName: 'ModelInvocationLogBucketNameOutput',
};

/**
 * Fetches and maps every output this test tool needs from the given
 * CloudFormation stack. Throws a descriptive error naming any output that
 * is missing, rather than silently proceeding with `undefined` values.
 */
export async function getStackOutputs(
  stackName: string,
  region?: string
): Promise<StackOutputs> {
  const client = new CloudFormationClient({ region });
  const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));

  const stack = response.Stacks?.[0];
  if (!stack) {
    throw new Error(`Stack not found: ${stackName}`);
  }

  const outputsByKey = new Map((stack.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));

  const result: Partial<StackOutputs> = {};
  const missing: string[] = [];

  for (const [field, outputKey] of Object.entries(OUTPUT_KEY_MAP) as Array<
    [keyof StackOutputs, string]
  >) {
    const value = outputsByKey.get(outputKey);
    if (value === undefined) {
      missing.push(outputKey);
    } else {
      result[field] = value;
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Stack "${stackName}" is missing expected outputs: ${missing.join(', ')}. Has the stack been deployed with the latest infra/stack.ts?`
    );
  }

  return result as StackOutputs;
}
