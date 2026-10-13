# Deployment runbook — per-team Bedrock cost control + CUR 2.0 dashboards

A single, ordered, **CLI-only** runbook to stand up the whole solution on your
own AWS account. Follow it top to bottom. Each part is self-contained (no
jumping to other sections for commands) and ends with a **Confirm** check.

For *how it works*, the architecture, IAM least-privilege detail, design
rationale, and the optional web UI, see [README.md](./README.md). This file is
only the deploy procedure.

## What you get

1. **Cost control** — a per-team, per-model **daily token budget**. When a team
   exceeds it, the stack attaches a real IAM **deny** policy to that team's
   role(s) for the rest of the day (not just an alert), then lifts it
   automatically at 00:00 UTC.
2. **Two QuickSight dashboards, split by audience** (admin = all teams; team =
   row-level secured) — **not** split by metric. Each carries, as separate
   sheets (tabs):
   - a **Token-usage** view (fresh within minutes), and
   - a **Billed Cost** view from **AWS Cost & Usage Report (CUR 2.0)**,
     attributed per team — the actual billed figure, no estimation.

## The one unavoidable wait

Everything except the **dollar** figures is **same-day**. The dollar rail rides
on CUR 2.0, which has a **~1-2 day AWS-side clock** (billing must process your
tagged usage, then the export must deliver it). So you **start the CUR export
first** (Part 1), do all the same-day work, and **finish the dollar dashboards
last** (Part 7), a day or two later. Token quotas, enforcement, and the
token-usage dashboards all work on day 0.

## Table of contents

