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

> **Deploying? Follow [DEPLOY.md](./DEPLOY.md).** It is the complete, ordered,
> CLI-only runbook (deploy → per-team token quotas → enforcement → both
> QuickSight dashboards, including CUR 2.0 billed-dollar → verify → teardown).
> **This README is the reference** — what the system is, how it works, and the
> design rationale behind it.

> **This is a reference implementation / sample code**, provided as-is
> under the [MIT License](./LICENSE) to demonstrate a working approach to
> per-team Bedrock token-quota enforcement. It is not an officially
> supported AWS product. Review it against your own security, cost, and
> data-governance requirements before running it in a production account.

> This project was built using [Kiro's](https://kiro.dev) spec-driven
> workflow (requirements → design → tasks). The generated spec documents
> aren't included in this repository; the sections below summarize the
> resulting architecture and design decisions directly.

## How it works, in short

1. Teams are identified by a tag (default key: `team`) on the IAM role
   they assume to call Bedrock. No code changes, no per-request headers.
   The **team is the unit of tracking and enforcement — not the individual
   user**. Everyone who assumes a role carrying the same `team` tag shares
   that team's single daily budget. A team can be a single person: to give
   one person their own budget, give them their own role tagged with a
   `team` value unique to them (a "team of one"). There is no user-level
   quota concept anywhere in this system.
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
   to every IAM role mapped to that team. (How roles get mapped to teams —
   automatically on use/tag, or manually via the UI — is described in
   [Mapping IAM roles to teams](#mapping-iam-roles-to-teams).)
5. A scheduled Lambda removes all of yesterday's deny policies at
   00:00 UTC, restoring access automatically.

The steps above describe the **Converse** (`bedrock-runtime`) path. This
system also tracks and enforces the **Mantle** (`bedrock-mantle`) endpoint,
which has no per-request log — its usage comes from `AWS/BedrockMantle`
CloudWatch metrics and is attributed to a team via a Team↔Project mapping.
A model's endpoint is set once in the model registry, and both tracking and
enforcement branch on it. See
[How a budget maps to Converse vs Mantle](#how-a-budget-maps-to-converse-vs-mantle)
for the full side-by-side.

See `infra/stack.ts` for the full architecture and per-Lambda IAM/data-flow
comments, and `src/*.ts` for the domain logic (each module documents the
correctness property it satisfies in its header comment). The test suite
(`src/*.test.ts`) includes property-based tests covering aggregation
correctness, per-model deny-policy isolation, retry/failure handling, and
audit fidelity.

## End-to-end flow (lifecycle of one Bedrock call)

Everything in this system is the consequence of one event — a Bedrock call —
flowing through an **asynchronous, event-driven** pipeline. This is the single
authoritative picture; the rest of the README zooms into individual stages.

```
                    A team's IAM role (tagged team=<name>) calls Bedrock
                                          │
        ┌─────────────────────────────────┴─────────────────────────────────┐
        │ CONVERSE (bedrock-runtime)                 MANTLE (bedrock-mantle)  │
        │ per-request log                            no per-request log       │
        ▼                                            ▼                         
  Model Invocation Logging                     AWS/BedrockMantle CloudWatch
  delivers a .json.gz to S3                    metrics (per Project/ModelId)
        │ (S3 ObjectCreated event)                   │ (polled every ~15 min)
        ▼                                            ▼
  Usage_Collector Lambda                        Mantle usage collector
        │                                            │
        │  resolveTeam(callerRoleArn):               │  team via Team↔Project
        │   • role has team tag  → that team         │  mapping (putTeamProjectMapping)
        │   • no team tag        → UNMAPPED          │
        │   (cached in Team_Role_Cache)              │
        └───────────────────────┬────────────────────┘
                                 ▼
         Usage_Aggregation (DynamoDB): counter per (team, model, day)
                                 │
             ┌───────────────────┼───────────────────────────────┐
             ▼ (DynamoDB Streams)                                 ▼ (hourly, or on demand)
      Quota_Enforcer Lambda                              Analytics export Lambda
      compares running total to the                      writes token-usage rows to
      configured daily quota; once                       the analytics S3 bucket
      exceeded, attaches an inline IAM                           │
      DENY policy to every role in                              ▼ (Glue + Athena)
      that team (per endpoint).                          QuickSight TOKEN dashboards
             │                                           (counts per team/model/day)
             ▼ (00:00 UTC, scheduled)
      Daily_Reset Lambda removes
      yesterday's deny policies →
      access restored automatically

  ── Separate rail: DOLLARS (not from the pipeline above) ─────────────────────
  The same tagged calls are billed by AWS. With the `team` cost-allocation tag
  active, AWS Cost & Usage Report (CUR 2.0) attributes billed $ per team
  (~24h latency). An opt-in Lambda reads CUR via Athena and writes per-team
  cost to the analytics bucket → QuickSight COST dashboards.
```

Reading it as a sentence: **a team-tagged role calls Bedrock → the call is
logged → a collector resolves which team made it and increments that team's
daily counter → an enforcer blocks the team when it exceeds its quota → a daily
reset lifts the block.** In parallel, the same counters are exported for the
**token** dashboards, and AWS billing (via CUR) feeds the separate **dollar**
dashboards.

Key properties this diagram encodes (each detailed later):

- **Attribution happens at collection time** via `resolveTeam` — a call from an
  untagged role is bucketed as `UNMAPPED` (see
  [Why `UNMAPPED` can show up](#why-unmapped-can-show-up-as-a-team)), never
  dropped.
- **It is not synchronous.** A successful Bedrock call is not "seen" by
  enforcement for minutes (log delivery + collection + stream processing). The
  realistic end-to-end latency and why it is a deliberate design choice are in
  [Why this takes a few minutes, not seconds](#why-this-takes-a-few-minutes-not-seconds).
- **Tokens and dollars are separate rails** from different authoritative
  sources — tokens drive enforcement (minutes), CUR drives cost (hours). See
  [Cost: where dollars come from](#cost-where-dollars-come-from-cur-20).
- **No periodic/polling trigger drives enforcement** — the whole Converse path
  is event-driven (S3 event → Streams); only Mantle metrics and the analytics
  export are time-based.

## Prerequisites

- Node.js 20+
- AWS CLI configured with credentials for the target account
- The AWS CDK CLI (installed as a pinned dev dependency — no global
  install needed, use `npx cdk ...` or the `npm run infra:*` scripts below)
- Bedrock model access enabled for whichever model(s) you plan to test
  with (Bedrock console → Model access). This is separate from IAM
  permissions.
- **For accurate cost tracking (recommended):** a
  [CUR 2.0 Data Export](https://docs.aws.amazon.com/cur/latest/userguide/what-is-data-exports.html)
  delivering to S3 with Athena/Glue integration, and the `team` IAM tag
  [activated as a cost-allocation tag](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/activating-tags.html).
  Without this, the system still tracks tokens and enforces quotas, but the
  cost (dollar) dashboards will have no data — token usage is still fully
  tracked and visualized. See
  [Cost: where dollars come from](#cost-where-dollars-come-from-cur-20)
  below for full setup steps.

Install dependencies:

```bash
npm install
```

## Project layout

```
src/                    Core domain logic (Usage_Collector, Quota_Enforcer, Daily_Reset, etc.)
src/cur/                CUR 2.0 integration (usage-type parser, per-team cost Athena queries)
src/pricing/            Model registry + token-type domain types
src/lambdaEntrypoints/  Thin Lambda handler adapters wiring src/ logic to AWS events
src/clients/            Thin AWS SDK v3 wrappers (one per service), mocked in tests
infra/stack.ts          The CDK stack: DynamoDB tables, Lambdas, IAM, EventBridge, SNS, Cognito
infra/bin/app.ts        CDK app entry point
web/                    React + Vite budget UI (Cognito login) — see "Budget UI" below
scripts/testTool/       The interactive CLI test tool described below
```

## Build, lint, test

```bash
npm run build          # tsc compile of src/
npm run lint            # tsc --noEmit (same as build, no output)
npm run infra:check     # typecheck infra/stack.ts and infra/bin/app.ts
npm test                # run the full Jest suite (unit + property-based tests)
```

The test suite includes property-based tests (via `fast-check`), each run
against 100+ randomized inputs, covering aggregation correctness, per-model
deny-policy isolation, retry/failure handling, and audit fidelity.

## Deploying

**To deploy, follow [DEPLOY.md](./DEPLOY.md).** It is the complete, ordered,
CLI-only runbook: start the CUR export, deploy the core stack, allow models,
set per-team token quotas, generate usage and verify enforcement, stand up the
two QuickSight dashboards (admin all-teams and team RLS — each with
token-usage and CUR 2.0 billed-cost sheets), verify, and tear down. This README
is the *reference* (what it is and how it works); DEPLOY.md is
the *procedure* (how to deploy it).

**What the stack deploys:** 6 DynamoDB tables, an S3 bucket, an SNS topic, 7+
Lambda functions (each with its own least-privilege IAM role), EventBridge
rules, a Cognito user pool for the Budget UI, and a **custom resource that
enables Bedrock Model Invocation Logging for the entire account/region** (a
one-time account-level setting — see
[About Model Invocation Logging](#about-model-invocation-logging)). The
QuickSight dashboards and the CUR cost Lambda are **opt-in**, created only when
you pass the relevant stack props / env vars (see DEPLOY.md).

> **Production hardening.** By default DynamoDB tables use `RemovalPolicy.DESTROY`
> (convenient for a sandbox — teardown removes the tables and their data). For a
> persistent environment, pass `tableRemovalPolicy: RemovalPolicy.RETAIN` via
> stack props in `infra/bin/app.ts` before deploying to production. See also
> [Security notes](#security-notes).

### QuickSight dashboards (optional) — and the region gotcha

The cost/usage dashboards are **opt-in**. The Glue + Athena analytics layer is
always created, but the QuickSight data source, datasets, and dashboard are
only created when you pass a QuickSight **principal ARN**
(`quickSightPrincipalArn` stack prop, or the `QUICKSIGHT_PRINCIPAL_ARN` env var
if you've wired it in `infra/bin/app.ts`). They're opt-in because QuickSight
needs a pre-existing subscription and a user/group that CloudFormation can't
create for you.

**Which region do the dashboards deploy to?** The QuickSight resources are
plain CloudFormation resources in **this stack**, so they deploy to the **same
account and region as the stack** (your `AWS_REGION` / `cdk deploy` target).
There is no separate region choice for them — they follow the stack. To put the
dashboards in a different region, deploy the stack in that region.

> **The gotcha — the principal ARN lives in QuickSight's *home* region, which
> is often NOT the stack region.** A QuickSight account has a single **identity
> (home) region** where all its users and groups live, chosen when QuickSight
> was first set up. That region is frequently different from where you deploy
> this stack. The `quickSightPrincipalArn` must reference the user/group in that
> **home region**, even though the dashboards themselves deploy to the stack
> region. For example, with the stack in `us-east-2` but QuickSight registered
> in `eu-west-1`, the ARN is:
>
> ```
> arn:aws:quicksight:eu-west-1:<account-id>:user/default/<your-quicksight-username>
> ```
>
> Note the `eu-west-1` (home region) in the ARN, not `us-east-2` (stack region).
> If you pass an ARN with the wrong region, the deploy fails because QuickSight
> can't find that principal. Find your home region in the QuickSight console
> (top-right region shown on the *Manage QuickSight → Account settings* page) or
> via `aws quicksight list-users --aws-account-id <acct> --namespace default
> --region <guess>` until it returns your user.

**Why QuickSight is a deploy-after-core step, not part of the cold deploy:**
when the QuickSight **data source** is created, QuickSight runs a *connection
test* that executes an Athena query — and that query must be able to **write
its results** to the analytics bucket under `athena-results/`. QuickSight does
this using its service role (`aws-quicksight-service-role-v0`), which the stack
cannot grant a bucket policy to at cold-deploy time. So the correct order is:
deploy the core stack first, grant the QuickSight service role access to the
analytics bucket (read **and** write-results), *then* redeploy with the
principal ARN to create the dashboards.

> **The grant must include `s3:PutObject` on `athena-results/`, not just read.**
> A read-only grant passes nothing — the data source's connection test fails
> with *"Access denied when writing to location: s3://…/athena-results/…"*. The
> grant below includes both the data read and the Athena-results write.

The exact `aws iam put-role-policy` grant — two statements on
`aws-quicksight-service-role-v0`: **read** on the analytics bucket and
`s3:PutObject` on `athena-results/` — and its removal at teardown, are in
**[DEPLOY.md → Part 6](./DEPLOY.md#part-6--token-usage-quicksight-dashboards)**.

#### Two dashboards: admin (all teams) vs team (row-level security)

The stack creates **two** dashboards, split by **audience** (not by metric) —
each carries both a **token-usage** view and a **Billed Cost** view as separate
sheets (tabs):

| Dashboard (display name) | Id | Sheets | Dataset RLS | Who it's for |
|---|---|---|---|---|
| **Bedrock Team Token Usage & Cost (Admin - All Teams)** | `bedrock-team-token-quota-cost-admin` | All Teams · Enforcement · Billed Cost | **none** — shows every team | admins / FinOps |
| **Bedrock Team Token Usage & Cost** | `bedrock-team-token-quota-cost` | Token Usage · Billed Cost | **row-level security** — a user sees only their own team(s) | individual team leads |

> The dollar view is the **Billed Cost** sheet *inside* each dashboard (switch
> sheets with the tabs at the top), **not** a separate "cost" dashboard. The id
> contains `-cost` and the display name includes "& Cost", but there is no
> standalone cost dashboard to look for in the Dashboards list.

The **admin dashboard works immediately** after deploy (no RLS). The **team
dashboard applies row-level security**, and on a fresh deploy it shows:

> *"You can't access this visual because the data is restricted. Contact the
> dataset owner to update the row-level security rules."*

**This is expected, not a bug.** RLS is driven by a rules table (`team_access`,
a Glue table over `s3://<analyticsBucket>/rls/`) of `{username, team}` pairs. A
QuickSight user sees a team's rows only if a rule maps their **QuickSight
username** to that team. On a fresh deploy that `rls/` location is empty — zero
rules — so everything is restricted. You populate it by uploading a
newline-delimited JSON rules file:

**How the restriction is actually enforced.** The team dataset
(`bedrock-team-token-quota-rls`) is registered with a
`rowLevelPermissionDataSet` of `permissionPolicy: GRANT_ACCESS` pointing at the
`team_access` rules dataset. At query time QuickSight takes the viewer's
identity, looks up every row in `team_access` whose `username` equals that
identity, and restricts the main `token_usage` query to the `team` values it
finds — joining the rules table to the data on the shared `team` column. No
matching rule means no visible rows (the "data is restricted" message). This is
why the admin dashboard (a separate dataset with **no**
`rowLevelPermissionDataSet`) shows everything regardless of rules.

The commands to upload the newline-delimited `{username, team}` rules file (one
JSON object per line) and verify Athena sees it are in
**[DEPLOY.md → Part 6d](./DEPLOY.md#part-6--token-usage-quicksight-dashboards)**.
Map each user to the team(s) they may see — a team lead gets just their team; an
admin who should see everything on the team dashboard gets one row per team. The
datasets are DIRECT_QUERY over Athena, so rules take effect on the next
dashboard load — no ingestion/refresh step.

> **In short:** if the team dashboard says "data is restricted," you haven't
> uploaded RLS rules yet. The admin dashboard needs no rules. This was verified
> end-to-end on a fresh deploy — after uploading the rules file above, the team
> dashboard renders each user's permitted teams.

### Costs

This stack creates billable resources. There is no fixed monthly fee, but
you will incur usage-based charges — the main drivers are:

- **S3 storage for Model Invocation Logging.** Every Bedrock call under a
  tracked role writes its full request/response to S3. On high-traffic
  accounts this is the largest cost and grows with traffic and prompt
  size; the 90-day lifecycle rule caps how long it accumulates.
- **DynamoDB** (on-demand): reads/writes for counters, dedup, quota
  config, blocked-state, and audit entries, plus DynamoDB Streams.
- **Lambda** invocations for the collector, enforcer, and daily-reset
  functions. (Role reconciliation is **on-demand only** — it runs as a
  background SQS job when an operator triggers it from the UI, not on a
  schedule — so its Lambda, SQS, and job-row costs are zero at steady state.)
- **SNS** notifications, **SQS** (only while an on-demand reconcile job is
  running), and standard S3/CloudWatch request charges.
- **CUR 2.0 Data Export (optional, only if you set it up for cost
  dashboards).** The export itself has no fee, but you pay standard S3
  storage for the delivered reports (daily Parquet files that accumulate in
  the CUR bucket indefinitely unless you add a lifecycle rule), plus Athena
  per-query scan charges each time the CUR cost Lambda or QuickSight runs a
  query. On a low-volume account this is a few cents a month; on a large
  CUR it can grow, so add an S3 lifecycle rule on the CUR bucket if cost
  matters.

For low-volume testing the total is negligible, but estimate against your
real Bedrock traffic before deploying broadly. See the
[AWS Pricing Calculator](https://calculator.aws/) for current rates.

### Tearing it down

See **[DEPLOY.md → Part 9](./DEPLOY.md#part-9--tear-it-down)** for the full
teardown: empty the stack buckets, delete the Athena workgroup, `cdk destroy`,
then remove the out-of-band resources (sample roles, the QuickSight S3 grant,
the CUR Glue catalog). It also shows how to **keep the CUR export and the
`iamPrincipal/team` cost-allocation tag** so you don't re-pay the ~1-2 day CUR
clock on a later redeploy.

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

## Allowed models (admin allow-list)

Before a team can be given a budget for a model, that model must be on the
**allow-list** — the `Model_Registry` table. This is an intentional gate: it
keeps the budget UI's model picker to the handful of models your org actually
uses, instead of the full account catalog (95+ models on a typical account).

The budget UI has an **Admin — allowed models** section driven by four
dependent dropdowns — **Endpoint → Region → Scope → Model** — because the exact
id a request names (and that usage is attributed to) depends on all of them:

1. **Endpoint.** **Converse** (`bedrock-runtime`) or **Mantle**
   (`bedrock-mantle`). A model can be allowed on both — each is a separate
   entry — because the same model can be served through either, and that's your
   call.
2. **Region.** The AWS Region whose catalog to list. Defaults to the deployed
   Region (where enforcement/logging actually happen). You can browse other
   Regions, but see the caveat below.
3. **Scope** (Converse only). **Regional** (the bare foundation-model id),
   **Cross-region** (a geographic inference profile — `us.`/`eu.`/`apac.`), or
   **Global** (a `global.` inference profile). This matters because, per AWS,
   the closed-weight OpenAI GPT models on Converse *require* an inference-profile
   id, not the bare model id. Mantle has no cross-region inference, so this
   dropdown is hidden there — Mantle ids are always regional.
4. **Model.** Loaded live for the chosen endpoint + region + scope. Allow the
   exact id a team will invoke.

**Where each list comes from:**

- **Converse** uses the control-plane `bedrock:ListFoundationModels` (regional
  ids) + `bedrock:ListInferenceProfiles` (the `us.`/`eu.`/`apac.` = cross-region
  and `global.` = global profiles), classified by id prefix.
  - **The Regional list is filtered to models that actually support on-demand
    (bare-id) invocation in that region.** `ListFoundationModels` advertises a
    model in a region even when the only supported inference type there is
    `INFERENCE_PROFILE` — i.e. the bare id is *not* callable and you must go
    through an `eu.`/`global.` profile. The catalog honours
    `inferenceTypesSupported` and drops any model lacking `ON_DEMAND` from the
    **Regional** scope, so you can't accidentally allow a model that Bedrock
    would then reject at Converse time. A concrete case: in `eu-central-1`
    (Frankfurt) `anthropic.claude-sonnet-5-5` is `INFERENCE_PROFILE`-only, so it
    appears **only** under Cross-region (`eu.anthropic.claude-sonnet-5-5`) and
    Global (`global.anthropic.claude-sonnet-5-5`), never as a bare Regional id.
- **Mantle** uses the endpoint's own OpenAI-compatible `GET /v1/models` — the
  authoritative Mantle surface. That is a bearer-token HTTP API, so the Admin
  Lambda mints a **short-lived, IAM-derived Bedrock token** on demand
  (`@aws/bedrock-token-generator`) and calls `/v1/models` with it. There is **no
  long-lived stored secret** — the token comes from the Lambda's execution role
  and expires within 12 hours. (This needs the role to carry
  `bedrock-mantle:CallWithBearerToken` + `bedrock-mantle:ListModels`, which the
  stack grants.)

Only allowed models appear in the per-team budget picker, shown as **distinct
model ids** labelled with the endpoint(s)/scope each is allowed on — because a
**budget is per (team, model) and endpoint/region-agnostic**: the daily token
quota applies to the model whatever endpoint/region served it, and enforcement
selects the matching Converse/Mantle deny policy from the usage record itself.
An allow-list entry's identity is `(modelId, endpoint, region)`, so the same id
can be allowed in several Regions / on both endpoints as separate entries.

Same thing over the Admin API (what the UI calls):

```bash
ADMIN_FN=$(aws cloudformation describe-stacks --stack-name BedrockTeamTokenQuotaStack \
  --query "Stacks[0].Outputs[?OutputKey=='AdminApiFunctionNameOutput'].OutputValue" --output text)

# List the live catalog for an endpoint + region (Converse adds inference profiles)
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"listModelCatalog","payload":{"endpoint":"bedrock-runtime","region":"us-east-2"}}' out.json && cat out.json
# Mantle variant:
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"listModelCatalog","payload":{"endpoint":"bedrock-mantle","region":"us-east-2"}}' out.json && cat out.json

# Allow a model (carry scope + region; a cross-region id looks like us.anthropic...):
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"putModelRegistryEntry","payload":{"modelId":"us.anthropic.claude-sonnet-4-5-20250929-v1:0","endpoint":"bedrock-runtime","provider":"anthropic","scope":"cross-region","region":"us-east-2"}}' out.json

# See the allow-list
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"listModelRegistry"}' out.json && cat out.json

# Un-allow a model on one endpoint + region
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"deleteModelRegistryEntry","payload":{"modelId":"us.anthropic.claude-sonnet-4-5-20250929-v1:0","endpoint":"bedrock-runtime","region":"us-east-2"}}' out.json
```

> **Single-region enforcement.** The region picker lets you *browse and
> whitelist* any Region's models, but this stack enforces and logs only in the
> Region it is deployed to. Whitelisting a different Region's id does not make
> enforcement work there unless you also deploy the stack in that Region. For
> real enforcement, whitelist ids for the deployed Region (the default).

> **Catalog vs account enablement.** `listModelCatalog` returns the ids that
> *exist* for the endpoint/region. Whether a model is also *enabled* for the
> account (Bedrock "model access") is a separate account-level setting with no
> cheap batch API, so the allow-list does not pre-check it — if you allow and
> budget a model the account hasn't enabled, the budget simply never gets
> exercised until the model is enabled and invoked.

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
(manually restores access before the next day's automatic reset). See
`src/adminApi.ts` for each operation's exact request/response shape.

If no quota is configured for a `(team, model)` pair, that team is
**unrestricted** for that model — usage is still tracked, but nothing is
ever enforced. A quota of `0` is rejected as invalid (use `removeDenyPolicy`
or delete the quota entry to make a team unrestricted instead).

## Budget UI (web/)

`web/` is a small React + Vite app for setting and modifying per-team,
per-model daily budgets from a browser instead of hand-crafting Admin API
payloads. It signs in through **Amazon Cognito** (User Pool for login, an
Identity Pool that vends short-lived, scoped AWS credentials), then
SigV4-signs its calls to the Admin API — no AWS credentials are ever typed
into the app.

The stack provisions the Cognito resources automatically. Sign-up is
**disabled by design** (budget administration controls spend), so you
create the first admin user yourself with the AWS CLI, as described below.

### 1. Configure the app

The deploy writes the Cognito/API IDs to the CDK outputs. Copy
`web/.env.example` to `web/.env` and fill in the values from your
`cdk deploy` output (`--outputs-file cdk-outputs.json` captures them):

```bash
cd web
cp .env.example .env
# then edit .env:
#   VITE_AWS_REGION           -> your deploy region (e.g. us-east-2)
#   VITE_ADMIN_API_ENDPOINT   -> AdminApiEndpointOutput
#   VITE_USER_POOL_ID         -> AdminUserPoolIdOutput
#   VITE_USER_POOL_CLIENT_ID  -> AdminUserPoolClientIdOutput
#   VITE_IDENTITY_POOL_ID     -> AdminIdentityPoolIdOutput
```

These IDs are not secrets (they are safe to ship in a browser bundle), but
`.env` is gitignored regardless.

### 2. Create an admin user

There is no self-service sign-up — an operator provisions each user. Create
one with the AWS CLI, substituting your User Pool ID (the
`AdminUserPoolIdOutput` value) and the login email:

```bash
# Point the CLI at the account/region you deployed to first, e.g.:
export AWS_PROFILE=your-profile-name
export AWS_REGION=us-east-2

USER_POOL_ID=<AdminUserPoolIdOutput>   # e.g. us-east-2_XXXXXXXXX
EMAIL=admin@example.com

# 1. Create the user (SUPPRESS = don't send a Cognito invitation email).
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS

# 2. Set a permanent password (so there's no forced-reset step on first login).
#    Must satisfy the pool's policy: >= 12 chars, upper + lower + digit + symbol.
aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --password '<a-strong-password>' \
  --permanent

# 3. (Optional) Add the user to the budget-admins group.
aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --group-name budget-admins
```

> If you omit step 2, Cognito instead issues a temporary password and forces
> a password change on first sign-in. Using `--message-action SUPPRESS`
> without setting a permanent password therefore leaves the user unable to
> log in — set the password explicitly (step 2) or drop `SUPPRESS` so the
> temporary password is emailed.

To rotate or reset a password later, re-run step 2 with a new value.

### 3. Run the app

```bash
cd web
npm install
npm run dev        # http://localhost:5173
npm run build      # production bundle in web/dist/
```

Open the dev URL, sign in with the user you created, pick a team (or type a
new one), and set or modify its per-model budgets. The team picker and the
model dropdown are both populated from the Admin API — see below for exactly
where each list comes from.

### Where the team list comes from

Everything here operates at the **team** level, never the individual-user
level. A "team" is just a `team` tag value on an IAM role (see "How it works"
above); it can represent many people or a single person (a "team of one").
The budgets you set in this UI apply to the team as a whole — all roles/users
sharing that `team` tag draw down the same daily allowance.

The team picker is **not** a directory of every team in your organization. It
is the **union** of two Scan-free sources:

- Teams that already have at least one **budget** configured — from
  `Quota_Configuration` via its `TeamListIndex` GSI.
- Teams **discovered from IAM role tags** — from `Team_Role_Cache` via its
  `RoleListIndex` GSI (populated when a role calls Bedrock, is tagged, or is
  found by the on-demand reconcile sweep).

The UI calls the Admin API `listTeams` operation, which queries both GSIs
(single bounded `Query` each — never a `Scan`), dedupes, and sorts.

Practical consequences:

- A team appears in the picker once it has **either** a budget **or** a
  tagged/discovered role — so a team you just reconciled shows up for
  budgeting even before it has any quota.
- You can always **type a brand-new team name** that isn't in the list.
  Saving a budget for it creates the team's first quota entry.
- The model dropdown is separate: it's populated from the **allow-list**
  (`listModelRegistry` — see "Allowed models" above), i.e. the models an admin
  has explicitly allowed. Each distinct model is labelled with the endpoint(s)
  it's allowed on — **Converse**, **Mantle**, or both. If the allow-list is
  empty the picker falls back to a free-text model-id input.

#### Why `UNMAPPED` can show up as a "team"

`UNMAPPED` is a **sentinel**, not a real team. It is the bucket the system uses
for any Bedrock usage it **could not attribute to a team** — i.e. a call made
by an IAM role that has **no `team` tag**. Usage is never silently dropped;
untagged usage is counted under `UNMAPPED` so it stays visible.

How it ends up in the picker, step by step:

1. Something calls Bedrock using a role (or your own IAM principal) that has
   **no `team` tag** — commonly an admin running a quick `aws bedrock-runtime
   converse` directly, rather than through a team-tagged role.
2. Model Invocation Logging delivers that call's log to S3; `Usage_Collector`
   processes it and asks `resolveTeam()` which team the caller belongs to.
3. `resolveTeam` reads the role's tags, finds no `team` tag, and returns the
   sentinel `UNMAPPED` (caching that result in `Team_Role_Cache`).
4. The usage is recorded under `TEAM#UNMAPPED#...` in `Usage_Aggregation`, and
   `UNMAPPED` is now a value in the cache's discovered-teams index — so
   `listTeams` surfaces it in the picker.

**What it means / what to do:** a little `UNMAPPED` usage during testing is
normal (e.g. a direct admin call). Sustained `UNMAPPED` usage in production is a
signal that real workloads are calling Bedrock from **untagged roles**, so that
spend isn't being attributed or enforced — fix it by tagging those roles with
`team` (or mapping them via the role-mapping panel). You generally would **not**
set a budget on `UNMAPPED` itself; treat it as a "please tag these roles" flag.

### How a budget maps to Converse vs Mantle

A budget is always the same thing — a **daily token count** (input + output)
for a `(team, model)` pair, and it is **endpoint-agnostic**: there is no
separate "Mantle budget" vs "Converse budget"; the number means the same on
both, and a model allowed on both endpoints still has one budget. What differs
is the plumbing underneath, selected **per usage record** by the endpoint that
served it: usage tracking and enforcement each branch on that endpoint (the
allow-list records which endpoints a model may be used on; each incoming usage
record carries the endpoint it actually came from, which selects the matching
deny policy).

| | **Converse** (`bedrock-runtime`) | **Mantle** (`bedrock-mantle`) |
|---|---|---|
| What it serves | `InvokeModel`/`Converse` family | OpenAI/Anthropic-compatible open-weight models |
| Where token counts come from | Model Invocation Logging → S3 (per-request `inputTokenCount`/`outputTokenCount`) | `AWS/BedrockMantle` CloudWatch metrics (`TotalInputTokens`/`TotalOutputTokens`, dimensioned by `Project`/`ModelId`) |
| How usage is attributed to a team | the `team` tag on the calling IAM role | the **Team↔Project mapping** (Mantle has no per-request identity log), so each Mantle `Project` must be mapped to a team via the `putTeamProjectMapping` admin op |
| How a breach is enforced | inline IAM **deny** on `bedrock:InvokeModel`/Converse actions for that model's ARN | inline IAM **deny** on the Mantle inference action, scoped to that model |

Practical implication for the UI: for a **Mantle** model, usage only shows up
(and enforcement only works) once the model's `Project` is mapped to the team
— otherwise its CloudWatch metrics can't be attributed to anyone. Setting a
budget alone is not enough for Mantle. For **Converse** models, the role's
`team` tag is sufficient; no mapping step is needed.

### Seeding / backfilling the team list

- **Fresh deployment:** nothing to seed. `Quota_Configuration` starts empty,
  so the budget side of the picker starts empty and fills in as you set
  budgets. The discovered-teams side fills in as roles call Bedrock, get
  tagged, or are picked up by a reconcile sweep. Both empty on first run is the
  expected state, not an error.
- **Discovered teams (role side):** these come from `Team_Role_Cache`'s
  `RoleListIndex`, which only indexes cache rows written by this version
  onward. After upgrading, run one **reconcile** (Team → IAM role mapping →
  "Refresh from IAM") to re-write existing cache rows so discovered teams
  appear — same backfill note as the role-mapping view above.
- **Upgrading an existing deployment:** the `TeamListIndex` GSI only indexes
  quota items that carry its key attributes, which are written on every
  `putQuota` from this version onward. Any budgets that were set **before**
  this version predate those attributes, so those teams won't appear in the
  picker until each quota row is re-written once. Two ways to backfill:

  1. **Re-save each budget in the UI** (load the team, click Save) — fine for
     a handful of teams, but you must already know the team names.
  2. **One-time migration script** that rewrites every existing quota row,
     adding the index attributes. This is operational tooling, so it uses a
     one-off `Scan` of the config table (the application itself never scans):

     ```bash
     export AWS_PROFILE=your-profile-name
     export AWS_REGION=us-east-2
     TABLE=Quota_Configuration

     # For every existing quota item, set teamListPk + team so it lands in the
     # TeamListIndex GSI. Derives the raw team name from the PK ("TEAM#<team>").
     aws dynamodb scan --table-name "$TABLE" \
       --projection-expression "PK,SK" --output json \
     | python -c '
     import json, subprocess, sys, os
     items = json.load(sys.stdin)["Items"]
     table = os.environ["TABLE"]
     for it in items:
         team = it["PK"]["S"].split("TEAM#", 1)[-1]
         subprocess.run([
             "aws","dynamodb","update-item","--table-name",table,
             "--key", json.dumps(it),
             "--update-expression","SET teamListPk = :p, team = :t",
             "--expression-attribute-values",
             json.dumps({":p":{"S":"TEAM"},":t":{"S":team}}),
         ], check=True)
     print(f"backfilled {len(items)} quota item(s)")
     '
     ```

  After backfilling, the previously-configured teams appear in the picker.

### Mapping IAM roles to teams

Enforcement needs to know **which IAM roles belong to a team** so it can
attach the deny policy to the right roles when a budget is exceeded. That
role→team mapping lives in the `Team_Role_Cache` table and is populated
**automatically** in two ways, with no operator action:

- **On use:** when a role makes a Bedrock call, `Usage_Collector` resolves
  that role's `team` tag and caches the mapping.
- **On tag:** a CloudTrail `TagRole` event warms the cache the instant a role
  is tagged with a `team` value.

For the common case you never touch this. The budget UI's **"Team → IAM role
mapping"** panel exists only for two edge cases:

**Option A — Refresh everything from IAM (on-demand background job).**
Scans every IAM role in the account and re-reads its `team` tag, correcting
any drift — e.g. you changed a role's `team` tag **directly in IAM**, outside
the normal call/tag flow, so the cache went stale. Key properties:

- **There is no automatic schedule.** Earlier versions ran a full
  `iam:ListRoles` sweep every 15 minutes; that was removed because, on
  accounts with many roles, it makes one `iam:GetRole` + `iam:ListRoleTags`
  call *per role* and quickly hits IAM throttle limits. It now runs **only
  when you click the button.**
- **It runs as a background SQS fan-out, not inside the HTTP request.**
  Clicking the button calls the Admin API, which enqueues one SQS message and
  returns a `jobId` immediately (sub-second). A dedicated **reconcile worker
  Lambda** then drains the queue: each invocation processes exactly **one**
  `iam:ListRoles` page, re-reads that page's roles' tags, updates the cache
  (see next bullet), and — if more pages remain — **re-enqueues itself** with
  the next pagination marker. The chain continues until every page is done.
  Because each
  invocation is bounded to a single page, it always finishes far under the
  Lambda timeout no matter how many thousands of roles the account has (the
  old synchronous path hit API Gateway's 29-second limit on large accounts —
  this removes that ceiling entirely).
- **It only stores genuinely team-mapped roles.** For each role the sweep
  either **upserts** a cache row (role has a `team` tag) or **deletes** any
  existing row (role has no `team` tag). It deliberately does **not** write an
  `UNMAPPED` placeholder for untagged roles — on a real account the vast
  majority of roles (service-linked roles, etc.) have no `team` tag and will
  never call Bedrock, so caching them would be pure noise and save nothing.
  The delete branch also corrects drift when a `team` tag is **removed** from a
  role directly in IAM. So the job's `rolesProcessed` counter reflects how many
  **team-mapped** roles were found, while `pageCount` reflects how many pages
  were scanned — on an account with no tagged roles yet, a complete sweep
  correctly reports `0 roles across N pages`. (The per-request path is separate
  and still negative-caches `UNMAPPED` for roles that actually invoke Bedrock,
  where that cache avoids repeat IAM lookups.)
- **Serial by design (worker reserved concurrency = 1).** The worker runs one
  page at a time, never two in parallel, which keeps the sweep gentle on IAM's
  read rate limits. A dead-letter queue (`...-ReconcileDLQ`) catches any page
  that fails repeatedly so a single poison page can't block the queue.
- **Progress via polling, not a held connection.** The job's status (`running`
  → `complete`/`failed`, with running `rolesProcessed`/`pageCount` counters) is
  written to a small `Reconcile_Job` DynamoDB row (24h TTL). The UI polls it
  every ~2 seconds via the Admin API `getReconcileJob` operation and shows live
  progress; you can leave the panel and the job keeps running server-side.
- **Cost/latency:** read-only against IAM but consumes IAM API quota
  proportional to the number of roles, so a full sweep of a large account can
  take a few minutes of background work. Run it deliberately, not routinely.

**Option B — Map one role directly (no IAM scan).**
Registers a single role→team mapping with one write and **zero IAM calls**.
Prefer this if you manage roles explicitly, or simply don't want to scan the
whole account to onboard one role. In the panel, paste the role ARN and the
team name. (You can also call the Admin API `mapRoleToTeam` operation
directly.)

> **Important:** Option B writes the enforcement cache only — it does **not**
> add the `team` tag to the IAM role. The role should still carry the matching
> `team` tag, because **CUR cost attribution reads the IAM tag**, not this
> cache. Option B is about enforcement knowing the mapping immediately; the
> tag is what makes the role's spend show up per-team in CUR.

### Testing the Option A reconcile sweep (sample roles)

To see Option A actually discover teams, you need some IAM roles that carry a
`team` tag. Two already-tagged roles exist/appear naturally:

- **`Bedrock_Test_Role`** — created by the stack itself, tagged
  `team=test-team` (the fixture the CLI test tool assumes). A reconcile will
  always find this one.
- Any role that has already **called Bedrock** gets cached the per-request way,
  independent of the sweep.

For a clearer multi-team demo, create a few throwaway roles that are tagged but
do nothing else — the reconcile only reads their `team` tag, so they need **no
trust relationship you'll use and no permissions**:

```bash
export AWS_PROFILE=...                      # your admin profile
export AWS_REGION=us-east-2                  # match your deployment
# A principal ARN for the (unused) trust policy — your own is fine:
TRUST=$(aws sts get-caller-identity --query Arn --output text)
DOC=$(printf '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"%s"},"Action":"sts:AssumeRole"}]}' "$TRUST")

for T in alpha beta gamma; do
  aws iam create-role --role-name "SampleTeamRole-$T" \
    --assume-role-policy-document "$DOC" \
    --description "Sample team fixture for reconcile testing (team=$T). Safe to delete." \
    --tags Key=team,Value=$T
done
```

Now press **"Refresh team→role mapping from IAM"** in the UI (Option A), or call
the Admin API directly:

```bash
ADMIN_FN=$(aws cloudformation describe-stacks --stack-name BedrockTeamTokenQuotaStack \
  --query "Stacks[0].Outputs[?OutputKey=='AdminApiFunctionNameOutput'].OutputValue" --output text)

# Start the background job -> returns a jobId
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"reconcileTeamRoles"}' out.json && cat out.json
# -> {"ok":true,"data":{"jobId":"...."}}

# Poll until status is "complete" (repeat with the jobId from above)
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"getReconcileJob","payload":{"jobId":"<jobId>"}}' out.json && cat out.json
```

**What to expect.** `rolesProcessed` counts only **team-mapped** roles found
(here it climbs to include your `alpha`/`beta`/`gamma` roles plus
`test-team`), while `pageCount` counts the IAM pages scanned (one per ~100
roles in the account). When it reaches `"status":"complete"`, the
`Team_Role_Cache` table holds exactly those tagged roles and nothing else —
every untagged role in the account was deliberately *not* cached (see the
upsert/delete behavior above). You can confirm:

```bash
aws dynamodb scan --table-name Team_Role_Cache --projection-expression "PK,team" --output json
# -> only your tagged roles (ROLE#...SampleTeamRole-alpha -> alpha, etc.) + Bedrock_Test_Role
```

To also exercise **enforcement/usage** (real Bedrock traffic, quotas, deny
policies, dashboards) rather than just the mapping, follow
**[DEPLOY.md → Part 5](./DEPLOY.md#part-5--generate-team-tagged-usage-and-verify-enforcement)**,
which creates tagged roles and sends live `Converse` calls.

> **Clean up the sample roles when done** (they are out-of-band — the stack
> does not manage them, so `cdk destroy` will not remove them):
>
> ```bash
> for T in alpha beta gamma; do
>   aws iam delete-role --role-name "SampleTeamRole-$T"
> done
> ```
>
> After deleting them, a subsequent reconcile will drop their rows from
> `Team_Role_Cache` automatically (the sweep deletes the cache entry for any
> role it can no longer find tagged). This cleanup is also covered in the
> [Tearing it down](#tearing-it-down) section's out-of-band resources.

### Security notes

- **MFA is off by default** to keep first-login friction-free for demos.
  Before any real/customer use, set `Mfa.REQUIRED` on the `UserPool` in
  `infra/stack.ts` (TOTP is already configured) and redeploy.
- The authenticated Identity Pool role is scoped to **only**
  `execute-api:Invoke` on the Admin API's `POST /admin` method — signing in
  grants nothing else in the account.
- The Admin API itself remains IAM-authorized; the browser's CORS calls are
  SigV4-signed with the Cognito-vended temporary credentials.

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

## Cost: where dollars come from (CUR 2.0)

This system keeps **tokens and dollars on separate rails**, each from the
source that is authoritative for it:

- **Tokens → enforcement** (within minutes). The token pipeline (Model
  Invocation Logging → `Usage_Collector` → `Usage_Aggregation`) tracks token
  counts per team/model/day and drives quota enforcement. Enforcement works
  on raw token budgets — it never needs a dollar figure.
- **Dollars → cost dashboards** (CUR 2.0, ~24h latency). Actual billed cost
  comes straight from the **AWS Cost and Usage Report (CUR 2.0)**, attributed
  per team via the `team` IAM-principal cost-allocation tag. No rates are
  computed or stored anywhere in this system — the dollar figure is the one
  AWS actually billed, including any discounts or savings plans.

There is deliberately **no rate card** and no `tokens × rate` estimation. A
derived estimate would only ever approximate a number CUR already provides
exactly, so cost reporting reads CUR directly.

> **Why some cost shows up as `UNTAGGED` (and how it differs from `UNMAPPED`).**
> The Billed Cost view groups by the `iamPrincipal/team` tag in CUR. A line item
> has **no** team value — bucketed as `UNTAGGED` — for either of two reasons:
> (a) the calling role had no `team` tag, **or** (b) the usage was billed
> *before* the tag was activated. **Cost-allocation tags are not retroactive**,
> so all pre-activation Bedrock spend stays `UNTAGGED` even if the role carried a
> `team` tag at the time — on a fresh install your entire history is `UNTAGGED`,
> and only usage billed *after* activation attributes to a team. (The line
> item still records the caller in `line_item_iam_principal`, so you can group
> historical spend by principal even when the team tag is absent.) This is
> distinct from `UNMAPPED` on the **token** rail, which specifically means a
> role with no `team` tag — see
> [Why `UNMAPPED` can show up](#why-unmapped-can-show-up-as-a-team). Both are
> expected, not errors.

### Where CUR lives, and what access this stack needs

Before the setup steps, here is the whole data-flow and permission picture in
one place, because CUR touches several accounts-level resources this stack does
**not** own:

**Who creates/owns what:**

| Thing | Created by | Lives in | Owned by |
|---|---|---|---|
| CUR 2.0 export definition | **You** (one-time, §setup below) | `us-east-1` (BCM Data Exports is us-east-1-only) | your account |
| CUR data (Parquet files) | AWS Billing, on a schedule | the **CUR S3 bucket** you create (e.g. `bedrock-cur2-export-<acct>`), `us-east-1` | your account |
| Glue database + table over the CUR | **You** (one-time, via a Glue crawler — AWS does **not** create it for CUR 2.0; see CUR Step 4) | AWS Glue Data Catalog, your stack's region | your account |
| `iamPrincipal/team` cost-allocation tag activation | **You** (one-time) | AWS Billing | your account |
| The per-team cost **Lambda** + its reads | **this stack** (opt-in) | the stack's region | this stack |
| The derived `cur-team-cost/` output | this stack's Lambda | the stack's **analytics bucket** | this stack |

**This stack does NOT create the CUR export, its bucket, the Glue table, or the
cost-allocation tag.** Those are account-level, must exist first, and are set up
once by you (the walkthrough below). The stack only *reads* them, and only when
you opt in by passing `CUR_DATABASE_NAME` + `CUR_TABLE_NAME` + `CUR_BUCKET_NAME`.

**Exactly what access the stack's CUR cost Lambda is granted** (least-privilege,
only created when the CUR props are set — see `CurTeamCostFunction` in
`infra/stack.ts`):

- **Athena** — `StartQueryExecution` / `GetQueryExecution` / `GetQueryResults`
  (Resource `*`; Athena has no resource-level ARN for these). It queries the CUR
  through Athena rather than reading Parquet directly.
- **Glue** — `GetTable` / `GetDatabase` / `GetPartitions`, scoped to exactly the
  CUR database + table you named (`CUR_DATABASE_NAME` / `CUR_TABLE_NAME`). Read
  metadata only — no write, no other tables.
- **S3 (analytics bucket)** — `GetObject` / `ListBucket` / `GetBucketLocation` /
  `PutObject` on the stack's **analytics bucket** (to stage Athena results under
  `athena-results/` and write the derived per-team cost under `cur-team-cost/`).
- **S3 (CUR bucket, read-only)** — `GetObject` / `ListBucket` / `GetBucketLocation`
  on the bucket you pass as `CUR_BUCKET_NAME` and nothing else. Athena reads the
  CUR Parquet files with the Lambda's own credentials, so without this the query
  fails with `not authorized to perform: s3:ListBucket` (we hit exactly this on
  the first live deploy).

**One access detail to get right:** Athena, when it runs the query, reads the
CUR Parquet files from the **CUR bucket** using the Lambda's credentials (granted
by `CUR_BUCKET_NAME`, above). If the CUR bucket is in
a **different region** (us-east-1) than the stack, cross-region Athena/Glue
still works because the Glue catalog and CUR are account-global, but the Lambda
runs Athena **in the stack's region** against a Glue table registered there. In
practice: register/point at the Glue database+table that Data Exports created
(step 4), and if the cost Lambda returns empty or an access error, confirm the
Glue table's S3 `LOCATION` points at the CUR bucket you passed as
`CUR_BUCKET_NAME`. The stack grants the Lambda read on that bucket; the CUR
bucket + Glue table are the account-owned pieces that must line up.

**Nothing dollar-related is stored by this stack except the derived output.**
The raw CUR stays in your CUR bucket; the stack only writes the small
per-team-cost rollup into its analytics bucket for the dashboard to read.

### What CUR 2.0 integration adds

When `curDatabaseName` + `curTableName` are set, the stack deploys one
scheduled Lambda (every 6 hours):

- **CUR Per-Team Cost** — queries CUR 2.0 via Athena for Bedrock billed cost
  per team (grouped by model and endpoint), using the `iamPrincipal/team`
  cost-allocation tag, and writes the result to `s3://<analyticsBucket>/cur-team-cost/dt=<day>/`.
  A Glue table (`cur_team_cost`) is created over it, so a QuickSight dataset /
  visual can show **AWS-billed dollars per team** directly.

Token usage (for enforcement monitoring, the enforcement-audit view, and the
currently-blocked view) is exported separately by the always-on analytics
export Lambda to `token-usage/`, `enforcement-audit/`, and `blocked-state/`.
Those carry token counts only — no cost.

### CUR 2.0 setup walkthrough (one-time, per account)

**CUR 2.0 is an AWS account prerequisite, not part of installing this solution**
— many orgs already run a CUR 2.0 export for FinOps. The step-by-step CLI
(create the export **with IAM principal data**, activate the `iamPrincipal/team`
cost-allocation tag, catalog the CUR in Glue, point the stack at it) lives in the
deploy runbook:
**[DEPLOY.md → Part 1](./DEPLOY.md#part-1--start-the-cur-20-export-do-this-first)**
(create the export — do this first) and
**[Part 7](./DEPLOY.md#part-7--dollar-dashboards-from-cur-20-next-day)** (activate
the tag, catalog, redeploy). The ownership/access model and what the integration
adds are the two subsections above.

### Bedrock cost management references

This solution builds on Amazon Bedrock's native cost management features. The
following documentation informed the design:

- [Track usage and costs in Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-management.html) —
  overview of all cost-attribution mechanisms (IAM principal, application
  inference profiles, Projects, per-request metadata tagging) and when to use
  each. This project uses IAM principal attribution (the `team` tag on the
  calling role) for team-level cost.
- [Understanding your Bedrock Cost and Usage Report data](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-understanding-cur-data.html) —
  the CUR 2.0 column reference for Bedrock: usage-type patterns, the four
  token types, service tiers, and cost-allocation tags. This is the schema the
  CUR per-team cost Lambda parses.
- [Bedrock cost management FAQ](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-faq.html) —
  common questions about combining Bedrock cost-attribution approaches.
- [Using IAM principal for cost allocation](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-iam-principal.html) —
  how to enable IAM principal data in CUR 2.0 so per-user/per-role Bedrock
  spend is visible.
- [Optimize LLM Costs on Amazon Bedrock: From Billing Attribution to Operational Telemetry](https://aws.amazon.com/blogs/aws-cloud-financial-management/optimize-llm-costs-on-amazon-bedrock-from-billing-attribution-to-operational-telemetry/) —
  AWS blog post describing the three-layer observability framework (native
  metrics → CUR attribution → operational telemetry) that informed this
  project's CUR integration and token-tracking pipeline.
- [Effective cost optimization strategies for Amazon Bedrock](https://aws.amazon.com/blogs/machine-learning/effective-cost-optimization-strategies-for-amazon-bedrock/) —
  AWS blog post on cost monitoring approaches including application inference
  profiles, CloudWatch metrics, and integration with AWS cost tools.
- [Amazon Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/) —
  the official Bedrock pricing page (on-demand rates by model, service tier,
  and token type).

## Generating sample usage data for the dashboards

To populate the dashboards on a fresh deploy, generate team-tagged usage as in
**[DEPLOY.md → Part 5](./DEPLOY.md#part-5--generate-team-tagged-usage-and-verify-enforcement)**
(create a few `team`-tagged roles, send real `Converse` calls), then run the
analytics export (**[Part 6a](./DEPLOY.md#part-6--token-usage-quicksight-dashboards)**).
Usage from a role with no `team` tag is bucketed as `TEAM#UNMAPPED#…` — correct,
not an error. Mantle has no per-request log; its usage comes from real Mantle
invocations (see
[How a budget maps to Converse vs Mantle](#how-a-budget-maps-to-converse-vs-mantle)).

## Known limitations / follow-ups

- **IAM permission gaps are an easy mistake when extending this stack.**
  A Lambda's event-source wiring (e.g. an S3 notification) and its
  execution-role permissions (e.g. `s3:GetObject` on the bucket) are
  configured independently, so a Lambda can be triggered correctly yet
  still fail at runtime with `AccessDenied` — and Lambda's built-in async
  retries can mask that failure everywhere except CloudWatch Logs. When
  you add a new Lambda/event-source pairing, verify the execution role
  grants every action the handler actually calls, not just the trigger
  wiring; `cdk diff`/`synth` won't catch a missing runtime permission.
- **Bedrock Model Invocation Logging delivers S3 objects gzip-compressed**
  (`.json.gz`), not as plain text. `usageCollectorEntry.ts` detects this
  via the gzip magic-byte header and decompresses before parsing; if
  you're testing with hand-crafted S3 objects, either gzip them or rely on
  the plain-text fallback path (both are covered by
  `usageCollectorEntry.test.ts`).
- **Athena/ad-hoc querying** over the raw S3 invocation log archive was
  deliberately left out of the *usage-tracking* pipeline in favor of the
  event-driven streaming pipeline described above (needed to hit the 5-minute
  freshness target). Athena *is* used by the CUR 2.0 integration to query
  the Cost and Usage Report (per-team billed cost) and by QuickSight for the
  dashboards. It's a natural future addition for longer-horizon ad-hoc
  reporting over the raw logs.
- **Dependency vulnerabilities**: `npm audit --omit=dev` reports **0 vulnerabilities**
  for the production/runtime tree (nothing shipped in any Lambda bundle or the web app
  is affected). A full `npm audit` reports ~20 **moderate**, **dev-only** findings that
  all trace to a single root cause: jest's coverage tooling (`babel-plugin-istanbul` →
  `@istanbuljs/load-nyc-config`) pins `js-yaml@3.x`, which pulls `argparse@1.x` →
  `sprintf-js`. `@istanbuljs/load-nyc-config` is effectively dormant and depends on the
  `js-yaml` 3.x API, so these can't be force-upgraded without breaking coverage, and
  npm's only offered "fix" is to *downgrade* `ts-jest` — not worth it. They are
  build-time only and never reach a deployed artifact.
  - **`brace-expansion` (bundled in `aws-cdk-lib`)**: the advisory range
    (`4.0.0 - 5.0.11`, GHSA-q2hr-2g5m-vwhr / GHSA-qhr7-859c-m2p7 / GHSA-6j4f-fj2g-mc7p)
    covers a *bundled* copy inside the `aws-cdk-lib` tarball that npm `overrides` can't
    reach, and AWS hasn't yet shipped a CDK release with a fixed bundle. It's closed at
    install time by a `postinstall` hook (`scripts/fixBundledDepAuditMetadata.js`): the
    script copies the fixed `brace-expansion@5.0.12` that `overrides` pins at the top
    level over the bundled copy, then reconciles the lockfile metadata `npm audit`
    reads. 5.0.12 is API-compatible with the bundled 5.0.x line, so CDK synth is
    unaffected (verified). The step is idempotent and survives a clean
    `rm -rf node_modules && npm install`. If a future `aws-cdk-lib` bundles a
    non-vulnerable `brace-expansion`, the override and script become no-ops and can be
    removed.

## Troubleshooting

### Budget UI shows "Network/CORS error" or `No 'Access-Control-Allow-Origin' header` after a redeploy

If you tore down and redeployed the stack (or otherwise replaced the Cognito
User Pool / Identity Pool), the budget UI may fail every Admin API call in a
browser that was previously signed in — typically surfacing as a CORS or
`NetworkError`, even though CORS is configured correctly.

**Why:** the `POST /admin` method is IAM-authorized (SigV4). The browser signs
it with short-lived credentials vended by the Cognito Identity Pool. Amplify
**caches the previous pool's tokens** in the browser (localStorage/IndexedDB).
After a redeploy those tokens belong to a *deleted* pool, so the signed request
fails authorization — and API Gateway does **not** attach
`Access-Control-Allow-Origin` to 4xx auth error responses, so the browser
reports it as a CORS/network failure rather than an auth failure. (The
unauthenticated `OPTIONS` preflight still succeeds, which is why the preflight
looks fine.)

**Fix:** clear the stale session. Any of these works:

- Open the app in a **private/incognito window** (no cached tokens), or
- DevTools → **Application → Storage → "Clear site data"** for the dev origin,
  then hard-reload (Ctrl+Shift+R) and sign in again, or
- Sign out in the app, then hard-reload.

Also make sure `web/.env` points at the **new** stack outputs (regenerate it
from `cdk-outputs.json` after the redeploy) and restart `npm run dev` so Vite
picks up the new Cognito/API IDs.

> How to confirm it's this and not a real CORS bug: in DevTools → Network, the
> failing request is the **POST** (not the OPTIONS preflight), and a direct
> `curl -i -X OPTIONS <endpoint>` returns `204` with
> `Access-Control-Allow-Origin: *`. That proves the API's CORS is fine and the
> problem is the signed POST failing auth with stale credentials.

### `CredentialsProviderError` on Windows even though the AWS CLI works

If `aws sts get-caller-identity --profile <name>` works but SDK-based tools
(the CDK CLI, `npm run test:tokens`, etc.) fail with
`CredentialsProviderError: Could not load credentials from any providers`
for the same profile, this is very likely a `HOME` resolution mismatch, not
a config-file problem.

The AWS SDK for JavaScript resolves your home directory (and therefore both
`~/.aws/config` and the SSO token cache at `~/.aws/sso/cache/`) via the
`HOME` environment variable, falling back to `HOMEDRIVE`+`HOMEPATH` if
`HOME` is unset — it does **not** use `USERPROFILE`, which is what the AWS
CLI and Node's own `os.homedir()` use. On Windows machines where
`HOMEDRIVE`/`HOMEPATH` point somewhere different from `USERPROFILE` (e.g. a
mapped/redirected home drive), the SDK silently reads the wrong (or an
empty) config and SSO cache. Fix: set `HOME` to match `USERPROFILE`.

- **cmd/PowerShell**: `setx HOME "%USERPROFILE%"` (or the literal path,
  e.g. `setx HOME "C:\Users\yourname"`), then open a **new** terminal —
  `setx` never updates the terminal you ran it in.
- **git-bash/MINGW64**: bash resolves `$HOME` independently of the Windows
  env var, so `setx` alone won't fix it here. Add
  `export HOME="/c/Users/yourname"` (bash-style path) to `~/.bashrc` or
  `~/.bash_profile`, or `export` it manually each session.
- Verify with `node -e "console.log(require('os').homedir())"` (should
  match `USERPROFILE`) vs. what the SDK sees — if they disagree, that's the
  mismatch to fix.
