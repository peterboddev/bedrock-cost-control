import { useEffect, useMemo, useState } from "react";
import { Authenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";

import {
  CatalogModel,
  ModelRegistryEntry,
  QuotaEntry,
  TeamRoleMapping,
  deleteModelRegistryEntry,
  listModelCatalog,
  listModelRegistry,
  listQuotas,
  listTeams,
  listTeamRoleMappings,
  getReconcileJob,
  mapRoleToTeam,
  putModelRegistryEntry,
  putQuota,
  reconcileTeamRoles,
} from "./api";
import { assertConfigured, config } from "./config";
import { currentConnection } from "./session";
import { Dropdown } from "./Dropdown";

type Status = { kind: "ok" | "err"; text: string } | null;

/** Sentinel value for the "add a new team" option in the team <select>. */
const NEW_TEAM_OPTION = "__new_team__";

/** Human-friendly label for a model's serving endpoint. */
function endpointLabel(endpoint?: string): string {
  if (endpoint === "bedrock-mantle") return "Mantle";
  if (endpoint === "bedrock-runtime") return "Converse";
  return "unregistered";
}

/** Human-friendly label for an inference scope. */
function scopeLabel(scope?: string): string {
  if (scope === "cross-region") return "Cross-region";
  if (scope === "global") return "Global";
  if (scope === "regional") return "Regional";
  return "—";
}

/**
 * AWS Regions offered in the admin "Allowed models" region picker. Covers the
 * Bedrock-mantle Regions (per AWS docs) plus common bedrock-runtime Regions.
 * The deployment region is always included (prepended at render time).
 */
const BEDROCK_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "ap-northeast-1",
  "ap-south-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-south-1",
  "eu-north-1",
  "sa-east-1",
];

export function App() {
  const configError = useMemo(() => assertConfigured(), []);

  if (configError) {
    return (
      <div className="app">
        <h1>Bedrock Team Token Budgets</h1>
        <div className="msg err">
          {configError}. Create <code>web/.env</code> from the CDK stack outputs
          (see <code>web/.env.example</code>) and restart the dev server.
        </div>
      </div>
    );
  }

  return (
    <Authenticator hideSignUp>
      {({ signOut, user }) => (
        <BudgetConsole
          email={user?.signInDetails?.loginId ?? user?.username}
          onSignOut={() => signOut?.()}
        />
      )}
    </Authenticator>
  );
}