- [Part 0 — Prerequisites and environment](#part-0--prerequisites-and-environment)
- [Part 1 — Start the CUR 2.0 export (do this first)](#part-1--start-the-cur-20-export-do-this-first)
- [Part 2 — Deploy the core stack](#part-2--deploy-the-core-stack)
- [Part 3 — Allow the models teams may use](#part-3--allow-the-models-teams-may-use)
- [Part 4 — Set per-team daily token quotas (cost control)](#part-4--set-per-team-daily-token-quotas-cost-control)
- [Part 5 — Generate team-tagged usage and verify enforcement](#part-5--generate-team-tagged-usage-and-verify-enforcement)
- [Part 6 — Token-usage QuickSight dashboards](#part-6--token-usage-quicksight-dashboards)
- [Part 7 — Dollar dashboards from CUR 2.0 (next day)](#part-7--dollar-dashboards-from-cur-20-next-day)
- [Part 8 — Full verification checklist](#part-8--full-verification-checklist)
- [Part 9 — Tear it down](#part-9--tear-it-down)
- [Known caveats](#known-caveats)

---

## Part 0 — Prerequisites and environment

- **Node.js 20+** and the **AWS CLI**, configured for the target account.
- **Bedrock model access** enabled for the model(s) you will test
  (Bedrock console → Model access). This is separate from IAM.
- **For the dollar dashboards only:** an existing **Amazon QuickSight**
  subscription with at least one user.
- **For the dollar dashboards only:** cost-allocation tags are activated in the
  **management (payer) account**. If your Bedrock account is a *member* account
  of an AWS Organization, the tag-activation step (Part 7) must be run by the
  management account's admin. See [Known caveats](#known-caveats).

> **Every `cdk deploy` must carry the same environment.** The stack switches
> optional parts (QuickSight dashboards, the CUR cost pipeline) on and off from
> environment variables, and CloudFormation **deletes** whatever a missing
> variable switches off. A fresh shell has none of your earlier exports, so
> **re-export the full set before every deploy** and run `npx cdk diff` first —
> if it shows a `[-]` (delete) you did not intend, a variable is missing. Stop
> and fix it before deploying.

Set the base variables once (every later part re-states what it needs):

```bash
export AWS_PROFILE=your-profile-name
export AWS_REGION=us-east-2        # the region you deploy the stack into
# Who may assume the Bedrock_Test_Role the stack creates (no default; required):
export TEST_ROLE_TRUSTED_PRINCIPAL_ARNS="arn:aws:iam::<account-id>:role/<your-sso-or-iam-principal>"
ACCT=$(aws sts get-caller-identity --query Account --output text)
npm install
```

---

## Part 1 — Start the CUR 2.0 export (do this first)

Skip this part if you do **not** want the dollar dashboards. Otherwise do it
**now** and then move straight on to Part 2 — do not wait on it here.

The BCM Data Exports API runs in **us-east-1 only**, regardless of your stack
region. CUR data is account-global and is queried from any region via Athena.

### 1a. If you already have a CUR 2.0 export

It must include **IAM principal data**, or per-team dollars can never appear.
Check:

```bash
ARN=$(aws bcm-data-exports list-exports --region us-east-1 \
  --query "Exports[0].ExportArn" --output text)
aws bcm-data-exports get-export --region us-east-1 --export-arn "$ARN" \
  --query "Export.DataQuery.TableConfigurations.COST_AND_USAGE_REPORT.INCLUDE_IAM_PRINCIPAL_DATA" \
  --output text
```

- Prints `TRUE` → you are set; note the export's S3 bucket and prefix for
  Part 7, and skip to Part 2.
- Prints `None`/empty → IAM principal data is **not** retroactive on an existing
  export. Create a **new** export with step 1b (use a distinct name/prefix).

### 1b. Create the CUR bucket and export

```bash
CUR_BUCKET="bedrock-cur2-export-$ACCT"

# Bucket (us-east-1) + the policy that lets Data Exports write to it
aws s3api create-bucket --bucket "$CUR_BUCKET" --region us-east-1
aws s3api put-bucket-policy --bucket "$CUR_BUCKET" --region us-east-1 --policy "{
  \"Version\":\"2012-10-17\",
  \"Statement\":[{
    \"Sid\":\"EnableAWSDataExportsToWriteToS3\",
    \"Effect\":\"Allow\",
    \"Principal\":{\"Service\":[\"bcm-data-exports.amazonaws.com\"]},
    \"Action\":[\"s3:PutObject\"],
    \"Resource\":\"arn:aws:s3:::$CUR_BUCKET/*\",
    \"Condition\":{
      \"ArnLike\":{\"aws:SourceArn\":\"arn:aws:bcm-data-exports:us-east-1:$ACCT:export/*\"},
      \"StringEquals\":{\"aws:SourceAccount\":\"$ACCT\"}
    }
  }]
}"

# The export. INCLUDE_IAM_PRINCIPAL_DATA=TRUE is REQUIRED — without it the CUR
# omits the line_item_iam_principal column (115 cols vs 116) and cannot carry
# per-team Bedrock cost.
COLS=$(aws bcm-data-exports get-table --table-name COST_AND_USAGE_REPORT \
  --table-properties INCLUDE_IAM_PRINCIPAL_DATA=TRUE \
  --query "Schema[].Name" --output text --region us-east-1)
SELECT_ALL=$(echo "$COLS" | tr '\t' ',')
python3 -c "
import json, sys
bucket, acct, cols = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
  'Name': 'bedrock-team-token-quota-cur2',
  'Description': 'CUR 2.0 export for bedrock-team-token-quota cost dashboards',
  'DataQuery': {
    'QueryStatement': f'SELECT {cols} FROM COST_AND_USAGE_REPORT',
    'TableConfigurations': {'COST_AND_USAGE_REPORT': {
      'TIME_GRANULARITY': 'DAILY', 'INCLUDE_RESOURCES': 'TRUE',
      'INCLUDE_MANUAL_DISCOUNT_COMPATIBILITY': 'FALSE',
      'INCLUDE_SPLIT_COST_ALLOCATION_DATA': 'FALSE',
      'INCLUDE_IAM_PRINCIPAL_DATA': 'TRUE'}}
  },
  'DestinationConfigurations': {'S3Destination': {
    'S3Bucket': bucket, 'S3Prefix': 'cur2', 'S3Region': 'us-east-1',
    'S3OutputConfigurations': {'OutputType': 'CUSTOM', 'Format': 'PARQUET',
      'Compression': 'PARQUET', 'Overwrite': 'OVERWRITE_REPORT'}}},
  'RefreshCadence': {'Frequency': 'SYNCHRONOUS'}
}))
" "$CUR_BUCKET" "$ACCT" "$SELECT_ALL" > /tmp/cur-export.json
aws bcm-data-exports create-export --export "file:///tmp/cur-export.json" --region us-east-1
```

**Confirm:** `aws bcm-data-exports list-exports --region us-east-1` lists
`bedrock-team-token-quota-cur2` with status `HEALTHY`. Its first delivery to S3
can take up to ~24h — that is fine, you continue now and return in Part 7.

Reference: [Creating a CUR 2.0 export](https://docs.aws.amazon.com/cur/latest/userguide/data-exports-migrate-two.html),
[Using IAM principal for cost allocation](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/iam-principal-cost-allocation.html).

---

## Part 2 — Deploy the core stack

```bash
npx cdk deploy --require-approval never --outputs-file cdk-outputs.json
```

This creates the token pipeline (DynamoDB tables, the collector/enforcer/daily-
reset Lambdas, the admin API Lambda), the analytics export, and the Glue/Athena
layer. QuickSight and the CUR cost Lambda are **not** created yet — they are
opt-in and come in Parts 6 and 7.

**Confirm:** the run ends with `✅ BedrockTeamTokenQuotaStack` and writes
`cdk-outputs.json`. Capture the admin API Lambda name — every admin command
below uses it:

```bash
ADMIN_FN=$(aws cloudformation describe-stacks --stack-name BedrockTeamTokenQuotaStack \
  --query "Stacks[0].Outputs[?OutputKey=='AdminApiFunctionNameOutput'].OutputValue" --output text)
echo "$ADMIN_FN"
```

> **Admin via CLI vs UI.** This runbook drives the admin API by invoking the
> Lambda directly. There is also a browser UI (Cognito login) for the same
> operations — see "Budget UI" in [README.md](./README.md) — but it is optional
> and not needed to follow this guide.
>
> **If you want that UI, now is the moment to set it up** — the stack is
> deployed and the Cognito IDs are already in `cdk-outputs.json`. Follow
> README's "Budget UI" section: copy those IDs into `web/.env`, then create a
> Cognito admin user with `aws cognito-idp admin-create-user`. The email you
> pass there is your **login username** (you type it again at the UI sign-in
> screen); it is not an env var or a stack parameter.

---

## Part 3 — Allow the models teams may use

A model must be on the allow-list before a team can be budgeted for it. Allow
each model your teams will call. Example — `amazon.nova-lite-v1:0` on the
Converse endpoint, in your stack region:

```bash
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload "{\"operation\":\"putModelRegistryEntry\",\"payload\":{\"modelId\":\"amazon.nova-lite-v1:0\",\"endpoint\":\"bedrock-runtime\",\"provider\":\"amazon\",\"scope\":\"regional\",\"region\":\"$AWS_REGION\"}}" \
  out.json && cat out.json   # -> {"ok":true}
```

**Confirm:**

```bash
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"listModelRegistry"}' out.json && cat out.json
# -> {"ok":true,"data":[{"modelId":"amazon.nova-lite-v1:0","endpoint":"bedrock-runtime",...}]}
```

### Mantle models (`bedrock-mantle`)

Mantle is a **co-equal endpoint, not an add-on** — allow the Mantle models your
teams use the same way, with `endpoint:"bedrock-mantle"`. Mantle ids are always
`regional` (no cross-region/global inference profiles). List what Mantle offers
in your region, then allow one:

```bash
# What Mantle serves here (its OpenAI-compatible /v1/models surface):
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload "{\"operation\":\"listModelCatalog\",\"payload\":{\"endpoint\":\"bedrock-mantle\",\"region\":\"$AWS_REGION\"}}" \
  out.json && cat out.json

# Allow one (use an id from the catalog above):
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload "{\"operation\":\"putModelRegistryEntry\",\"payload\":{\"modelId\":\"openai.gpt-oss-120b\",\"endpoint\":\"bedrock-mantle\",\"provider\":\"openai\",\"scope\":\"regional\",\"region\":\"$AWS_REGION\"}}" \
  out.json && cat out.json   # -> {"ok":true}
```

A model may be allowed on **both** endpoints — they are independent allow-list
entries keyed by `(modelId, endpoint, region)`, and one budget (Part 4) covers
both. Allowing a Mantle model is only step 1 for Mantle; finish it in **Part
5c**, which maps that usage to teams and makes enforcement and cost work.

---

## Part 4 — Set per-team daily token quotas (cost control)

A quota is a **daily token budget** for one `(team, model)` pair. A team is just
a `team` tag value on an IAM role (Part 5). If no quota exists for a
`(team, model)`, that team is **unrestricted** for that model (usage is still
tracked, never blocked).

```bash
# Example: team "data-science" may spend 50,000 tokens/day on nova-lite.
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"putQuota","payload":{"team":"data-science","model":"amazon.nova-lite-v1:0","dailyTokenQuota":50000}}' \
  out.json && cat out.json   # -> {"ok":true}
```

**Confirm:**

```bash
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"listQuotas","payload":{"team":"data-science"}}' out.json && cat out.json
# -> {"ok":true,"data":[{"model":"amazon.nova-lite-v1:0","dailyTokenQuota":50000}]}
```

> A quota of `0` is rejected. To make a team unrestricted again, delete its
> quota entry or use `removeDenyPolicy` (Part 5) to clear an active block.

---

## Part 5 — Generate team-tagged usage and verify enforcement

Teams are identified by a `team` tag on the IAM role that calls Bedrock. In
production you tag your **own** roles. For this walkthrough, create a few
throwaway tagged roles, drive usage through them, and watch a block happen.

### 5a. Create tagged roles and send usage

```bash
MODEL=amazon.nova-lite-v1:0
ME=$(aws sts get-caller-identity --query Arn --output text)
INVOKE='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream","bedrock:Converse","bedrock:ConverseStream"],"Resource":["arn:aws:bedrock:*::foundation-model/*","arn:aws:bedrock:*:*:inference-profile/*"]}]}'

for T in alpha beta gamma; do
  aws iam create-role --role-name "SampleTeamRole-$T" \
    --assume-role-policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"AWS\":\"$ME\"},\"Action\":\"sts:AssumeRole\"}]}" \
    --tags Key=team,Value=$T 2>/dev/null || true
  aws iam tag-role --role-name "SampleTeamRole-$T" --tags Key=team,Value=$T
  aws iam put-role-policy --role-name "SampleTeamRole-$T" --policy-name BedrockInvoke --policy-document "$INVOKE"
done
sleep 10   # let the new role trust/policy propagate

for T in alpha beta gamma; do
  CREDS=$(aws sts assume-role --role-arn "arn:aws:iam::$ACCT:role/SampleTeamRole-$T" \
    --role-session-name "usage-$T" --query Credentials --output json)
  AKI=$(echo "$CREDS" | python3 -c "import sys,json;print(json.load(sys.stdin)['AccessKeyId'])")
  SAK=$(echo "$CREDS" | python3 -c "import sys,json;print(json.load(sys.stdin)['SecretAccessKey'])")
  STK=$(echo "$CREDS" | python3 -c "import sys,json;print(json.load(sys.stdin)['SessionToken'])")
  for i in 1 2 3; do
    env -u AWS_PROFILE AWS_ACCESS_KEY_ID=$AKI AWS_SECRET_ACCESS_KEY=$SAK AWS_SESSION_TOKEN=$STK \
      aws bedrock-runtime converse --region "$AWS_REGION" --model-id "$MODEL" \
      --messages "[{\"role\":\"user\",\"content\":[{\"text\":\"Write ~200 words on event-driven architecture, example $i for team $T.\"}]}]" \
      --inference-config '{"maxTokens":600}' --query usage.totalTokens --output text
  done
done
```

Each call prints a token count. `env -u AWS_PROFILE ...` is required so the SDK
signs with the assumed-role credentials, not your base profile.

**Confirm attribution** (allow a few minutes for log delivery + the collector):

```bash
aws dynamodb scan --table-name Usage_Aggregation --region "$AWS_REGION" \
  --projection-expression "PK,SK,inputTokens,outputTokens"
# -> rows like PK="TEAM#alpha#MODEL#amazon.nova-lite-v1:0". A call from an
#    untagged role shows as TEAM#UNMAPPED# — correct, not an error.
```

### 5b. Watch a quota block happen (optional but recommended)

Set a deliberately tiny quota for one team, push it over, and watch the deny
policy attach.

```bash
# 500-token/day budget for team alpha on nova-lite
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"putQuota","payload":{"team":"alpha","model":"amazon.nova-lite-v1:0","dailyTokenQuota":500}}' \
  out.json && cat out.json
```

Re-run the alpha calls from 5a (the three `SampleTeamRole-alpha` Converse
calls). A few hundred tokens each will exceed 500.

> **Enforcement is asynchronous — allow ~10-15 minutes.** A successful Bedrock
> call is not "seen" instantly: Model Invocation Logging batches the log to S3,
> the collector updates the counter, then DynamoDB Streams triggers the
> enforcer. This is by design (event-driven, no polling).

**Confirm the block** (after ~10-15 min):

```bash
# The team is now blocked for this model:
aws dynamodb scan --table-name Blocked_State --region "$AWS_REGION" \
  --filter-expression "begins_with(PK, :p)" \
  --expression-attribute-values '{":p":{"S":"TEAM#alpha"}}' --output json
# And a deny policy is attached to the role:
aws iam list-role-policies --role-name SampleTeamRole-alpha --query PolicyNames --output text
# A fresh Converse call through SampleTeamRole-alpha now fails with AccessDeniedException.
```

**Restore access** (otherwise it clears automatically at 00:00 UTC):

```bash
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"removeDenyPolicy","payload":{"team":"alpha","model":"amazon.nova-lite-v1:0"}}' \
  out.json && cat out.json
```

### 5c. Cover the Mantle endpoint (`bedrock-mantle`)

Parts 5a/5b are the **Converse** half. **Mantle is the other half of this
product** — skip it and half your Bedrock spend goes untracked and unenforced.
Mantle has no per-request identity log, so its two rails use two different keys:

- **Token usage + enforcement** → the **Team↔Project mapping** (the `Project`
  dimension on `AWS/BedrockMantle` CloudWatch metrics), *not* the role tag.
- **Billed dollars** → the `team` tag on the IAM role whose **bearer token**
  authorized the call (CUR `iamPrincipal/team`).

Full per-team Mantle coverage therefore needs **both** of the steps below (see
[How a budget maps to Converse vs Mantle](./README.md#how-a-budget-maps-to-converse-vs-mantle)).

**1. Allow a Mantle model** — the "Mantle models" block in
[Part 3](#part-3--allow-the-models-teams-may-use). The collector ignores Mantle
until at least one `bedrock-mantle` model is on the allow-list.

**2. Map each Mantle Project to a team.** This stack has **no project-discovery
API** — read your project ids from the metrics your Mantle traffic emits, then
map each one:

```bash
# Project ids that have emitted Mantle metrics (the dimension the collector reads):
aws cloudwatch list-metrics --namespace AWS/BedrockMantle --region "$AWS_REGION" \
  --query "Metrics[].Dimensions[?Name=='Project'].Value" --output text | tr '\t' '\n' | sort -u

# Map one to a team (repeat per project):
aws lambda invoke --function-name "$ADMIN_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"putTeamProjectMapping","payload":{"projectId":"<project-id>","team":"alpha"}}' \
  out.json && cat out.json   # -> {"ok":true}
```

Usage for a Mantle project with **no** mapping is bucketed under team `UNMAPPED`
(never dropped), so that team's budget never sees it and enforcement never fires.

**3. Make the Mantle-calling roles enforceable and cost-attributed.** The roles
your apps use to call Mantle must (a) carry the `team` tag — so **CUR attributes
the dollars** — and (b) be known to enforcement. A `team`-tagged role is cached
for enforcement automatically the instant it is tagged; pre-existing roles can
be added with `reconcileTeamRoles` or `mapRoleToTeam`
(`{"roleArn":"...","team":"..."}`). **This step is more load-bearing for Mantle
than Converse**: Mantle has no per-request log to auto-cache a role "on use," so
a Mantle breach for a team whose roles aren't cached records the block and sends
a notification but attaches **no deny policy**.

**4. Drive Mantle traffic.** Mantle inference is an OpenAI-compatible HTTPS call
to `https://bedrock-mantle.<region>.api.aws` authorized by a short-lived Bedrock
bearer token (minted e.g. with `@aws/bedrock-token-generator`) from a
`team`-tagged role. There is **no `aws` CLI verb** for Mantle inference, so point
an existing Mantle client at a model you allowed in step 1 using credentials
from a team-tagged role — in production this is just your normal app traffic.

**Confirm attribution** (after the collector's next 15-min run):

```bash
aws dynamodb scan --table-name Usage_Aggregation --region "$AWS_REGION" \
  --filter-expression "#e = :m" \
  --expression-attribute-names '{"#e":"endpoint"}' \
  --expression-attribute-values '{":m":{"S":"bedrock-mantle"}}' \
  --projection-expression "PK,SK,inputTokens,outputTokens" --output json
# -> rows like PK="TEAM#alpha#MODEL#openai.gpt-oss-120b". PK="TEAM#UNMAPPED#..."
#    means that project id is not mapped yet (step 2).
```

**Enforcement** uses the same endpoint-agnostic budget (Part 4), but a Mantle
breach attaches a `bedrock-mantle-quota-deny-*` inline policy denying
`bedrock-mantle:CreateInference` for that one model (vs `bedrock-quota-deny-*` /
`bedrock:InvokeModel` on Converse). A model allowed on both endpoints keeps one
budget but gets two independent deny policies.

---

## Part 6 — Token-usage QuickSight dashboards

These show per-team token counts (fresh within minutes). They need a QuickSight
subscription. Dollars come later in Part 7.

### 6a. Publish the current usage for the dashboards

```bash
EXPORT_FN=$(aws lambda list-functions \
  --query "Functions[?contains(FunctionName,'AnalyticsExportFunction')].FunctionName" --output text)
aws lambda invoke --function-name "$EXPORT_FN" --cli-binary-format raw-in-base64-out --payload '{}' out.json
```

**Confirm:** `s3://<analyticsBucket>/token-usage/dt=<today>/part-0.json` exists
(the analytics bucket name is found by prefix in 6b).

### 6b. Grant QuickSight's service role access to the analytics bucket

The data-source connection test runs an Athena query and must **write results**
to the bucket, so the grant needs `s3:PutObject` on `athena-results/`, not just
read.

```bash
BUCKET=$(aws s3 ls | awk '{print $3}' | grep analyticsexportbucket)
aws iam put-role-policy --role-name aws-quicksight-service-role-v0 \
  --policy-name BedrockTeamTokenQuotaAnalyticsBucketAccess \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[
    {\"Sid\":\"ReadAnalyticsData\",\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:ListBucket\",\"s3:GetBucketLocation\"],\"Resource\":[\"arn:aws:s3:::$BUCKET\",\"arn:aws:s3:::$BUCKET/*\"]},
    {\"Sid\":\"WriteAthenaResults\",\"Effect\":\"Allow\",\"Action\":[\"s3:PutObject\",\"s3:AbortMultipartUpload\"],\"Resource\":[\"arn:aws:s3:::$BUCKET/athena-results/*\"]}
  ]}"
```

### 6c. Redeploy with your QuickSight principal

> **Region gotcha.** The principal ARN must reference your QuickSight **home
> (identity) region**, which is often **not** your stack region. Find it with
> `aws quicksight list-users --aws-account-id $ACCT --namespace default --region <guess>`
> until it returns your user.

```bash
# Re-export the full environment (see the Part 0 rule), then add the principal:
export QUICKSIGHT_PRINCIPAL_ARN="arn:aws:quicksight:<home-region>:$ACCT:user/default/<your-qs-username>"
npx cdk diff     # expect only ADDITIONS (QuickSight data source, datasets, 2 dashboards)
npx cdk deploy --require-approval never --outputs-file cdk-outputs.json
```

This creates **two** dashboards, split by **audience** — each carries a
token-usage view and (after Part 7) a **Billed Cost** view as separate sheets:

| Dashboard (display name) | Id | Row-level security | For |
|---|---|---|---|
| Bedrock Team Token Usage & Cost (Admin - All Teams) | `bedrock-team-token-quota-cost-admin` | none — all teams | admins / FinOps |
| Bedrock Team Token Usage & Cost | `bedrock-team-token-quota-cost` | yes — each user sees only their team(s) | team leads |

> The dollar view is the **Billed Cost** sheet *inside* each dashboard (switch
> with the sheet tabs at the top), not a separate "cost" dashboard.

### 6d. Upload row-level-security rules (so the team dashboard renders)

The admin dashboard works immediately. The team dashboard shows "data is
restricted" until you map QuickSight usernames to teams.

```bash
# Your QuickSight username — for SSO users it's the full name,
# e.g. "AWSReservedSSO_<permset>_<id>/you@example.com":
QS_USER="<your quicksight username>"
printf '%s\n' "{\"username\":\"$QS_USER\",\"team\":\"alpha\"}" \
              "{\"username\":\"$QS_USER\",\"team\":\"beta\"}" \
              "{\"username\":\"$QS_USER\",\"team\":\"gamma\"}" > rls-rules.json
aws s3 cp rls-rules.json "s3://$BUCKET/rls/rules.json" && rm -f rls-rules.json
```

**Confirm:** open the **admin** dashboard — it shows all teams' token usage. The
**team** dashboard shows only the teams you mapped. (Datasets are DIRECT_QUERY,
so rules take effect on the next dashboard load — no refresh step.)

---

## Part 7 — Dollar dashboards from CUR 2.0 (next day)

This lights up **AWS-billed dollars per team**. It depends on the CUR clock, so
you do it a day or two after Part 1. Do the sub-steps **in order** and do not
run the next until its check passes.

### 7a. Activate the `iamPrincipal/team` cost-allocation tag

> **The key is `iamPrincipal/team`, NOT `team`.** Bedrock attributes cost to the
> calling IAM principal, and billing lists IAM-principal tags under the
> `iamPrincipal/` prefix. Activating the bare `team` key fails forever — it is a
> different key.

```bash
aws ce update-cost-allocation-tags-status --region us-east-1 \
  --cost-allocation-tags-status '[{"TagKey":"iamPrincipal/team","Status":"Active"}]'
```

- **Succeeds (empty `Errors`)** → the tag is active. Cost-allocation tags are
  **not retroactive**, so now **re-run the Part 5a usage** to produce
  post-activation tagged usage (or rely on your real ongoing traffic). Continue
  to 7b.
- **Errors `Tag keys not found: iamPrincipal/team`** → billing has not listed
  the key yet. It only becomes listable after a `team`-tagged role has made a
  Bedrock call (Part 5), and can take up to ~24h. Wait and re-run this exact
  command — that is the whole "is it time yet?" loop.

In an AWS Organization, run this in the **management (payer) account** (see
[Known caveats](#known-caveats)).

### 7b. Catalog the CUR in Glue (one-time)

CUR 2.0 does **not** auto-create a Glue table — you crawl it once. (If you
already had a CUR with Glue integration from Part 1a, use that database/table
name instead and skip to 7c.)

```bash
CUR_BUCKET="bedrock-cur2-export-$ACCT"

aws glue create-database --region "$AWS_REGION" \
  --database-input '{"Name":"cur2_db","Description":"CUR 2.0 raw export for bedrock-team-token-quota"}'

aws iam create-role --role-name BedrockCur2CrawlerRole \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"glue.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name BedrockCur2CrawlerRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole
aws iam put-role-policy --role-name BedrockCur2CrawlerRole --policy-name CurS3Read \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:ListBucket\"],\"Resource\":[\"arn:aws:s3:::$CUR_BUCKET\",\"arn:aws:s3:::$CUR_BUCKET/*\"]}]}"
sleep 10

aws glue create-crawler --region "$AWS_REGION" --name bedrock-cur2-crawler \
  --role "arn:aws:iam::$ACCT:role/BedrockCur2CrawlerRole" --database-name cur2_db \
  --targets "{\"S3Targets\":[{\"Path\":\"s3://$CUR_BUCKET/cur2/bedrock-team-token-quota-cur2/data/\"}]}"
aws glue start-crawler --region "$AWS_REGION" --name bedrock-cur2-crawler
```

**Confirm:** wait for the crawler to return to `READY`, then the table exists:

```bash
aws glue get-crawler --region "$AWS_REGION" --name bedrock-cur2-crawler --query "Crawler.State" --output text
aws glue get-tables --region "$AWS_REGION" --database-name cur2_db --query "TableList[].Name" --output text
# -> prints "data"  (CUR_DATABASE_NAME=cur2_db, CUR_TABLE_NAME=data)
```

### 7c. ⛔ Wait until the CUR actually contains your team values

The tag appears in CUR's `tags` map as `iamPrincipal/team`, only on usage billed
**after** 7a, and only after the export delivers a new file (~24h). Re-crawl if
the export changed, then query until team names appear:

```bash
BUCKET=$(aws s3 ls | awk '{print $3}' | grep analyticsexportbucket)   # for Athena results
QID=$(aws athena start-query-execution --region "$AWS_REGION" \
  --work-group bedrock-team-token-quota \
  --query-execution-context Database=cur2_db \
  --result-configuration "OutputLocation=s3://$BUCKET/athena-results/" \
  --query-string "SELECT DISTINCT tags['iamPrincipal/team'] AS team
                  FROM cur2_db.data
                  WHERE line_item_product_code IN ('AmazonBedrock', 'AmazonBedrockService')" \
  --query QueryExecutionId --output text)
sleep 5
aws athena get-query-results --region "$AWS_REGION" --query-execution-id "$QID" \
  --query 'ResultSet.Rows[].Data[].VarCharValue' --output text
```

- Only a `team` header / blanks → not landed yet. **Wait and re-run.** Do not
  proceed.
- Real team names (`alpha`, `beta`, ...) → proceed to 7d.

> **Why two product codes.** Bedrock bills under both `AmazonBedrock` (Nova,
> Llama, gpt-oss, ...) and `AmazonBedrockService` (Anthropic Claude). On a real
> account Claude is often ~99% of the dollars, so both are required. (AWS's CUR
> reference documents usage-type patterns and token types but does not enumerate
> product codes — this split is from inspecting a live export, so re-check it if
> your account shows Bedrock cost under a different `line_item_product_code`.)

### 7d. Redeploy pointed at the CUR table

```bash
# Re-export the FULL environment (Part 0 rule) including QuickSight, then add CUR:
export QUICKSIGHT_PRINCIPAL_ARN="arn:aws:quicksight:<home-region>:$ACCT:user/default/<your-qs-username>"   # same as Part 6
export CUR_DATABASE_NAME="cur2_db"
export CUR_TABLE_NAME="data"
export CUR_BUCKET_NAME="bedrock-cur2-export-$ACCT"   # Athena reads CUR with the Lambda's creds; required

npx cdk diff     # expect only ADDITIONS (CurTeamCost Lambda, cur_team_cost table,
                 # "Billed Cost" sheet + datasets). Any QuickSight [-] = a missing
                 # variable — STOP (see the Part 0 rule).
npx cdk deploy --require-approval never --outputs-file cdk-outputs.json
```

**Confirm:** run the cost Lambda once (instead of waiting for its 6-hourly
schedule), then open the **Billed Cost** sheet on either dashboard:

```bash
FN=$(aws lambda list-functions \
  --query "Functions[?contains(FunctionName,'CurTeamCostFunction')].FunctionName" --output text)
aws lambda invoke --function-name "$FN" --cli-binary-format raw-in-base64-out --payload '{}' out.json
# No "FunctionError" → it wrote s3://<analyticsBucket>/cur-team-cost/dt=<today>/part-0.json
```

The admin dashboard's Billed Cost sheet shows every team (untagged pre-activation
spend appears under `UNTAGGED`); the team dashboard shows each viewer's own
team(s). Token counts on this sheet come from the bill (CUR reports usage in
`1K tokens`, which the Lambda converts to absolute counts).

> **What's summed.** Bedrock bills a separate CUR line item per token type —
> input, output, **cache-read**, and **cache-write** — plus distinct usage
> types for service tier (standard/priority/flex) and cross-region routing. The
> cost Lambda sums **all** of them per `(team, model, endpoint)`, so the dollars
> reconcile to the invoice; AWS notes that counting only input + output
> undercounts. See
> [Understanding your Bedrock CUR data](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-understanding-cur-data.html).

> **Mantle dollars attribute the same way, with one wrinkle.** CUR groups by
> `iamPrincipal/team`, and for Mantle AWS bills the role whose **bearer token**
> authorized the call — so Mantle spend lands per team only when your apps mint
> those tokens from `team`-tagged roles (otherwise `UNTAGGED`, even though the
> Team↔Project mapping still attributes the *tokens*). Mantle-served Claude bills
> under `AmazonBedrockService`, already included in the query above. Both
> endpoints share this ~1-2 day CUR delay.

---

## Part 8 — Full verification checklist

| # | Check | Command / where |
|---|---|---|
| 1 | Stack deployed | `cdk-outputs.json` written; `✅ BedrockTeamTokenQuotaStack` |
| 2 | Model allowed | `listModelRegistry` (Part 3) |
| 3 | Quota set | `listQuotas` (Part 4) |
| 4 | Usage attributed per team | `Usage_Aggregation` scan (Part 5a) |
| 5 | Enforcement blocks + restores | `Blocked_State` + role deny policy (Part 5b) |
| 6 | Token dashboards render | admin + team dashboards (Part 6) |
| 7 | CUR has team values | Athena query returns team names (Part 7c) |
| 8 | Dollar dashboards render | Billed Cost sheet (Part 7d) |
| 9 | Mantle model allowed + project mapped | `listModelRegistry` (a `bedrock-mantle` entry) + `listTeamProjectMappings` (Part 5c) |
| 10 | Mantle usage attributed per team | `Usage_Aggregation` rows with `endpoint=bedrock-mantle` (Part 5c) |

---

## Part 9 — Tear it down

```bash
# A. Empty the buckets and the Athena workgroup (CloudFormation won't delete non-empty ones)
LOG_BUCKET=$(aws cloudformation describe-stacks --stack-name BedrockTeamTokenQuotaStack \
  --query "Stacks[0].Outputs[?OutputKey=='ModelInvocationLogBucketNameOutput'].OutputValue" --output text)
aws s3 rm "s3://$LOG_BUCKET" --recursive
for b in $(aws s3 ls | awk '{print $3}' | grep analyticsexportbucket); do aws s3 rm "s3://$b" --recursive; done
aws athena delete-work-group --work-group bedrock-team-token-quota --recursive-delete-option

# B. Destroy the stack (TEST_ROLE_TRUSTED_PRINCIPAL_ARNS must still be set)
npx cdk destroy --force

# C. Out-of-band resources the stack does not own:
#  - sample roles
for R in $(aws iam list-roles --query "Roles[?starts_with(RoleName,'SampleTeamRole')].RoleName" --output text); do
  for P in $(aws iam list-role-policies --role-name "$R" --query "PolicyNames" --output text); do
    aws iam delete-role-policy --role-name "$R" --policy-name "$P"; done
  aws iam delete-role --role-name "$R"; done
#  - QuickSight S3 grant (if you did Part 6)
aws iam delete-role-policy --role-name aws-quicksight-service-role-v0 \
  --policy-name BedrockTeamTokenQuotaAnalyticsBucketAccess 2>/dev/null || true
#  - CUR Glue catalog (if you did Part 7b)
aws glue delete-crawler --region "$AWS_REGION" --name bedrock-cur2-crawler 2>/dev/null || true
aws glue delete-database --region "$AWS_REGION" --name cur2_db 2>/dev/null || true
aws iam delete-role-policy --role-name BedrockCur2CrawlerRole --policy-name CurS3Read 2>/dev/null || true
aws iam detach-role-policy --role-name BedrockCur2CrawlerRole --policy-arn arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole 2>/dev/null || true
aws iam delete-role --role-name BedrockCur2CrawlerRole 2>/dev/null || true

# D. Local files
rm -f cdk-outputs.json web/.env
```

> **Keeping CUR?** To preserve the dollar history, **skip the CUR Glue cleanup
> and the CUR export/bucket** — they carry the ~1-2 day clock you already paid
> for. Deleting and recreating them restarts that clock. (The cost-allocation
> tag activation is a Billing setting and is not removed by any of the above;
> deactivate it separately if you want, in us-east-1.)

---

## Known caveats

- **AWS Organizations / member accounts.** AWS activates cost-allocation tags in
  the **management (payer) account**; member-account usage consolidates there.
  If your Bedrock account is a member account, the Part 7a activation must be
  done by the management account's admin. Verified only from an account that
  *is* the management account; the member-account path is per AWS guidance, not
  verified here.
  Sources: [IAM principal cost allocation](https://aws.amazon.com/blogs/aws-cloud-financial-management/track-amazon-bedrock-costs-by-caller-identity-with-iam-based-cost-allocation/),
  [Bedrock inference-profile cost tracking](https://aws.amazon.com/blogs/architecture/track-generative-ai-costs-with-amazon-bedrock-inference-profiles/).
- **The CUR clock is AWS-side.** The ~1-2 day wait in Parts 1 and 7 is billing
  propagation + export delivery, not something the stack or this runbook can
  speed up.
- **`UNMAPPED` vs `UNTAGGED` — not the same thing.**
  - `UNMAPPED` (token pipeline) is usage this system could not attribute to a
    team: on **Converse**, a call from a role with **no `team` tag**; on
    **Mantle**, usage from a `Project` with **no Team↔Project mapping** (Part
    5c). Either way it is bucketed under `UNMAPPED`, never dropped.
  - `UNTAGGED` (cost / CUR Billed Cost sheet) is Bedrock cost with **no
    `iamPrincipal/team` value in the CUR**, which happens for either reason:
    (a) the calling role had no `team` tag, **or** (b) the usage was billed
    *before* you activated the tag — cost-allocation tags are **not
    retroactive**, so all pre-activation spend is `UNTAGGED` even if the role
    carried a `team` tag at the time. On a fresh account this is the usual
    cause: your historical Bedrock spend stays `UNTAGGED`, and only usage billed
    after activation attributes to a team. Both are expected, not errors.
- **Mantle enforcement needs the team's roles cached.** Mantle has no
  per-request log, so a Mantle breach only attaches deny policies to roles
  already in the role cache (tagged, reconciled, or `mapRoleToTeam`'d). A
  Mantle-only team with no cached roles gets the block recorded and a
  notification sent, but nothing is actually denied until a role is cached.
  (Converse auto-caches a role the first time it is used.)

For the architecture, the full IAM least-privilege breakdown, the reconcile
sweep for mapping existing roles to teams, the Mantle endpoint, and design
rationale, see [README.md](./README.md).
