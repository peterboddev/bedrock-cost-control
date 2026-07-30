#!/usr/bin/env ts-node
/**
 * Interactive CLI test tool for the bedrock-team-token-quota system.
 *
 * See README.md's "Testing end to end" section for the full walkthrough.
 * In short, this tool:
 *
 *   1. Asks for (or defaults) the Team, Model, and Daily_Token_Quota to test.
 *   2. Writes that quota via the deployed Admin API Lambda.
 *   3. Assumes the deployed Bedrock_Test_Role (sts:AssumeRole) - a role
 *      tagged with the same Team, and scoped to Bedrock invocation only.
 *   4. Sends real Bedrock Converse invocations through the assumed role,
 *      one at a time, on your confirmation.
 *   5. After each invocation, polls the deployed Usage_Aggregation and
 *      Blocked_State tables (the same read paths the production Lambdas
 *      use) and reports the running total and whether enforcement has
 *      kicked in yet, explaining the expected end-to-end latency.
 *   6. Once blocked, offers to send one more invocation so you can watch
 *      it fail with AccessDeniedException - proof the IAM deny policy is
 *      actually in effect - and offers to fetch the Audit_Log trail.
 *
 * Run via: npm run test:tokens
 */
import { getStackOutputs, StackOutputs } from './stackOutputs';
import { createPrompter } from './promptHelpers';
import { invokeAdminApi } from './adminApiClient';
import { assumeTestRole } from './assumeRole';
import { buildBedrockRuntimeClient, invokeOnce } from './bedrockInvoker';
import { getUsageStatus } from './pollStatus';

const DEFAULT_STACK_NAME = 'BedrockTeamTokenQuotaStack';
const DEFAULT_REGION = process.env.AWS_REGION ?? 'us-east-1';
const DEFAULT_MODEL_ID = 'amazon.nova-lite-v1:0';
const DEFAULT_DAILY_QUOTA = 500;

const TEST_PROMPT =
  'Write a short, three-paragraph explanation of how token-based rate ' +
  'limiting works for large language model APIs, including why input and ' +
  'output tokens are both counted, and why a sliding daily window is a ' +
  'common design choice. Be thorough and use complete sentences.';

