import * as fc from 'fast-check';

import {
  computeUsageDay,
  parseInvocationLogEntry,
  ParsedInvocationLogEntry,
  processInvocationLogEntry,
} from './usageCollector';
import * as dynamoDbClient from './clients/dynamoDbClient';
import * as teamRoleCache from './teamRoleCache';
import { UNMAPPED_ROLE } from './types';

jest.mock('./clients/dynamoDbClient', () => ({
  transactWrite: jest.fn(),
}));

jest.mock('./teamRoleCache', () => ({
  resolveTeam: jest.fn(),
}));

const mockedTransactWrite = dynamoDbClient.transactWrite as jest.Mock;
const mockedResolveTeam = teamRoleCache.resolveTeam as jest.Mock;

const arnSegment = () =>
  fc.stringOf(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+=,.@_-'),
    { minLength: 1, maxLength: 20 },
  );

const roleArn = () =>
  fc.tuple(
    fc.stringOf(fc.constantFrom(...'0123456789'), { minLength: 12, maxLength: 12 }),
    arnSegment(),
  ).map(([account, roleName]) => `arn:aws:iam::${account}:role/${roleName}`);

const requestId = () => fc.uuid();

const modelId = () =>
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789.-'), { minLength: 1, maxLength: 40 });

const isoTimestamp = () =>
  fc.date({ min: new Date('2000-01-01T00:00:00.000Z'), max: new Date('2100-01-01T00:00:00.000Z') }).map((d) => d.toISOString());

const tokenCount = () => fc.integer({ min: 0, max: 1_000_000 });

/**
 * A fake, in-memory DynamoDB `TransactWriteItems` implementation backing
 * both the Processed_Requests dedup table and the Usage_Aggregation
 * running-total table, faithfully replicating the real conditional-Put +
 * ADD-Update transaction semantics (including atomic rollback of the whole
 * transaction, i.e. no partial increment, when the dedup condition fails).
 */
function createFakeTransactWriteStore() {
  const processedRequestIds = new Set<string>();
  const usageAggregation = new Map<string, { runningTotalTokens: number }>();

  const transactWriteImpl = jest.fn(async (input: any) => {
    const [putItem, updateItem] = input.TransactItems;
    const dedupKey = putItem.Put.Item.PK as string;

    if (processedRequestIds.has(dedupKey)) {
      const error: any = new Error('TransactionCanceledException');
      error.name = 'TransactionCanceledException';
      error.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }];
      throw error;
    }

    processedRequestIds.add(dedupKey);

    const aggKey = `${updateItem.Update.Key.PK}#${updateItem.Update.Key.SK}`;
    const increment = updateItem.Update.ExpressionAttributeValues[':increment'] as number;
    const existing = usageAggregation.get(aggKey) ?? { runningTotalTokens: 0 };
    usageAggregation.set(aggKey, {
      runningTotalTokens: existing.runningTotalTokens + increment,
    });

    return {};
  });

  return {
    transactWriteImpl,
    getRunningTotal: (team: string, model: string, usageDay: string): number =>
      usageAggregation.get(`TEAM#${team}#MODEL#${model}#DAY#${usageDay}`)?.runningTotalTokens ?? 0,
    processedRequestCount: () => processedRequestIds.size,
  };
}

function buildParsedEntry(overrides: Partial<ParsedInvocationLogEntry> = {}): ParsedInvocationLogEntry {
  return {
    requestId: 'req-1',
    roleArn: 'arn:aws:iam::123456789012:role/MyRole',
    modelId: 'anthropic.claude-v2',
    inputTokenCount: 10,
    outputTokenCount: 20,
    timestamp: '2025-01-15T10:00:00.000Z',
    ...overrides,
  };
}

const TEAM_TAG_KEY = 'team';
const TEAM_ROLE_CACHE_TABLE = 'TeamRoleCache';
const USAGE_AGGREGATION_TABLE = 'UsageAggregation';
const PROCESSED_REQUESTS_TABLE = 'ProcessedRequests';

function baseProcessOptions() {
  return {
    teamTagKey: TEAM_TAG_KEY,
    teamRoleCacheTableName: TEAM_ROLE_CACHE_TABLE,
    usageAggregationTableName: USAGE_AGGREGATION_TABLE,
    processedRequestsTableName: PROCESSED_REQUESTS_TABLE,
  };
}

