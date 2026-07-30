import * as fc from 'fast-check';
import { AuditAction, listAuditEntries, writeAuditEntry } from './auditLog';
import * as dynamoDbClient from './clients/dynamoDbClient';

jest.mock('./clients/dynamoDbClient', () => ({
  putItem: jest.fn(),
  query: jest.fn(),
}));

const mockedPutItem = dynamoDbClient.putItem as jest.Mock;
const mockedQuery = dynamoDbClient.query as jest.Mock;

describe('writeAuditEntry', () => {
  beforeEach(() => {
    mockedPutItem.mockReset();
    mockedPutItem.mockResolvedValue({});
  });

  it('persists an ATTACH_DENY entry with all fields populated', async () => {
    await writeAuditEntry(
      'teamA',
      'modelX',
      'arn:aws:iam::123456789012:role/MyRole',
      'ATTACH_DENY',
      15000,
      10000,
      '2025-01-15T12:00:00.000Z',
      { tableName: 'AuditLog', uuid: () => 'fixed-uuid' }
    );

    expect(mockedPutItem).toHaveBeenCalledTimes(1);
    const call = mockedPutItem.mock.calls[0][0];
    expect(call.TableName).toBe('AuditLog');
    expect(call.Item).toMatchObject({
      PK: 'TEAM#teamA',
      SK: 'TS#2025-01-15T12:00:00.000Z#fixed-uuid',
      model: 'modelX',
      roleArn: 'arn:aws:iam::123456789012:role/MyRole',
      action: 'ATTACH_DENY',
      runningTotalTokens: 15000,
      dailyTokenQuota: 10000,
      timestamp: '2025-01-15T12:00:00.000Z',
    });
    expect(typeof call.Item.ttl).toBe('number');
  });

  it('persists a REMOVE_DENY entry with a null dailyTokenQuota when omitted', async () => {
    await writeAuditEntry(
      'teamA',
      'modelX',
      'arn:aws:iam::123456789012:role/MyRole',
      'REMOVE_DENY',
      500,
      undefined,
      '2025-01-16T00:00:00.000Z',
      { tableName: 'AuditLog' }
    );

    const call = mockedPutItem.mock.calls[0][0];
    expect(call.Item.dailyTokenQuota).toBeNull();
    expect(call.Item.action).toBe('REMOVE_DENY');
  });

  it('computes a ttl at least 90 days after the entry timestamp by default', async () => {
    const timestamp = '2025-01-15T12:00:00.000Z';
    await writeAuditEntry(
      'teamA',
      'modelX',
      'arn:aws:iam::123456789012:role/MyRole',
      'ATTACH_DENY',
      15000,
      10000,
      timestamp,
      { tableName: 'AuditLog' }
    );

    const call = mockedPutItem.mock.calls[0][0];
    const minExpectedMs = new Date(timestamp).getTime() + 90 * 24 * 60 * 60 * 1000;
    expect(call.Item.ttl * 1000).toBeGreaterThanOrEqual(minExpectedMs);
  });

  it('generates a unique SK per call when no uuid is injected', async () => {
    await writeAuditEntry(
      'teamA',
      'modelX',
      'arn:aws:iam::123456789012:role/MyRole',
      'ATTACH_DENY_FAILED',
      15000,
      10000,
      '2025-01-15T12:00:00.000Z',
      { tableName: 'AuditLog' }
    );
    await writeAuditEntry(
      'teamA',
      'modelX',
      'arn:aws:iam::123456789012:role/MyRole',
      'ATTACH_DENY_FAILED',
      15000,
      10000,
      '2025-01-15T12:00:00.000Z',
      { tableName: 'AuditLog' }
    );

    const sk1 = mockedPutItem.mock.calls[0][0].Item.SK;
    const sk2 = mockedPutItem.mock.calls[1][0].Item.SK;
    expect(sk1).not.toBe(sk2);
  });
});