function printHeader(title: string): void {
  console.log('');
  console.log('='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
}

function printExplainerOnce(): void {
  printHeader('bedrock-team-token-quota interactive test tool');
  console.log(
    [
      'This tool sends REAL Amazon Bedrock invocations through a dedicated',
      'test IAM role, then watches the deployed pipeline turn those',
      'invocations into DynamoDB counters and, once the configured quota is',
      'exceeded, an IAM deny policy that blocks further calls.',
      '',
      'IMPORTANT - end-to-end latency: Bedrock Model Invocation Logging',
      'delivers log files to S3 in batches (not instantly), and the',
      'pipeline is designed for eventual freshness within about 5 minutes',
      'per stage (log delivery -> Usage_Collector -> aggregation ->',
      'Quota_Enforcer -> IAM policy change), so it can take up to roughly',
      '10-15 minutes after an invocation before the running total updates',
      'and up to a few minutes more before a block takes effect. This tool',
      'polls for you and explains what it is waiting for at each step -',
      'this is expected behavior, not a bug.',
    ].join('\n')
  );
}

async function main(): Promise<void> {
  printExplainerOnce();
  const prompter = createPrompter();

  try {
    const stackName = await prompter.askWithDefault(
      '\nCloudFormation stack name',
      DEFAULT_STACK_NAME
    );
    const region = await prompter.askWithDefault('AWS region the stack is deployed in', DEFAULT_REGION);

    console.log(`\nLooking up stack outputs for "${stackName}" in ${region}...`);
    const outputs: StackOutputs = await getStackOutputs(stackName, region);
    console.log(`Found Bedrock_Test_Role: ${outputs.testRoleArn}`);
    console.log(`Test role's Team tag value: ${outputs.testRoleTeam}`);

    const team = await prompter.askWithDefault('Team to test (must match a Team_Tag_Key value)', outputs.testRoleTeam);
    const model = await prompter.askWithDefault('Bedrock model ID to invoke', DEFAULT_MODEL_ID);
    const dailyTokenQuota = await prompter.askNumber(
      'Daily token quota to enforce for this Team + Model (input + output tokens combined)',
      DEFAULT_DAILY_QUOTA
    );

    printHeader('Step 1: Configure the quota');
    console.log(`Setting Daily_Token_Quota = ${dailyTokenQuota} for team="${team}", model="${model}"...`);
    const putQuotaResult = await invokeAdminApi(outputs.adminApiFunctionName, region, 'putQuota', {
      team,
      model,
      dailyTokenQuota,
      updatedBy: 'test-tool',
    });
    if (!putQuotaResult.ok) {
      throw new Error(`Failed to set quota: ${putQuotaResult.error}`);
    }
    console.log('Quota configured. (Takes effect on the very next usage evaluation - no caching.)');

    printHeader('Step 2: Assume the Bedrock_Test_Role');
    console.log(`Assuming ${outputs.testRoleArn} via sts:AssumeRole...`);
    const credentials = await assumeTestRole(outputs.testRoleArn, region);
    console.log(
      `Assumed role successfully. Session expires: ${credentials.expiration?.toISOString() ?? 'unknown'}`
    );
    const bedrockClient = buildBedrockRuntimeClient(credentials, region);

    printHeader('Step 3: Send invocations');
    console.log(
      [
        'Each confirmed invocation sends one Converse call through the',
        'assumed test role. The tool reports the tokens Bedrock says were',
        'used immediately - but that number will not appear in the',
        'Usage_Aggregation table (or affect enforcement) until the log',
        'pipeline catches up, per the latency note above.',
      ].join('\n')
    );

    console.log(`\nChecking the running total already on record for team="${team}", model="${model}"...`);
    const startingStatus = await getUsageStatus(
      team,
      model,
      outputs.usageAggregationTableName,
      outputs.blockedStateTableName
    );
    console.log(
      `  Already recorded in Usage_Aggregation: ${startingStatus.runningTotalTokens} / ${dailyTokenQuota} tokens. Blocked: ${startingStatus.isBlocked}`
    );
    if (startingStatus.runningTotalTokens > 0) {
      console.log(
        '  (This reflects usage from a PRIOR run today, if any - not just what this session sends.)'
      );
    }

    let blockedObserved = startingStatus.isBlocked;
    let invocationCount = 0;
    let sessionTokensSent = 0;

    while (!blockedObserved) {
      const shouldSend = await prompter.confirm(
        `\nSend invocation #${invocationCount + 1} to ${model}?`
      );
      if (!shouldSend) {
        break;
      }

      try {
        const result = await invokeOnce(bedrockClient, model, TEST_PROMPT);
        invocationCount += 1;
        sessionTokensSent += result.totalTokens;
        console.log(
          `  -> Bedrock reported: ${result.inputTokens} input + ${result.outputTokens} output = ${result.totalTokens} total tokens`
        );
        console.log(`  -> Response preview: "${result.outputPreview}..."`);
        const projectedTotal = startingStatus.runningTotalTokens + sessionTokensSent;
        const projectedPct = dailyTokenQuota > 0 ? Math.round((projectedTotal / dailyTokenQuota) * 100) : 0;
        console.log(
          `  -> Session so far: ${sessionTokensSent} tokens sent across ${invocationCount} invocation(s).`
        );
        console.log(
          `  -> Projected total once the log lands in DynamoDB: ~${projectedTotal} / ${dailyTokenQuota} tokens (${projectedPct}%) ` +
            `- this is an ESTIMATE (recorded total + tokens sent this session); the actual Usage_Aggregation value updates ` +
            `only after Model Invocation Logging delivers the log and Usage_Collector processes it.`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('AccessDenied') || message.includes('not authorized')) {
          console.log('  -> DENIED. The Model_Deny_Policy is active - this Team is blocked from this Model.');
          blockedObserved = true;
          break;
        }
        console.log(`  -> Invocation failed: ${message}`);
        continue;
      }

      const shouldCheck = await prompter.confirm('Check current running total and block status now?');
      if (shouldCheck) {
        const stillBlocked = await pollUntilOperatorIsSatisfied(
          prompter,
          team,
          model,
          outputs,
          dailyTokenQuota
        );
        if (stillBlocked) {
          blockedObserved = true;
        }
      }
    }

    if (!blockedObserved) {
      const wasBlocked = await checkBlockedNow(team, model, outputs);
      blockedObserved = wasBlocked;
    }

    if (blockedObserved) {
      printHeader('Step 4: Confirm enforcement (optional)');
      const tryAnother = await prompter.confirm(
        'Send one more invocation now to confirm it is actually denied?'
      );
      if (tryAnother) {
        try {
          await invokeOnce(bedrockClient, model, TEST_PROMPT);
          console.log('  -> Unexpected: call succeeded. Enforcement may not have propagated yet - try again shortly.');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`  -> Call failed as expected: ${message}`);
        }
      }

      const wantAudit = await prompter.confirm('Fetch Audit_Log entries for this Team now?');
      if (wantAudit) {
        await printAuditLog(team, outputs, region);
      }

      console.log(
        '\nAccess will automatically restore at 00:00 UTC (Daily_Reset), or you can run the ' +
          'manual override documented in README.md ("removeDenyPolicy") to restore it sooner.'
      );
    } else {
      console.log('\nNo block observed. Increase the quota or send more invocations to test enforcement.');
    }
  } finally {
    prompter.close();
  }
}

