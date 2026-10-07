import {
  UsageAggregationItem,
  buildExportKey,
  buildUsageTokenRow,
  serializeJsonl,
} from './analyticsExport';
import { ModelRegistry } from './pricing/modelRegistry';
import { Endpoint } from './pricing/types';

describe('buildUsageTokenRow', () => {
  it('emits token counts and totalTokens using the item endpoint', () => {
    const item: UsageAggregationItem = {
      team: 'teamA',
      model: 'openai.gpt-6-sol',
      usageDay: '2025-01-15',
      endpoint: Endpoint.BedrockMantle,
      inputTokens: 100_000,
      outputTokens: 100_000,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 1_000,
    };
    const row = buildUsageTokenRow(item, {});
    expect(row.endpoint).toBe(Endpoint.BedrockMantle);
    expect(row.inputTokens).toBe(100_000);
    expect(row.outputTokens).toBe(100_000);
    expect(row.cacheReadTokens).toBe(5_000);
    expect(row.cacheWriteTokens).toBe(1_000);
    expect(row.totalTokens).toBe(206_000);
  });

  it('falls back to the registry for endpoint when the item has none (legacy)', () => {
    const registry = ModelRegistry.fromList([
      { modelId: 'anthropic.claude-sonnet-4-6', endpoint: Endpoint.BedrockRuntime, provider: 'anthropic' },
    ]);
    const item: UsageAggregationItem = {
      team: 'teamA',
      model: 'anthropic.claude-sonnet-4-6',
      usageDay: '2025-01-15',
      inputTokens: 100_000,
      outputTokens: 0,
    };
    const row = buildUsageTokenRow(item, { registry });
    expect(row.endpoint).toBe(Endpoint.BedrockRuntime);
    expect(row.totalTokens).toBe(100_000);
  });

  it('defaults missing token counts to zero', () => {
    const item: UsageAggregationItem = {
      team: 't',
      model: 'm',
      usageDay: '2025-01-15',
      endpoint: Endpoint.BedrockRuntime,
    };
    const row = buildUsageTokenRow(item, {});
    expect(row.totalTokens).toBe(0);
    expect(row.inputTokens).toBe(0);
  });

  it('defaults to bedrock-runtime endpoint when neither item nor registry resolves one', () => {
    const item: UsageAggregationItem = {
      team: 't', model: 'unknown.model', usageDay: '2025-01-15', inputTokens: 10, outputTokens: 10,
    };
    const row = buildUsageTokenRow(item, {});
    expect(row.endpoint).toBe(Endpoint.BedrockRuntime);
    expect(row.totalTokens).toBe(20);
  });
});

describe('serializeJsonl / buildExportKey', () => {
  it('produces one JSON object per line', () => {
    const rows = [
      buildUsageTokenRow(
        { team: 't', model: 'openai.gpt-6-sol', usageDay: '2025-01-15', endpoint: Endpoint.BedrockMantle, inputTokens: 1, outputTokens: 1 },
        {}
      ),
    ];
    const jsonl = serializeJsonl(rows);
    expect(jsonl.split('\n')).toHaveLength(1);
    expect(JSON.parse(jsonl)).toMatchObject({ team: 't', model: 'openai.gpt-6-sol', totalTokens: 2 });
  });

  it('builds a Hive-partitioned key by day', () => {
    expect(buildExportKey('token-usage/', '2025-01-15', 0)).toBe('token-usage/dt=2025-01-15/part-0.json');
  });
});
