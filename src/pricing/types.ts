/**
 * Core pricing/cost domain types shared by the Bedrock + Mantle cost engine.
 *
 * These types underpin the "accurate cost tracking" hard requirement
 * (requirements.md FR-4, NFR-1): cost must be computed from the four
 * distinct token types, never a single summed total, and must be aware of
 * which endpoint served the request.
 */

/** The two Amazon Bedrock inference endpoints this system reconciles. */
export enum Endpoint {
  /** bedrock-runtime.region.amazonaws.com — Converse / InvokeModel family. */
  BedrockRuntime = 'bedrock-runtime',
  /** bedrock-mantle.region.api.aws — OpenAI/Anthropic-compatible open-weight models. */
  BedrockMantle = 'bedrock-mantle',
}

/** The four billable token types (per Bedrock CUR). All must be tracked for accurate cost. */
export type TokenType = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

/** A set of token counts for a single (team, model, day, endpoint) bucket. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The zero element for TokenCounts. */
export const ZERO_TOKENS: TokenCounts = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

/** Bedrock service tiers that affect unit price. */
export type ServiceTier = 'standard' | 'priority' | 'flex';

/**
 * Context-length pricing tier. Long-context rates apply to the entire
 * request when input exceeds the model's long-context threshold
 * (272,000 input tokens for the current OpenAI-on-Bedrock model cards).
 */
export type ContextTier = 'short' | 'long';

/** Default long-context input-token threshold (model cards: 272K). */
export const DEFAULT_LONG_CONTEXT_THRESHOLD = 272_000;

/** Returns the context tier for a given input-token count. */
export function contextTierForInput(
  inputTokens: number,
  threshold: number = DEFAULT_LONG_CONTEXT_THRESHOLD
): ContextTier {
  return inputTokens > threshold ? 'long' : 'short';
}

/** Immutably adds two TokenCounts component-wise. */
export function addTokenCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** Sum of all four token types (billable total). */
export function billableTotalTokens(counts: TokenCounts): number {
  return counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
}

/**
 * The token measure used for quota ENFORCEMENT breach decisions. Kept
 * separate from billing: enforcement historically counts input + output
 * (the directly consumed tokens), independent of cache accounting.
 */
export function enforcementTotalTokens(counts: TokenCounts): number {
  return counts.input + counts.output;
}
