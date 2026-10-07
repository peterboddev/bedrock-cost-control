#!/usr/bin/env node
/**
 * CDK app entry point for the bedrock-team-token-quota stack.
 *
 * Deploys to whatever AWS account/region the active credentials resolve to
 * (e.g. `AWS_PROFILE=<your-sso-profile-name>`). No account/region is
 * hardcoded here; `env` is intentionally left undefined so the CDK CLI's
 * environment-agnostic resolution (from the current credentials) is used.
 *
 * TEST_ROLE_TRUSTED_PRINCIPAL_ARNS (required): a comma-separated list of
 * IAM principal ARN(s) allowed to assume the Bedrock_Test_Role that this
 * stack creates for the interactive CLI test tool (`npm run test:tokens`).
 * There is no default - deploying without this set fails fast rather than
 * silently trusting every principal in the account. Set it to the ARN of
 * whichever specific IAM user/role you'll actually run the test tool as,
 * e.g.:
 *
 *   export TEST_ROLE_TRUSTED_PRINCIPAL_ARNS="arn:aws:iam::123456789012:user/your-username"
 */
import "source-map-support/register";
import { App } from "aws-cdk-lib";
import { BedrockTeamTokenQuotaStack } from "../stack";

const app = new App();

const testRoleTrustedPrincipalArnsRaw = process.env.TEST_ROLE_TRUSTED_PRINCIPAL_ARNS;
if (!testRoleTrustedPrincipalArnsRaw) {
  throw new Error(
    "TEST_ROLE_TRUSTED_PRINCIPAL_ARNS environment variable is required. " +
      "Set it to a comma-separated list of IAM principal ARN(s) (user or role) " +
      "that should be allowed to assume Bedrock_Test_Role, e.g.:\n" +
      '  export TEST_ROLE_TRUSTED_PRINCIPAL_ARNS="arn:aws:iam::123456789012:user/your-username"'
  );
}
const testRoleTrustedPrincipalArns = testRoleTrustedPrincipalArnsRaw
  .split(",")
  .map((arn) => arn.trim())
  .filter((arn) => arn.length > 0);

/**
 * QUICKSIGHT_PRINCIPAL_ARN (optional): the QuickSight user/group ARN that
 * owns the cost-dashboard datasets. When unset, the Glue/Athena analytics
 * layer is still created but QuickSight resources are skipped (a QuickSight
 * subscription + principal are deploy-time prerequisites). Example:
 *   export QUICKSIGHT_PRINCIPAL_ARN="arn:aws:quicksight:us-east-1:123456789012:user/default/your-user"
 */
const quickSightPrincipalArn = process.env.QUICKSIGHT_PRINCIPAL_ARN?.trim() || undefined;

/**
 * CUR_DATABASE_NAME / CUR_TABLE_NAME (optional): when both are set, the
 * stack deploys CUR 2.0 integration Lambdas that auto-populate rate cards
 * from billed rates and run cost reconciliation. The CUR 2.0 Data Export
 * must already exist as a Glue table in this account/region. Example:
 *   export CUR_DATABASE_NAME="cid_data_export"
 *   export CUR_TABLE_NAME="cur2"
 */
const curDatabaseName = process.env.CUR_DATABASE_NAME?.trim() || undefined;
const curTableName = process.env.CUR_TABLE_NAME?.trim() || undefined;

new BedrockTeamTokenQuotaStack(app, "BedrockTeamTokenQuotaStack", {
  // Default (dev/sandbox) removal policy and team tag key are used here.
  // Override via props if deploying a production stage.
  testRoleTrustedPrincipalArns,
  quickSightPrincipalArn,
  curDatabaseName,
  curTableName,
});