function BudgetConsole({
  email,
  onSignOut,
}: {
  email?: string;
  onSignOut: () => void;
}) {
  const [team, setTeam] = useState("");
  const [teams, setTeams] = useState<string[]>([]);
  const [addingNewTeam, setAddingNewTeam] = useState(false);
  const [loadedTeam, setLoadedTeam] = useState("");
  const [quotas, setQuotas] = useState<QuotaEntry[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [models, setModels] = useState<ModelRegistryEntry[]>([]);
  const [newModel, setNewModel] = useState("");
  // Admin "Allowed models" section — dependent dropdowns:
  //   Endpoint -> Region -> Scope (runtime only) -> Model.
  const [allowEndpoint, setAllowEndpoint] = useState("bedrock-runtime");
  const [allowRegion, setAllowRegion] = useState(config.region);
  const [allowScope, setAllowScope] = useState("regional");
  const [allowModelId, setAllowModelId] = useState("");
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [newQuota, setNewQuota] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  // Team → IAM role mapping panel state.
  const [reconciling, setReconciling] = useState(false);
  const [reconcileProgress, setReconcileProgress] = useState("");
  const [mapRoleArn, setMapRoleArn] = useState("");
  const [mapRoleTeam, setMapRoleTeam] = useState("");
  // Read-only view of the role→team mappings the system currently knows.
  const [mappings, setMappings] = useState<TeamRoleMapping[]>([]);
  const [mappingsLoading, setMappingsLoading] = useState(false);

  async function refreshTeams() {
    try {
      const conn = await currentConnection();
      const res = await listTeams(conn);
      if (res.ok) setTeams(res.data);
    } catch {
      /* non-fatal: the picker just stays empty and the user can type a team */
    }
  }

  // Load the current role→team mappings (reconcile output + on-use/tag caches).
  async function refreshMappings() {
    setMappingsLoading(true);
    try {
      const conn = await currentConnection();
      const res = await listTeamRoleMappings(conn);
      if (res.ok) {
        setMappings(
          [...res.data].sort(
            (a, b) => a.team.localeCompare(b.team) || a.roleArn.localeCompare(b.roleArn)
          )
        );
      }
    } catch {
      /* non-fatal: the mappings table just stays empty */
    }
    setMappingsLoading(false);
  }

  // Populate the team picker + mappings view + allow-list once, on first render.
  useEffect(() => {
    void refreshTeams();
    void refreshMappings();
    void refreshAllowedModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Loads the allow-list (Model_Registry) that drives the budget dropdown.
  async function refreshAllowedModels() {
    try {
      const conn = await currentConnection();
      const res = await listModelRegistry(conn);
      if (res.ok) setModels(res.data);
    } catch {
      /* non-fatal */
    }
  }

  async function ensureModels() {
    if (models.length > 0) return;
    await refreshAllowedModels();
  }

  // Loads the live Bedrock catalog for the chosen endpoint + region. Clears any
  // previously-selected model (it may not exist in the new endpoint/region).
  async function refreshCatalog() {
    setCatalogLoading(true);
    setAllowModelId("");
    try {
      const conn = await currentConnection();
      const res = await listModelCatalog(conn, allowEndpoint, allowRegion);
      if (res.ok) setCatalog(res.data);
      else {
        setCatalog([]);
        setStatus({ kind: "err", text: res.error });
      }
    } catch (err) {
      setCatalog([]);
      setStatus({ kind: "err", text: (err as Error).message });
    }
    setCatalogLoading(false);
  }

  // Models shown in the Model dropdown: filtered by scope for Converse; Mantle
  // is always regional so no scope filter applies.
  const scopedCatalog =
    allowEndpoint === "bedrock-mantle"
      ? catalog
      : catalog.filter((c) => c.scope === allowScope);

  // Whitelist the selected model (carries endpoint + region + scope).
  async function handleAllowModel() {
    const modelId = allowModelId.trim();
    if (!modelId) {
      setStatus({ kind: "err", text: "Pick a model to allow." });
      return;
    }
    const chosen = catalog.find((c) => c.id === modelId);
    const provider = chosen?.provider ?? "unknown";
    const scope = allowEndpoint === "bedrock-mantle" ? "regional" : (chosen?.scope ?? allowScope);
    setBusy(true);
    setStatus(null);
    try {
      const conn = await currentConnection();
      const res = await putModelRegistryEntry(conn, {
        modelId,
        endpoint: allowEndpoint,
        provider,
        scope,
        region: allowRegion,
      });
      if (res.ok) {
        setStatus({
          kind: "ok",
          text: `Allowed ${modelId} on ${endpointLabel(allowEndpoint)} / ${allowRegion}.`,
        });
        setAllowModelId("");
        await refreshAllowedModels();
      } else {
        setStatus({ kind: "err", text: res.error });
      }
    } catch (err) {
      setStatus({ kind: "err", text: (err as Error).message });
    }
    setBusy(false);
  }

  // Remove a model+endpoint+region from the allow-list.
  async function handleRemoveAllowed(modelId: string, endpoint: string, region?: string) {
    setBusy(true);
    setStatus(null);
    try {
      const conn = await currentConnection();
      const res = await deleteModelRegistryEntry(conn, modelId, endpoint, region);
      if (res.ok) {
        setStatus({
          kind: "ok",
          text: `Removed ${modelId} (${endpointLabel(endpoint)}${region ? " / " + region : ""}) from allowed.`,
        });
        await refreshAllowedModels();
      } else {
        setStatus({ kind: "err", text: res.error });
      }
    } catch (err) {
      setStatus({ kind: "err", text: (err as Error).message });
    }
    setBusy(false);
  }

  async function handleLoad(e?: React.FormEvent) {
    e?.preventDefault();
    const t = team.trim();
    if (!t) return;
    setBusy(true);
    setStatus(null);
    try {
      const conn = await currentConnection();
      const res = await listQuotas(conn, t);
      if (res.ok) {
        const sorted = [...res.data].sort((a, b) => a.model.localeCompare(b.model));
        setQuotas(sorted);
        setEdits(
          Object.fromEntries(sorted.map((q) => [q.model, String(q.dailyTokenQuota)]))
        );
        setLoadedTeam(t);
        setStatus({
          kind: "ok",
          text:
            sorted.length > 0
              ? `Loaded ${sorted.length} budget(s) for "${t}".`
              : `No budgets set yet for "${t}". Add one below.`,
        });
        void ensureModels();
      } else {
        setStatus({ kind: "err", text: res.error });
      }
    } catch (err) {
      setStatus({ kind: "err", text: (err as Error).message });
    }
    setBusy(false);
  }

  async function handleSaveRow(model: string) {
    const value = Number(edits[model]);
    if (!Number.isFinite(value) || value < 0) {
      setStatus({ kind: "err", text: `Invalid budget for ${model}.` });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const conn = await currentConnection();
      const res = await putQuota(conn, loadedTeam, model, Math.floor(value));
      if (res.ok) {
        setStatus({
          kind: "ok",
          text: `Updated ${loadedTeam} / ${model} → ${Math.floor(value)} tokens/day.`,
        });
        await handleLoad();
      } else {
        setStatus({ kind: "err", text: res.error });
      }
    } catch (err) {
      setStatus({ kind: "err", text: (err as Error).message });
    }
    setBusy(false);
  }

  async function handleAdd() {
    const model = newModel.trim();
    const value = Number(newQuota);
    if (!model) {
      setStatus({ kind: "err", text: "Pick or enter a model." });
      return;
    }
    if (!Number.isFinite(value) || value < 0) {
      setStatus({ kind: "err", text: "Enter a valid daily token budget." });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const conn = await currentConnection();
      const res = await putQuota(conn, loadedTeam, model, Math.floor(value));
      if (res.ok) {
        setStatus({
          kind: "ok",
          text: `Set ${loadedTeam} / ${model} → ${Math.floor(value)} tokens/day.`,
        });
        setNewModel("");
        setNewQuota("");
        await handleLoad();
        void refreshTeams();
      } else {
        setStatus({ kind: "err", text: res.error });
      }
    } catch (err) {
      setStatus({ kind: "err", text: (err as Error).message });
    }
    setBusy(false);
  }

  // Approach 1: on-demand, resumable IAM-role reconciliation. Drives the
  // background SQS fan-out and then POLLS the job-status row until it reaches a
  // terminal state. The HTTP "start" call returns a jobId sub-second; the
  // actual IAM sweep (one iam:ListRoles page per worker invocation, serial)
  // runs server-side, so this never risks an API Gateway/Lambda timeout no
  // matter how many thousands of roles the account has.
  async function handleReconcile() {
    setReconciling(true);
    setStatus(null);
    setReconcileProgress("Starting…");
    try {
      const startConn = await currentConnection();
      const started = await reconcileTeamRoles(startConn);
      if (!started.ok) {
        setStatus({ kind: "err", text: started.error });
        setReconcileProgress("");
        setReconciling(false);
        return;
      }
      const { jobId } = started.data;
      setReconcileProgress("Reconciliation started — running in the background…");

      // Poll the job row ~every 2s. A safety cap stops the browser polling
      // forever if something goes wrong server-side (worst case the user can
      // re-open the panel; the job row persists for 24h).
      const POLL_INTERVAL_MS = 2000;
      const MAX_POLLS = 600; // ~20 minutes
      for (let i = 0; i < MAX_POLLS; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        const conn = await currentConnection();
        const res = await getReconcileJob(conn, jobId);
        if (!res.ok) {
          // A transient poll error shouldn't kill the whole run — keep trying.
          setReconcileProgress(`Checking status… (${res.error})`);
          continue;
        }
        const job = res.data;
        setReconcileProgress(
          `${job.rolesProcessed} role(s) across ${job.pageCount} page(s) — ${job.status}`
        );
        if (job.status === "complete") {
          setStatus({
            kind: "ok",
            text: `Reconciled ${job.rolesProcessed} IAM role(s) against their ${config.region} team tags.`,
          });
          void refreshTeams();
          void refreshMappings();
          break;
        }
        if (job.status === "failed") {
          setStatus({
            kind: "err",
            text: `Reconciliation failed: ${job.error ?? "unknown error"}`,
          });
          break;
        }
      }
    } catch (err) {
      setStatus({ kind: "err", text: (err as Error).message });
    }
    setReconciling(false);
  }

  // Approach 2: direct single-role mapping (no IAM scan).
  async function handleMapRole() {
    const roleArn = mapRoleArn.trim();
    const team = mapRoleTeam.trim();
    if (!roleArn || !team) {
      setStatus({ kind: "err", text: "Provide both a role ARN and a team." });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const conn = await currentConnection();
      const res = await mapRoleToTeam(conn, roleArn, team);
      if (res.ok) {
        setStatus({ kind: "ok", text: `Mapped ${roleArn} → team "${team}".` });
        setMapRoleArn("");
        setMapRoleTeam("");
        void refreshTeams();
        void refreshMappings();
      } else {
        setStatus({ kind: "err", text: res.error });
      }
    } catch (err) {
      setStatus({ kind: "err", text: (err as Error).message });
    }
    setBusy(false);
  }

  const existingModels = new Set(quotas.map((q) => q.model));
  // Budgets are per (team, model) and endpoint-agnostic (enforcement picks the
  // deny-policy endpoint from the usage record). The allow-list, though, is
  // keyed per (model, endpoint) — a model may be whitelisted on both. So for
  // the budget picker we collapse to DISTINCT model ids, carrying the set of
  // endpoints each is allowed on just as an informational label.
  const endpointsByModel = new Map<string, string[]>();
  const providerByModel = new Map<string, string>();
  for (const m of models) {
    const eps = endpointsByModel.get(m.modelId) ?? [];
    if (!eps.includes(m.endpoint)) eps.push(m.endpoint);
    endpointsByModel.set(m.modelId, eps);
    providerByModel.set(m.modelId, m.provider);
  }
  const distinctAllowedModels = [...endpointsByModel.keys()].sort((a, b) => a.localeCompare(b));
  const availableModels = distinctAllowedModels.filter((id) => !existingModels.has(id));
  const endpointsLabel = (modelId: string) =>
    (endpointsByModel.get(modelId) ?? []).map(endpointLabel).join(" / ");

  return (
    <div className="app">
      <div className="topbar">
        <div>
          <h1>Bedrock Team Token Budgets</h1>
          <p className="sub">Set and modify per-team, per-model daily token budgets.</p>
        </div>
        <div className="user">
          {email && <span className="muted">{email}</span>}
          <button className="secondary" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>

      <section className="card">
        <h2>Team</h2>
        <form className="inline" onSubmit={handleLoad}>
          <div>
            <label>
              Team{" "}
              {teams.length > 0 && (
                <span className="muted">({teams.length} with budgets)</span>
              )}
            </label>
            {teams.length > 0 && !addingNewTeam ? (
              <select
                value={teams.includes(team) ? team : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === NEW_TEAM_OPTION) {
                    setAddingNewTeam(true);
                    setTeam("");
                  } else {
                    setTeam(v);
                  }
                }}
              >
                <option value="">Select a team…</option>
                {teams.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
                <option value={NEW_TEAM_OPTION}>➕ Add a new team…</option>
              </select>
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  autoFocus={addingNewTeam}
                  value={team}
                  onChange={(e) => setTeam(e.target.value)}
                  placeholder="New team name (the IAM role's team tag)"
                />
                {teams.length > 0 && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setAddingNewTeam(false);
                      setTeam("");
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            )}
          </div>
          <button type="submit" disabled={busy || !team.trim()}>
            Load budgets
          </button>
        </form>
        <p className="muted">
          Budgets apply to a whole team (the <code>team</code> tag on the IAM
          role), not individual users. A team can be one person — give them
          their own uniquely-tagged role.
        </p>
        <p className="muted">
          Connected to <code>{config.adminApiEndpoint}</code> ({config.region}).
        </p>
      </section>

      {loadedTeam && (
        <section className="card">
          <h2>
            Budgets for <span className="badge">{loadedTeam}</span>
          </h2>
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Endpoint</th>
                <th>Daily token budget</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {quotas.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No budgets yet.
                  </td>
                </tr>
              )}
              {quotas.map((q) => {
                const changed = edits[q.model] !== String(q.dailyTokenQuota);
                return (
                  <tr key={q.model}>
                    <td>{q.model}</td>
                    <td>
                      <span className="badge">{endpointsLabel(q.model) || "—"}</span>
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        value={edits[q.model] ?? ""}
                        onChange={(e) =>
                          setEdits((prev) => ({ ...prev, [q.model]: e.target.value }))
                        }
                      />
                    </td>
                    <td>
                      <button
                        className="secondary"
                        disabled={busy || !changed}
                        onClick={() => handleSaveRow(q.model)}
                      >
                        Save
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <h2 style={{ marginTop: 20 }}>Add / set a budget</h2>
          <div className="inline">
            <div>
              <label>Model</label>
              {availableModels.length > 0 ? (
                <select value={newModel} onChange={(e) => setNewModel(e.target.value)}>
                  <option value="">Select a model…</option>
                  {availableModels.map((id) => (
                    <option key={id} value={id}>
                      {id} — {endpointsLabel(id)} ({providerByModel.get(id)})
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                  placeholder="No allowed models yet — add some in the Admin section"
                />
              )}
            </div>
            <div>
              <label>Daily token budget</label>
              <input
                type="number"
                min={0}
                value={newQuota}
                onChange={(e) => setNewQuota(e.target.value)}
                placeholder="e.g. 5000"
              />
            </div>
            <button disabled={busy || !newModel.trim() || !newQuota} onClick={handleAdd}>
              Set budget
            </button>
          </div>
          <p className="muted">
            Saving an existing model overwrites its budget; a new model adds one.
            Only models on the <strong>allowed list</strong> (Admin section below)
            appear here.
          </p>
        </section>
      )}

      <section className="card">
        <h2>Admin — allowed models</h2>
        <p className="muted">
          Choose which Bedrock models can be budgeted in this tool. Only models you
          allow here appear in the per-team budget picker above. Pick the
          <strong> endpoint</strong>, the <strong>region</strong>, and (for
          Converse) the <strong>inference scope</strong>, then load that region's
          live catalog and allow the exact id a team will invoke. A model can be
          allowed on both endpoints and in multiple regions — each is its own
          entry.
        </p>

        <div className="inline">
          <div>
            <label>Endpoint</label>
            <Dropdown
              value={allowEndpoint}
              onChange={(v) => {
                setAllowEndpoint(v);
                setCatalog([]);
                setAllowModelId("");
              }}
              options={[
                { value: "bedrock-runtime", label: "Converse (bedrock-runtime)" },
                { value: "bedrock-mantle", label: "Mantle (bedrock-mantle)" },
              ]}
            />
          </div>
          <div>
            <label>Region</label>
            <Dropdown
              value={allowRegion}
              onChange={(v) => {
                setAllowRegion(v);
                setCatalog([]);
                setAllowModelId("");
              }}
              options={[config.region, ...BEDROCK_REGIONS.filter((r) => r !== config.region)].map(
                (r) => ({ value: r, label: r })
              )}
            />
          </div>
          {allowEndpoint === "bedrock-runtime" && (
            <div>
              <label>Scope</label>
              <Dropdown
                value={allowScope}
                onChange={(v) => {
                  setAllowScope(v);
                  setAllowModelId("");
                }}
                options={[
                  { value: "regional", label: "Regional" },
                  { value: "cross-region", label: "Cross-region" },
                  { value: "global", label: "Global" },
                ]}
              />
            </div>
          )}
          <button className="secondary" onClick={() => void refreshCatalog()} disabled={catalogLoading}>
            {catalogLoading ? "Loading…" : "Load models"}
          </button>
        </div>

        {catalog.length > 0 && (
          <div className="inline" style={{ marginTop: 8 }}>
            <div style={{ flex: 2 }}>
              <label>
                Model{" "}
                {allowEndpoint === "bedrock-runtime" ? `(${scopeLabel(allowScope)})` : ""}
              </label>
              <Dropdown
                value={allowModelId}
                onChange={setAllowModelId}
                placeholder={
                  scopedCatalog.length > 0
                    ? "Select a model…"
                    : "No models for this endpoint/region/scope"
                }
                options={scopedCatalog.map((c) => ({
                  value: c.id,
                  label: `${c.id} (${c.provider})`,
                }))}
              />
            </div>
            <button onClick={handleAllowModel} disabled={busy || !allowModelId}>
              Allow model
            </button>
          </div>
        )}

        <h3 style={{ marginTop: 20, marginBottom: 4 }}>Currently allowed</h3>
        {models.length === 0 ? (
          <p className="muted">
            No models allowed yet. Load a catalog above and allow at least one so
            teams can have budgets set.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Endpoint</th>
                <th>Scope</th>
                <th>Region</th>
                <th>Provider</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={`${m.endpoint}#${m.region ?? "-"}#${m.modelId}`}>
                  <td style={{ fontFamily: "monospace", fontSize: "0.85em" }}>{m.modelId}</td>
                  <td>
                    <span className="badge">{endpointLabel(m.endpoint)}</span>
                  </td>
                  <td>{scopeLabel(m.scope)}</td>
                  <td>{m.region ?? "—"}</td>
                  <td>{m.provider}</td>
                  <td>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void handleRemoveAllowed(m.modelId, m.endpoint, m.region)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Team → IAM role mapping</h2>
        <p className="muted">
          A team is the <code>team</code> tag on an IAM role. The system learns
          a role's team automatically when the role calls Bedrock or when it's
          tagged. Use the options below only to <strong>correct drift</strong>
          {" "}(e.g. you changed a role's <code>team</code> tag directly in IAM)
          or to register a role explicitly.
        </p>

        <h3 style={{ marginBottom: 4 }}>Option A — refresh everything from IAM</h3>
        <p className="muted">
          Scans every IAM role in the account and re-reads its <code>team</code>
          {" "}tag. Pressing the button starts a <strong>background job</strong>
          {" "}(an SQS fan-out: a single worker walks one page of roles at a time,
          serially, so it stays gentle on IAM API limits and is safe for accounts
          with thousands of roles). The button returns immediately and this panel
          polls the job's progress until it finishes — you can leave it running.
          There is no automatic schedule; run it deliberately (e.g. after editing
          a role's <code>team</code> tag directly in IAM).
        </p>
        <div className="inline">
          <button onClick={handleReconcile} disabled={reconciling || busy}>
            {reconciling ? "Running…" : "Refresh team→role mapping from IAM"}
          </button>
          {reconcileProgress && <span className="muted">{reconcileProgress}</span>}
        </div>

        <h3 style={{ marginTop: 20, marginBottom: 4 }}>
          Option B — map one role directly (no IAM scan)
        </h3>
        <p className="muted">
          Register a single IAM role to a team with one write and zero IAM calls.
          Prefer this if you manage roles explicitly and don't want to scan the
          account. (The role should still carry the matching <code>team</code>
          {" "}tag so CUR cost attribution works.)
        </p>
        <div className="inline">
          <div style={{ flex: 2 }}>
            <label>IAM role ARN</label>
            <input
              value={mapRoleArn}
              onChange={(e) => setMapRoleArn(e.target.value)}
              placeholder="arn:aws:iam::123456789012:role/MyTeamRole"
            />
          </div>
          <div>
            <label>Team</label>
            <input
              value={mapRoleTeam}
              onChange={(e) => setMapRoleTeam(e.target.value)}
              placeholder="e.g. alpha"
            />
          </div>
          <button
            className="secondary"
            onClick={handleMapRole}
            disabled={busy || !mapRoleArn.trim() || !mapRoleTeam.trim()}
          >
            Map role
          </button>
        </div>

        <h3 style={{ marginTop: 20, marginBottom: 4 }}>Current role → team mappings</h3>
        <p className="muted">
          What the system knows right now (the result of a reconcile, plus roles
          cached when they called Bedrock or were tagged). Untagged roles are not
          listed. These teams also appear in the budget picker above.
        </p>
        <div className="inline" style={{ marginBottom: 8 }}>
          <button className="secondary" onClick={() => void refreshMappings()} disabled={mappingsLoading}>
            {mappingsLoading ? "Loading…" : "Refresh list"}
          </button>
          <span className="muted">
            {mappings.length} mapping(s)
            {mappings.length > 0
              ? ` across ${new Set(mappings.map((m) => m.team)).size} team(s)`
              : ""}
          </span>
        </div>
        {mappings.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Team</th>
                <th>IAM role ARN</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((m) => (
                <tr key={m.roleArn}>
                  <td>{m.team}</td>
                  <td style={{ fontFamily: "monospace", fontSize: "0.85em" }}>{m.roleArn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {status && <div className={`msg ${status.kind}`}>{status.text}</div>}
    </div>
  );
}
