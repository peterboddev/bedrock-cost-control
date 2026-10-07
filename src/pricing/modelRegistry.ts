/**
 * Model registry (requirements.md FR-1): maps each tracked model to the
 * endpoint that serves it (bedrock-runtime vs bedrock-mantle) and its
 * provider. Enforcement (FR-5.3) and cost (FR-4) both branch on endpoint,
 * so this registry is the single source of truth for that classification.
 *
 * Data-driven and immutable: entries are supplied by the caller (seeded
 * from config / a DynamoDB table in later units), so onboarding a new
 * model requires no code change (NFR-5).
 */
import { Endpoint } from './types';

/**
 * Inference scope of a model id (bedrock-runtime / Converse only).
 *   - `regional`      : the bare foundation-model id (in-region inference)
 *   - `cross-region`  : a geographic system inference profile (`us.`/`eu.`/`apac.` ...)
 *   - `global`        : a global system inference profile (`global.` ...)
 * Mantle ids have no cross-region scope (the plain model id is used); such
 * entries carry `regional` by convention since there is only one invocation id.
 */
export type ModelScope = 'regional' | 'cross-region' | 'global';

/** One model's classification. */
export interface ModelRegistryEntry {
  /**
   * The exact model identifier a request names — and the string usage is
   * attributed to. For Converse cross-region/global models this is the
   * inference-profile id (e.g. `us.openai.gpt-5.6-sol`), NOT the bare
   * foundation-model id.
   */
  modelId: string;
  /** Which endpoint serves this model. */
  endpoint: Endpoint;
  /** Provider label (e.g. "anthropic", "openai", "minimax"); free-form. */
  provider: string;
  /**
   * Inference scope of `modelId` (display/informational — the scope is already
   * implied by the id's prefix). Optional for backward compatibility with rows
   * written before this field existed; readers default to `regional`.
   */
  scope?: ModelScope;
  /**
   * The AWS region this model id was whitelisted for. A model's availability
   * and exact invocation id differ by region (e.g. `us.` vs `eu.` profiles),
   * so region is part of a whitelist entry's identity. Optional for backward
   * compatibility with rows written before this field existed.
   */
  region?: string;
}

/** Immutable lookup over a set of model registry entries. */
export class ModelRegistry {
  /** All entries, keyed by `${modelId}\u0000${endpoint}` so a model may appear under both endpoints. */
  private readonly byKey: Map<string, ModelRegistryEntry>;
  /** modelId -> its registered entries (1 or 2, one per endpoint it's allowed on). */
  private readonly byModelId: Map<string, ModelRegistryEntry[]>;

  private constructor(entries: ModelRegistryEntry[]) {
    this.byKey = new Map();
    this.byModelId = new Map();
    for (const e of entries) {
      this.byKey.set(`${e.modelId}\u0000${e.endpoint}`, e);
      const list = this.byModelId.get(e.modelId) ?? [];
      // Replace any prior entry for the same (modelId, endpoint); otherwise append.
      const existingIdx = list.findIndex((x) => x.endpoint === e.endpoint);
      if (existingIdx >= 0) {
        list[existingIdx] = e;
      } else {
        list.push(e);
      }
      this.byModelId.set(e.modelId, list);
    }
  }

  /** Builds a registry from a list of entries. */
  static fromList(entries: ModelRegistryEntry[]): ModelRegistry {
    return new ModelRegistry(entries);
  }

  /** Returns the exact entry for a (modelId, endpoint), or `undefined`. */
  getFor(modelId: string, endpoint: Endpoint): ModelRegistryEntry | undefined {
    return this.byKey.get(`${modelId}\u0000${endpoint}`);
  }

  /** All endpoints a model is registered under (0, 1, or 2). */
  endpointsFor(modelId: string): Endpoint[] {
    return (this.byModelId.get(modelId) ?? []).map((e) => e.endpoint);
  }

  /**
   * Returns an entry for a model, or `undefined` if unknown. When a model is
   * registered under BOTH endpoints this is ambiguous; it prefers the
   * bedrock-runtime row (the recommended endpoint). Prefer `getFor` when the
   * endpoint is known. Retained for the analytics fallback where a legacy
   * usage item carries no endpoint of its own.
   */
  get(modelId: string): ModelRegistryEntry | undefined {
    const list = this.byModelId.get(modelId);
    if (!list || list.length === 0) {
      return undefined;
    }
    return list.find((e) => e.endpoint === Endpoint.BedrockRuntime) ?? list[0];
  }

  /**
   * Returns a serving endpoint for a model, or `undefined` if unknown.
   * Deterministic when a model is registered under both endpoints (prefers
   * bedrock-runtime). This is only a FALLBACK for usage records that do not
   * already carry their own endpoint — which in practice they always do.
   */
  endpointFor(modelId: string): Endpoint | undefined {
    return this.get(modelId)?.endpoint;
  }

  /** True if the model is registered under the Mantle endpoint. */
  isMantle(modelId: string): boolean {
    return this.endpointsFor(modelId).includes(Endpoint.BedrockMantle);
  }

  /** True if the model is registered under the bedrock-runtime (Converse) endpoint. */
  isConverse(modelId: string): boolean {
    return this.endpointsFor(modelId).includes(Endpoint.BedrockRuntime);
  }

  /** All registered entries (one per model+endpoint). */
  list(): ModelRegistryEntry[] {
    return [...this.byKey.values()];
  }
}
