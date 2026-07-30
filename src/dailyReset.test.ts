import * as fc from 'fast-check';

import { removeDenyPolicy, runDailyReset, DailyResetOptions } from './dailyReset';
import * as dynamoDbClient from './clients/dynamoDbClient';
import * as iamClient from './clients/iamClient';
import * as snsClient from './clients/snsClient';

jest.mock('./clients/dynamoDbClient', () => ({
  getItem: jest.fn(),
  putItem: jest.fn(),
  deleteItem: jest.fn(),
  query: jest.fn(),
}));

jest.mock('./clients/iamClient', () => ({
  deleteRolePolicy: jest.fn(),
}));

jest.mock('./clients/snsClient', () => ({
  publish: jest.fn(),
}));

const mockedQuery = dynamoDbClient.query as jest.Mock;
const mockedGetItem = dynamoDbClient.getItem as jest.Mock;
const mockedDeleteItem = dynamoDbClient.deleteItem as jest.Mock;
const mockedPutItem = dynamoDbClient.putItem as jest.Mock;
const mockedDeleteRolePolicy = iamClient.deleteRolePolicy as jest.Mock;
const mockedPublish = snsClient.publish as jest.Mock;

const BLOCKED_STATE_TABLE = 'BlockedState';
const TEAM_ROLE_CACHE_TABLE = 'TeamRoleCache';
const AUDIT_LOG_TABLE = 'AuditLog';

const baseOptions: DailyResetOptions = {
  blockedStateTableName: BLOCKED_STATE_TABLE,
  teamRoleCacheTableName: TEAM_ROLE_CACHE_TABLE,
  auditLogTableName: AUDIT_LOG_TABLE,
  notificationTopicArn: 'arn:aws:sns:us-east-1:123456789012:notifications',
  // now() is 2025-01-16T00:00:00Z, so the previous Usage_Day is 2025-01-15.
  now: () => new Date('2025-01-16T00:00:00.000Z'),
};

interface BlockedPairFixture {
  team: string;
  model: string;
  roleArns: string[];
}

/**
 * Configures the query mock: `StatusDayIndex` queries keyed by `statusDay`
 * return the configured Blocked_State pairs; `TeamIndex` queries (via
 * `listRolesForTeam`) return the mapped role ARNs for the pair's team.
 */
function mockQueryForPairs(blockedPairs: BlockedPairFixture[], pendingResetPairs: BlockedPairFixture[] = []): void {
  mockedQuery.mockImplementation(async (input: any) => {
    if (input.IndexName === 'StatusDayIndex') {
      const statusDay = input.ExpressionAttributeValues[':statusDay'] as string;
      const sourcePairs = statusDay.startsWith('BLOCKED#') ? blockedPairs : pendingResetPairs;
      return {
        Items: sourcePairs.map((pair) => ({
          PK: `TEAM#${pair.team}`,
          SK: `MODEL#${pair.model}`,
          status: statusDay.startsWith('BLOCKED#') ? 'BLOCKED' : 'PENDING_RESET',
          statusDay,
          blockedUsageDay: '2025-01-15',
        })),
      };
    }

    if (input.IndexName === 'TeamIndex') {
      const team = input.ExpressionAttributeValues[':team'] as string;
      const allPairs = [...blockedPairs, ...pendingResetPairs];
      const matchingPair = allPairs.find((pair) => pair.team === team);
      return {
        Items: (matchingPair?.roleArns ?? []).map((roleArn) => ({ PK: `ROLE#${roleArn}`, team })),
      };
    }

    return { Items: [] };
  });
}

beforeEach(() => {
  mockedQuery.mockReset();
  mockedGetItem.mockReset();
  mockedDeleteItem.mockReset();
  mockedPutItem.mockReset();
  mockedDeleteRolePolicy.mockReset();
  mockedPublish.mockReset();

  mockedGetItem.mockResolvedValue({});
  mockedDeleteItem.mockResolvedValue({});
  mockedPutItem.mockResolvedValue({});
  mockedDeleteRolePolicy.mockResolvedValue({});
  mockedPublish.mockResolvedValue({});
});

