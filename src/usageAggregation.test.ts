import * as fc from 'fast-check';
import { getRunningTotal } from './usageAggregation';
import * as dynamoDbClient from './clients/dynamoDbClient';

jest.mock('./clients/dynamoDbClient', () => ({
  getItem: jest.fn(),
}));

const mockedGetItem = dynamoDbClient.getItem as jest.Mock;

const TABLE_NAME = 'UsageAggregation';

const teamArb = () => fc.string({ minLength: 1, maxLength: 20 });
const modelArb = () => fc.string({ minLength: 1, maxLength: 30 });
const usageDayArb = () =>
  fc
    .tuple(
      fc.integer({ min: 2020, max: 2030 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 1, max: 28 })
    )
    .map(
      ([year, month, day]) =>
        `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    );

describe('getRunningTotal', () => {
  beforeEach(() => {
    mockedGetItem.mockReset();
  });

  it('issues a GetItem keyed on the exact PK/SK format from design.md', async () => {
    mockedGetItem.mockResolvedValue({ Item: undefined });

    await getRunningTotal('teamA', 'anthropic.claude-v2', '2025-01-15', {
      tableName: TABLE_NAME,
    });

    expect(mockedGetItem).toHaveBeenCalledTimes(1);
    expect(mockedGetItem).toHaveBeenCalledWith({
      TableName: TABLE_NAME,
      Key: {
        PK: 'TEAM#teamA#MODEL#anthropic.claude-v2',
        SK: 'DAY#2025-01-15',
      },
    });
  });

  it('returns 0 when no item exists yet for the Team, Model, and Usage_Day', async () => {
    mockedGetItem.mockResolvedValue({ Item: undefined });

    const result = await getRunningTotal('teamA', 'modelA', '2025-01-15', {
      tableName: TABLE_NAME,
    });

    expect(result).toBe(0);
  });

  it('returns the running total from the item when it exists', async () => {
    mockedGetItem.mockResolvedValue({
      Item: {
        PK: 'TEAM#teamA#MODEL#modelA',
        SK: 'DAY#2025-01-15',
        runningTotalTokens: 4200,
        usageDay: '2025-01-15',
        team: 'teamA',
        model: 'modelA',
        lastUpdatedAt: '2025-01-15T10:00:00.000Z',
        ttl: 1234567890,
      },
    });

    const result = await getRunningTotal('teamA', 'modelA', '2025-01-15', {
      tableName: TABLE_NAME,
    });

    expect(result).toBe(4200);
  });

  it('returns 0 when the item exists but has no runningTotalTokens attribute', async () => {
    mockedGetItem.mockResolvedValue({
      Item: {
        PK: 'TEAM#teamA#MODEL#modelA',
        SK: 'DAY#2025-01-15',
      },
    });

    const result = await getRunningTotal('teamA', 'modelA', '2025-01-15', {
      tableName: TABLE_NAME,
    });

    expect(result).toBe(0);
  });

  it('for any Team/Model/UsageDay, returns the stored running total when present, or 0 when absent', async () => {
    await fc.assert(
      fc.asyncProperty(
        teamArb(),
        modelArb(),
        usageDayArb(),
        fc.option(fc.integer({ min: 0, max: 1_000_000_000 }), { nil: undefined }),
        async (team, model, usageDay, runningTotalTokens) => {
          mockedGetItem.mockReset();
          mockedGetItem.mockResolvedValue({
            Item:
              runningTotalTokens === undefined
                ? undefined
                : {
                    PK: `TEAM#${team}#MODEL#${model}`,
                    SK: `DAY#${usageDay}`,
                    runningTotalTokens,
                  },
          });

          const result = await getRunningTotal(team, model, usageDay, {
            tableName: TABLE_NAME,
          });

          expect(result).toBe(runningTotalTokens ?? 0);
          expect(mockedGetItem).toHaveBeenCalledWith({
            TableName: TABLE_NAME,
            Key: {
              PK: `TEAM#${team}#MODEL#${model}`,
              SK: `DAY#${usageDay}`,
            },
          });
        }
      )
    );
  });
});
