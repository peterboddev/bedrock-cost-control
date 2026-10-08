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

### Full deploy-and-test walkthrough (A-Z, in order)

Follow this top to bottom to stand up and verify the **whole** solution on a
clean account. It is the exact order the maintainers ran, verified end to end.
Each step says what to run and how to **confirm it worked** before moving on.
The detailed topic sections further below expand on each step.

The only part with a long clock is CUR dollar cost — so you **start CUR first**
(step B), let AWS churn on it for a day, and finish it last (step I). Everything
in between is same-day and gives a fully working product (tokens, enforcement,
dashboards) within minutes.

```bash
# Set once, used throughout:
export AWS_PROFILE=your-profile-name
export AWS_REGION=us-east-2        # your deploy/stack region
export TEST_ROLE_TRUSTED_PRINCIPAL_ARNS="arn:aws:iam::<account-id>:role/<your-sso-or-iam-principal>"
ACCT=$(aws sts get-caller-identity --query Account --output text)
```

**A. Prerequisites.** Node 20+, AWS CLI configured, Bedrock **model access**
enabled for the model(s) you'll test (Bedrock console → Model access), and — if
you want dashboards — an existing **QuickSight** subscription with a user.

**B. Start CUR enablement NOW (longest clock — do it first, then move on).**
Only if you want the dollar-cost view. Create the CUR bucket and export (full
commands + bucket policy in
[CUR 2.0 setup walkthrough](#cur-20-setup-walkthrough-one-time-per-account),
Steps 1-2). **The export must be created with IAM principal data
(`INCLUDE_IAM_PRINCIPAL_DATA=TRUE`)** — the Step 2 commands do this; without it
per-team dollars can never appear. If your account **already** has a CUR 2.0
export, check it has that option:
`aws bcm-data-exports get-export --region us-east-1 --export-arn <arn> --query "Export.DataQuery.TableConfigurations.COST_AND_USAGE_REPORT.INCLUDE_IAM_PRINCIPAL_DATA"`
must print `TRUE`; if not, create a new export (see "Already created the
export without IAM principal data?" in that walkthrough). This starts the AWS
billing clock. Do **not** wait on it — continue to step C immediately.

**C. Deploy the core stack.**

```bash
npm install
npx cdk deploy --require-approval never --outputs-file cdk-outputs.json
```

*Confirm:* ends with `✅ BedrockTeamTokenQuotaStack` and writes
`cdk-outputs.json`. You now have the Admin API endpoint, Cognito ids, and bucket
names in that file.

**D. Create the admin user + web config.** Read ids from `cdk-outputs.json`.

```bash
USER_POOL_ID=<AdminUserPoolIdOutput>
EMAIL=admin@example.com
aws cognito-idp admin-create-user --user-pool-id "$USER_POOL_ID" --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id "$USER_POOL_ID" --username "$EMAIL" \
  --password '<a-strong-password>' --permanent
aws cognito-idp admin-add-user-to-group --user-pool-id "$USER_POOL_ID" --username "$EMAIL" --group-name budget-admins
# Write web/.env from the cdk outputs (see "Budget UI (web/)" for the exact keys), then:
cd web && npm install && npm run dev     # http://localhost:5173
```

*Confirm:* sign in at the dev URL; the UI loads with empty team/model lists
(expected on a fresh deploy).

**E. Allow some models (so teams can be budgeted).**

*Default (UI):* in the UI's **Admin — allowed models** section, pick Endpoint →
Region → (Converse) Scope → **Load models** → pick a model → **Allow**.

*Alternative (CLI):* the UI's **Allow** button just calls the
`putModelRegistryEntry` Admin API op — you can do the same from the shell (this
is the exact command the maintainers run in a headless/scripted install):

```bash
ADMIN_FN=$(aws cloudformation describe-stacks --stack-name BedrockTeamTokenQuotaStack \
  --query "Stacks[0].Outputs[?OutputKey=='AdminApiFunctionNameOutput'].OutputValue" --output text)
# Allow amazon.nova-lite-v1:0 on bedrock-runtime, Regional scope, in your region:
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"putModelRegistryEntry","payload":{"modelId":"amazon.nova-lite-v1:0","endpoint":"bedrock-runtime","provider":"amazon","scope":"regional","region":"us-east-2"}}' \
  out.json && cat out.json   # -> {"ok":true}
```

*Confirm (either path):* the model appears under "Currently allowed" in the UI
and in the budget picker's Model dropdown. From the CLI you can confirm with
`listModelRegistry`:

```bash
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"listModelRegistry"}' out.json && cat out.json
# -> {"ok":true,"data":[{"modelId":"amazon.nova-lite-v1:0","endpoint":"bedrock-runtime",...}]}
```

**F. Generate real team-tagged usage** (this also feeds CUR's tag clock — doing
it now matters). Full copy-paste block in
[Step 1 — generate real Converse usage](#step-1--generate-real-converse-usage-per-team):
it creates `SampleTeamRole-{alpha,beta,gamma}`, assumes each, and sends Converse
calls. *Confirm:* each call prints a token count.

**G. Verify the pipeline attributed usage, then export for dashboards.**

```bash
# Per-team counters landed (proof of end-to-end attribution):
aws dynamodb scan --table-name Usage_Aggregation \
  --projection-expression "PK,SK,inputTokens,outputTokens" --region "$AWS_REGION"
#  -> rows like PK="TEAM#alpha#MODEL#...". A call from an untagged role shows as
#     TEAM#UNMAPPED# — correct, not an error.

# Publish to the analytics bucket QuickSight reads:
EXPORT_FN=$(aws lambda list-functions --query "Functions[?contains(FunctionName,'AnalyticsExportFunction')].FunctionName" --output text)
aws lambda invoke --function-name "$EXPORT_FN" --cli-binary-format raw-in-base64-out --payload '{}' out.json
```

*Confirm:* the scan shows per-team rows; `s3://<analyticsBucket>/token-usage/dt=<today>/part-0.json` exists.

**H. (Optional) QuickSight dashboards.** Grant the service role S3 access
**first** (read **and** Athena-results write — a read-only grant fails the
data-source connection test), then redeploy with the principal ARN (in
QuickSight's **home region**, which may differ from the stack region):

```bash
# The analytics bucket is NOT a stack output; find it by name prefix:
BUCKET=$(aws s3 ls | awk '{print $3}' | grep analyticsexportbucket)
aws iam put-role-policy --role-name aws-quicksight-service-role-v0 \
  --policy-name BedrockTeamTokenQuotaAnalyticsBucketAccess \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[
    {\"Sid\":\"ReadAnalyticsData\",\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:ListBucket\",\"s3:GetBucketLocation\"],\"Resource\":[\"arn:aws:s3:::$BUCKET\",\"arn:aws:s3:::$BUCKET/*\"]},
    {\"Sid\":\"WriteAthenaResults\",\"Effect\":\"Allow\",\"Action\":[\"s3:PutObject\",\"s3:AbortMultipartUpload\"],\"Resource\":[\"arn:aws:s3:::$BUCKET/athena-results/*\"]}
  ]}"

export QUICKSIGHT_PRINCIPAL_ARN="arn:aws:quicksight:<home-region>:$ACCT:user/default/<your-qs-username>"
npx cdk deploy --require-approval never --outputs-file cdk-outputs.json

# Team dashboard uses row-level security — upload RLS rules so it renders
# (the ADMIN dashboard works without this):
QS_USER="<your quicksight username>"
printf '%s\n' "{\"username\":\"$QS_USER\",\"team\":\"alpha\"}" \
              "{\"username\":\"$QS_USER\",\"team\":\"beta\"}" \
              "{\"username\":\"$QS_USER\",\"team\":\"gamma\"}" > rls-rules.json
aws s3 cp rls-rules.json "s3://$BUCKET/rls/rules.json" && rm -f rls-rules.json
```

*Confirm:* open the **admin** dashboard (`...-cost-admin`) — it shows all teams'
token usage immediately. The **team** dashboard (`...-cost`) shows only the
teams you mapped in the RLS file. (A "data is restricted" message on the team
dashboard means you haven't uploaded RLS rules yet — see "Two dashboards".)

**I. Finish CUR — LATER (next day+), once AWS has caught up.** This is the step
that lights up the **dollar** dashboard. **Steps A-H above are the whole
same-day install.** After H, **try I.1 straight away** — it is a safe, idempotent
command and also the "is it time yet?" gate. If the `iamPrincipal/team` key is
already listed in your billing account it succeeds immediately (it did when we
re-ran the README on an account that had used the tag before); if it errors
"Tag keys not found", stop, wait, and come back later. Either way the remaining
gates (billing posting your usage, the CUR delivering it) are waits of about a
day.

**The complete CUR order, start to finish** (this is the one sequence to
follow; the "CUR 2.0 setup walkthrough" section further down holds the full
commands for steps 1, 2 and 4 and is a reference, not a second procedure):

1. **Step B (day 0)** — create the CUR bucket + export *with IAM principal data*
   (walkthrough Steps 1-2).
2. **Steps C-H (day 0)** — deploy and generate usage under `team`-tagged roles.
3. **I.1 (day 1+)** — activate `iamPrincipal/team` (the command is just below).
   **Retry until it succeeds** — failing with "Tag keys not found" means "not
   yet", not "broken". When it succeeds, **generate usage again** (tags are not
   retroactive).
4. **⛔ Gate 1 — billing has the tag (Cost Explorer).** Run Check 1, then
   Check 2, until Check 2 returns your team names for the post-activation usage
   day. Usually about a day.
5. **I.2** — create/refresh the Glue table (walkthrough Step 4), then
   **⛔ Gate 2 — the CUR has it:** re-run the Athena query until it returns real
   team names. (This waits on the CUR export delivering to S3, which is
   separate from Gate 1.)
6. **I.3 (only after Gate 2 passes)** — redeploy with the CUR table to light up
   the dollar dashboard.

Do the sub-steps strictly in order, and do **not** run the next one until its
"wait here" check passes — each stage depends on AWS having propagated the
previous one, and running ahead just produces an empty dashboard you'll have to
debug.

---

**I.1 — Activate the `iamPrincipal/team` cost-allocation tag. This command is
also the "is it time yet?" gate.**

> **The key is `iamPrincipal/team`, NOT `team`.** Bedrock attributes cost to the
> calling IAM principal, and billing lists IAM-principal tags under an
> `iamPrincipal/` prefix. Activating the bare key `team` fails with "Tag keys not
> found: team" forever (it is a different key) — verified live. Also confirm your
> CUR export was created with `INCLUDE_IAM_PRINCIPAL_DATA` (CUR Step 2), or the
> tag can never appear in CUR.
>
> **AWS Organizations:** AWS's guidance is that cost allocation tags are
> activated in the **management (payer) account**; tagged usage from member
> accounts then consolidates there. If your Bedrock account is a *member*
> account, ask the management account's admin to run this activation. (Sources:
> the [AWS Cost Management blog on IAM principal cost allocation](https://aws.amazon.com/blogs/aws-cloud-financial-management/track-amazon-bedrock-costs-by-caller-identity-with-iam-based-cost-allocation/)
> and the [Architecture blog on Bedrock inference-profile cost tracking](https://aws.amazon.com/blogs/architecture/track-generative-ai-costs-with-amazon-bedrock-inference-profiles/).
> The Bedrock user guide page itself does not state this. We verified activation
> only from an account that *is* the management account; the member-account
> case is unverified.)

```bash
aws ce update-cost-allocation-tags-status --region us-east-1 \
  --cost-allocation-tags-status '[{"TagKey":"iamPrincipal/team","Status":"Active"}]'
```

- **Succeeds (no error / empty `Errors`)** → the tag is active. **Now generate
  usage again** — re-run the step-F block
  ([Step 1 — generate real Converse usage](#step-1--generate-real-converse-usage-per-team)).
  AWS states cost allocation tags are **not retroactive: only costs incurred
  after activation are tagged**, so the usage you generated *before* this point
  will most likely show no `iamPrincipal/team` value in CUR. Usage generated
  *after* activation will. Then go to **Gate 1** below.
- **Errors with `ValidationException ... Tag keys not found: iamPrincipal/team`**
  → billing has not yet listed that key. Per the AWS docs, an IAM-principal tag
  only becomes available to activate after the tagged principal has made at
  least one Bedrock call, then can take up to ~24h to appear. Make sure step F
  ran under a role that carries the `team` tag, then wait and re-run this exact
  command. Re-running it is the "are we there yet?" loop.

> The CLI surfaces an unknown key as a top-level `ValidationException`; the AWS
> API reference example shows a per-entry `TagKeysNotFoundException` in an
> `Errors` array. Both mean "not listed yet". See
> [UpdateCostAllocationTagsStatus](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_UpdateCostAllocationTagsStatus.html),
> [Using IAM principal for cost allocation](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/iam-principal-cost-allocation.html)
> and [Activating user-defined cost allocation tags](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/activating-tags.html).

**⛔ Gate 1 — has billing processed your Bedrock usage and seen the tag?** Use
these two read-only checks in two situations: (a) **after I.1 succeeds**, to
wait for the usage you generated *after* activation to be posted, and (b) if
**I.1 keeps erroring** after a day or more, to see where billing is instead of
just waiting. Set `<usage-day>` to the day you ran the usage:

```bash
# Check 1 — has any Bedrock cost posted at all? Replace the dates with the days
# spanning your step-F usage. $0 on your usage day (and "Estimated": true) =
# billing has not processed the spend yet; the tag CANNOT be catalogued until it
# does. NOTE: Bedrock bills under TWO Cost Explorer service names — "Amazon
# Bedrock" (Nova, Llama, gpt-oss, ...) and "Amazon Bedrock Service" (Anthropic
# Claude). Filter on BOTH or you can read a false $0.
aws ce get-cost-and-usage --region us-east-1 \
  --time-period Start=<usage-day> End=<usage-day+2> --granularity DAILY \
  --metrics UnblendedCost \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Bedrock","Amazon Bedrock Service"]}}' \
  --query "ResultsByTime[].[TimePeriod.Start,Total.UnblendedCost.Amount]" --output text

# Check 2 — has billing seen the team tag VALUES on that spend? Returns [""]
# (empty) until it has; returns your team names (alpha/beta/gamma) once it has.
aws ce get-tags --region us-east-1 \
  --time-period Start=<usage-day> End=<usage-day+2> --tag-key "iamPrincipal/team"
```

Interpretation:
- **Check 1 is $0 / estimated** → billing hasn't posted your usage day yet
  (typically up to ~24h after the day closes, sometimes longer). Wait and re-run.
- **Check 1 shows cost but Check 2 returns `[""]`** → cost posted but the tag
  hasn't propagated yet; give it the documented extra window. Re-run.
- **Check 2 returns your team names** → Gate 1 passed: billing has the tag on
  your usage. If I.1 was still erroring, re-run it now (it will succeed);
  otherwise proceed to I.2.

Optional — confirm the activated status (any iamPrincipal/* tag your account has
seen is listed; only the ones you activate show `Active`):

```bash
aws ce list-cost-allocation-tags --region us-east-1 --tag-keys "iamPrincipal/team" \
  --query "CostAllocationTags[].{Tag:TagKey,Status:Status}" --output table
```

---

**I.2 — Create the Glue table over the CUR data.** AWS does **not** auto-create
one for CUR 2.0 Data Exports — you create it with a crawler (full commands under
[CUR 2.0 setup walkthrough](#cur-20-setup-walkthrough-one-time-per-account),
step 4). Result: `CUR_DATABASE_NAME=cur2_db`, `CUR_TABLE_NAME=data`, cataloged in the
**stack** region over the us-east-1 CUR S3 data (cross-region read verified).

**⛔ Gate 2 — WAIT HERE until this check returns real team names.** Do this
after Gate 1 passes. CUR 2.0 puts IAM-principal tags in the `tags` **map**
column under the key `iamPrincipal/team`, and only on line items for usage
*after* I.1 succeeded. Even once billing has the tag (Gate 1), the CUR export
must still deliver a new file to S3 on its own schedule (on our account it had
not refreshed for about a day), so this can lag Gate 1. Re-run this query until
it returns non-blank teams:

```bash
BUCKET=<AnalyticsExportBucket id>   # for Athena results
aws athena start-query-execution --region "$AWS_REGION" \
  --work-group bedrock-team-token-quota \
  --query-execution-context Database=cur2_db \
  --result-configuration "OutputLocation=s3://$BUCKET/athena-results/" \
  --query-string "SELECT DISTINCT tags['iamPrincipal/team'] AS team
                  FROM cur2_db.data
                  WHERE line_item_product_code IN ('AmazonBedrock', 'AmazonBedrockService')"
# ...then read the result:
#   aws athena get-query-results --query-execution-id <id> \
#     --query 'ResultSet.Rows[].Data[].VarCharValue' --output text
#
# Empty / all-blank  → the tag hasn't propagated into the data yet. WAIT and
#                      re-run this query (do NOT proceed to I.3).
# Real team names     → the column has landed → proceed to I.3.
```

> **Two Bedrock product codes.** Bedrock bills under both `AmazonBedrock`
> (Nova, Llama, gpt-oss, ...) and `AmazonBedrockService` (Anthropic Claude,
> including Mantle-served Claude). Verified on a live CUR 2.0 export: Claude was
> ~99% of the dollars, so a filter on `AmazonBedrock` alone silently drops most
> of the cost. The stack's `CurTeamCost` Lambda query matches both.
> To see what your own CUR contains:
> `SELECT line_item_product_code, line_item_usage_type, SUM(line_item_unblended_cost) FROM cur2_db.data WHERE lower(line_item_product_code) LIKE '%bedrock%' GROUP BY 1,2`

> If the query errors with **"Column 'tags' cannot be resolved"**, the Glue
> table doesn't have the column (e.g. it was crawled before the export changed).
> Re-run the CUR
> crawler ([CUR 2.0 setup walkthrough](#cur-20-setup-walkthrough-one-time-per-account),
> step 4 / I.2) so Glue picks up the new schema, then re-run the check.

---

**I.3 — Redeploy pointed at the CUR table.** Only do this once Gate 2 (I.2's
Athena check) returns real team names. This creates the CUR cost Lambda + `cur_team_cost`
table + dollar dashboard:

```bash
export CUR_DATABASE_NAME="cur2_db"
export CUR_TABLE_NAME="data"
npx cdk deploy --require-approval never --outputs-file cdk-outputs.json
```

*Confirm:* the dollar dashboard populates on its next refresh. Under the hood
the `CurTeamCost` Lambda runs the same `tags['iamPrincipal/team']` query you
just validated (`buildPerTeamCostQuery`), so if I.2's check returned real teams,
the dashboard will too.

> **Reality we observed on a clean account:** CUR Parquet reached S3 within ~1h,
> but the `team` tag was still not catalogued and no CUR Glue table existed
> hours later — so step I is genuinely a next-day task, and the Glue table is a
> step **you** create (I.2), not something AWS registers for you.

### Deploy the core stack

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

The exact one-time grant (substitute your analytics bucket name — the
`AnalyticsExportBucket` physical id from `cdk-outputs.json` / the stack's
resources):

```bash
export AWS_PROFILE=...          # your admin profile
BUCKET=<your analytics bucket name>

aws iam put-role-policy --role-name aws-quicksight-service-role-v0 \
  --policy-name BedrockTeamTokenQuotaAnalyticsBucketAccess \
  --policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[
      {
        \"Sid\":\"ReadAnalyticsData\",
        \"Effect\":\"Allow\",
        \"Action\":[\"s3:GetObject\",\"s3:ListBucket\",\"s3:GetBucketLocation\"],
        \"Resource\":[\"arn:aws:s3:::$BUCKET\",\"arn:aws:s3:::$BUCKET/*\"]
      },
      {
        \"Sid\":\"WriteAthenaResults\",
        \"Effect\":\"Allow\",
        \"Action\":[\"s3:PutObject\",\"s3:AbortMultipartUpload\"],
        \"Resource\":[\"arn:aws:s3:::$BUCKET/athena-results/*\"]
      }
    ]
  }"
```

Remove this grant at teardown (see "Tearing it down").

#### Two dashboards: admin (all teams) vs team (row-level security)

The stack creates **two** dashboards, by design:

| Dashboard | Id | Dataset RLS | Who it's for |
|---|---|---|---|
| **Admin** | `bedrock-team-token-quota-cost-admin` | **none** — shows every team | admins / FinOps |
| **Team** | `bedrock-team-token-quota-cost` | **row-level security** — a user sees only their own team(s) | individual team leads |

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

```bash
BUCKET=<your analytics bucket name>
# Your QuickSight username — for IAM-federated/SSO users it's the full name,
# e.g. "AWSReservedSSO_<permset>_<id>/you@example.com". Find it with:
#   aws quicksight list-users --aws-account-id <acct> --namespace default --region <home-region>
QS_USER="<your quicksight username>"

# One JSON object PER LINE (the Glue table uses a JSON SerDe = newline-delimited).
# Map a user to each team they may see. An admin who should see everything on
# the team dashboard gets one row per team; a team lead gets just their team.
printf '%s\n' \
  "{\"username\":\"$QS_USER\",\"team\":\"alpha\"}" \
  "{\"username\":\"$QS_USER\",\"team\":\"beta\"}" \
  "{\"username\":\"$QS_USER\",\"team\":\"gamma\"}" > rls-rules.json

aws s3 cp rls-rules.json "s3://$BUCKET/rls/rules.json"
rm -f rls-rules.json
```

The datasets are DIRECT_QUERY over Athena, so the rules take effect on the next
dashboard load — no ingestion/refresh step. Verify Athena sees the rules:

```bash
# Expect one row per (username, team) pair you uploaded.
aws athena start-query-execution \
  --query-string "SELECT username, team FROM bedrock_team_token_quota.team_access" \
  --work-group bedrock-team-token-quota \
  --query-execution-context Database=bedrock_team_token_quota \
  --result-configuration "OutputLocation=s3://$BUCKET/athena-results/"
# ...then `aws athena get-query-results --query-execution-id <id>`.
```

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

A full teardown has **three parts**, in order: (A) prerequisites that must be
cleared before `cdk destroy` will succeed, (B) `cdk destroy` itself, and
(C) resources created *outside* the stack that `cdk destroy` never touches.
The steps below are the exact sequence, including the two gotchas that make a
naive `cdk destroy` fail.

Set your shell first:

```bash
export AWS_PROFILE=your-profile-name
export AWS_REGION=us-east-2          # the region you deployed to
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
```

#### Part A — clear the two things that block `cdk destroy`

CloudFormation refuses to delete a non-empty S3 bucket or a non-empty Athena
workgroup. Both will be non-empty after any real use, so clear them first.

```bash
# 1. Empty both S3 buckets. The analytics bucket has autoDeleteObjects, but the
#    model-invocation-log bucket does NOT auto-empty — emptying both is safe.
#    Find the exact names from the stack outputs (or the S3 console):
LOG_BUCKET=$(aws cloudformation describe-stacks --stack-name BedrockTeamTokenQuotaStack \
  --query "Stacks[0].Outputs[?OutputKey=='ModelInvocationLogBucketNameOutput'].OutputValue" --output text)
aws s3 rm "s3://$LOG_BUCKET" --recursive
# The analytics bucket name isn't a stack output; find it by prefix:
for b in $(aws s3 ls | awk '{print $3}' | grep analyticsexportbucket); do
  aws s3 rm "s3://$b" --recursive
done

# 2. Delete the Athena workgroup WITH its saved queries. cdk destroy fails with
#    "WorkGroup ... is not empty" otherwise, because CloudFormation will not
#    force-delete a workgroup that has query history.
aws athena delete-work-group --work-group bedrock-team-token-quota --recursive-delete-option
```

#### Part B — destroy the stack

```bash
# TEST_ROLE_TRUSTED_PRINCIPAL_ARNS must still be set (the app reads it on synth).
export TEST_ROLE_TRUSTED_PRINCIPAL_ARNS="arn:aws:iam::$ACCOUNT_ID:user/<your-username>"
npx cdk destroy --force    # --force skips the interactive y/n prompt (needed in scripts)
```

This removes everything the stack created: all DynamoDB tables (**and their
data** — quotas, usage, audit, blocked-state, registry, mappings), both S3
buckets, every Lambda + IAM role, the Cognito User Pool (**your admin login
user is deleted**), the QuickSight datasets/dashboards, the Glue database/
tables, EventBridge rules, and the SNS topic. It also **disables the account/
region Model Invocation Logging** configuration the stack enabled (best-effort;
a prior configuration is not restored).

> If `cdk destroy` still reports `DELETE_FAILED` on the Athena workgroup or an
> S3 bucket, it means that resource was repopulated between Part A and Part B
> (e.g. a scheduled Lambda ran once more). Re-run the matching Part A command,
> then `npx cdk destroy` again.

#### Part C — remove out-of-band resources (NOT part of the stack)

These were created by the test tooling / cost-dashboard / CUR setup steps and
live outside CloudFormation, so `cdk destroy` leaves them behind:

```bash
# 1. Sample/test team roles you created out-of-band (only if you did):
#      - SampleTeamRole-alpha/beta/gamma  — the reconcile-sweep + usage demos
#      - TokenQuotaTestRole-*             — older interactive-test-tool roles
#    (The stack-managed Bedrock_Test_Role is NOT here — cdk destroy removes it.)
for R in $(aws iam list-roles \
    --query "Roles[?starts_with(RoleName,'SampleTeamRole') || starts_with(RoleName,'TokenQuotaTestRole')].RoleName" \
    --output text); do
  for P in $(aws iam list-role-policies --role-name "$R" --query "PolicyNames" --output text); do
    aws iam delete-role-policy --role-name "$R" --policy-name "$P"
  done
  aws iam delete-role --role-name "$R"
done

# 2. QuickSight S3 access grant (added to let QuickSight read the Athena
#    results bucket — only if you enabled QuickSight dashboards):
aws iam delete-role-policy --role-name aws-quicksight-service-role-v0 \
  --policy-name BedrockTeamTokenQuotaAnalyticsBucketAccess 2>/dev/null || true

# 3. CUR 2.0 export + its delivery bucket (us-east-1 only — only if you set up
#    cost dashboards per the CUR walkthrough):
CUR_ARN=$(aws bcm-data-exports list-exports --region us-east-1 \
  --query "Exports[?Name=='bedrock-team-token-quota-cur2'].ExportArn" --output text)
[ -n "$CUR_ARN" ] && aws bcm-data-exports delete-export --region us-east-1 --export-arn "$CUR_ARN"
CUR_BUCKET="bedrock-cur2-export-$ACCOUNT_ID"
aws s3 rm "s3://$CUR_BUCKET" --recursive --region us-east-1 2>/dev/null || true
aws s3api delete-bucket --bucket "$CUR_BUCKET" --region us-east-1 2>/dev/null || true
# Optional: deactivate the team cost-allocation tag (ignore "Tag keys not
# found" — that just means it never activated).
aws ce update-cost-allocation-tags-status --region us-east-1 \
  --cost-allocation-tags-status '[{"TagKey":"iamPrincipal/team","Status":"Inactive"}]' 2>/dev/null || true

# 3b. The CUR Glue catalog objects from CUR Step 4 (also outside the stack):
aws glue delete-crawler --region "$AWS_REGION" --name bedrock-cur2-crawler 2>/dev/null || true
aws glue delete-database --region "$AWS_REGION" --name cur2_db 2>/dev/null || true
aws iam delete-role-policy --role-name BedrockCur2CrawlerRole --policy-name CurS3Read 2>/dev/null || true
aws iam detach-role-policy --role-name BedrockCur2CrawlerRole --policy-arn arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole 2>/dev/null || true
aws iam delete-role --role-name BedrockCur2CrawlerRole 2>/dev/null || true

# 4. Watch for ORPHANED buckets from earlier stack versions. A stack
#    replacement can leave old model-invocation-log buckets behind (they match
#    the same prefix but aren't in the current stack). List and remove any:
aws s3 ls | awk '{print $3}' | grep -E 'bedrockteamtokenquota|bedrock-cur2'
# ...then for each stray bucket: aws s3 rm s3://<name> --recursive && aws s3api delete-bucket --bucket <name>
```

#### Part D — local artifacts

```bash
rm -f cdk-outputs.json web/.env   # regenerated on the next deploy
```

#### Verify a clean account

```bash
aws s3 ls | grep -E 'bedrockteamtokenquota|bedrock-cur2'                     # expect no output
aws iam list-roles --query "Roles[?starts_with(RoleName,'SampleTeamRole') || starts_with(RoleName,'TokenQuotaTestRole')].RoleName" --output text  # empty
aws cognito-idp list-user-pools --max-results 20 \
  --query "UserPools[?Name=='bedrock-team-token-quota-admins'].Id" --output text   # empty
aws glue get-databases --query "DatabaseList[?Name=='bedrock_team_token_quota'].Name" --output text   # empty
```

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
policies, dashboards) rather than just the mapping, use the fuller
"generate real Converse usage" walkthrough further below, which assumes a
tagged role and sends live `Converse` calls.

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
you opt in by passing `CUR_DATABASE_NAME` + `CUR_TABLE_NAME`.

**Exactly what access the stack's CUR cost Lambda is granted** (least-privilege,
only created when the CUR props are set — see `CurTeamCostFunction` in
`infra/stack.ts`):

- **Athena** — `StartQueryExecution` / `GetQueryExecution` / `GetQueryResults`
  (Resource `*`; Athena has no resource-level ARN for these). It queries the CUR
  through Athena rather than reading Parquet directly.
- **Glue** — `GetTable` / `GetDatabase` / `GetPartitions`, scoped to exactly the
  CUR database + table you named (`CUR_DATABASE_NAME` / `CUR_TABLE_NAME`). Read
  metadata only — no write, no other tables.
- **S3** — `GetObject` / `ListBucket` / `GetBucketLocation` / `PutObject` on the
  stack's **analytics bucket** only (to stage Athena results under
  `athena-results/` and write the derived per-team cost under `cur-team-cost/`).

**One access detail to get right:** Athena, when it runs the query, reads the
CUR Parquet files from the **CUR bucket**. That read is governed by the CUR
bucket's own policy + the query executor's permissions. If the CUR bucket is in
a **different region** (us-east-1) than the stack, cross-region Athena/Glue
still works because the Glue catalog and CUR are account-global, but the Lambda
runs Athena **in the stack's region** against a Glue table registered there. In
practice: register/point at the Glue database+table that Data Exports created
(step 4), and if the cost Lambda returns empty or an access error, confirm the
CUR bucket policy allows your account and that the Glue table's S3 `LOCATION`
points at the CUR bucket. The stack grants the Lambda everything on *its* side;
the CUR bucket + Glue table are the account-owned pieces that must line up.

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

**CUR 2.0 is an AWS account prerequisite, not part of installing this
solution.** Many organizations already run a CUR 2.0 export for FinOps — if
yours does, you don't set anything up here; you just point the stack at the
existing Glue table (step 4). If your account does *not* have one yet, enabling
it is an **account-level task you own**, and it is **independent of deploying
this solution**:

- **You do not wait on CUR to use the product.** Token tracking, quota
  enforcement, and the token-usage dashboards all work the moment the core
  stack is deployed. CUR adds only the *dollar* view.
- **Do these in parallel.** Do Steps 1-2 below first (the export has a
  first-delivery lag that is entirely AWS-side), and meanwhile deploy the
  solution and start using it. **The order to follow, with the wait gates, is
  step I of the [A-Z walkthrough](#full-deploy-and-test-walkthrough-a-z-in-order)**
  — this section just holds the commands for Steps 1, 2 and 4.
- Because the tag activation (step I.1) requires billing to have already seen a
  Bedrock call from a `team`-tagged role, the realistic cold-start for the
  dollar view is **~1-3 days** on a brand-new account — all AWS-side waiting,
  not solution setup. On an account that already has CUR + the tag active, it's
  effectively immediate (just Step 4 and the redeploy).

The steps below are the exact CLI (the same can be done in the AWS Billing
console). This stack does **not** create the CUR export — you own it.

> **Important:** The BCM Data Exports API (`bcm-data-exports`) runs in
> **us-east-1 only**, regardless of where you deploy the stack. CUR data is
> account-global and queryable from any region via Athena once the Glue table
> exists.

**Step 1 — Create an S3 bucket for CUR delivery and apply the required
policy:**

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
CUR_BUCKET="bedrock-cur2-export-$ACCOUNT_ID"

# Create the bucket (in us-east-1, the Data Exports region)
aws s3api create-bucket --bucket "$CUR_BUCKET" --region us-east-1

# Apply the required bucket policy so Data Exports can write to it
aws s3api put-bucket-policy --bucket "$CUR_BUCKET" --region us-east-1 --policy "{
  \"Version\":\"2012-10-17\",
  \"Statement\":[{
    \"Sid\":\"EnableAWSDataExportsToWriteToS3\",
    \"Effect\":\"Allow\",
    \"Principal\":{\"Service\":[\"bcm-data-exports.amazonaws.com\"]},
    \"Action\":[\"s3:PutObject\"],
    \"Resource\":\"arn:aws:s3:::$CUR_BUCKET/*\",
    \"Condition\":{
      \"ArnLike\":{\"aws:SourceArn\":\"arn:aws:bcm-data-exports:us-east-1:$ACCOUNT_ID:export/*\"},
      \"StringEquals\":{\"aws:SourceAccount\":\"$ACCOUNT_ID\"}
    }
  }]
}"
```

For the bucket policy specification, see
[Setting up an S3 bucket for data exports](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-s3-bucket.html).

**Step 2 — Create the CUR 2.0 Data Export:**

```bash
# Get all CUR 2.0 column names (builds the SELECT query automatically).
# --table-properties INCLUDE_IAM_PRINCIPAL_DATA=TRUE is REQUIRED: without it the
# column list omits line_item_iam_principal (115 columns vs 116), and the export
# cannot carry per-team data for Bedrock.
COLS=$(aws bcm-data-exports get-table --table-name COST_AND_USAGE_REPORT \
  --table-properties INCLUDE_IAM_PRINCIPAL_DATA=TRUE \
  --query "Schema[].Name" --output text --region us-east-1)
SELECT_ALL=$(echo "$COLS" | tr '\t' ',')

# Create the export (this produces a JSON definition inline — the Python
# one-liner makes it readable, but you can also use the console)
python3 -c "
import json, sys
bucket, acct, cols = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
  'Name': 'bedrock-team-token-quota-cur2',
  'Description': 'CUR 2.0 export for bedrock-team-token-quota cost dashboards',
  'DataQuery': {
    'QueryStatement': f'SELECT {cols} FROM COST_AND_USAGE_REPORT',
    'TableConfigurations': {
      'COST_AND_USAGE_REPORT': {
        'TIME_GRANULARITY': 'DAILY',
        'INCLUDE_RESOURCES': 'TRUE',
        'INCLUDE_MANUAL_DISCOUNT_COMPATIBILITY': 'FALSE',
        'INCLUDE_SPLIT_COST_ALLOCATION_DATA': 'FALSE',
        'INCLUDE_IAM_PRINCIPAL_DATA': 'TRUE'
      }
    }
  },
  'DestinationConfigurations': {
    'S3Destination': {
      'S3Bucket': bucket, 'S3Prefix': 'cur2', 'S3Region': 'us-east-1',
      'S3OutputConfigurations': {
        'OutputType': 'CUSTOM', 'Format': 'PARQUET',
        'Compression': 'PARQUET', 'Overwrite': 'OVERWRITE_REPORT'
      }
    }
  },
  'RefreshCadence': {'Frequency': 'SYNCHRONOUS'}
}))
" "$CUR_BUCKET" "$ACCOUNT_ID" "$SELECT_ALL" > /tmp/cur-export.json

aws bcm-data-exports create-export --export "file:///tmp/cur-export.json" --region us-east-1
```

For full details, see
[Creating a CUR 2.0 export](https://docs.aws.amazon.com/cur/latest/userguide/data-exports-migrate-two.html)
and
[Using IAM principal for cost allocation](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/iam-principal-cost-allocation.html).

**Already created the export without IAM principal data?** AWS's
[IAM principal attribution](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-iam-principal-tracking.html)
page says to **create a new export** with the caller-identity option: existing
exports do not retroactively include identity data. Re-run Step 2 above to create
a new export (with a new name and `S3Prefix`), then point the Glue crawler at
that prefix.

**Step 3 — Activate the `iamPrincipal/team` cost-allocation tag.** This is
**step I.1** of the A-Z walkthrough — the command, the retry logic and the
caveats (prefixed key, Organizations, not retroactive) live there so there is
exactly one copy. Don't run it here: it fails until your tagged roles have made
a Bedrock call.

For background, see
[Activating user-defined cost allocation tags](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/activating-tags.html)
and
[Understanding Bedrock cost allocation tags in CUR](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-understanding-cur-data.html#cost-allocation-tags-in-cur).

**Step 4 — Create a Glue table over the CUR, then point the stack at it.**

This stack reads CUR **through Athena**, which needs a **Glue table** over the
CUR Parquet. There are two situations:

- **You already run CUR with Athena/Glue integration** (common for existing
  FinOps setups): you already have a Glue database + table. Skip to the
  redeploy at the end of this step and pass their names.
- **You created the export with the §Step 2 command above** (or otherwise have
  no Glue table): **AWS does NOT auto-create one.** CUR 2.0 Data Exports write
  only the Parquet + a manifest to S3 — there is no Glue table until you make
  one. (This was verified live: hours after first delivery, no CUR Glue
  database existed.) Create it once with a Glue crawler:

```bash
export AWS_REGION=us-east-2            # your STACK region — catalog the table here
ACCT=$(aws sts get-caller-identity --query Account --output text)
CUR_BUCKET="bedrock-cur2-export-$ACCT"   # the CUR bucket (physically us-east-1; S3 is global)

# 4a. A Glue database (in the stack region) to hold the CUR table.
aws glue create-database --region "$AWS_REGION" \
  --database-input '{"Name":"cur2_db","Description":"CUR 2.0 raw export table for bedrock-team-token-quota"}'

# 4b. A minimal IAM role the crawler assumes (Glue service policy + read on the CUR bucket).
aws iam create-role --role-name BedrockCur2CrawlerRole \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"glue.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name BedrockCur2CrawlerRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole
aws iam put-role-policy --role-name BedrockCur2CrawlerRole --policy-name CurS3Read \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:ListBucket\"],\"Resource\":[\"arn:aws:s3:::$CUR_BUCKET\",\"arn:aws:s3:::$CUR_BUCKET/*\"]}]}"
sleep 10   # let the new role propagate

# 4c. A crawler (in the stack region) pointed at the CUR data prefix (in us-east-1 S3).
aws glue create-crawler --region "$AWS_REGION" --name bedrock-cur2-crawler \
  --role "arn:aws:iam::$ACCT:role/BedrockCur2CrawlerRole" --database-name cur2_db \
  --targets "{\"S3Targets\":[{\"Path\":\"s3://$CUR_BUCKET/cur2/bedrock-team-token-quota-cur2/data/\"}]}"
aws glue start-crawler --region "$AWS_REGION" --name bedrock-cur2-crawler

# 4d. Wait for it to finish (State returns to READY), then confirm the table:
aws glue get-crawler --region "$AWS_REGION" --name bedrock-cur2-crawler --query "Crawler.State" --output text
aws glue get-tables --region "$AWS_REGION" --database-name cur2_db --query "TableList[].Name" --output text
#  -> prints "data"  (the crawler names the table after the S3 prefix). You now
#     have CUR_DATABASE_NAME=cur2_db and CUR_TABLE_NAME=data, both in the stack
#     region, cataloging the us-east-1 CUR S3 data (cross-region S3 read works —
#     verified with a live Athena query).
```

Then redeploy the stack with the CUR props (this creates the CUR cost Lambda +
`cur_team_cost` table + dollar dashboard):

```bash
export CUR_DATABASE_NAME="cur2_db"
export CUR_TABLE_NAME="data"
npm run infra:deploy
```

> **Per-team dollars still wait on the `iamPrincipal/team` tag (step I.1).** Even
> with the Glue table and the redeploy done, the CUR cost Lambda groups cost by
> `tags['iamPrincipal/team']` — which CUR only populates **after** the tag is
> activated (step I.1) and billing processes usage under it (~24-48h). Until then
> the pipeline is wired correctly but the per-team cost visual is empty.
> (Verified live: Bedrock line items were present in CUR within the hour, with
> no tag keys on them yet.)

Omit `CUR_DATABASE_NAME` / `CUR_TABLE_NAME` and the stack skips the CUR cost
Lambda entirely — token tracking and enforcement still work fully; only the
dollar cost dashboards have no data.

Clean up the crawler + its role at teardown:
`aws glue delete-crawler --name bedrock-cur2-crawler --region <stack-region>`,
`aws glue delete-database --name cur2_db --region <stack-region>`,
`aws iam delete-role-policy --role-name BedrockCur2CrawlerRole --policy-name CurS3Read`,
`aws iam detach-role-policy --role-name BedrockCur2CrawlerRole --policy-arn arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole`,
`aws iam delete-role --role-name BedrockCur2CrawlerRole`.

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

The QuickSight dashboards show **token usage** (from the pipeline) and
**billed cost** (from CUR 2.0, if configured). This section walks through
producing real usage across several teams and models, for both the **Converse**
(`bedrock-runtime`) and **Mantle** (`bedrock-mantle`) endpoints.

Two things need to happen for data to appear:

1. **Token usage** — real Bedrock calls under team-tagged roles (within minutes).
2. **An analytics export run** — writes token-usage rows to S3 where Athena/
   QuickSight read them (runs hourly on a schedule, or invoke it on demand).

For the dollar-cost view, CUR 2.0 must be configured and the `team` cost
allocation tag activated (see above). CUR cost lags ~24h behind the actual
calls, so tokens appear in the dashboards before dollars do — that's expected.

Set your shell up first:

```bash
export AWS_PROFILE=your-profile-name
export AWS_REGION=us-east-2            # match your deployment
```

### Step 1 — generate real Converse usage (per team)

Each team is the `team` tag on an IAM role (see "How it works"). To attribute
usage to a team, you create a role tagged with that team name, give it
permission to invoke Bedrock, assume it, and call `Converse`. Usage made under
that role flows through the pipeline tagged with its team, and (once CUR is
active) its cost is attributed to that team too.

The block below is **copy-paste runnable** — it derives your account id and
your own principal ARN, creates three team roles (`alpha`/`beta`/`gamma`), and
sends 3 real Converse calls through each. It is exactly what the maintainers
run to populate a fresh deployment's dashboards.

```bash
export AWS_PROFILE=your-profile-name
export AWS_REGION=us-east-2                     # match your deployment
MODEL=amazon.nova-lite-v1:0                     # a model you have access to in that region

ACCT=$(aws sts get-caller-identity --query Account --output text)
ME=$(aws sts get-caller-identity --query Arn --output text)   # your principal, trusted to assume the roles
INVOKE='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream","bedrock:Converse","bedrock:ConverseStream"],"Resource":["arn:aws:bedrock:*::foundation-model/*","arn:aws:bedrock:*:*:inference-profile/*"]}]}'

# 1) Create (or update) one tagged, assumable, Bedrock-invoking role per team.
for T in alpha beta gamma; do
  aws iam create-role --role-name "SampleTeamRole-$T" \
    --assume-role-policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"AWS\":\"$ME\"},\"Action\":\"sts:AssumeRole\"}]}" \
    --tags Key=team,Value=$T 2>/dev/null || true
  aws iam tag-role --role-name "SampleTeamRole-$T" --tags Key=team,Value=$T
  aws iam put-role-policy --role-name "SampleTeamRole-$T" --policy-name BedrockInvoke --policy-document "$INVOKE"
done
sleep 10   # let the new role trust/policy propagate before assuming

# 2) Assume each role and send real Converse calls through it. Isolating the
#    assumed creds with `env -u AWS_PROFILE ...` is REQUIRED — otherwise the SDK
#    may sign with your base profile and the usage is attributed to the wrong
#    principal (or you get InvalidSignatureException).
for T in alpha beta gamma; do
  CREDS=$(aws sts assume-role --role-arn "arn:aws:iam::$ACCT:role/SampleTeamRole-$T" \
    --role-session-name "usage-$T" --query Credentials --output json)
  AKI=$(echo "$CREDS" | python -c "import sys,json;print(json.load(sys.stdin)['AccessKeyId'])")
  SAK=$(echo "$CREDS" | python -c "import sys,json;print(json.load(sys.stdin)['SecretAccessKey'])")
  STK=$(echo "$CREDS" | python -c "import sys,json;print(json.load(sys.stdin)['SessionToken'])")
  for i in 1 2 3; do
    env -u AWS_PROFILE AWS_ACCESS_KEY_ID=$AKI AWS_SECRET_ACCESS_KEY=$SAK AWS_SESSION_TOKEN=$STK \
      aws bedrock-runtime converse --region "$AWS_REGION" --model-id "$MODEL" \
      --messages "[{\"role\":\"user\",\"content\":[{\"text\":\"Write ~200 words on event-driven architecture, example $i for team $T.\"}]}]" \
      --inference-config '{"maxTokens":600}' --query usage.totalTokens --output text
  done
done
```

Each call prints the token count it consumed. Within a few minutes those land
in `Usage_Aggregation` as per-team rows (verify in Step 3). The **dollar** cost
for the same calls appears later, once CUR 2.0 is active and has delivered
(~24h) — see the CUR note below.

> **The `iamPrincipal/team` cost-allocation tag is activated *after* this usage.**
> Per the AWS docs, an IAM-principal tag only becomes available to activate once
> the tagged role has made a Bedrock call. So the order is: generate
> team-tagged usage (this step) → activate `iamPrincipal/team` (step I.1;
> retry if it isn't listed yet) → wait for CUR to populate. The token
> dashboards, by contrast, show this usage within minutes.

### Step 2 — generate Mantle usage (if your account/region has Mantle)

Mantle has no per-request log; usage is pulled from `AWS/BedrockMantle`
CloudWatch metrics (`TotalInputTokens`/`TotalOutputTokens`, dimensioned by
`Project` and `ModelId`) and attributed to a team via a Team↔Project mapping.
So for Mantle you must (1) map the project to a team and (2) generate real
Mantle traffic under that project:

```bash
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"putTeamProjectMapping","payload":{"projectId":"<your-mantle-project-id>","team":"alpha"}}' out.json
# ...then invoke the Mantle model under that project so AWS/BedrockMantle metrics appear.
```

> **Mantle availability varies by account/region.** If
> `aws cloudwatch list-metrics --namespace AWS/BedrockMantle` returns nothing,
> the Mantle endpoint isn't emitting metrics in your account — in that case a
> model that happens to be OpenAI/open-weight is still served through the
> normal Converse endpoint, and you should register it as `bedrock-runtime`
> and generate usage via Step 1. There's no way to fabricate
> `AWS/BedrockMantle` data; it only exists from real Mantle invocations.

### Step 3 — export and view

Token usage lands in `Usage_Aggregation` within a few minutes of each
Converse call (see the latency note above); Mantle totals refresh every 15
minutes. Once usage is recorded, run the analytics export (it also runs
hourly on its own):

First, confirm the pipeline recorded the per-team counters (this is the proof
that team attribution worked, before any export/dashboard):

```bash
aws dynamodb scan --table-name Usage_Aggregation \
  --projection-expression "PK,SK,inputTokens,outputTokens" --output json \
  --region "$AWS_REGION"
# Expect rows like PK = "TEAM#alpha#MODEL#amazon.nova-lite-v1:0", SK = "DAY#<today>".
# A call made WITHOUT a team-tagged role shows up as TEAM#UNMAPPED#... — that's
# correct behavior, not an error.
```

Then run the analytics export (it also runs hourly on its own) to publish the
rows to the analytics bucket where QuickSight reads them:

```bash
EXPORT_FN=$(aws lambda list-functions \
  --query "Functions[?contains(FunctionName,'AnalyticsExportFunction')].FunctionName" --output text)
aws lambda invoke --function-name "$EXPORT_FN" --cli-binary-format raw-in-base64-out --payload '{}' out.json
```

Verify the exported token-usage rows:

```bash
BUCKET=<analytics bucket name from cdk outputs>   # the AnalyticsExportBucket physical id
aws s3 cp "s3://$BUCKET/token-usage/dt=$(date -u +%Y-%m-%d)/part-0.json" -
# Each line is one {team, model, usageDay, endpoint, inputTokens, outputTokens,
# cacheReadTokens, cacheWriteTokens, totalTokens} row — the exact shape the
# QuickSight `token_usage` dataset queries.
```

Then open the QuickSight dashboards (team dashboard = per-team RLS; admin
dashboard = all teams). The datasets are DIRECT_QUERY over Athena, so they
reflect the latest export on refresh — no SPICE ingestion step. The token
dashboards show usage immediately. For dollar cost, the `cur-team-cost/`
dataset populates after CUR 2.0 delivers data (~24h after the calls).

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
- **Dependency vulnerabilities**: `npm audit` reports **0 vulnerabilities**. One
  high-severity finding (`brace-expansion` GHSA-mh99-v99m-4gvg) is a *bundled*
  dependency inside the `aws-cdk-lib` tarball that npm `overrides` can't reach and
  AWS hasn't yet shipped a patched `aws-cdk-lib` for, so it's fixed at install time
  via a `postinstall` hook: `patch-package` (see `patches/`) swaps in the patched
  `brace-expansion@5.0.9` source, and `scripts/fixBundledDepAuditMetadata.js`
  reconciles the lockfile/`package.json` metadata `npm audit` reads. Both steps are
  idempotent and verified to survive a clean `rm -rf node_modules && npm install`. If
  a future `aws-cdk-lib` release bundles a non-vulnerable `brace-expansion`, the patch
  and script become no-ops and can be removed.

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
