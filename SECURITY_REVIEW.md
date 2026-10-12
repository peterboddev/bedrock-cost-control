# Security Review

Pre-publication review for public GitHub release. Last updated after the
CUR 2.0 per-team cost pipeline + QuickSight dashboards were added (October 2026).

## Secrets / credential scan

No secrets, API keys, passwords, or access keys appear in any tracked file.

- `cdk-outputs.json` (live account ID, endpoints, Cognito pool IDs) — gitignored.
- `web/.env` (Cognito config for the local dev instance) — gitignored.
- `aidlc-docs/` (AIDLC workflow docs with account-specific data) — gitignored.
- `cdk.out/` — gitignored.
- No AWS access key patterns (`AKIA*`/`ASIA*`) found.
- No personal emails or usernames in tracked source.
- The `.gitignore` explicitly covers `cdk-outputs.json`, `*.outputs.json`,
  `aidlc-docs/`, `.kiro/`, `web/.env*`, and `cdk.out/`.

## IAM least-privilege

Every Lambda execution role uses per-action, per-resource grants via the
custom `grantExactTableActions()` helper. CDK's `grantReadData` /
`grantWriteData` / `grantReadWriteData` (which unconditionally add
`dynamodb:Scan` and other unused actions) are never used. Confirmed via
search: no `grantReadData`/`grantWriteData`/`grantReadWriteData` calls or
`dynamodb:Scan` actions anywhere in the stack.

### Intentional `Resource: "*"` grants (documented in `infra/stack.ts`)

| Lambda | Actions | Why `*` |
|---|---|---|
| Quota_Enforcer | `iam:PutRolePolicy`, `iam:DeleteRolePolicy` | Target roles are determined at runtime by Team tag; not knowable at deploy time. |
| TagRole handler | `iam:PutRolePolicy` | Same reason; only attaches, never deletes. |
| Daily_Reset | `iam:DeleteRolePolicy` | Same reason; only removes, never attaches. |
| Admin API | `iam:DeleteRolePolicy` | `removeDenyPolicy` manual override. |
| Usage_Collector | `iam:GetRole`, `iam:ListRoleTags` | Read-only tag lookup; IAM has no resource-level scoping for these. |
| Reconciliation | `iam:ListRoles`, `iam:GetRole`, `iam:ListRoleTags` | Paginates all roles; read-only enumeration. |
| Mantle collector | `cloudwatch:GetMetricData` | CloudWatch does not support resource-level scoping. |
| Model Invocation Logging | `bedrock:Put/DeleteModelInvocationLoggingConfiguration` | Account singleton, no ARN to scope to. |
| CUR Per-Team Cost | `athena:StartQueryExecution`, `athena:GetQueryExecution`, `athena:GetQueryResults` | Athena has no resource-level scoping for query execution. All other grants on this Lambda are resource-scoped (see below). |

**Production hardening recommendation**: Use SCPs or `iam:ResourceTag`
condition keys to constrain which roles the `PutRolePolicy`/`DeleteRolePolicy`
Lambdas can modify (e.g., only roles tagged `managed-by = bedrock-quota`).

### Cognito authenticated role

Scoped to exactly `execute-api:Invoke` on
`adminApi.arnForExecuteApi("POST", "/admin", "prod")` — one method, one
resource, one stage. No other AWS action or resource is granted.

### Bedrock_Test_Role trust policy

Requires explicit `TEST_ROLE_TRUSTED_PRINCIPAL_ARNS` (fails fast if empty).
Never trusts the whole account.

### CUR Per-Team Cost Lambda (scoped grants)

Beyond the Athena `*` grant above (unavoidable — Athena has no resource-level
scoping), every other permission on `CurTeamCostFunction` is resource-scoped:

- **Glue** (`glue:GetTable`, `GetDatabase`, `GetPartitions`): scoped to the
  account catalog plus the specific CUR database and table ARNs only.
- **S3 read of CUR export** (`s3:GetObject`, `GetBucketLocation`, `ListBucket`):
  scoped to the CUR export bucket and its objects only. Required because Athena
  reads the underlying CUR data files with the caller's credentials.
- **S3 on analytics bucket** (`s3:GetObject`, `GetBucketLocation`, `ListBucket`,
  `PutObject`): scoped to the analytics bucket, its `athena-results/*` prefix,
  and its `cur-team-cost/*` export prefix. No account-wide S3 access.

## QuickSight (CUR cost dashboards)

The CUR 2.0 cost pipeline feeds two QuickSight dashboards
(`bedrock-team-token-quota-cost`, the RLS-scoped per-team view, and
`bedrock-team-token-quota-cost-admin`, the admin all-teams view), backed by
SPICE datasets over the `cur-team-cost/` analytics export.

- Dashboards are shared only with the deploying QuickSight principal
  (`QUICKSIGHT_PRINCIPAL_ARN`); no account-wide or public sharing.
- Row-level security (RLS) restricts per-team viewers to their own team's rows
  via a committed `rls/rules.json` mapping; the admin dashboard sees all teams.
- **Operator-applied grant (not in this stack)**: QuickSight's own service role
  (`aws-quicksight-service-role-v0`) must be granted read on the analytics
  bucket's `cur-team-cost/` prefix for SPICE ingestion. This is applied once by
  the operator during setup (documented in `DEPLOY.md`), lives outside the CDK
  stack, and is scoped to that prefix — it is intentionally not managed here
  because the QuickSight service role is an account-level resource.

## S3 bucket security

