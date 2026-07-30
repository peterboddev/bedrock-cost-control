# Security Review — bedrock-team-token-quota

Reviewed before first commit/push to `https://github.com/peterboddev/bedrock-cost-control.git`.

## Summary

No secrets, credentials, or private keys found in the codebase. Two account-specific
references were found and fixed. IAM policies use exact per-action grants throughout
(no `dynamodb:Scan`, no wildcard managed policies). A few items below are worth a
decision before/after pushing.

## Findings

### 1. Fixed — account ID in a code comment
`infra/bin/app.ts` had an example `AWS_PROFILE` value containing the real account ID
(`450683699755`) in a comment. Not a secret, but unnecessary in a shared repo.
**Fixed**: replaced with a generic placeholder (`<your-sso-profile-name>`).

### 2. No secrets/credentials found
- No `.env` files, no hardcoded `accessKeyId`/`secretAccessKey`/`sessionToken` anywhere
  in `src/`, `scripts/`, or `infra/`.
- No private keys, no AWS access key patterns (`AKIA...`), no other 12-digit account
  IDs left in source, docs, or config after the fix above.
- `console.error`/`console.warn` calls (in `notifications.ts` and the Model Invocation
  Logging custom resource) only log team/model/action metadata and error objects —
  never tokens or credentials.

### 3. IAM: `Resource: "*"` grants — reviewed, each is justified
Several Lambdas have `Resource: "*"` on specific IAM/Bedrock actions. In every case
this is because the action targets resources not known at deploy time (e.g. any IAM
role that gets tagged into a team) or the AWS API has no resource-level ARN to scope to
(the Bedrock Model Invocation Logging *account-level* configuration). None of these are
wildcard action lists — each is restricted to exactly 1-3 specific actions:
- `iam:GetRole`, `iam:ListRoleTags` (read-only tag lookups)
- `iam:PutRolePolicy`, `iam:DeleteRolePolicy` (deny-policy attach/remove on dynamically
  tagged roles)
- `iam:ListRoles` (reconciliation's account-wide enumeration)
- `bedrock:PutModelInvocationLoggingConfiguration`,
  `bedrock:DeleteModelInvocationLoggingConfiguration` (account-level singleton setting)

No `dynamodb:Scan` anywhere, and no CDK `grantReadData`/`grantWriteData`/
`grantReadWriteData` convenience grants are used (those add `Scan` automatically) —
every DynamoDB grant is an exact action list scoped to a specific table/GSI ARN.

### 4. Fixed — `Bedrock_Test_Role` trust policy tightened
`Bedrock_Test_Role` previously used `assumedBy: new AccountPrincipal(this.account)`,
letting any principal in the deploying account attempt `sts:AssumeRole` on it. **Fixed**:
the trust policy now requires an explicit, required stack prop
(`testRoleTrustedPrincipalArns: string[]`, no default) listing exactly which IAM
user/role ARN(s) may assume it, wired via `ArnPrincipal`/`CompositePrincipal`. The CDK
app entry point (`infra/bin/app.ts`) reads this from a required
`TEST_ROLE_TRUSTED_PRINCIPAL_ARNS` environment variable and fails fast with a clear
error if it's unset — deploying can no longer silently default to account-wide trust.
Verified via `cdk synth` that the rendered `AssumeRolePolicyDocument` contains only the
explicit ARN(s) passed in, no wildcards.

### 5. Data sensitivity: Model Invocation Logging captures full prompts/completions
The stack enables `textDataDeliveryEnabled: true` on Bedrock Model Invocation Logging,
which means the S3 bucket (`ModelInvocationLogBucket`) stores the **full text of every
prompt and completion** sent through any role tagged into a tracked team, across the
whole account/region (this is an account-level Bedrock setting, not scoped to just the
test role). The bucket itself is well-secured (SSL-enforced, S3-managed encryption,
`BlockPublicAccess.BLOCK_ALL`), but this is a real data-handling consideration for
anyone deploying this stack against production Bedrock traffic — not a code
vulnerability, but worth documenting prominently (see README suggestion below).

### 6. Dependency vulnerabilities (pre-existing, not introduced by this review)
`npm audit` currently reports **42 vulnerabilities (5 low, 15 moderate, 21 high, 1
critical)**, all inside transitively-pinned `@aws-sdk/*`/`@smithy/*`/`uuid` packages
shared across the pinned SDK version used throughout this project. Fixing requires a
deliberate, tested bump of the whole AWS SDK dependency set (`npm audit fix --force`
would jump multiple major versions unprompted) — already called out in README's
"Known limitations" section. Not something to silently `--force` fix as part of a
routine commit.

### 7. `.gitignore` coverage (being added as part of this task)
Before first commit, `.gitignore` needs to exclude at minimum:
- `.kiro/` (per your instruction — spec/task tracking, not meant for the public repo)
- `node_modules/`
- `dist/` (compiled build output)
- `cdk.out/` (CDK synthesis output — contains the full rendered CloudFormation
  template and Lambda bundles; regenerable, and templates can reveal account/resource
  naming details)
- Standard OS/editor cruft (`.DS_Store`, etc.)

## Recommendation

Safe to commit and push after:
1. `.gitignore` is added (this task).
2. README is refreshed to reflect current state (this task) — should explicitly
   mention the prompt/completion data-capture behavior from finding #5.
3. You decide on finding #4 (test role trust policy scope) — no blocking issue either
   way, just flagging the tradeoff.

No changes needed for findings #2, #3, #6 — already fine or already documented.
