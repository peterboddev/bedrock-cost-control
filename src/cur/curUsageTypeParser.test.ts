import { parseUsageType } from './curUsageTypeParser';
import { Endpoint } from '../pricing/types';

describe('parseUsageType', () => {
  it('parses standard bedrock-runtime input tokens', () => {
    const r = parseUsageType('USE1-Claude4.6Sonnet-input-tokens');
    expect(r).toEqual({
      curModelName: 'Claude4.6Sonnet',
      tokenType: 'input',
      endpoint: Endpoint.BedrockRuntime,
      serviceTier: 'standard',
      crossRegion: false,
    });
  });

  it('parses standard bedrock-runtime output tokens', () => {
    const r = parseUsageType('USE1-Claude4.6Sonnet-output-tokens');
    expect(r?.tokenType).toBe('output');
    expect(r?.endpoint).toBe(Endpoint.BedrockRuntime);
    expect(r?.serviceTier).toBe('standard');
  });

  it('parses priority tier', () => {
    const r = parseUsageType('USE1-gpt-oss-120b-output-tokens-priority');
    expect(r?.curModelName).toBe('gpt-oss-120b');
    expect(r?.tokenType).toBe('output');
    expect(r?.serviceTier).toBe('priority');
    expect(r?.endpoint).toBe(Endpoint.BedrockRuntime);
  });

  it('parses flex tier', () => {
    const r = parseUsageType('USE1-Nova2.0Lite-input-tokens-flex');
    expect(r?.curModelName).toBe('Nova2.0Lite');
    expect(r?.tokenType).toBe('input');
    expect(r?.serviceTier).toBe('flex');
  });

  it('parses mantle input tokens', () => {
    const r = parseUsageType('USE1-openai.gpt-oss-120b-mantle-input-tokens-standard');
    expect(r).toEqual({
      curModelName: 'openai.gpt-oss-120b',
      tokenType: 'input',
      endpoint: Endpoint.BedrockMantle,
      serviceTier: 'standard',
      crossRegion: false,
    });
  });

  it('parses mantle output tokens', () => {
    const r = parseUsageType('USE1-openai.gpt-oss-120b-mantle-output-tokens-standard');
    expect(r?.tokenType).toBe('output');
    expect(r?.endpoint).toBe(Endpoint.BedrockMantle);
  });

  it('parses cache-read tokens', () => {
    const r = parseUsageType('USE1-Claude4.6Sonnet-cache-read-input-token-count');
    expect(r).toEqual({
      curModelName: 'Claude4.6Sonnet',
      tokenType: 'cacheRead',
      endpoint: Endpoint.BedrockRuntime,
      serviceTier: 'standard',
      crossRegion: false,
    });
  });

  it('parses cache-write tokens', () => {
    const r = parseUsageType('USE1-Claude4.6Sonnet-cache-write-input-token-count');
    expect(r?.tokenType).toBe('cacheWrite');
  });

  it('parses cross-region global', () => {
    const r = parseUsageType('USE1-Claude4.6Sonnet-output-tokens-cross-region-global');
    expect(r?.crossRegion).toBe(true);
    expect(r?.serviceTier).toBe('standard');
    expect(r?.endpoint).toBe(Endpoint.BedrockRuntime);
    expect(r?.tokenType).toBe('output');
  });

  it('returns undefined for unrecognized usage types', () => {
    expect(parseUsageType('USE1-SomethingElse')).toBeUndefined();
    expect(parseUsageType('')).toBeUndefined();
  });

  it('handles multi-segment model names with dots and hyphens', () => {
    const r = parseUsageType('USW2-anthropic.claude-opus-4-5-20251101-v1-input-tokens');
    expect(r?.curModelName).toBe('anthropic.claude-opus-4-5-20251101-v1');
    expect(r?.tokenType).toBe('input');
    expect(r?.endpoint).toBe(Endpoint.BedrockRuntime);
  });
});