describe('writeAuditEntry - Property 21: Audit entry field fidelity', () => {
  beforeEach(() => {
    mockedPutItem.mockReset();
    mockedPutItem.mockResolvedValue({});
  });

  const teamArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);
  const modelArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);
  const roleArnArb = fc
    .tuple(
      fc.stringOf(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'), {
        minLength: 12,
        maxLength: 12,
      }),
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0)
    )
    .map(([accountId, roleName]) => `arn:aws:iam::${accountId}:role/${roleName}`);
  const actionArb: fc.Arbitrary<AuditAction> = fc.constantFrom(
    'ATTACH_DENY',
    'REMOVE_DENY',
    'ATTACH_DENY_FAILED',
    'REMOVE_DENY_FAILED'
  );
  const runningTotalArb = fc.nat(1_000_000_000);
  const dailyTokenQuotaArb = fc.option(fc.nat(1_000_000_000), { nil: undefined });
  const timestampArb = fc
    .integer({ min: 1600000000, max: 1900000000 })
    .map((epochSeconds) => new Date(epochSeconds * 1000).toISOString());

  // Validates: Requirements 8.1
  it('persists an entry whose fields exactly match the action parameters', async () => {
    await fc.assert(
      fc.asyncProperty(
        teamArb,
        modelArb,
        roleArnArb,
        actionArb,
        runningTotalArb,
        dailyTokenQuotaArb,
        timestampArb,
        async (team, model, roleArn, action, runningTotal, dailyTokenQuota, timestamp) => {
          mockedPutItem.mockReset();
          mockedPutItem.mockResolvedValue({});

          await writeAuditEntry(team, model, roleArn, action, runningTotal, dailyTokenQuota, timestamp, {
            tableName: 'AuditLog',
          });

          expect(mockedPutItem).toHaveBeenCalledTimes(1);
          const persisted = mockedPutItem.mock.calls[0][0].Item;

          expect(persisted.PK).toBe(`TEAM#${team}`);
          expect(persisted.model).toBe(model);
          expect(persisted.roleArn).toBe(roleArn);
          expect(persisted.action).toBe(action);
          expect(persisted.runningTotalTokens).toBe(runningTotal);
          expect(persisted.dailyTokenQuota).toBe(dailyTokenQuota ?? null);
          expect(persisted.timestamp).toBe(timestamp);
          expect(persisted.SK.startsWith(`TS#${timestamp}#`)).toBe(true);
        }
      )
    );
  });
});

const TABLE_NAME = 'AuditLog';

describe('listAuditEntries', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
  });

  it('queries PK = TEAM#<team> with an SK BETWEEN range condition, not a Scan', async () => {
    mockedQuery.mockResolvedValue({ Items: [] });

    await listAuditEntries('teamA', '2025-01-01', '2025-01-31', { tableName: TABLE_NAME });

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const call = mockedQuery.mock.calls[0][0];
    expect(call.TableName).toBe(TABLE_NAME);
    expect(call.KeyConditionExpression).toBe('PK = :pk AND SK BETWEEN :lower AND :upper');
    expect(call.ExpressionAttributeValues[':pk']).toBe('TEAM#teamA');
    expect(call.ExpressionAttributeValues[':lower']).toBe('TS#2025-01-01');
    expect(call.ExpressionAttributeValues[':upper']).toBe('TS#2025-01-31\uFFFF');
  });

  it('maps returned items to AuditLogEntry objects', async () => {
    mockedQuery.mockResolvedValue({
      Items: [
        {
          PK: 'TEAM#teamA',
          SK: 'TS#2025-01-15T12:00:00.000Z#uuid-1',
          model: 'modelX',
          roleArn: 'arn:aws:iam::123456789012:role/MyRole',
          action: 'ATTACH_DENY',
          runningTotalTokens: 15000,
          dailyTokenQuota: 10000,
          timestamp: '2025-01-15T12:00:00.000Z',
          ttl: 123,
        },
      ],
    });

    const result = await listAuditEntries('teamA', '2025-01-01', '2025-01-31', {
      tableName: TABLE_NAME,
    });

    expect(result).toEqual([
      {
        team: 'teamA',
        model: 'modelX',
        roleArn: 'arn:aws:iam::123456789012:role/MyRole',
        action: 'ATTACH_DENY',
        runningTotalTokens: 15000,
        dailyTokenQuota: 10000,
        timestamp: '2025-01-15T12:00:00.000Z',
      },
    ]);
  });

  it('returns an empty array when no entries match', async () => {
    mockedQuery.mockResolvedValue({ Items: [] });

    const result = await listAuditEntries('teamA', '2025-01-01', '2025-01-31', {
      tableName: TABLE_NAME,
    });

    expect(result).toEqual([]);
  });

  it('follows pagination via LastEvaluatedKey and aggregates results across pages', async () => {
    mockedQuery
      .mockResolvedValueOnce({
        Items: [
          {
            PK: 'TEAM#teamA',
            SK: 'TS#2025-01-05T00:00:00.000Z#uuid-1',
            model: 'modelX',
            roleArn: 'roleA',
            action: 'ATTACH_DENY',
            runningTotalTokens: 100,
            dailyTokenQuota: 50,
            timestamp: '2025-01-05T00:00:00.000Z',
          },
        ],
        LastEvaluatedKey: { PK: 'TEAM#teamA', SK: 'TS#2025-01-05T00:00:00.000Z#uuid-1' },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            PK: 'TEAM#teamA',
            SK: 'TS#2025-01-06T00:00:00.000Z#uuid-2',
            model: 'modelX',
            roleArn: 'roleB',
            action: 'REMOVE_DENY',
            runningTotalTokens: 10,
            dailyTokenQuota: 50,
            timestamp: '2025-01-06T00:00:00.000Z',
          },
        ],
      });

    const result = await listAuditEntries('teamA', '2025-01-01', '2025-01-31', {
      tableName: TABLE_NAME,
    });

    expect(result).toHaveLength(2);
    expect(mockedQuery).toHaveBeenCalledTimes(2);
    expect(mockedQuery.mock.calls[1][0].ExclusiveStartKey).toEqual({
      PK: 'TEAM#teamA',
      SK: 'TS#2025-01-05T00:00:00.000Z#uuid-1',
    });
  });
});

