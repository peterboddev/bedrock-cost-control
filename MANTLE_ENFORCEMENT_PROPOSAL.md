# Mantle Enforcement — Current State & Proposal

This document captures what a full teardown-and-replay of the deploy runbook
revealed about the **Mantle (`bedrock-mantle`)** half of the system, and
proposes fixes for the two issues that are still open. It is a decision doc:
one issue is already fixed and committed; two need a design call before I touch
them.

## Context

Everything except the CUR 2.0 export/bucket/data/tag was torn down, then
`DEPLOY.md` was followed end-to-end as a customer would, on a live account
(`us-east-2`). Keeping CUR meant the dollar steps (Part 7) completed in minutes
instead of waiting 1–2 days for the billing clock.

---

## Current state

### Validated working, end-to-end

| Area | Result |
|---|---|
| Core deploy (Part 2) | ✓ |
| Allow-list — **Converse and Mantle** (Part 3, incl. the new Mantle block) | ✓ |
| Quotas (Part 4) | ✓ |
| Converse usage attribution (Part 5a) | ✓ alpha/beta/gamma rows in `Usage_Aggregation` |
| Converse enforcement (Part 5b) | ✓ block + `bedrock-quota-deny-*` attached + `AccessDenied` |
| Mantle usage attribution (Part 5c) | ✓ **after the fix below** — alpha `openai.gpt-oss-120b` row, `endpoint=bedrock-mantle` |
| QuickSight dashboards (Part 6) | ✓ |
| Glue recrawl of preserved CUR (Part 7b) | ✓ seconds, no billing-clock wait |
| CUR per-team dollars (Part 7c/7d) | ✓ `alpha/beta/gamma` dollars written |

The runbook itself is accurate A–Z. The teardown also confirmed Part 9's note
that the Athena workgroup must be emptied before `cdk destroy` (it fails on a
non-empty workgroup).

### Already fixed — Finding A: Mantle usage collection was silently broken

**Committed as `b44ec2f`.** The Mantle usage collector queried CloudWatch
metrics `TotalInputTokens`/`TotalOutputTokens` with a **`ModelId`** dimension,
but the live `AWS/BedrockMantle` metrics expose per-`(Project, Model)` tokens as
**`InputTokens`/`OutputTokens`** with a **`Model`** dimension (the `Total*`
variants exist only at `[]`, `[Project]`, or `[Model]` granularity — never the
combined `[Project, Model]`). `GetMetricData` matched nothing, so **all Mantle
token usage silently returned zero** — which broke both Mantle usage tracking
and Mantle enforcement (enforcement keys off `Usage_Aggregation`, which never
got a Mantle row).

Unit tests passed because they asserted the code's own (wrong) strings without
hitting CloudWatch. The fix (`src/mantleMetrics.ts`) corrects the metric names
and dimension, adds a regression test asserting them, and was verified live: a
team's 1,960 Mantle tokens now land in `Usage_Aggregation` with
`endpoint=bedrock-mantle`.

### Open — Finding B: Mantle enforcement is unreliable (not yet fixed)

With collection fixed, Mantle **usage** attributes correctly, but Mantle
**enforcement** only works for ~15 minutes after a role is tagged/mapped.

### Open — Finding C: `removeDenyPolicy` is not idempotent (not yet fixed)

Clearing a block whose deny policy was never attached fails and leaves the model
stuck in `PENDING_RESET`.

---

## Finding B — Mantle enforcement reliability gap

### Symptom (observed live)

A Mantle quota breach wrote `Blocked_State` and sent a "blocked" notification,
but attached **no deny policy** to the team's role. No `ATTACH_DENY` audit entry
was written. The Converse breach on the *same role* minutes earlier *did* attach
its deny — so the role was reachable then, but not at Mantle-breach time.

### Root cause

The enforcer resolves a team's roles from `Team_Role_Cache` via
`listRolesForTeam` (`src/quotaEnforcer.ts` → `src/teamRoleCache.ts`). That cache
has a **15-minute TTL** (`DEFAULT_CACHE_TTL_SECONDS = 15 * 60`); the table has a
DynamoDB TTL on the `ttl` attribute, so expired entries are reaped. Three things
combine:

1. **Converse self-heals.** Every Converse call runs `resolveTeam`, which
   re-writes the role→team entry with a fresh 15-min TTL. An actively-used
   Converse role is therefore always in the cache at breach time.
2. **Mantle has no per-request role resolution.** Mantle usage is attributed by
   the `Project→team` mapping, not by resolving the calling role, so nothing
   re-warms a Mantle-only role's cache entry on use.
3. **Reconciliation is on-demand only.** `infra/stack.ts` deliberately runs
   reconciliation as an on-demand SQS fan-out with **no schedule** (to avoid
   `iam:ListRoles` throttling on large accounts). The file's own header comment
   is stale and wrongly claims a *"Reconciliation Lambda (15-minute scheduled
   EventBridge rule)"* — there is none.

So a Mantle-only role is warmed once (by the `TagRole` event, or `mapRoleToTeam`,
or an on-demand reconcile), its entry expires 15 minutes later, and nothing
re-warms it. After that, `listRolesForTeam(team)` returns empty and the enforcer
hits its documented "silent no-op" branch: it still writes `Blocked_State` and
notifies, but the per-role attach loop has zero iterations, so **no deny policy
is applied**. The `TagRole` warming comment even says it closes the gap "without
waiting for the next periodic reconciliation sweep" — but that periodic sweep
doesn't exist, so the gap only closes for 15 minutes.

### Impact