describe('runDailyReset (unit)', () => {
  it('removes the Model_Deny_Policy from every mapped role and clears Blocked_State for each prior-day pair', async () => {
    mockQueryForPairs([
      {
        team: 'teamA',
        model: 'modelX',
        roleArns: ['arn:aws:iam::123456789012:role/RoleA', 'arn:aws:iam::123456789012:role/RoleB'],
      },
    ]);

    await runDailyReset(baseOptions);

    expect(mockedDeleteRolePolicy).toHaveBeenCalledTimes(2);
    expect(mockedDeleteRolePolicy.mock.calls[0][0]).toMatchObject({ RoleName: 'RoleA' });
    expect(mockedDeleteRolePolicy.mock.calls[1][0]).toMatchObject({ RoleName: 'RoleB' });

    expect(mockedDeleteItem).toHaveBeenCalledTimes(1);
    expect(mockedDeleteItem.mock.calls[0][0]).toMatchObject({
      TableName: BLOCKED_STATE_TABLE,
      Key: { PK: 'TEAM#teamA', SK: 'MODEL#modelX' },
    });

    const auditCalls = mockedPutItem.mock.calls.filter((call) => call[0].TableName === AUDIT_LOG_TABLE);
    expect(auditCalls).toHaveLength(2);
    for (const call of auditCalls) {
      expect(call[0].Item).toMatchObject({ action: 'REMOVE_DENY', model: 'modelX' });
    }

    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const publishedMessage = JSON.parse(mockedPublish.mock.calls[0][0].Message);
    expect(publishedMessage).toMatchObject({ action: 'restored', team: 'teamA', model: 'modelX' });
  });

  it('queries both BLOCKED and PENDING_RESET status days for the previous Usage_Day', async () => {
    mockQueryForPairs([], []);

    await runDailyReset(baseOptions);

    const statusDayValues = mockedQuery.mock.calls
      .filter((call) => call[0].IndexName === 'StatusDayIndex')
      .map((call) => call[0].ExpressionAttributeValues[':statusDay']);

    expect(statusDayValues).toEqual(
      expect.arrayContaining(['BLOCKED#2025-01-15', 'PENDING_RESET#2025-01-15'])
    );
  });

  it('never uses a table Scan', async () => {
    mockQueryForPairs([
      { team: 'teamA', model: 'modelX', roleArns: ['arn:aws:iam::123456789012:role/RoleA'] },
    ]);

    await runDailyReset(baseOptions);

    for (const call of mockedQuery.mock.calls) {
      expect(call[0]).not.toHaveProperty('Scan');
    }
  });

  it('marks Blocked_State PENDING_RESET when a role removal fails, and does not publish a restored notification', async () => {
    mockQueryForPairs([
      { team: 'teamA', model: 'modelX', roleArns: ['arn:aws:iam::123456789012:role/RoleA'] },
    ]);
    mockedDeleteRolePolicy.mockRejectedValue(new Error('throttled'));

    await runDailyReset({ ...baseOptions, retryOptions: { maxAttempts: 1 } });

    expect(mockedDeleteItem).not.toHaveBeenCalled();
    expect(mockedPublish).not.toHaveBeenCalled();

    const blockedStateCalls = mockedPutItem.mock.calls.filter(
      (call) => call[0].TableName === BLOCKED_STATE_TABLE
    );
    expect(blockedStateCalls).toHaveLength(1);
    expect(blockedStateCalls[0][0].Item).toMatchObject({
      PK: 'TEAM#teamA',
      SK: 'MODEL#modelX',
      status: 'PENDING_RESET',
      statusDay: 'PENDING_RESET#2025-01-15',
    });

    const auditCalls = mockedPutItem.mock.calls.filter((call) => call[0].TableName === AUDIT_LOG_TABLE);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0][0].Item).toMatchObject({ action: 'REMOVE_DENY_FAILED' });
  });

  it('re-processes a PENDING_RESET pair on a subsequent invocation and clears it once the removal succeeds', async () => {
    mockQueryForPairs(
      [],
      [{ team: 'teamB', model: 'modelZ', roleArns: ['arn:aws:iam::123456789012:role/RoleD'] }]
    );

    await runDailyReset(baseOptions);

    expect(mockedDeleteRolePolicy).toHaveBeenCalledTimes(1);
    expect(mockedDeleteItem).toHaveBeenCalledTimes(1);
    expect(mockedDeleteItem.mock.calls[0][0]).toMatchObject({
      Key: { PK: 'TEAM#teamB', SK: 'MODEL#modelZ' },
    });
    expect(mockedPublish).toHaveBeenCalledTimes(1);
  });

  it('resets a pair found via PENDING_RESET even with no corresponding BLOCKED entry', async () => {
    mockQueryForPairs(
      [],
      [{ team: 'teamB', model: 'modelY', roleArns: ['arn:aws:iam::123456789012:role/RoleC'] }]
    );

    await runDailyReset(baseOptions);

    expect(mockedDeleteRolePolicy).toHaveBeenCalledTimes(1);
    expect(mockedDeleteItem).toHaveBeenCalledTimes(1);
    expect(mockedDeleteItem.mock.calls[0][0]).toMatchObject({
      Key: { PK: 'TEAM#teamB', SK: 'MODEL#modelY' },
    });
  });
});