/** A raw log entry representing a successful, billable invocation. */
const successfulLogEntry = () =>
  fc.record({
    requestId: requestId(),
    identity: fc.record({ arn: roleArn() }),
    modelId: modelId(),
    timestamp: isoTimestamp(),
    input: fc.record({ inputTokenCount: tokenCount() }),
    output: fc.record({ outputTokenCount: tokenCount() }),
  });

/**
 * A raw log entry representing a failed/throttled invocation: it otherwise
 * looks like a real entry but lacks token counts, which is how the Bedrock
 * Model Invocation Logging pipeline represents non-successful calls.
 */
const failedLogEntry = () =>
  fc.record({
    requestId: requestId(),
    identity: fc.record({ arn: roleArn() }),
    modelId: modelId(),
    timestamp: isoTimestamp(),
  });

describe('parseInvocationLogEntry', () => {
  // Validates: Requirements 2.1
  test('Property 4: Log entry to Token_Usage_Record field fidelity', () => {
    fc.assert(
      fc.property(successfulLogEntry(), (entry) => {
        const parsed = parseInvocationLogEntry(entry);

        expect(parsed).not.toBeNull();
        expect(parsed!.inputTokenCount).toBe(entry.input.inputTokenCount);
        expect(parsed!.outputTokenCount).toBe(entry.output.outputTokenCount);
        expect(parsed!.modelId).toBe(entry.modelId);
        expect(parsed!.timestamp).toBe(entry.timestamp);
      }),
    );
  });

  // Validates: Requirements 2.3
  test('Property 5: Only successful invocations produce records', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            successfulLogEntry().map((entry) => ({ successful: true as const, entry })),
            failedLogEntry().map((entry) => ({ successful: false as const, entry })),
          ),
          { minLength: 0, maxLength: 25 },
        ),
        (taggedEntries) => {
          const results = taggedEntries.map(({ entry }) => parseInvocationLogEntry(entry));

          taggedEntries.forEach((tagged, index) => {
            if (tagged.successful) {
              expect(results[index]).not.toBeNull();
              expect(results[index]!.requestId).toBe(tagged.entry.requestId);
            } else {
              expect(results[index]).toBeNull();
            }
          });
        },
      ),
    );
  });

  test('parses a concrete valid log entry', () => {
    const entry = {
      requestId: 'req-123',
      identity: { arn: 'arn:aws:iam::123456789012:role/MyRole' },
      modelId: 'anthropic.claude-v2',
      timestamp: '2025-01-15T10:00:00.000Z',
      input: { inputTokenCount: 100 },
      output: { outputTokenCount: 200 },
    };

    const parsed = parseInvocationLogEntry(entry);

    expect(parsed).toEqual({
      requestId: 'req-123',
      roleArn: 'arn:aws:iam::123456789012:role/MyRole',
      modelId: 'anthropic.claude-v2',
      inputTokenCount: 100,
      outputTokenCount: 200,
      timestamp: '2025-01-15T10:00:00.000Z',
    });
  });

  test('returns null for an entry lacking token counts (failed/throttled invocation)', () => {
    const entry = {
      requestId: 'req-123',
      identity: { arn: 'arn:aws:iam::123456789012:role/MyRole' },
      modelId: 'anthropic.claude-v2',
      timestamp: '2025-01-15T10:00:00.000Z',
    };

    expect(parseInvocationLogEntry(entry)).toBeNull();
  });

  test('returns null for non-object input (null, array, primitive)', () => {
    expect(parseInvocationLogEntry(null)).toBeNull();
    expect(parseInvocationLogEntry(undefined)).toBeNull();
    expect(parseInvocationLogEntry('not an object')).toBeNull();
    expect(parseInvocationLogEntry(42)).toBeNull();
    expect(parseInvocationLogEntry([])).toBeNull();
  });

  test('returns null when requestId is missing or empty', () => {
    const base = {
      identity: { arn: 'arn:aws:iam::123456789012:role/MyRole' },
      modelId: 'anthropic.claude-v2',
      timestamp: '2025-01-15T10:00:00.000Z',
      input: { inputTokenCount: 100 },
      output: { outputTokenCount: 200 },
    };

    expect(parseInvocationLogEntry({ ...base })).toBeNull();
    expect(parseInvocationLogEntry({ ...base, requestId: '' })).toBeNull();
  });

  test('returns null when identity.arn is missing', () => {
    const entry = {
      requestId: 'req-123',
      identity: {},
      modelId: 'anthropic.claude-v2',
      timestamp: '2025-01-15T10:00:00.000Z',
      input: { inputTokenCount: 100 },
      output: { outputTokenCount: 200 },
    };

    expect(parseInvocationLogEntry(entry)).toBeNull();
  });

  test('returns null when identity is missing entirely', () => {
    const entry = {
      requestId: 'req-123',
      modelId: 'anthropic.claude-v2',
      timestamp: '2025-01-15T10:00:00.000Z',
      input: { inputTokenCount: 100 },
      output: { outputTokenCount: 200 },
    };

    expect(parseInvocationLogEntry(entry)).toBeNull();
  });

  test('returns null when token counts are non-numeric', () => {
    const entry = {
      requestId: 'req-123',
      identity: { arn: 'arn:aws:iam::123456789012:role/MyRole' },
      modelId: 'anthropic.claude-v2',
      timestamp: '2025-01-15T10:00:00.000Z',
      input: { inputTokenCount: 'not-a-number' },
      output: { outputTokenCount: 200 },
    };

    expect(parseInvocationLogEntry(entry)).toBeNull();
  });

  test('malformed entries are skipped without affecting other entries in the same batch', () => {
    const malformedEntries: unknown[] = [
      null,
      undefined,
      {},
      { requestId: 'only-a-request-id' },
      { requestId: 'req-1', identity: { arn: 'arn:aws:iam::123456789012:role/MyRole' } },
    ];

    const validEntry = {
      requestId: 'req-valid',
      identity: { arn: 'arn:aws:iam::123456789012:role/MyRole' },
      modelId: 'anthropic.claude-v2',
      timestamp: '2025-01-15T10:00:00.000Z',
      input: { inputTokenCount: 10 },
      output: { outputTokenCount: 20 },
    };

    const batch = [...malformedEntries, validEntry];
    const results = batch.map((rawEntry) => parseInvocationLogEntry(rawEntry));

    for (let i = 0; i < malformedEntries.length; i++) {
      expect(results[i]).toBeNull();
    }
    expect(results[malformedEntries.length]).toEqual({
      requestId: 'req-valid',
      roleArn: 'arn:aws:iam::123456789012:role/MyRole',
      modelId: 'anthropic.claude-v2',
      inputTokenCount: 10,
      outputTokenCount: 20,
      timestamp: '2025-01-15T10:00:00.000Z',
    });
  });
});

