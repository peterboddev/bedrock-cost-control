import fc from 'fast-check';

import {
  MantleMetricPoint,
  attributeMantleUsage,
  collectMantleUsage,
} from './mantleUsageCollector';
import * as dynamoDbClient from './clients/dynamoDbClient';
import { UNMAPPED_ROLE } from './types';

jest.mock('./clients/dynamoDbClient', () => ({
  updateItem: jest.fn(),
}));

const mockedUpdateItem = dynamoDbClient.updateItem as jest.Mock;

const pointArb: fc.Arbitrary<MantleMetricPoint> = fc.record({
  projectId: fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0),
  modelId: fc.constantFrom('openai.gpt-6-sol', 'minimax.m2-5', 'moonshot.k2'),
  usageDay: fc.constant('2025-01-15'),
  totalInputTokens: fc.nat({ max: 1_000_000 }),
  totalOutputTokens: fc.nat({ max: 1_000_000 }),
});

describe('attributeMantleUsage', () => {
  it('attributes points to their mapped team', () => {
    const lookup = new Map([['proj-a', 'teamA'], ['proj-b', 'teamB']]);
    const records = attributeMantleUsage(
      [
        { projectId: 'proj-a', modelId: 'openai.gpt-6-sol', usageDay: '2025-01-15', totalInputTokens: 100, totalOutputTokens: 50 },
        { projectId: 'proj-b', modelId: 'minimax.m2-5', usageDay: '2025-01-15', totalInputTokens: 10, totalOutputTokens: 5 },
      ],
      lookup
    );
    expect(records[0]).toMatchObject({ team: 'teamA', inputTokens: 100, outputTokens: 50 });
    expect(records[1]).toMatchObject({ team: 'teamB', inputTokens: 10, outputTokens: 5 });
  });

  it('attributes unmapped projects to the UNMAPPED sentinel (never drops usage)', () => {
    const records = attributeMantleUsage(
      [{ projectId: 'unknown', modelId: 'openai.gpt-6-sol', usageDay: '2025-01-15', totalInputTokens: 7, totalOutputTokens: 3 }],
      new Map()
    );
    expect(records[0].team).toBe(UNMAPPED_ROLE);
    expect(records[0].inputTokens).toBe(7);
  });

  it('PBT: never loses a point and preserves token totals', () => {
    fc.assert(
      fc.property(fc.array(pointArb, { maxLength: 30 }), (points) => {
        const records = attributeMantleUsage(points, new Map());
        expect(records).toHaveLength(points.length);
        const inSum = points.reduce((s, p) => s + p.totalInputTokens + p.totalOutputTokens, 0);
        const outSum = records.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
        return inSum === outSum;
      })
    );
  });
});

describe('collectMantleUsage', () => {
  beforeEach(() => mockedUpdateItem.mockReset());

  it('writes absolute totals (SET) per record, tagged bedrock-mantle', async () => {
    mockedUpdateItem.mockResolvedValue({});
    await collectMantleUsage(
      [{ projectId: 'proj-a', modelId: 'openai.gpt-6-sol', usageDay: '2025-01-15', totalInputTokens: 100, totalOutputTokens: 50 }],
      {
        projectToTeam: new Map([['proj-a', 'teamA']]),
        usageAggregationTableName: 'UsageAggregation',
        now: () => new Date('2025-01-15T12:00:00.000Z'),
      }
    );
    expect(mockedUpdateItem).toHaveBeenCalledTimes(1);
    const call = mockedUpdateItem.mock.calls[0][0];
    expect(call.Key).toEqual({ PK: 'TEAM#teamA#MODEL#openai.gpt-6-sol', SK: 'DAY#2025-01-15' });
    expect(call.UpdateExpression).toContain('SET');
    expect(call.UpdateExpression).not.toContain('ADD');
    expect(call.ExpressionAttributeValues[':endpoint']).toBe('bedrock-mantle');
    expect(call.ExpressionAttributeValues[':runningTotal']).toBe(150);
    expect(call.ExpressionAttributeValues[':inputTokens']).toBe(100);
  });

  it('is idempotent: re-running the same day issues SET writes (no accumulation)', async () => {
    mockedUpdateItem.mockResolvedValue({});
    const args = {
      projectToTeam: new Map([['proj-a', 'teamA']]),
      usageAggregationTableName: 'UsageAggregation',
      now: () => new Date('2025-01-15T12:00:00.000Z'),
    };
    const points = [{ projectId: 'proj-a', modelId: 'openai.gpt-6-sol', usageDay: '2025-01-15', totalInputTokens: 100, totalOutputTokens: 50 }];
    await collectMantleUsage(points, args);
    await collectMantleUsage(points, args);
    // Both writes set the same absolute value; SET semantics make this safe.
    expect(mockedUpdateItem.mock.calls[0][0].ExpressionAttributeValues[':runningTotal']).toBe(150);
    expect(mockedUpdateItem.mock.calls[1][0].ExpressionAttributeValues[':runningTotal']).toBe(150);
  });
});