Mantle enforcement is effectively non-functional for any Mantle-only team beyond
the first 15 minutes after its roles are registered. Budgets can be breached
with no deny applied; the system reports a block that was never enforced. This
is the enforcement half of "Mantle is half the product."

---

## Finding C — `removeDenyPolicy` is not idempotent

### Symptom / root cause

Clearing the stale (never-attached) Mantle block via the admin `removeDenyPolicy`
op produced `REMOVE_DENY_FAILED` and left `Blocked_State` in `PENDING_RESET`. The
removal path (`src/dailyReset.ts` → `iam:DeleteRolePolicy`) treats a missing
inline policy (`NoSuchEntity`) as a failure and retries/aborts, rather than
treating "already not there" as success.

### Impact

Minor but real: a block that was a silent no-op (Finding B), or any already-
cleared block, cannot be cleared cleanly and gets stuck in `PENDING_RESET`,
which the daily reset then retries indefinitely.

---

## Proposal

### Fix B — make authoritative role→team mappings durable

Distinguish **authoritative** mappings from the **IAM-lookup cache**:

- **Authoritative** entries are written when someone states a role's team
  explicitly: the `TagRole` event (`cacheRoleTeam`), the `mapRoleToTeam` admin
  op, and the reconcile worker. These are facts, not a throttling cache.
- **IAM-lookup** entries are written by `resolveTeam` when it resolves a role's
  tag from IAM during Converse use. These are a cache and should stay fresh.

Change:

1. `cacheRoleTeam` (and the reconcile worker's upsert) write the entry **without
   a `ttl` attribute** → DynamoDB never reaps it → the role stays enforceable
   indefinitely, with no periodic IAM scan.
2. `resolveTeam` keeps writing a 15-minute `ttl` (unchanged) for its IAM-lookup
   entries.
3. `isFresh()` treats a **missing `ttl` as "never expires"** (always fresh), so a
   Converse `resolveTeam` cache-hit on a durable entry returns immediately
   instead of needlessly re-resolving and re-stamping a short TTL.
4. Fix the stale `infra/stack.ts` header comment to say reconciliation is
   on-demand (no schedule).

**Why this is the right fix.** It aligns with the deliberate "no periodic
`iam:ListRoles` sweep" design: authoritative mappings persist on their own, so
Mantle enforcement works without reintroducing the IAM-throttle risk that
on-demand reconciliation was created to avoid.

**Tradeoff.** A durable entry persists until an explicit event changes it
(`UntagRole`, a re-tag, or an on-demand reconcile with `forceRefresh`). If a
role's `team` tag is changed directly in IAM and nothing re-reconciles, the
mapping is stale until then. This is **no worse than today** (today the entry
simply vanishes and enforcement breaks), it matches the system's existing
event-driven consistency model, and `UntagRole`/reconcile already exist to
correct it.

**Alternatives considered**

- *Add a periodic reconciliation schedule* (what the stale comment claims
  exists). Rejected: the implementation intentionally removed it to avoid
  `iam:ListRoles` throttling on large accounts. A low-frequency opt-in sweep
  could complement this fix later, but should not be the primary mechanism.
- *Resolve roles for Mantle enforcement from the `Project→team` mapping.*
  Rejected: that mapping carries no role ARNs; deny policies attach to roles,
  which must come from the cache.

### Fix C — idempotent deny removal

In the removal path (`src/dailyReset.ts`'s `resetBlockedStatePair` /
`removeModelDenyPolicy`), treat `DeleteRolePolicy` returning `NoSuchEntity`
(policy — or role — not present) as **success**. Clearing a block whose deny was
never attached (or was already removed) then completes cleanly and clears
`Blocked_State` instead of parking it in `PENDING_RESET`.

### Optional hardening

The enforcer currently writes `Blocked_State` + notifies even when it attached
zero deny policies (zero roles resolved). Once B is fixed this is rare, but it
would be worth either logging a warning ("blocked, but 0 roles mapped for team")
or surfacing it in the audit trail so a genuinely unmapped team is visible rather
than silently unenforced.

---

## Verification plan

**Unit (jest):**
- `isFresh` returns fresh for an entry with no `ttl`.
- `cacheRoleTeam` writes no `ttl`; `resolveTeam` still writes a 15-min `ttl`.
- Deny removal treats `NoSuchEntity` as success (no `PENDING_RESET`).

**Live:**
- Tag a Mantle-only role, wait **>15 minutes**, drive Mantle usage over quota,
  and confirm a `bedrock-mantle-quota-deny-*` policy attaches (the exact case
  that silently no-oped during the replay).
- Confirm Converse enforcement is unchanged.

**Regression:** full suite (currently 292 tests) stays green; `cdk diff` after
the change touches only the affected Lambdas.

---

## Rollout / risk

Code-only change to `src/teamRoleCache.ts` and `src/dailyReset.ts` (plus a
comment fix in `infra/stack.ts`); redeploy picks it up on the affected Lambdas.
Low blast radius, no data migration — existing cache entries either age out or
get overwritten with durable ones on the next tag/map/reconcile/use.

## Summary

| # | Finding | Status | Fix |
|---|---|---|---|
| A | Mantle usage collection queried the wrong metric name + dimension (collected nothing) | **Fixed** (`b44ec2f`) | Correct metric names + `Model` dimension + regression test |
| B | Mantle enforcement silently stops after the 15-min role-cache TTL | Open — needs your call | Durable authoritative role→team mappings; keep the 15-min TTL only for IAM-lookup cache entries; fix the stale schedule comment |
| C | `removeDenyPolicy` not idempotent when the deny was never attached | Open — needs your call | Treat `NoSuchEntity` on delete as success |
