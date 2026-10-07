/**
 * Tests for the model registry (Unit 1).
 */
import { ModelRegistry } from './modelRegistry';
import { Endpoint } from './types';

describe('ModelRegistry', () => {
  const registry = ModelRegistry.fromList([
    { modelId: 'anthropic.claude-sonnet-4-6', endpoint: Endpoint.BedrockRuntime, provider: 'anthropic' },
    { modelId: 'openai.gpt-6-sol', endpoint: Endpoint.BedrockMantle, provider: 'openai' },
    { modelId: 'minimax.m2-5', endpoint: Endpoint.BedrockMantle, provider: 'minimax' },
  ]);

  it('classifies a Converse model', () => {
    expect(registry.endpointFor('anthropic.claude-sonnet-4-6')).toBe(Endpoint.BedrockRuntime);
    expect(registry.isConverse('anthropic.claude-sonnet-4-6')).toBe(true);
    expect(registry.isMantle('anthropic.claude-sonnet-4-6')).toBe(false);
  });

  it('classifies a Mantle model', () => {
    expect(registry.endpointFor('openai.gpt-6-sol')).toBe(Endpoint.BedrockMantle);
    expect(registry.isMantle('openai.gpt-6-sol')).toBe(true);
    expect(registry.isConverse('openai.gpt-6-sol')).toBe(false);
  });

  it('returns undefined for an unknown model (caller must handle)', () => {
    expect(registry.get('unknown.model')).toBeUndefined();
    expect(registry.endpointFor('unknown.model')).toBeUndefined();
    expect(registry.isMantle('unknown.model')).toBe(false);
  });

  it('lists all registered entries', () => {
    expect(registry.list()).toHaveLength(3);
  });
});

describe('ModelRegistry - a model allowed on BOTH endpoints', () => {
  const registry = ModelRegistry.fromList([
    { modelId: 'openai.gpt-oss-120b-1:0', endpoint: Endpoint.BedrockRuntime, provider: 'openai' },
    { modelId: 'openai.gpt-oss-120b-1:0', endpoint: Endpoint.BedrockMantle, provider: 'openai' },
  ]);

  it('keeps both (model, endpoint) rows (no silent last-wins collapse)', () => {
    expect(registry.list()).toHaveLength(2);
    expect(registry.endpointsFor('openai.gpt-oss-120b-1:0').sort()).toEqual(
      [Endpoint.BedrockMantle, Endpoint.BedrockRuntime].sort()
    );
  });

  it('getFor resolves each endpoint exactly', () => {
    expect(registry.getFor('openai.gpt-oss-120b-1:0', Endpoint.BedrockMantle)?.endpoint).toBe(
      Endpoint.BedrockMantle
    );
    expect(registry.getFor('openai.gpt-oss-120b-1:0', Endpoint.BedrockRuntime)?.endpoint).toBe(
      Endpoint.BedrockRuntime
    );
  });

  it('is both Converse and Mantle (membership semantics)', () => {
    expect(registry.isConverse('openai.gpt-oss-120b-1:0')).toBe(true);
    expect(registry.isMantle('openai.gpt-oss-120b-1:0')).toBe(true);
  });

  it('endpointFor fallback deterministically prefers bedrock-runtime', () => {
    expect(registry.endpointFor('openai.gpt-oss-120b-1:0')).toBe(Endpoint.BedrockRuntime);
  });
});
