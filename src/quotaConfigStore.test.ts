import * as fc from 'fast-check';

import { listQuotas, putQuota } from './quotaConfigStore';
import * as dynamoDbClient from './clients/dynamoDbClient';

jest.mock('./clients/dynamoDbClient', () => ({
  putItem: jest.fn(),
  getItem: jest.fn(),
  query: jest.fn(),
}));

const mockedPutItem = dynamoDbClient.putItem as jest.Mock;
const mockedGetItem = dynamoDbClient.getItem as jest.Mock;
const mockedQuery = dynamoDbClient.query as jest.Mock;

describe('putQuota', () => {
  beforeEach(() => {
    mockedPutItem.mockReset();
    mockedPutItem.mockResolvedValue({});
  });

  it('writes a valid positive integer quota to the table', async () => {
    await putQuota('teamA', 'modelX', 1000, { tableName: 'QuotaConfiguration' });

    expect(mockedPutItem).toHaveBeenCalledTimes(1);
    const call = mockedPutItem.mock.calls[0][0];
    expect(call.TableName).toBe('QuotaConfiguration');
    expect(call.Item).toMatchObject({
      PK: 'TEAM#teamA',
      SK: 'MODEL#modelX',
      dailyTokenQuota: 1000,
    });
    expect(typeof call.Item.updatedAt).toBe('string');
  });

  it('rejects a zero quota without writing', async () => {
    await expect(
      putQuota('teamA', 'modelX', 0, { tableName: 'QuotaConfiguration' })
    ).rejects.toThrow(/positive integer/);
    expect(mockedPutItem).not.toHaveBeenCalled();
  });

  it('rejects a negative quota without writing', async () => {
    await expect(
      putQuota('teamA', 'modelX', -5, { tableName: 'QuotaConfiguration' })
    ).rejects.toThrow(/positive integer/);
    expect(mockedPutItem).not.toHaveBeenCalled();
  });

  it('rejects a non-integer quota without writing', async () => {
    await expect(
      putQuota('teamA', 'modelX', 12.5, { tableName: 'QuotaConfiguration' })
    ).rejects.toThrow(/positive integer/);
    expect(mockedPutItem).not.toHaveBeenCalled();
  });

  it('records the updatedBy identity when provided', async () => {
    await putQuota('teamA', 'modelX', 500, {
      tableName: 'QuotaConfiguration',
      updatedBy: 'admin@example.com',
    });

    const call = mockedPutItem.mock.calls[0][0];
    expect(call.Item.updatedBy).toBe('admin@example.com');
  });
});

describe('putQuota - Property 11: Quota validation rejects non-positive integers', () => {
  beforeEach(() => {
    mockedPutItem.mockReset();
    mockedPutItem.mockResolvedValue({});
  });

  const teamArb = fc.string({ minLength: 1, maxLength: 20 });
  const modelArb = fc.string({ minLength: 1, maxLength: 20 });

  const invalidQuotaArb = fc.oneof(
    fc.integer({ min: -1_000_000, max: 0 }),
    fc
      .float({ min: -1000, max: 1000, noNaN: true })
      .filter((value) => Number.isFinite(value) && !Number.isInteger(value)),
    fc.constantFrom(NaN, Infinity, -Infinity),
  );

  const validQuotaArb = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });

  // Validates: Requirements 4.4
  it('rejects any non-positive-integer dailyTokenQuota without persisting it', async () => {
    await fc.assert(
      fc.asyncProperty(teamArb, modelArb, invalidQuotaArb, async (team, model, quota) => {
        mockedPutItem.mockClear();

        await expect(
          putQuota(team, model, quota, { tableName: 'QuotaConfiguration' }),
        ).rejects.toThrow(/positive integer/);

        expect(mockedPutItem).not.toHaveBeenCalled();
      }),
    );
  });

  // Validates: Requirements 4.4
  it('accepts and persists any positive-integer dailyTokenQuota', async () => {
    await fc.assert(
      fc.asyncProperty(teamArb, modelArb, validQuotaArb, async (team, model, quota) => {
        mockedPutItem.mockClear();

        await expect(
          putQuota(team, model, quota, { tableName: 'QuotaConfiguration' }),
        ).resolves.toBeUndefined();

        expect(mockedPutItem).toHaveBeenCalledTimes(1);
        expect(mockedPutItem.mock.calls[0][0].Item.dailyTokenQuota).toBe(quota);
      }),
    );
  });
});

describe('putQuota - Property 10: Quota store round trip', () => {
  const teamArb = fc.string({ minLength: 1, maxLength: 20 });
  const modelArb = fc.string({ minLength: 1, maxLength: 20 });
  const quotaArb = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });

  // Validates: Requirements 4.1
  it('reading back a written quota for a Team and Model returns the exact value written', async () => {
    await fc.assert(
      fc.asyncProperty(teamArb, modelArb, quotaArb, async (team, model, quota) => {
        const fakeTable = new Map<string, Map<string, unknown>>();

        mockedPutItem.mockReset();
        mockedPutItem.mockImplementation(async (input: any) => {
          const { PK, SK } = input.Item;
          if (!fakeTable.has(PK)) {
            fakeTable.set(PK, new Map());
          }
          fakeTable.get(PK)!.set(SK, input.Item);
          return {};
        });

        mockedGetItem.mockReset();
        mockedGetItem.mockImplementation(async (input: any) => {
          const { PK, SK } = input.Key;
          const item = fakeTable.get(PK)?.get(SK);
          return { Item: item };
        });

        await putQuota(team, model, quota, { tableName: 'QuotaConfiguration' });

        const readBack = await dynamoDbClient.getItem({
          TableName: 'QuotaConfiguration',
          Key: { PK: `TEAM#${team}`, SK: `MODEL#${model}` },
        });

        expect(readBack.Item).toBeDefined();
        expect((readBack.Item as any).dailyTokenQuota).toBe(quota);
      }),
    );
  });
});