async function checkBlockedNow(
  team: string,
  model: string,
  outputs: StackOutputs
): Promise<boolean> {
  const status = await getUsageStatus(
    team,
    model,
    outputs.usageAggregationTableName,
    outputs.blockedStateTableName
  );
  console.log(`\nCurrent running total: ${status.runningTotalTokens} tokens. Blocked: ${status.isBlocked}`);
  return status.isBlocked;
}

async function pollUntilOperatorIsSatisfied(
  prompter: ReturnType<typeof createPrompter>,
  team: string,
  model: string,
  outputs: StackOutputs,
  dailyTokenQuota: number
): Promise<boolean> {
  for (;;) {
    const status = await getUsageStatus(
      team,
      model,
      outputs.usageAggregationTableName,
      outputs.blockedStateTableName
    );
    const pctOfQuota = dailyTokenQuota > 0 ? Math.round((status.runningTotalTokens / dailyTokenQuota) * 100) : 0;
    console.log(
      `  Usage_Aggregation (actual, real value): ${status.runningTotalTokens} / ${dailyTokenQuota} tokens (${pctOfQuota}%). Blocked: ${status.isBlocked}`
    );

    if (status.isBlocked) {
      console.log('  Enforcement has kicked in.');
      return true;
    }

    const keepWaiting = await prompter.confirm('  Check again in 30 seconds?', false);
    if (!keepWaiting) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

async function printAuditLog(team: string, outputs: StackOutputs, region: string): Promise<void> {
  const today = new Date();
  const startDate = new Date(today.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const endDate = today.toISOString().slice(0, 10);

  const result = await invokeAdminApi<Array<Record<string, unknown>>>(
    outputs.adminApiFunctionName,
    region,
    'listAuditEntries',
    { team, startDate, endDate }
  );

  if (!result.ok) {
    console.log(`  Failed to fetch audit entries: ${result.error}`);
    return;
  }

  if (!result.data || result.data.length === 0) {
    console.log('  No audit entries found yet.');
    return;
  }

  for (const entry of result.data) {
    console.log(`  ${JSON.stringify(entry)}`);
  }
}

main().catch((error) => {
  console.error('\nTest tool failed:', error);
  process.exitCode = 1;
});