describe('listAuditEntries - Property 22: Audit retrieval by team and date range is exact', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
  });

  const teamArb = fc.constantFrom('teamA', 'teamB', 'teamC');
  const actionArb: fc.Arbitrary<AuditAction> = fc.constantFrom(
    'ATTACH_DENY',
    'REMOVE_DENY',
    'ATTACH_DENY_FAILED',
    'REMOVE_DENY_FAILED'
  );

  // Timestamps as whole seconds since epoch, rendered as ISO strings, so
  // lexicographic string ordering matches chronological ordering exactly.
  const timestampArb = fc
    .integer({ min: 1700000000, max: 1750000000 })
    .map((epochSeconds) => new Date(epochSeconds * 1000).toISOString());

  const entryArb = fc
    .tuple(teamArb, timestampArb, actionArb, fc.nat(1_000_000), fc.uuid())
    .map(([team, timestamp, action, runningTotalTokens, id]) => ({
      team,
      timestamp,
      action,
      runningTotalTokens,
      id,
    }));

  // Validates: Requirements 8.3
  it('returns exactly the entries for the queried team whose timestamp falls within the range', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(entryArb, { minLength: 0, maxLength: 30 }),
        teamArb,
        fc.tuple(timestampArb, timestampArb),
        async (entries, queriedTeam, rangeEndpoints) => {
          mockedQuery.mockReset();

          const [rawStart, rawEnd] = rangeEndpoints;
          const startDate = rawStart <= rawEnd ? rawStart : rawEnd;
          const endDate = rawStart <= rawEnd ? rawEnd : rawStart;

          const items = entries.map((entry) => ({
            PK: `TEAM#${entry.team}`,
            SK: `TS#${entry.timestamp}#${entry.id}`,
            model: 'modelX',
            roleArn: 'arn:aws:iam::123456789012:role/SomeRole',
            action: entry.action,
            runningTotalTokens: entry.runningTotalTokens,
            dailyTokenQuota: null,
            timestamp: entry.timestamp,
          }));

          mockedQuery.mockImplementation(async (input: any) => {
            const pk = input.ExpressionAttributeValues[':pk'];
            const lower = input.ExpressionAttributeValues[':lower'];
            const upper = input.ExpressionAttributeValues[':upper'];
            const matching = items.filter(
              (item) => item.PK === pk && item.SK >= lower && item.SK <= upper
            );
            return { Items: matching };
          });

          const expected = entries.filter(
            (entry) =>
              entry.team === queriedTeam &&
              entry.timestamp >= startDate &&
              entry.timestamp <= endDate
          );

          const result = await listAuditEntries(queriedTeam, startDate, endDate, {
            tableName: TABLE_NAME,
          });

          expect(result.length).toBe(expected.length);
          expect(new Set(result.map((r) => r.timestamp + '|' + r.runningTotalTokens))).toEqual(
            new Set(expected.map((e) => e.timestamp + '|' + e.runningTotalTokens))
          );
          expect(result.every((r) => r.team === queriedTeam)).toBe(true);
        },
      ),
    );
  });
});