describe('listQuotas', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
  });

  it('queries the known partition key for the team, not a Scan', async () => {
    mockedQuery.mockResolvedValue({
      Items: [{ PK: 'TEAM#teamA', SK: 'MODEL#modelX', dailyTokenQuota: 1000 }],
    });

    const result = await listQuotas('teamA', { tableName: 'QuotaConfiguration' });

    expect(result).toEqual([{ model: 'modelX', dailyTokenQuota: 1000 }]);
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const queryCall = mockedQuery.mock.calls[0][0];
    expect(queryCall.TableName).toBe('QuotaConfiguration');
    expect(queryCall.KeyConditionExpression).toBe('PK = :pk');
    expect(queryCall.ExpressionAttributeValues).toEqual({ ':pk': 'TEAM#teamA' });
  });

  it('returns an empty array when no quotas are configured for the team', async () => {
    mockedQuery.mockResolvedValue({ Items: [] });

    const result = await listQuotas('teamWithNoQuotas', { tableName: 'QuotaConfiguration' });

    expect(result).toEqual([]);
  });

  it('strips the MODEL# prefix from every returned sort key', async () => {
    mockedQuery.mockResolvedValue({
      Items: [
        { PK: 'TEAM#teamA', SK: 'MODEL#modelX', dailyTokenQuota: 1000 },
        { PK: 'TEAM#teamA', SK: 'MODEL#modelY', dailyTokenQuota: 2000 },
      ],
    });

    const result = await listQuotas('teamA', { tableName: 'QuotaConfiguration' });

    expect(result).toEqual([
      { model: 'modelX', dailyTokenQuota: 1000 },
      { model: 'modelY', dailyTokenQuota: 2000 },
    ]);
  });

  it('follows pagination via LastEvaluatedKey and aggregates results across pages', async () => {
    mockedQuery
      .mockResolvedValueOnce({
        Items: [{ PK: 'TEAM#teamA', SK: 'MODEL#modelX', dailyTokenQuota: 1000 }],
        LastEvaluatedKey: { PK: 'TEAM#teamA', SK: 'MODEL#modelX' },
      })
      .mockResolvedValueOnce({
        Items: [{ PK: 'TEAM#teamA', SK: 'MODEL#modelY', dailyTokenQuota: 2000 }],
      });

    const result = await listQuotas('teamA', { tableName: 'QuotaConfiguration' });

    expect(result).toEqual([
      { model: 'modelX', dailyTokenQuota: 1000 },
      { model: 'modelY', dailyTokenQuota: 2000 },
    ]);
    expect(mockedQuery).toHaveBeenCalledTimes(2);
    expect(mockedQuery.mock.calls[1][0].ExclusiveStartKey).toEqual({
      PK: 'TEAM#teamA',
      SK: 'MODEL#modelX',
    });
  });
});

describe('listQuotas - Property 12: Listing quotas for a team is exact', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
  });

  const teamArb = fc.string({ minLength: 1, maxLength: 20 });
  const modelArb = fc.string({ minLength: 1, maxLength: 20 });
  const quotaArb = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });

  // Validates: Requirements 4.5
  it('returns exactly the (model, dailyTokenQuota) pairs configured for the queried team', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.tuple(teamArb, modelArb), {
          minLength: 0,
          maxLength: 20,
          selector: ([team, model]) => `${team}\u0000${model}`,
        }),
        fc.array(quotaArb, { minLength: 0, maxLength: 20 }),
        teamArb,
        async (teamModelPairs, quotas, queriedTeam) => {
          mockedQuery.mockReset();

          const allEntries = teamModelPairs.map(([team, model], index) => ({
            PK: `TEAM#${team}`,
            SK: `MODEL#${model}`,
            dailyTokenQuota: quotas[index % Math.max(quotas.length, 1)] ?? 1,
          }));

          const expected = allEntries
            .filter((entry) => entry.PK === `TEAM#${queriedTeam}`)
            .map((entry) => ({
              model: entry.SK.slice('MODEL#'.length),
              dailyTokenQuota: entry.dailyTokenQuota,
            }));

          mockedQuery.mockImplementation(async (input: any) => {
            const matching = allEntries.filter((entry) => entry.PK === input.ExpressionAttributeValues[':pk']);
            return { Items: matching };
          });

          const result = await listQuotas(queriedTeam, { tableName: 'QuotaConfiguration' });

          expect(new Set(result.map((r) => JSON.stringify(r)))).toEqual(
            new Set(expected.map((r) => JSON.stringify(r))),
          );
          expect(result.length).toBe(expected.length);
        },
      ),
    );
  });
});
