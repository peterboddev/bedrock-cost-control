import type { MetricDataResult } from '@aws-sdk/client-cloudwatch';

import {
  buildMantleMetricQueries,
  parseMantleMetricResults,
  usageDayEnd,
  usageDayStart,
} from './mantleMetrics';

describe('buildMantleMetricQueries', () => {
  it('builds two queries (input + output) per spec with day window and Sum stat', () => {
    const { queries, index, startTime, endTime } = buildMantleMetricQueries(
      [{ projectId: 'proj-a', modelId: 'openai.gpt-6-sol' }],
      '2025-01-15'
    );
    expect(queries).toHaveLength(2);
    expect(queries[0].MetricStat?.Stat).toBe('Sum');
    expect(queries[0].MetricStat?.Metric?.Namespace).toBe('AWS/BedrockMantle');
    // Regression guard: AWS/BedrockMantle exposes per-(Project, Model) tokens
    // as InputTokens/OutputTokens on a `Model` dimension — NOT the Total*
    // variants and NOT a `ModelId` dimension. Getting these wrong makes
    // GetMetricData return nothing and the collector silently records zero.
    const names = queries.map((q) => q.MetricStat?.Metric?.MetricName).sort();
    expect(names).toEqual(['InputTokens', 'OutputTokens']);
    const dims = queries[0].MetricStat?.Metric?.Dimensions ?? [];
    expect(dims).toContainEqual({ Name: 'Project', Value: 'proj-a' });
    expect(dims).toContainEqual({ Name: 'Model', Value: 'openai.gpt-6-sol' });
    expect(dims.map((d) => d.Name)).not.toContain('ModelId');
    expect(startTime).toEqual(usageDayStart('2025-01-15'));
    expect(endTime).toEqual(usageDayEnd('2025-01-15'));
    // index maps ids back to (project, model, tokenType)
    expect([...index.values()].map((v) => v.tokenType).sort()).toEqual(['input', 'output']);
  });
});

describe('parseMantleMetricResults', () => {
  it('round-trips queries -> results into per-(project,model) points', () => {
    const { queries, index } = buildMantleMetricQueries(
      [
        { projectId: 'proj-a', modelId: 'openai.gpt-6-sol' },
        { projectId: 'proj-b', modelId: 'minimax.m2-5' },
      ],
      '2025-01-15'
    );

    // Fabricate results: input ids get 100, output ids get 50 (sum of datapoints).
    const results: MetricDataResult[] = queries.map((q) => ({
      Id: q.Id,
      Values: index.get(q.Id!)?.tokenType === 'input' ? [60, 40] : [50],
    }));

    const points = parseMantleMetricResults(results, index, '2025-01-15');
    const byProject = new Map(points.map((p) => [p.projectId, p]));
    expect(byProject.get('proj-a')).toMatchObject({ totalInputTokens: 100, totalOutputTokens: 50, modelId: 'openai.gpt-6-sol' });
    expect(byProject.get('proj-b')).toMatchObject({ totalInputTokens: 100, totalOutputTokens: 50 });
  });

  it('drops points with no usage on the day', () => {
    const { queries, index } = buildMantleMetricQueries([{ projectId: 'p', modelId: 'm' }], '2025-01-15');
    const results: MetricDataResult[] = queries.map((q) => ({ Id: q.Id, Values: [] }));
    expect(parseMantleMetricResults(results, index, '2025-01-15')).toHaveLength(0);
  });
});