describe('removeDenyPolicy (manual override)', () => {
  it('removes the Model_Deny_Policy from every mapped role, clears Blocked_State, writes Audit_Log entries, and publishes a restored notification', async () => {
    mockedGetItem.mockResolvedValue({
      Item: {
        PK: 'TEAM#teamA',
        SK: 'MODEL#modelX',
        blockedUsageDay: '2025-01-15',
        blockedAt: '2025-01-15T00:00:00.000Z',
        status: 'BLOCKED',
        statusDay: 'BLOCKED#2025-01-15',
      },
    });
    mockQueryForPairs([
      {
        team: 'teamA',
        model: 'modelX',
        roleArns: ['arn:aws:iam::123456789012:role/RoleA', 'arn:aws:iam::123456789012:role/RoleB'],
      },
    ]);

    await removeDenyPolicy('teamA', 'modelX', baseOptions);

    expect(mockedGetItem).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: BLOCKED_STATE_TABLE,
        Key: { PK: 'TEAM#teamA', SK: 'MODEL#modelX' },
      })
    );

    expect(mockedDeleteRolePolicy).toHaveBeenCalledTimes(2);
    expect(mockedDeleteRolePolicy.mock.calls[0][0]).toMatchObject({ RoleName: 'RoleA' });
    expect(mockedDeleteRolePolicy.mock.calls[1][0]).toMatchObject({ RoleName: 'RoleB' });

    expect(mockedDeleteItem).toHaveBeenCalledTimes(1);
    expect(mockedDeleteItem.mock.calls[0][0]).toMatchObject({
      TableName: BLOCKED_STATE_TABLE,
      Key: { PK: 'TEAM#teamA', SK: 'MODEL#modelX' },
    });

    const auditCalls = mockedPutItem.mock.calls.filter((call) => call[0].TableName === AUDIT_LOG_TABLE);
    expect(auditCalls).toHaveLength(2);
    for (const call of auditCalls) {
      expect(call[0].Item).toMatchObject({ action: 'REMOVE_DENY', model: 'modelX' });
      expect(call[0].Item.PK).toBe('TEAM#teamA');
    }

    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const publishedMessage = JSON.parse(mockedPublish.mock.calls[0][0].Message);
    expect(publishedMessage).toMatchObject({ action: 'restored', team: 'teamA', model: 'modelX' });
  });

  it('is independent of the schedule: does not query the StatusDayIndex GSI for a specific pair', async () => {
    mockedGetItem.mockResolvedValue({
      Item: {
        PK: 'TEAM#teamA',
        SK: 'MODEL#modelX',
        blockedUsageDay: '2025-01-15',
        blockedAt: '2025-01-15T00:00:00.000Z',
        status: 'BLOCKED',
        statusDay: 'BLOCKED#2025-01-15',
      },
    });
    mockQueryForPairs([
      { team: 'teamA', model: 'modelX', roleArns: ['arn:aws:iam::123456789012:role/RoleA'] },
    ]);

    await removeDenyPolicy('teamA', 'modelX', baseOptions);

    const statusDayQueries = mockedQuery.mock.calls.filter((call) => call[0].IndexName === 'StatusDayIndex');
    expect(statusDayQueries).toHaveLength(0);
  });

  it('marks the pair PENDING_RESET (preserving blockedUsageDay) when a role removal fails, and does not publish a restored notification', async () => {
    mockedGetItem.mockResolvedValue({
      Item: {
        PK: 'TEAM#teamA',
        SK: 'MODEL#modelX',
        blockedUsageDay: '2025-01-15',
        blockedAt: '2025-01-15T00:00:00.000Z',
        status: 'BLOCKED',
        statusDay: 'BLOCKED#2025-01-15',
      },
    });
    mockQueryForPairs([
      { team: 'teamA', model: 'modelX', roleArns: ['arn:aws:iam::123456789012:role/RoleA'] },
    ]);
    mockedDeleteRolePolicy.mockRejectedValue(new Error('throttled'));

    await removeDenyPolicy('teamA', 'modelX', { ...baseOptions, retryOptions: { maxAttempts: 1 } });

    expect(mockedDeleteItem).not.toHaveBeenCalled();
    expect(mockedPublish).not.toHaveBeenCalled();

    const blockedStateCalls = mockedPutItem.mock.calls.filter(
      (call) => call[0].TableName === BLOCKED_STATE_TABLE
    );
    expect(blockedStateCalls).toHaveLength(1);
    expect(blockedStateCalls[0][0].Item).toMatchObject({
      PK: 'TEAM#teamA',
      SK: 'MODEL#modelX',
      status: 'PENDING_RESET',
      statusDay: 'PENDING_RESET#2025-01-15',
    });

    const auditCalls = mockedPutItem.mock.calls.filter((call) => call[0].TableName === AUDIT_LOG_TABLE);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0][0].Item).toMatchObject({ action: 'REMOVE_DENY_FAILED' });
  });

  it("falls back to today's Usage_Day when no Blocked_State entry exists for the pair", async () => {
    mockedGetItem.mockResolvedValue({});
    mockQueryForPairs([
      { team: 'teamC', model: 'modelZ', roleArns: ['arn:aws:iam::123456789012:role/RoleE'] },
    ]);
    mockedDeleteRolePolicy.mockRejectedValue(new Error('throttled'));

    await removeDenyPolicy('teamC', 'modelZ', { ...baseOptions, retryOptions: { maxAttempts: 1 } });

    const blockedStateCalls = mockedPutItem.mock.calls.filter(
      (call) => call[0].TableName === BLOCKED_STATE_TABLE
    );
    expect(blockedStateCalls).toHaveLength(1);
    // baseOptions.now() is 2025-01-16T00:00:00Z, so today's Usage_Day is 2025-01-16.
    expect(blockedStateCalls[0][0].Item).toMatchObject({
      status: 'PENDING_RESET',
      statusDay: 'PENDING_RESET#2025-01-16',
      blockedUsageDay: '2025-01-16',
    });
  });

  it('behaves sanely for a Team/Model pair that was never blocked: clears a nonexistent Blocked_State entry without erroring', async () => {
    // No Blocked_State entry exists for this pair (e.g. an administrator
    // pre-emptively removing a stray policy that was never recorded as a
    // block), and the team still has a mapped role whose removal succeeds.
    mockedGetItem.mockResolvedValue({});
    mockQueryForPairs([
      { team: 'teamNeverBlocked', model: 'modelQ', roleArns: ['arn:aws:iam::123456789012:role/RoleF'] },
    ]);

    await expect(
      removeDenyPolicy('teamNeverBlocked', 'modelQ', baseOptions)
    ).resolves.toBeUndefined();

    expect(mockedDeleteRolePolicy).toHaveBeenCalledTimes(1);

    // Clearing Blocked_State for a pair with no existing entry is a
    // harmless no-op DeleteItem call, not an error.
    expect(mockedDeleteItem).toHaveBeenCalledTimes(1);
    expect(mockedDeleteItem.mock.calls[0][0]).toMatchObject({
      TableName: BLOCKED_STATE_TABLE,
      Key: { PK: 'TEAM#teamNeverBlocked', SK: 'MODEL#modelQ' },
    });

    expect(mockedPublish).toHaveBeenCalledTimes(1);
  });

  it('behaves sanely when the team has no mapped roles at all: no policy removal or audit entries, but still clears Blocked_State and publishes', async () => {
    mockedGetItem.mockResolvedValue({
      Item: {
        PK: 'TEAM#teamNoRoles',
        SK: 'MODEL#modelX',
        blockedUsageDay: '2025-01-15',
        blockedAt: '2025-01-15T00:00:00.000Z',
        status: 'BLOCKED',
        statusDay: 'BLOCKED#2025-01-15',
      },
    });
    // `listRolesForTeam` (via the TeamIndex GSI) resolves to an empty set
    // of mapped roles for this team.
    mockQueryForPairs([{ team: 'teamNoRoles', model: 'modelX', roleArns: [] }]);

    await removeDenyPolicy('teamNoRoles', 'modelX', baseOptions);

    expect(mockedDeleteRolePolicy).not.toHaveBeenCalled();

    const auditCalls = mockedPutItem.mock.calls.filter((call) => call[0].TableName === AUDIT_LOG_TABLE);
    expect(auditCalls).toHaveLength(0);

    expect(mockedDeleteItem).toHaveBeenCalledTimes(1);
    expect(mockedDeleteItem.mock.calls[0][0]).toMatchObject({
      TableName: BLOCKED_STATE_TABLE,
      Key: { PK: 'TEAM#teamNoRoles', SK: 'MODEL#modelX' },
    });

    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const publishedMessage = JSON.parse(mockedPublish.mock.calls[0][0].Message);
    expect(publishedMessage).toMatchObject({ action: 'restored', team: 'teamNoRoles', model: 'modelX' });
  });

  it('is idempotent: calling it a second time in a row after the block is already cleared behaves sanely with no errors', async () => {
    mockedGetItem.mockResolvedValueOnce({
      Item: {
        PK: 'TEAM#teamRepeat',
        SK: 'MODEL#modelX',
        blockedUsageDay: '2025-01-15',
        blockedAt: '2025-01-15T00:00:00.000Z',
        status: 'BLOCKED',
        statusDay: 'BLOCKED#2025-01-15',
      },
    });
    mockQueryForPairs([
      { team: 'teamRepeat', model: 'modelX', roleArns: ['arn:aws:iam::123456789012:role/RoleG'] },
    ]);

    await removeDenyPolicy('teamRepeat', 'modelX', baseOptions);

    expect(mockedDeleteRolePolicy).toHaveBeenCalledTimes(1);
    expect(mockedDeleteItem).toHaveBeenCalledTimes(1);
    expect(mockedPublish).toHaveBeenCalledTimes(1);

    // Second call: Blocked_State has already been cleared (GetItem now
    // returns nothing), but the deny policy attachment on IAM_Role is
    // itself idempotent (`iam:DeleteRolePolicy` on an already-removed
    // policy simply succeeds again in practice), so a repeated manual call
    // must not error and should still clear/publish sanely.
    mockedGetItem.mockResolvedValueOnce({});
    mockedDeleteRolePolicy.mockClear();
    mockedDeleteItem.mockClear();
    mockedPutItem.mockClear();
    mockedPublish.mockClear();

    await expect(removeDenyPolicy('teamRepeat', 'modelX', baseOptions)).resolves.toBeUndefined();

    expect(mockedDeleteRolePolicy).toHaveBeenCalledTimes(1);
    expect(mockedDeleteItem).toHaveBeenCalledTimes(1);
    expect(mockedPublish).toHaveBeenCalledTimes(1);
  });
});

const teamArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);
const modelArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);
const roleArnArb = fc
  .tuple(
    fc.stringOf(fc.constantFrom(...'0123456789'), { minLength: 12, maxLength: 12 }),
    fc.stringOf(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'), {
      minLength: 1,
      maxLength: 20,
    })
  )
  .map(([account, roleName]) => `arn:aws:iam::${account}:role/${roleName}`);

/**
 * A set of distinct (Team, Model) Blocked_State pairs. Since `listRolesForTeam`
 * resolves mapped roles purely by Team (not by Model), every pair sharing the
 * same Team must share the same set of mapped roles.
 */
const blockedPairsArb = fc
  .uniqueArray(teamArb, { minLength: 1, maxLength: 4 })
  .chain((teams) =>
    fc
      .tuple(...teams.map(() => fc.uniqueArray(roleArnArb, { minLength: 1, maxLength: 4 })))
      .chain((roleArnLists) => {
        const rolesByTeam = new Map(teams.map((team, i) => [team, roleArnLists[i]]));
        return fc
          .uniqueArray(
            fc.tuple(fc.constantFrom(...teams), modelArb).map(([team, model]) => ({ team, model })),
            { minLength: 0, maxLength: 5, selector: (pair) => `${pair.team}#${pair.model}` }
          )
          .map((pairs) => pairs.map((pair) => ({ ...pair, roleArns: rolesByTeam.get(pair.team)! })));
      })
  );