describe('computeUsageDay', () => {
  test('derives the UTC calendar date from an ISO timestamp', () => {
    expect(computeUsageDay('2025-01-15T23:59:59.999Z')).toBe('2025-01-15');
    expect(computeUsageDay('2025-01-15T00:00:00.000Z')).toBe('2025-01-15');
    expect(computeUsageDay('2025-01-16T00:00:00.000Z')).toBe('2025-01-16');
  });

  test('throws for an unparsable timestamp', () => {
    expect(() => computeUsageDay('not-a-timestamp')).toThrow();
  });
});

describe('processInvocationLogEntry', () => {
  beforeEach(() => {
    mockedTransactWrite.mockReset();
    mockedResolveTeam.mockReset();
  });

  it('resolves the role, team, and usage day, and writes a single TransactWriteItems call', async () => {
    const store = createFakeTransactWriteStore();
    mockedTransactWrite.mockImplementation(store.transactWriteImpl);
    mockedResolveTeam.mockResolvedValue('teamA');

    const entry = buildParsedEntry();
    const result = await processInvocationLogEntry(entry, {
      ...baseProcessOptions(),
      now: () => new Date('2025-01-15T12:00:00.000Z'),
    });

    expect(result).toEqual({
      team: 'teamA',
      roleArn: 'arn:aws:iam::123456789012:role/MyRole',
      usageDay: '2025-01-15',
      duplicate: false,
    });
    expect(store.getRunningTotal('teamA', 'anthropic.claude-v2', '2025-01-15')).toBe(30);
    expect(mockedTransactWrite).toHaveBeenCalledTimes(1);
  });

  it('resolves an assumed-role session ARN to the underlying IAM role before resolving the team', async () => {
    const store = createFakeTransactWriteStore();
    mockedTransactWrite.mockImplementation(store.transactWriteImpl);
    mockedResolveTeam.mockResolvedValue('teamA');

    const entry = buildParsedEntry({
      roleArn: 'arn:aws:sts::123456789012:assumed-role/MyRole/session-1',
    });

    const result = await processInvocationLogEntry(entry, baseProcessOptions());

    expect(result.roleArn).toBe('arn:aws:iam::123456789012:role/MyRole');
    expect(mockedResolveTeam).toHaveBeenCalledWith(
      'arn:aws:iam::123456789012:role/MyRole',
      expect.objectContaining({ teamTagKey: TEAM_TAG_KEY, tableName: TEAM_ROLE_CACHE_TABLE }),
    );
  });

  it('discards a duplicate requestId as harmless without double-incrementing the running total', async () => {
    const store = createFakeTransactWriteStore();
    mockedTransactWrite.mockImplementation(store.transactWriteImpl);
    mockedResolveTeam.mockResolvedValue('teamA');

    const entry = buildParsedEntry();
    const first = await processInvocationLogEntry(entry, baseProcessOptions());
    const second = await processInvocationLogEntry(entry, baseProcessOptions());

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(store.getRunningTotal('teamA', entry.modelId, '2025-01-15')).toBe(30);
    expect(store.processedRequestCount()).toBe(1);
  });

  it('classifies an unmapped role and still contributes to the running total', async () => {
    const store = createFakeTransactWriteStore();
    mockedTransactWrite.mockImplementation(store.transactWriteImpl);
    mockedResolveTeam.mockResolvedValue(UNMAPPED_ROLE);

    const entry = buildParsedEntry();
    const result = await processInvocationLogEntry(entry, baseProcessOptions());

    expect(result.team).toBe(UNMAPPED_ROLE);
    expect(store.getRunningTotal(UNMAPPED_ROLE, entry.modelId, '2025-01-15')).toBe(30);
  });

  it('propagates non-conditional-check errors from the transaction instead of swallowing them', async () => {
    mockedResolveTeam.mockResolvedValue('teamA');
    mockedTransactWrite.mockRejectedValue(new Error('ProvisionedThroughputExceededException'));

    await expect(
      processInvocationLogEntry(buildParsedEntry(), baseProcessOptions()),
    ).rejects.toThrow('ProvisionedThroughputExceededException');
  });

  // Validates: Requirements 2.5
  test('Property 6: Duplicate request IDs are idempotent', async () => {
    await fc.assert(
      fc.asyncProperty(
        requestId(),
        roleArn(),
        modelId(),
        isoTimestamp(),
        tokenCount(),
        tokenCount(),
        fc.string({ minLength: 1, maxLength: 15 }),
        fc.integer({ min: 1, max: 5 }),
        async (reqId, role, model, timestamp, inputTokens, outputTokens, team, n) => {
          const store = createFakeTransactWriteStore();
          mockedTransactWrite.mockReset();
          mockedTransactWrite.mockImplementation(store.transactWriteImpl);
          mockedResolveTeam.mockReset();
          mockedResolveTeam.mockResolvedValue(team);

          const entry = buildParsedEntry({
            requestId: reqId,
            roleArn: role,
            modelId: model,
            timestamp,
            inputTokenCount: inputTokens,
            outputTokenCount: outputTokens,
          });

          for (let i = 0; i < n; i++) {
            await processInvocationLogEntry(entry, baseProcessOptions());
          }

          const usageDay = computeUsageDay(timestamp);
          expect(store.getRunningTotal(team, model, usageDay)).toBe(inputTokens + outputTokens);
        },
      ),
    );
  });

  // Validates: Requirements 1.3
  test('Property 2: Unmapped roles are preserved, not discarded', async () => {
    await fc.assert(
      fc.asyncProperty(
        requestId(),
        roleArn(),
        modelId(),
        isoTimestamp(),
        tokenCount(),
        tokenCount(),
        async (reqId, role, model, timestamp, inputTokens, outputTokens) => {
          const store = createFakeTransactWriteStore();
          mockedTransactWrite.mockReset();
          mockedTransactWrite.mockImplementation(store.transactWriteImpl);
          mockedResolveTeam.mockReset();
          mockedResolveTeam.mockResolvedValue(UNMAPPED_ROLE);

          const entry = buildParsedEntry({
            requestId: reqId,
            roleArn: role,
            modelId: model,
            timestamp,
            inputTokenCount: inputTokens,
            outputTokenCount: outputTokens,
          });

          const result = await processInvocationLogEntry(entry, baseProcessOptions());

          expect(result.team).toBe(UNMAPPED_ROLE);
          const usageDay = computeUsageDay(timestamp);
          expect(store.getRunningTotal(UNMAPPED_ROLE, model, usageDay)).toBe(
            inputTokens + outputTokens,
          );
        },
      ),
    );
  });

  // Validates: Requirements 1.4, 3.1, 3.2
  test('Property 8: Aggregation summation invariant', async () => {
    const recordArb = fc.record({
      requestId: requestId(),
      roleArn: roleArn(),
      modelId: fc.constantFrom('modelA', 'modelB'),
      team: fc.constantFrom('teamA', 'teamB', 'teamC'),
      usageDay: fc.constantFrom('2025-01-15', '2025-01-16'),
      inputTokens: tokenCount(),
      outputTokens: tokenCount(),
    });

    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(recordArb, { minLength: 0, maxLength: 25, selector: (r) => r.requestId }),
        async (records) => {
          const store = createFakeTransactWriteStore();
          mockedTransactWrite.mockReset();
          mockedTransactWrite.mockImplementation(store.transactWriteImpl);
          mockedResolveTeam.mockReset();
          mockedResolveTeam.mockImplementation(async () => {
            throw new Error('unexpected resolveTeam call; team is provided per-record in this test');
          });

          for (const record of records) {
            mockedResolveTeam.mockResolvedValueOnce(record.team);
            const entry = buildParsedEntry({
              requestId: record.requestId,
              roleArn: record.roleArn,
              modelId: record.modelId,
              timestamp: `${record.usageDay}T12:00:00.000Z`,
              inputTokenCount: record.inputTokens,
              outputTokenCount: record.outputTokens,
            });
            await processInvocationLogEntry(entry, baseProcessOptions());
          }

          const combinations = new Set(
            records.map((r) => `${r.team}#${r.modelId}#${r.usageDay}`),
          );

          for (const combination of combinations) {
            const [team, model, usageDay] = combination.split('#');
            const expectedTotal = records
              .filter((r) => r.team === team && r.modelId === model && r.usageDay === usageDay)
              .reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);

            expect(store.getRunningTotal(team, model, usageDay)).toBe(expectedTotal);
          }
        },
      ),
    );
  });

  // Validates: Requirements 3.3
  test('Property 9: Usage-day bucketing is correct and days are isolated', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.constantFrom('modelA', 'modelB'),
        fc.uniqueArray(
          fc.record({
            requestId: requestId(),
            usageDay: fc.constantFrom('2025-01-14', '2025-01-15', '2025-01-16'),
            inputTokens: tokenCount(),
            outputTokens: tokenCount(),
          }),
          { minLength: 1, maxLength: 20, selector: (r) => r.requestId },
        ),
        async (team, model, records) => {
          const store = createFakeTransactWriteStore();
          mockedTransactWrite.mockReset();
          mockedTransactWrite.mockImplementation(store.transactWriteImpl);
          mockedResolveTeam.mockReset();
          mockedResolveTeam.mockResolvedValue(team);

          for (const record of records) {
            const entry = buildParsedEntry({
              requestId: record.requestId,
              modelId: model,
              timestamp: `${record.usageDay}T08:00:00.000Z`,
              inputTokenCount: record.inputTokens,
              outputTokenCount: record.outputTokens,
            });
            await processInvocationLogEntry(entry, baseProcessOptions());
          }

          for (const usageDay of ['2025-01-14', '2025-01-15', '2025-01-16']) {
            const expectedTotal = records
              .filter((r) => r.usageDay === usageDay)
              .reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);

            expect(store.getRunningTotal(team, model, usageDay)).toBe(expectedTotal);
          }
        },
      ),
    );
  });
});