| Bucket | BlockPublicAccess | Encryption | enforceSSL | Lifecycle |
|---|---|---|---|---|
| ModelInvocationLogBucket | BLOCK_ALL | S3_MANAGED | Yes | 90-day expiration |
| AnalyticsExportBucket | BLOCK_ALL | S3_MANAGED | Yes | 365-day expiration |

**Note**: `textDataDeliveryEnabled: true` in Model Invocation Logging means
full prompt/completion text is stored in S3 (not just token counts). This is
required because token counts are only available as part of the same log
entry. See README's "Data captured by this system" section. Consider making
this a configurable stack prop for production deployments with sensitive data.

## API Gateway

- Admin API method: `AuthorizationType.IAM` (SigV4-signed, no unauthenticated access).
- CORS `allowOrigins: *` with IAM auth is safe — SigV4 authenticates via headers,
  not cookies, so CORS's credentialed-request protection does not apply.
- The OPTIONS preflight is unauthenticated (required by the CORS spec).

## Input validation

Every Admin API operation validates payload shape (required fields, types,
enum membership) via `adminApi.ts`'s `requireNonEmptyString` /
`requireNumber` / `requireOneOf` / `requireNonNegativeNumber` checks before
touching any data store. The `operation` field is validated as a string in
`handleHttp` and dispatched through a switch with a `default` error branch.

## IAM policy injection defense

Model identifiers (which flow into IAM policy Resource ARNs and Condition
values) are validated via `validateModelForPolicy()` in both
`quotaEnforcer.ts` and `mantleDenyPolicy.ts` before being embedded in any
IAM policy document. The validation rejects empty strings and strings
containing characters that would alter IAM policy semantics (wildcards,
whitespace, control characters, quotes). Covered by unit tests.

## Error handling

The Admin API's `runHandler` wrapper distinguishes validation errors (whose
messages are safe to return) from unexpected errors (which are logged
server-side but return a generic `"Internal error processing request"`
message). SDK errors, table names, regions, and request IDs are never leaked
to callers. All callers are IAM-authenticated.

## HTTP security headers

Responses include: `Content-Type: application/json`, `X-Content-Type-Options:
nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src
'none'`, `Strict-Transport-Security`, `Cache-Control: no-store`,
`Access-Control-Allow-Origin: *`.

## Sensitive data logging

No Lambda handler logs prompts, completions, tokens, credentials, or PII.
Only `console.error` for SNS publish failures (team/model + error object,
no sensitive data) and `console.warn` on logging-config delete failure.

## Cognito

- Self-signup disabled (admin-provisioned users only).
- Password policy: >= 12 chars, upper + lower + digit + symbol.
- **MFA is OFF by default** (for demo/sandbox frictionless onboarding).
  Set `Mfa.REQUIRED` in `infra/stack.ts` before any real/customer deployment.
  TOTP is already configured; flipping the property and redeploying is sufficient.
- `preventUserExistenceErrors: true` on the app client.
- Identity Pool: `allowUnauthenticatedIdentities: false`.

## Budget UI (web/)

- No credentials stored in code; Cognito identity pool vends short-lived
  AWS credentials via `fetchAuthSession`.
- `web/.env` (containing Cognito pool IDs — not secrets, but deployment-
  specific) is gitignored; `.env.example` is committed with placeholders.
- React app uses SigV4-signed fetch via `aws4fetch`; no raw credentials
  appear in the DOM or network requests.
- No `dangerouslySetInnerHTML` usage; all data rendered via JSX.

## Removal policies / data retention

`RemovalPolicy.DESTROY` and `autoDeleteObjects: true` are the defaults for
dev/sandbox convenience. The `tableRemovalPolicy` stack prop exists for
production deployments — pass `RemovalPolicy.RETAIN`. This is documented
in both the code and the README.

## Dependencies

All AWS SDK packages pinned to `3.1098.0`; CDK pinned to `2.262.2`.
DevDependencies are well-known packages at pinned versions. The
`brace-expansion@5.0.9` override + `patches/` patch-package fix is a
mitigation for CVE-2024-4067 in CDK's bundled `minimatch`; documented in
README and `scripts/fixBundledDepAuditMetadata.js`.

**`npm audit` findings are dev-only.** The high-severity advisories reported
by `npm audit` are all in the devDependency / build-tooling tree (CDK CLI
transitive deps and test tooling), none of which ship in any deployed Lambda
bundle or the web app. Runtime dependencies are clean. `npm audit fix` can be
run cosmetically but is not required for a safe release.

## Pre-push checklist

- [x] No secrets/credentials/API keys in any tracked file
- [x] `cdk-outputs.json` gitignored (contains live account data)
- [x] `web/.env` gitignored; `.env.example` has placeholders only
- [x] `aidlc-docs/` gitignored (contains account-specific workflow data)
- [x] No account ID, personal email, or endpoint URL in tracked source
- [x] All DynamoDB grants use exact per-action scoping (no Scan)
- [x] Model IDs validated before IAM policy generation
- [x] SDK errors not leaked in API responses
- [x] HTTP security headers complete (incl. CSP)
- [x] S3 buckets: block-all, SSL-only, encrypted, lifecycle rules
- [x] Cognito MFA off documented with production-enable instructions
- [x] `RemovalPolicy.DESTROY` documented as sandbox default with RETAIN guidance
- [x] CUR cost Lambda grants resource-scoped except unavoidable Athena `*`
- [x] QuickSight dashboards shared only with deploying principal; RLS per team
- [x] `npm audit` highs confirmed dev-only (no runtime/shipped impact)
- [x] 292/292 tests pass
- [x] `tsc --noEmit` + `infra:check` + `cdk synth` clean