describe('runDailyReset - Property 18: Reset removes all prior-day blocks', () => {
  // Validates: Requirements 6.1
  it('removes the Model_Deny_Policy for every prior-day Blocked_State pair from every mapped role, and clears Blocked_State for each', async () => {
    await fc.assert(
      fc.asyncProperty(blockedPairsArb, async (pairs: BlockedPairFixture[]) => {
        mockedQuery.mockReset();
        mockedDeleteItem.mockReset();
        mockedPutItem.mockReset();
        mockedDeleteRolePolicy.mockReset();
        mockedPublish.mockReset();
        mockedDeleteItem.mockResolvedValue({});
        mockedPutItem.mockResolvedValue({});
        mockedDeleteRolePolicy.mockResolvedValue({});
        mockedPublish.mockResolvedValue({});

        mockQueryForPairs(pairs, []);

        await runDailyReset(baseOptions);

        const expectedDeleteCalls = pairs.reduce((sum, pair) => sum + pair.roleArns.length, 0);
        expect(mockedDeleteRolePolicy).toHaveBeenCalledTimes(expectedDeleteCalls);

        for (const pair of pairs) {
          for (const roleArn of pair.roleArns) {
            const roleName = roleArn.split('/').pop();
            expect(mockedDeleteRolePolicy.mock.calls).toEqual(
              expect.arrayContaining([[expect.objectContaining({ RoleName: roleName })]])
            );
          }

          expect(mockedDeleteItem.mock.calls).toEqual(
            expect.arrayContaining([
              [
                expect.objectContaining({
                  Key: { PK: `TEAM#${pair.team}`, SK: `MODEL#${pair.model}` },
                }),
              ],
            ])
          );
        }

        expect(mockedDeleteItem).toHaveBeenCalledTimes(pairs.length);
      })
    );
  });
});

