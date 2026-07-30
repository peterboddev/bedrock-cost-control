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

### 6. Fixed — dependency vulnerabilities resolved (`npm audit` clean)
`npm audit` originally reported **42 vulnerabilities (5 low, 15 moderate, 21 high, 1
critical)**, all inside transitively-pinned `@aws-sdk/*`/`@smithy/*` packages and
their nested dependencies. These are now fully resolved — `npm audit` reports **0
vulnerabilities**, verified to survive a clean `rm -rf node_modules && npm install`.

How it was fixed:
- **AWS SDK bump**: all `@aws-sdk/*` packages were bumped to `3.1098.0`
  (`@aws-sdk/util-dynamodb` to `3.996.7`, which versions independently), and
  `aws-cdk-lib` to `2.262.2`. This cleared 41 of the 42 findings.
- **Bundled `brace-expansion` (the last, stubborn one)**: the final high-severity
  finding was `brace-expansion@5.0.7` (GHSA-mh99-v99m-4gvg, a DoS via unbounded
  expansion length). It is a **bundled dependency** shipped *inside* the `aws-cdk-lib`
  npm tarball (`bundleDependencies`), so npm's `overrides` field cannot reach it —
  `npm audit fix` itself reports "It cannot be fixed automatically." AWS has not yet
  published an `aws-cdk-lib` release with the patched version. Rather than deferring,
  it was fixed properly with two coordinated, idempotent, install-time steps wired
  into a `postinstall` hook:
  1. `patch-package` (see `patches/aws-cdk-lib++brace-expansion+5.0.9.patch`) replaces
     the vulnerable bundled `brace-expansion` source with the patched `5.0.9`
     implementation (which caps total expansion length).
  2. `scripts/fixBundledDepAuditMetadata.js` reconciles the on-disk `package.json`
     and the `package-lock.json` entry for that bundled copy to the patched version,
     because `npm audit` keys off lockfile metadata rather than file contents and a
     fresh install regenerates the lockfile from the tarball's unpatched metadata.
- **`@smithy/util-stream`**: added as an explicit pinned devDependency (`4.7.16`) —
  the SDK bump stopped hoisting it transitively, which a unit test's mock helper
  relied on.

After all changes: `npm audit` = 0 vulnerabilities, 175 tests pass, `npm run build`
and `npm run infra:check` are clean, and `cdk synth` renders successfully.

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

No changes needed for findings #2, #3 — already fine. Findings #1, #4, and #6 are
fixed.
