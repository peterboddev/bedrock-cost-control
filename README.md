# bedrock-team-token-quota

Tracks Amazon Bedrock foundation model token consumption per **team**, per
**model**, per **day**, and automatically blocks a team's access to a
specific model for the rest of the day once its configured daily token
quota is exceeded — enforced via a real IAM deny policy, not just an alert.

This has been deployed and verified end to end against a live AWS account:
real `Converse` invocations flow through Model Invocation Logging → S3 →
`Usage_Collector` → DynamoDB → `Quota_Enforcer`, correctly attach an IAM
deny policy once a quota is exceeded, and get automatically restored by the
scheduled daily reset — with no manual or periodic triggering anywhere in
the enforcement path.

> This project was built using [Kiro's](https://kiro.dev) spec-driven
> workflow (requirements → design → tasks). The generated spec documents
> aren't included in this repository; the sections below summarize the
> resulting architecture and design decisions directly.

## How it works, in short

1. Teams are identified by a tag (default key: `team`) on the IAM role
   they assume to call Bedrock. No code changes, no per-request headers.
2. **Amazon Bedrock Model Invocation Logging** delivers a log of every
   `InvokeModel`/`Converse` call (with token counts) to an S3 bucket.
   This is the *only* source of token counts — AWS CloudTrail records
   that a call happened and who made it, but never how many tokens it
   used.
3. A Lambda (`Usage_Collector`) parses those logs, resolves the calling
   role's team, and atomically increments a DynamoDB counter per
   `(team, model, day)`.
4. A second Lambda (`Quota_Enforcer`), triggered by DynamoDB Streams on
   that counter table, compares the running total to the configured
   quota. Once exceeded, it attaches an inline **deny** policy — scoped to
   exactly that model's `bedrock:InvokeModel`/`Converse`-family actions —
   to every IAM role mapped to that team.
5. A scheduled Lambda removes all of yesterday's deny policies at
   00:00 UTC, restoring access automatically.

See `infra/stack.ts` for the full architecture and per-Lambda IAM/data-flow
comments, and `src/*.ts` for the domain logic (each module documents which
requirement/correctness-property it satisfies in its header comment). The
test suite (`src/*.test.ts`) implements 23 property-based tests covering
aggregation correctness, per-model deny-policy isolation, retry/failure
handling, and audit fidelity.

## Prerequisites

- Node.js 20+
- AWS CLI configured with credentials for the target account
- The AWS CDK CLI (installed as a pinned dev dependency — no global
  install needed, use `npx cdk ...` or the `npm run infra:*` scripts below)
- Bedrock model access enabled for whichever model(s) you plan to test
  with (Bedrock console → Model access). This is separate from IAM
  permissions.

Install dependencies:

```bash
npm install
```

## Project layout

```
src/                    Core domain logic (Usage_Collector, Quota_Enforcer, Daily_Reset, etc.)
src/lambdaEntrypoints/  Thin Lambda handler adapters wiring src/ logic to AWS events
src/clients/            Thin AWS SDK v3 wrappers (one per service), mocked in tests
infra/stack.ts          The CDK stack: DynamoDB tables, Lambdas, IAM, EventBridge, SNS
infra/bin/app.ts        CDK app entry point
scripts/testTool/       The interactive CLI test tool described below
```

## Build, lint, test

```bash
npm run build          # tsc compile of src/
npm run lint            # tsc --noEmit (same as build, no output)
npm run infra:check     # typecheck infra/stack.ts and infra/bin/app.ts
npm test                # run the full Jest suite (unit + property-based tests)
```

The test suite includes 23 property-based tests (via `fast-check`), each
run against 100+ randomized inputs, covering aggregation correctness,
per-model deny-policy isolation, retry/failure handling, and audit
fidelity.

## Deploying

This deploys real infrastructure: 6 DynamoDB tables, an S3 bucket, an SNS
topic, 7+ Lambda functions with their own IAM roles, EventBridge rules, and
a **custom resource that enables Bedrock Model Invocation Logging for the
entire account/region** (a one-time account-level setting, not scoped to
this stack — see "About Model Invocation Logging" below).

```bash
# Point your AWS credentials at the target account/region first, e.g.:
export AWS_PROFILE=your-profile-name
export AWS_REGION=us-east-1   # or wherever you want Bedrock usage tracked

# Required: who is allowed to assume the Bedrock_Test_Role this stack
# creates for the interactive CLI test tool. There is no default - deploy
# will fail fast if this isn't set, rather than silently trusting every
# principal in the account. Comma-separate multiple ARNs if needed.
export TEST_ROLE_TRUSTED_PRINCIPAL_ARNS="arn:aws:iam::<account-id>:user/<your-username>"

npm run infra:synth     # sanity-check the generated CloudFormation
npm run infra:diff      # see exactly what will change before deploying
npm run infra:deploy    # deploy
```

`infra:deploy` runs `cdk deploy` without `--require-approval never`, so it
will show you the IAM/security-relevant changes and ask for confirmation
before proceeding.

By default, DynamoDB tables use `RemovalPolicy.DESTROY` (convenient for a
sandbox — tearing down the stack removes the tables). If this becomes a
persistent environment, pass `tableRemovalPolicy: RemovalPolicy.RETAIN` via
stack props in `infra/bin/app.ts` before deploying to production.

### About Model Invocation Logging

Amazon Bedrock **CloudTrail** logging alone is not enough for this system:
a CloudTrail entry for `InvokeModel`/`Converse` tells you who called which
model and when, but its `responseElements` field is always `null` for
Bedrock — it never contains token counts. **Model Invocation Logging** is a
separate, opt-in feature that captures the full request/response
(including `inputTokenCount`/`outputTokenCount`) and delivers it to S3.
This stack enables it automatically via a CDK custom resource pointed at
the bucket the stack creates.

Two things worth knowing:

- This is an **account/region-level singleton setting** — there's no
  native `AWS::Bedrock::*` CloudFormation resource for it. If you already
  have Model Invocation Logging configured for something else in this
  account/region, deploying this stack will overwrite that configuration
  to point at this stack's bucket instead.
- Destroying the stack disables it again (best-effort — a failure here
  won't block stack teardown).

### Data captured by this system (read before deploying)

The logging configuration enables `textDataDeliveryEnabled: true`, which
means **the full prompt and completion text of every Bedrock call made
under a tagged role is captured and stored in S3** — not just token
counts. This is necessary because token counts are only available as part
of the same log entry; there's no way to opt into token counts alone.

To reduce the blast radius of storing full conversation content:

- The log bucket has `blockPublicAccess: BLOCK_ALL`, `enforceSSL: true`
  (rejects non-TLS requests), and default S3-managed encryption at rest.
- A 90-day lifecycle rule expires log objects automatically (independent
  of the 90-day TTL on the aggregated token-count data in DynamoDB).
- `Usage_Collector`'s IAM role can read *only* the `s3:GetObject` action
  scoped to this bucket's `bedrock-model-invocation-logs/` prefix — no
  other Lambda in this stack has any S3 permission at all.

If your use case is sensitive to storing full conversation content (e.g.
regulated data, PII in prompts), review your organization's data handling
requirements before deploying this to a production account, and consider
shortening the lifecycle rule in `infra/stack.ts`.

### Least-privilege IAM

Every Lambda's IAM policy in this stack is built from explicit, per-action
`PolicyStatement`s scoped to specific table/GSI ARNs — **not** CDK's
`Table.grantReadData`/`grantWriteData`/`grantReadWriteData` convenience
methods, because those unconditionally add `dynamodb:Scan` (and other
unused actions) regardless of what the granted code actually calls. No
Lambda in this system ever scans a table; every DynamoDB access pattern is
a targeted `GetItem`/`PutItem`/`UpdateItem`/`DeleteItem` or a bounded,
single-partition `Query` against a real key or GSI. See the per-Lambda
comments in `infra/stack.ts` for the exact grants and the reasoning behind
each one.

The Bedrock log S3 bucket is similarly locked down: TLS-only access,
encryption at rest, blocked public access, and a 90-day lifecycle
expiration — see "Data captured by this system" above, since that bucket
holds full prompt/completion text, not just token counts.

`Bedrock_Test_Role`'s trust policy is scoped the same way: it can only be
assumed by the exact IAM principal ARN(s) passed via
`TEST_ROLE_TRUSTED_PRINCIPAL_ARNS` (see "Deploying" above) — there is no
default, and it never trusts the whole account.

## Configuring quotas

Quotas are managed through the deployed `AdminApiFunction` Lambda (invoke
directly via the SDK/CLI, or use the interactive test tool below, which
sets one for you as part of the walkthrough):

```bash
aws lambda invoke \
  --function-name <AdminApiFunctionNameOutput> \
  --payload '{"operation":"putQuota","payload":{"team":"data-science","model":"amazon.nova-lite-v1:0","dailyTokenQuota":50000}}' \
  --cli-binary-format raw-in-base64-out \
  response.json
```

Other operations: `listQuotas`, `listAuditEntries`, `removeDenyPolicy`
(manually restores access before the next day, per Requirement 6.4). See
`src/adminApi.ts` for each operation's exact request/response shape.

If no quota is configured for a `(team, model)` pair, that team is
**unrestricted** for that model — usage is still tracked, but nothing is
ever enforced. A quota of `0` is rejected as invalid (use `removeDenyPolicy`
or delete the quota entry to make a team unrestricted instead).

## Testing end to end: the interactive CLI tool

`scripts/testTool/` is a real, hands-on test — not a mock. It:

1. Sets a small daily token quota for a team/model via the deployed Admin API.
2. Assumes a dedicated IAM role (`Bedrock_Test_Role`, created by this
   stack and tagged with the same team) via `sts:AssumeRole`.
3. Sends real `Converse` invocations to Bedrock through that assumed role,
   one at a time, on your confirmation.
4. Polls the actual deployed `Usage_Aggregation` and `Blocked_State`
   DynamoDB tables (through the same read functions the production
   Lambdas use) so you can watch the running total climb and see the
   moment enforcement kicks in.
5. Once blocked, offers to send one more call to prove it now fails with
   `AccessDeniedException`, and to print the `Audit_Log` trail.

Run it:

```bash
npm run test:tokens
```

You'll be prompted for:

| Prompt | Default | Notes |
|---|---|---|
| CloudFormation stack name | `BedrockTeamTokenQuotaStack` | |
| AWS region | `$AWS_REGION` or `us-east-1` | Must match where you deployed |
| Team | the `Bedrock_Test_Role`'s own team tag | Change this if you want to test a different team name |
| Bedrock model ID | `amazon.nova-lite-v1:0` | Must be a model you have access to in that region |
| Daily token quota | `500` | Kept small on purpose — a couple of `Converse` calls with the tool's built-in verbose test prompt is usually enough to exceed it |

The tool reports two different numbers, and they mean different things:

- **"Session so far" / "Projected total"** — a running count of tokens
  Bedrock reported for calls made *in this session*, added to whatever was
  already on record when the session started. This is an **estimate**,
  computed locally by the tool, so you have immediate feedback on how
  close you are to the quota without waiting on the pipeline.
- **"Usage_Aggregation (actual, real value)"** — the real number read
  directly from the deployed DynamoDB table, via the status-check prompts.
  This is the number that actually drives enforcement, and it only updates
  once Model Invocation Logging has delivered the log and Usage_Collector
  has processed it (see the latency note below).

### Why this takes a few minutes, not seconds

This is the single most important thing to understand before running the
tool: **the pipeline is not synchronous**. A `Converse` call returning
successfully does not mean the quota system has "seen" it yet. The real
flow is:

```
Bedrock call returns  →  Model Invocation Logging batches and delivers
a log file to S3 (not instant)  →  S3 event triggers Usage_Collector
(target: within 5 min)  →  DynamoDB counter updated  →  DynamoDB Streams
triggers Quota_Enforcer (target: within 5 min)  →  IAM deny policy attached
```

So after sending an invocation, it can realistically take **10-15 minutes**
before the running total updates, and a bit longer before a block takes
effect. The tool's polling step explains this and lets you check again on
your own schedule rather than busy-waiting. This is expected, working
behavior — this design intentionally favors a push-based pipeline with a
bounded freshness target over a tighter-but-more-expensive polling
architecture. Athena/ad-hoc querying over the raw S3 log archive was
considered and deliberately left out of the core pipeline for the same
reason (see "Known limitations" below).

### Restoring access after testing

Once you're done, either:
- Wait for the daily reset at 00:00 UTC (automatic), or
- Use the tool's own prompt to fetch the audit log and then call
  `removeDenyPolicy` directly:

```bash
aws lambda invoke \
  --function-name <AdminApiFunctionNameOutput> \
  --payload '{"operation":"removeDenyPolicy","payload":{"team":"data-science","model":"amazon.nova-lite-v1:0"}}' \
  --cli-binary-format raw-in-base64-out \
  response.json
```

### Cleaning up the test role's usage data

The test tool writes real entries into `Usage_Aggregation`, `Blocked_State`,
and `Audit_Log` under whatever team name you tested with. These age out on
their own (`Usage_Aggregation` and `Audit_Log` carry a 90-day TTL); there's
nothing that needs manual cleanup unless you want the counters gone sooner.

## Known limitations / follow-ups

- **IAM permission gaps are the most likely failure mode when extending
  this stack.** During development, `Usage_Collector` was deployed for a
  period without `s3:GetObject` on the log bucket — the S3 event
  notification still triggered the Lambda, but every invocation failed
  with `AccessDenied` when it tried to read the object it was notified
  about, and Lambda's built-in async retries masked the failure from
  casual observation (no data ever reached DynamoDB, with no obvious
  error surfaced anywhere except CloudWatch Logs). If you add a new
  Lambda/event source pairing, always verify the *execution role* has
  every permission the handler code actually calls, not just the trigger
  wiring — `cdk diff`/`synth` won't catch this since the trigger and the
  permission are configured independently.
- **Bedrock Model Invocation Logging delivers S3 objects gzip-compressed**
  (`.json.gz`), not as plain text. `usageCollectorEntry.ts` detects this
  via the gzip magic-byte header and decompresses before parsing; if
  you're testing with hand-crafted S3 objects, either gzip them or rely on
  the plain-text fallback path (both are covered by
  `usageCollectorEntry.test.ts`).
- **Athena/ad-hoc querying** over the raw S3 log archive was deliberately
  left out of this design in favor of the event-driven streaming pipeline
  described above (needed to hit the 5-minute freshness target). It's a
  natural future addition layered on top of the same S3 bucket for
  longer-horizon reporting.
- **Dependency vulnerabilities**: `npm audit` currently reports findings in
  transitively-pinned `@aws-sdk/*`/`@smithy/*` packages shared across this
  project's pinned SDK version. Worth a deliberate, tested bump of the
  whole AWS SDK dependency set at some point rather than a piecemeal fix.
- **If `aws sts get-caller-identity --profile <name>` works but SDK-based
  tools (the CDK CLI, `npm run test:tokens`, etc.) fail with
  `CredentialsProviderError: Could not load credentials from any providers`
  for the same profile**, this is very likely a `HOME` resolution mismatch,
  not a config file problem. The AWS SDK for JavaScript resolves your home
  directory (and therefore both `~/.aws/config` and the SSO token cache at
  `~/.aws/sso/cache/`) via the `HOME` environment variable, falling back to
  `HOMEDRIVE`+`HOMEPATH` if `HOME` is unset — it does **not** use
  `USERPROFILE`, which is what the AWS CLI and Node's own `os.homedir()`
  use instead. On Windows machines where `HOMEDRIVE`/`HOMEPATH` point
  somewhere different from `USERPROFILE` (e.g. a mapped/redirected home
  drive), this causes the SDK to silently read the wrong (or an empty)
  config and SSO cache. Fix: set `HOME` to match `USERPROFILE`.
  - **cmd/PowerShell**: `setx HOME "%USERPROFILE%"` (or the literal path,
    e.g. `setx HOME "C:\Users\yourname"`), then open a **new** terminal —
    `setx` never updates the terminal you ran it in.
  - **git-bash/MINGW64**: bash resolves `$HOME` independently of the
    Windows env var, so `setx` alone won't fix it here. Add
    `export HOME="/c/Users/yourname"` (bash-style path) to `~/.bashrc` or
    `~/.bash_profile`, or `export` it manually each session.
  - Verify with `node -e "console.log(require('os').homedir())"` (should
    match `USERPROFILE`) vs. checking what the SDK itself sees — if they
    disagree, that's the mismatch to fix.