describe('runDailyReset - Property 19: Reset retries until success without abandoning', () => {
  // Validates: Requirements 6.2
  it('keeps retrying a pending pair across repeated invocations, remaining PENDING_RESET rather than abandoned, until the removal eventually succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(
        teamArb,
        modelArb,
        roleArnArb,
        fc.integer({ min: 0, max: 8 }),
        async (team: string, model: string, roleArn: string, failureCount: number) => {
          mockedQuery.mockReset();
          mockedDeleteItem.mockReset();
          mockedPutItem.mockReset();
          mockedDeleteRolePolicy.mockReset();
          mockedPublish.mockReset();
          mockedDeleteItem.mockResolvedValue({});
          mockedPutItem.mockResolvedValue({});
          mockedPublish.mockResolvedValue({});

          // `iam:DeleteRolePolicy` fails `failureCount` times (a random
          // number of transient failures), then succeeds.
          let callsSoFar = 0;
          mockedDeleteRolePolicy.mockImplementation(async () => {
            callsSoFar += 1;
            if (callsSoFar <= failureCount) {
              throw new Error('throttled');
            }
            return {};
          });

          const pair: BlockedPairFixture = { team, model, roleArns: [roleArn] };
          // No retry-with-backoff budget within a single Daily_Reset
          // invocation's per-role attempt: each scheduled invocation makes
          // exactly one `DeleteRolePolicy` attempt, and it is Daily_Reset's
          // own re-invocation (not `retryWithBackoff`) that keeps retrying
          // the pair across invocations until it succeeds.
          const singleAttemptOptions: DailyResetOptions = {
            ...baseOptions,
            retryOptions: { maxAttempts: 1 },
          };

          let invocationCount = 0;
          const maxInvocations = failureCount + 5;

          // First invocation always finds the pair via BLOCKED#; every
          // subsequent invocation (if the pair is still not cleared) finds
          // it via PENDING_RESET# instead, simulating Daily_Reset being
          // re-invoked on a short follow-up schedule (design.md).
          let currentlyPending = false;
          let cleared = false;

          while (!cleared && invocationCount < maxInvocations) {
            invocationCount += 1;
            mockQueryForPairs(currentlyPending ? [] : [pair], currentlyPending ? [pair] : []);

            await runDailyReset(singleAttemptOptions);

            const deletedThisPair = mockedDeleteItem.mock.calls.some(
              (call) =>
                call[0].Key?.PK === `TEAM#${team}` && call[0].Key?.SK === `MODEL#${model}`
            );
            const markedPendingThisPair = mockedPutItem.mock.calls.some(
              (call) =>
                call[0].TableName === BLOCKED_STATE_TABLE &&
                call[0].Item?.PK === `TEAM#${team}` &&
                call[0].Item?.SK === `MODEL#${model}` &&
                call[0].Item?.status === 'PENDING_RESET'
            );

            if (deletedThisPair) {
              cleared = true;
            } else {
              // Must never be abandoned: every failed attempt re-marks the
              // pair PENDING_RESET so it is retried on the next invocation.
              expect(markedPendingThisPair).toBe(true);
              currentlyPending = true;
            }

            mockedDeleteItem.mockClear();
            mockedPutItem.mockClear();
          }

          expect(cleared).toBe(true);
          expect(callsSoFar).toBe(failureCount + 1);
        }
      ),
      { numRuns: 25 }
    );
  });
});
