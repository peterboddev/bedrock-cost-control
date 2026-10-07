/**
 * Parses CUR 2.0 `line_item_usage_type` for Amazon Bedrock line items into
 * structured components (model, token type, endpoint, service tier, routing).
 *
 * CUR usage-type formats (from the Bedrock CUR documentation):
 *   {region}-{model}-{token-type}                         → bedrock-runtime, standard, in-region
 *   {region}-{model}-{token-type}-{tier}                  → bedrock-runtime, priority/flex, in-region
 *   {region}-{model}-mantle-{token-type}-standard         → bedrock-mantle, standard, in-region
 *   {region}-{model}-{token-type}-cross-region-global     → bedrock-runtime, standard, cross-region
 *   cache patterns: {region}-{model}-cache-read-input-token-count
 *                   {region}-{model}-cache-write-input-token-count
 *
 * Pure and side-effect free; fully unit-testable.
 */
import { Endpoint, ServiceTier, TokenType } from '../pricing/types';

export interface ParsedUsageType {
  /** The model identifier as it appears in CUR (CUR-style name, e.g. "Claude4.6Sonnet", not the Bedrock model id). */
  curModelName: string;
  tokenType: TokenType;
  endpoint: Endpoint;
  serviceTier: ServiceTier;
  /** True when the request used cross-region inference. */
  crossRegion: boolean;
}

// Region prefix pattern: region abbreviation like USE1, USW2, EUW1, etc.
const REGION_PREFIX = /^[A-Z]{2,4}\d-/;

/**
 * Strips the leading region prefix (e.g. "USE1-") from a usage type string.
 * Returns the remainder after the first hyphen following the region code.
 */
function stripRegion(usageType: string): string {
  const match = REGION_PREFIX.exec(usageType);
  return match ? usageType.slice(match[0].length) : usageType;
}

/**
 * Parses a Bedrock CUR `line_item_usage_type` into structured components.
 * Returns `undefined` if the usage type doesn't match any known Bedrock pattern.
 */
export function parseUsageType(usageType: string): ParsedUsageType | undefined {
  const body = stripRegion(usageType);
  if (!body) return undefined;

  // Cache-read pattern: {model}-cache-read-input-token-count
  const cacheReadIdx = body.indexOf('-cache-read-input-token-count');
  if (cacheReadIdx > 0) {
    return {
      curModelName: body.slice(0, cacheReadIdx),
      tokenType: 'cacheRead',
      endpoint: Endpoint.BedrockRuntime,
      serviceTier: 'standard',
      crossRegion: false,
    };
  }

  // Cache-write pattern: {model}-cache-write-input-token-count
  const cacheWriteIdx = body.indexOf('-cache-write-input-token-count');
  if (cacheWriteIdx > 0) {
    return {
      curModelName: body.slice(0, cacheWriteIdx),
      tokenType: 'cacheWrite',
      endpoint: Endpoint.BedrockRuntime,
      serviceTier: 'standard',
      crossRegion: false,
    };
  }

  // Mantle pattern: {model}-mantle-{input|output}-tokens-standard
  const mantleInputMatch = body.match(/^(.+)-mantle-input-tokens-(\w+)$/);
  if (mantleInputMatch) {
    return {
      curModelName: mantleInputMatch[1],
      tokenType: 'input',
      endpoint: Endpoint.BedrockMantle,
      serviceTier: parseTier(mantleInputMatch[2]),
      crossRegion: false,
    };
  }
  const mantleOutputMatch = body.match(/^(.+)-mantle-output-tokens-(\w+)$/);
  if (mantleOutputMatch) {
    return {
      curModelName: mantleOutputMatch[1],
      tokenType: 'output',
      endpoint: Endpoint.BedrockMantle,
      serviceTier: parseTier(mantleOutputMatch[2]),
      crossRegion: false,
    };
  }

  // Cross-region pattern: {model}-{input|output}-tokens-cross-region-global
  const crossRegionMatch = body.match(/^(.+)-(input|output)-tokens-cross-region-global$/);
  if (crossRegionMatch) {
    return {
      curModelName: crossRegionMatch[1],
      tokenType: crossRegionMatch[2] as 'input' | 'output',
      endpoint: Endpoint.BedrockRuntime,
      serviceTier: 'standard',
      crossRegion: true,
    };
  }

  // Tiered pattern: {model}-{input|output}-tokens-{priority|flex}
  const tieredMatch = body.match(/^(.+)-(input|output)-tokens-(priority|flex)$/);
  if (tieredMatch) {
    return {
      curModelName: tieredMatch[1],
      tokenType: tieredMatch[2] as 'input' | 'output',
      endpoint: Endpoint.BedrockRuntime,
      serviceTier: parseTier(tieredMatch[3]),
      crossRegion: false,
    };
  }

  // Standard pattern (no tier suffix): {model}-{input|output}-tokens
  const standardMatch = body.match(/^(.+)-(input|output)-tokens$/);
  if (standardMatch) {
    return {
      curModelName: standardMatch[1],
      tokenType: standardMatch[2] as 'input' | 'output',
      endpoint: Endpoint.BedrockRuntime,
      serviceTier: 'standard',
      crossRegion: false,
    };
  }

  return undefined;
}

function parseTier(raw: string): ServiceTier {
  if (raw === 'priority') return 'priority';
  if (raw === 'flex') return 'flex';
  return 'standard';
}
