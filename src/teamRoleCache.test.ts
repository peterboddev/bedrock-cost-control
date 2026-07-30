import * as fc from 'fast-check';
import { listRolesForTeam, resolveTeam } from './teamRoleCache';
import * as dynamoDbClient from './clients/dynamoDbClient';
import * as iamClient from './clients/iamClient';
import { UNMAPPED_ROLE } from './types';

jest.mock('./clients/dynamoDbClient', () => ({
  getItem: jest.fn(),
  putItem: jest.fn(),
  query: jest.fn(),
}));

jest.mock('./clients/iamClient', () => ({
  getRole: jest.fn(),
  listRoleTags: jest.fn(),
}));

const mockedGetItem = dynamoDbClient.getItem as jest.Mock;
const mockedPutItem = dynamoDbClient.putItem as jest.Mock;
const mockedQuery = dynamoDbClient.query as jest.Mock;
const mockedGetRole = iamClient.getRole as jest.Mock;
const mockedListRoleTags = iamClient.listRoleTags as jest.Mock;

const ROLE_ARN = 'arn:aws:iam::123456789012:role/MyRole';
const TABLE_NAME = 'TeamRoleCache';
const TEAM_TAG_KEY = 'team';

const accountIdArb = () =>
  fc.stringOf(fc.constantFrom(...'0123456789'), { minLength: 12, maxLength: 12 });

const iamNameSegmentArb = () =>
  fc.stringOf(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+=,.@_-'),
    { minLength: 1, maxLength: 30 },
  );

const roleArnArb = () =>
  fc
    .tuple(accountIdArb(), iamNameSegmentArb())
    .map(([account, roleName]) => `arn:aws:iam::${account}:role/${roleName}`);

const tagKeyArb = () =>
  fc.stringOf(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-.:/@'),
    { minLength: 1, maxLength: 20 },
  );

const tagValueArb = () => fc.string({ minLength: 0, maxLength: 40 });

describe('resolveTeam - Property 1: Team tag resolution', () => {
  beforeEach(() => {
    mockedGetItem.mockReset();
    mockedPutItem.mockReset();
    mockedGetRole.mockReset();
    mockedListRoleTags.mockReset();

    mockedPutItem.mockResolvedValue({});
    mockedGetRole.mockResolvedValue({});
  });

  // Validates: Requirements 1.2
  it('returns exactly the Team_Tag_Key tag value for any role and tag set containing it', async () => {
    await fc.assert(
      fc.asyncProperty(
        roleArnArb(),
        tagKeyArb(),
        tagValueArb(),
        fc.array(fc.tuple(tagKeyArb(), tagValueArb()), { maxLength: 5 }),
        async (roleArn, teamTagKey, teamValue, otherTagPairs) => {
          const otherTags = otherTagPairs
            .filter(([key]) => key !== teamTagKey)
            .map(([key, value]) => ({ Key: key, Value: value }));

          mockedGetItem.mockReset();
          mockedPutItem.mockReset();
          mockedGetRole.mockReset();
          mockedListRoleTags.mockReset();
          mockedPutItem.mockResolvedValue({});
          mockedGetRole.mockResolvedValue({});

          mockedGetItem.mockResolvedValue({ Item: undefined });
          mockedListRoleTags.mockResolvedValue({
            Tags: [...otherTags, { Key: teamTagKey, Value: teamValue }],
          });

          const result = await resolveTeam(roleArn, {
            teamTagKey,
            tableName: TABLE_NAME,
            now: () => new Date('2025-01-15T12:00:00.000Z'),
          });

          expect(result).toBe(teamValue);
        },
      ),
    );
  });
});

describe('resolveTeam', () => {
  beforeEach(() => {
    mockedGetItem.mockReset();
    mockedPutItem.mockReset();
    mockedGetRole.mockReset();
    mockedListRoleTags.mockReset();

    mockedPutItem.mockResolvedValue({});
    mockedGetRole.mockResolvedValue({});
  });

  it('returns the cached team on a fresh cache hit without calling IAM', async () => {
    const now = new Date('2025-01-15T12:00:00.000Z');
    mockedGetItem.mockResolvedValue({
      Item: {
        PK: `ROLE#${ROLE_ARN}`,
        team: 'teamA',
        cachedAt: '2025-01-15T11:55:00.000Z',
        ttl: Math.floor(now.getTime() / 1000) + 60,
      },
    });

    const result = await resolveTeam(ROLE_ARN, {
      teamTagKey: TEAM_TAG_KEY,
      tableName: TABLE_NAME,
      now: () => now,
    });

    expect(result).toBe('teamA');
    expect(mockedGetItem).toHaveBeenCalledTimes(1);
    expect(mockedGetItem.mock.calls[0][0]).toMatchObject({
      TableName: TABLE_NAME,
      Key: { PK: `ROLE#${ROLE_ARN}` },
    });
    expect(mockedGetRole).not.toHaveBeenCalled();
    expect(mockedListRoleTags).not.toHaveBeenCalled();
    expect(mockedPutItem).not.toHaveBeenCalled();
  });

  it('falls back to IAM and caches the result on a cache miss', async () => {
    const now = new Date('2025-01-15T12:00:00.000Z');
    mockedGetItem.mockResolvedValue({ Item: undefined });
    mockedListRoleTags.mockResolvedValue({
      Tags: [
        { Key: 'other', Value: 'ignored' },
        { Key: TEAM_TAG_KEY, Value: 'teamB' },
      ],
    });

    const result = await resolveTeam(ROLE_ARN, {
      teamTagKey: TEAM_TAG_KEY,
      tableName: TABLE_NAME,
      now: () => now,
    });

    expect(result).toBe('teamB');
    expect(mockedGetRole).toHaveBeenCalledWith({ RoleName: 'MyRole' });
    expect(mockedListRoleTags).toHaveBeenCalledWith({ RoleName: 'MyRole' });

    expect(mockedPutItem).toHaveBeenCalledTimes(1);
    const putCall = mockedPutItem.mock.calls[0][0];
    expect(putCall.TableName).toBe(TABLE_NAME);
    expect(putCall.Item).toMatchObject({
      PK: `ROLE#${ROLE_ARN}`,
      team: 'teamB',
    });
    expect(putCall.Item.ttl).toBeGreaterThan(Math.floor(now.getTime() / 1000));
  });

  it('falls back to IAM and re-resolves when the cached entry has expired', async () => {
    const now = new Date('2025-01-15T12:00:00.000Z');
    const expiredTtl = Math.floor(now.getTime() / 1000) - 60;
    mockedGetItem.mockResolvedValue({
      Item: {
        PK: `ROLE#${ROLE_ARN}`,
        team: 'staleTeam',
        cachedAt: '2025-01-15T10:00:00.000Z',
        ttl: expiredTtl,
      },
    });
    mockedListRoleTags.mockResolvedValue({
      Tags: [{ Key: TEAM_TAG_KEY, Value: 'freshTeam' }],
    });

    const result = await resolveTeam(ROLE_ARN, {
      teamTagKey: TEAM_TAG_KEY,
      tableName: TABLE_NAME,
      now: () => now,
    });

    expect(result).toBe('freshTeam');
    expect(mockedGetRole).toHaveBeenCalledTimes(1);
    expect(mockedListRoleTags).toHaveBeenCalledTimes(1);
    expect(mockedPutItem).toHaveBeenCalledTimes(1);
  });

  it('classifies a role with no matching Team_Tag_Key tag as Unmapped_Role', async () => {
    const now = new Date('2025-01-15T12:00:00.000Z');
    mockedGetItem.mockResolvedValue({ Item: undefined });
    mockedListRoleTags.mockResolvedValue({
      Tags: [{ Key: 'unrelated', Value: 'x' }],
    });

    const result = await resolveTeam(ROLE_ARN, {
      teamTagKey: TEAM_TAG_KEY,
      tableName: TABLE_NAME,
      now: () => now,
    });

    expect(result).toBe(UNMAPPED_ROLE);
    const putCall = mockedPutItem.mock.calls[0][0];
    expect(putCall.Item.team).toBe(UNMAPPED_ROLE);
  });

  it('classifies a role with no tags at all as Unmapped_Role', async () => {
    const now = new Date('2025-01-15T12:00:00.000Z');
    mockedGetItem.mockResolvedValue({ Item: undefined });
    mockedListRoleTags.mockResolvedValue({ Tags: [] });

    const result = await resolveTeam(ROLE_ARN, {
      teamTagKey: TEAM_TAG_KEY,
      tableName: TABLE_NAME,
      now: () => now,
    });

    expect(result).toBe(UNMAPPED_ROLE);
  });

  it('uses the configured Team_Tag_Key rather than a hardcoded key', async () => {
    const now = new Date('2025-01-15T12:00:00.000Z');
    mockedGetItem.mockResolvedValue({ Item: undefined });
    mockedListRoleTags.mockResolvedValue({
      Tags: [{ Key: 'costCenter', Value: 'teamC' }],
    });

    const result = await resolveTeam(ROLE_ARN, {
      teamTagKey: 'costCenter',
      tableName: TABLE_NAME,
      now: () => now,
    });

    expect(result).toBe('teamC');
  });

  it('respects a custom cacheTtlSeconds when writing the fresh cache entry', async () => {
    const now = new Date('2025-01-15T12:00:00.000Z');
    mockedGetItem.mockResolvedValue({ Item: undefined });
    mockedListRoleTags.mockResolvedValue({
      Tags: [{ Key: TEAM_TAG_KEY, Value: 'teamD' }],
    });

    await resolveTeam(ROLE_ARN, {
      teamTagKey: TEAM_TAG_KEY,
      tableName: TABLE_NAME,
      cacheTtlSeconds: 300,
      now: () => now,
    });

    const putCall = mockedPutItem.mock.calls[0][0];
    expect(putCall.Item.ttl).toBe(Math.floor(now.getTime() / 1000) + 300);
  });

  it('extracts the role name from an ARN with a path component', async () => {
    const roleArnWithPath = 'arn:aws:iam::123456789012:role/path/to/MyRole';
    const now = new Date('2025-01-15T12:00:00.000Z');
    mockedGetItem.mockResolvedValue({ Item: undefined });
    mockedListRoleTags.mockResolvedValue({
      Tags: [{ Key: TEAM_TAG_KEY, Value: 'teamE' }],
    });

    await resolveTeam(roleArnWithPath, {
      teamTagKey: TEAM_TAG_KEY,
      tableName: TABLE_NAME,
      now: () => now,
    });

    expect(mockedGetRole).toHaveBeenCalledWith({ RoleName: 'MyRole' });
    expect(mockedListRoleTags).toHaveBeenCalledWith({ RoleName: 'MyRole' });
  });
});

describe('resolveTeam - Team_Tag_Key configuration', () => {
  beforeEach(() => {
    mockedGetItem.mockReset();
    mockedPutItem.mockReset();
    mockedGetRole.mockReset();
    mockedListRoleTags.mockReset();

    mockedPutItem.mockResolvedValue({});
    mockedGetRole.mockResolvedValue({});
  });

  // Validates: Requirements 1.1
  it('uses whatever Team_Tag_Key is configured, not a hardcoded key name', async () => {
    const now = new Date('2025-01-15T12:00:00.000Z');
    mockedGetItem.mockResolvedValue({ Item: undefined });
    mockedListRoleTags.mockResolvedValue({
      Tags: [
        { Key: 'team', Value: 'wrongIfHardcoded' },
        { Key: 'department-owner', Value: 'correctTeam' },
      ],
    });

    const result = await resolveTeam(ROLE_ARN, {
      teamTagKey: 'department-owner',
      tableName: TABLE_NAME,
      now: () => now,
    });

    expect(result).toBe('correctTeam');
  });

  // Validates: Requirements 1.1
  it('classifies as Unmapped_Role when only a different tag key matches the default "team" convention', async () => {
    const now = new Date('2025-01-15T12:00:00.000Z');
    mockedGetItem.mockResolvedValue({ Item: undefined });
    mockedListRoleTags.mockResolvedValue({
      Tags: [{ Key: 'team', Value: 'shouldNotBeUsed' }],
    });

    const result = await resolveTeam(ROLE_ARN, {
      teamTagKey: 'owning-team',
      tableName: TABLE_NAME,
      now: () => now,
    });

    expect(result).toBe(UNMAPPED_ROLE);
  });
});

describe('resolveTeam - IAM throttle/failure fallback', () => {
  beforeEach(() => {
    mockedGetItem.mockReset();
    mockedPutItem.mockReset();
    mockedGetRole.mockReset();
    mockedListRoleTags.mockReset();

    mockedPutItem.mockResolvedValue({});
  });

  const noRetryDelay = { sleep: async () => {} };

  // Validates: Requirements 1.1
  it('falls back to the last-known cached value (even if expired) when IAM retries are exhausted', async () => {
    const now = new Date('2025-01-15T12:00:00.000Z');
    const expiredTtl = Math.floor(now.getTime() / 1000) - 60;
    mockedGetItem.mockResolvedValue({
      Item: {
        PK: `ROLE#${ROLE_ARN}`,
        team: 'lastKnownTeam',
        cachedAt: '2025-01-15T10:00:00.000Z',
        ttl: expiredTtl,
      },
    });
    mockedGetRole.mockRejectedValue(new Error('Throttling: Rate exceeded'));

    const result = await resolveTeam(ROLE_ARN, {
      teamTagKey: TEAM_TAG_KEY,
      tableName: TABLE_NAME,
      now: () => now,
      retryOptions: { maxAttempts: 3, ...noRetryDelay },
    });

    expect(result).toBe('lastKnownTeam');
    expect(mockedGetRole).toHaveBeenCalledTimes(3);
    expect(mockedPutItem).not.toHaveBeenCalled();
  });

  // Validates: Requirements 1.1
  it('falls back to Unmapped_Role when IAM retries are exhausted and there is no cached value at all', async () => {
    const now = new Date('2025-01-15T12:00:00.000Z');
    mockedGetItem.mockResolvedValue({ Item: undefined });
    mockedGetRole.mockRejectedValue(new Error('Throttling: Rate exceeded'));

    const result = await resolveTeam(ROLE_ARN, {
      teamTagKey: TEAM_TAG_KEY,
      tableName: TABLE_NAME,
      now: () => now,
      retryOptions: { maxAttempts: 3, ...noRetryDelay },
    });

    expect(result).toBe(UNMAPPED_ROLE);
    expect(mockedGetRole).toHaveBeenCalledTimes(3);
    expect(mockedPutItem).not.toHaveBeenCalled();
  });

  it('succeeds without falling back when IAM fails transiently but recovers within the retry budget', async () => {
    const now = new Date('2025-01-15T12:00:00.000Z');
    mockedGetItem.mockResolvedValue({ Item: undefined });
    mockedGetRole
      .mockRejectedValueOnce(new Error('Throttling: Rate exceeded'))
      .mockResolvedValueOnce({});
    mockedListRoleTags.mockResolvedValue({
      Tags: [{ Key: TEAM_TAG_KEY, Value: 'recoveredTeam' }],
    });

    const result = await resolveTeam(ROLE_ARN, {
      teamTagKey: TEAM_TAG_KEY,
      tableName: TABLE_NAME,
      now: () => now,
      retryOptions: { maxAttempts: 3, ...noRetryDelay },
    });

    expect(result).toBe('recoveredTeam');
    expect(mockedGetRole).toHaveBeenCalledTimes(2);
    expect(mockedPutItem).toHaveBeenCalledTimes(1);
  });
});

describe('listRolesForTeam - Property 3: Listing roles for a team is exact', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
  });

  // Validates: Requirements 1.5
  it('returns exactly the roles whose team attribute equals the queried team', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(roleArnArb(), { minLength: 0, maxLength: 15 }),
        fc.array(fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }), {
          minLength: 0,
          maxLength: 15,
        }),
        tagValueArb(),
        async (roleArns, teamAssignmentsRaw, queriedTeam) => {
          mockedQuery.mockReset();

          const teamAssignments = roleArns.map(
            (_, index) => teamAssignmentsRaw[index] ?? undefined
          );

          const allRoles = roleArns.map((roleArn, index) => ({
            PK: `ROLE#${roleArn}`,
            team: teamAssignments[index],
          }));

          const expectedRoleArns = allRoles
            .filter((role) => role.team === queriedTeam)
            .map((role) => role.PK.slice('ROLE#'.length));

          mockedQuery.mockImplementation(async (input: any) => {
            const matching = allRoles.filter(
              (role) => role.team === input.ExpressionAttributeValues[':team']
            );
            return { Items: matching };
          });

          const result = await listRolesForTeam(queriedTeam, { tableName: TABLE_NAME });

          expect(new Set(result)).toEqual(new Set(expectedRoleArns));
          expect(result.length).toBe(expectedRoleArns.length);
        },
      ),
    );
  });
});

describe('listRolesForTeam', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
  });

  it('queries the TeamIndex GSI with the team as the key condition, not a Scan', async () => {
    mockedQuery.mockResolvedValue({
      Items: [{ PK: `ROLE#${ROLE_ARN}`, team: 'teamA' }],
    });

    const result = await listRolesForTeam('teamA', { tableName: TABLE_NAME });

    expect(result).toEqual([ROLE_ARN]);
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const queryCall = mockedQuery.mock.calls[0][0];
    expect(queryCall.TableName).toBe(TABLE_NAME);
    expect(queryCall.IndexName).toBe('TeamIndex');
    expect(queryCall.KeyConditionExpression).toBe('#team = :team');
    expect(queryCall.ExpressionAttributeValues).toEqual({ ':team': 'teamA' });
  });

  it('returns an empty array when no roles are mapped to the team', async () => {
    mockedQuery.mockResolvedValue({ Items: [] });

    const result = await listRolesForTeam('teamWithNoRoles', { tableName: TABLE_NAME });

    expect(result).toEqual([]);
  });

  it('strips the ROLE# prefix from every returned partition key', async () => {
    const roleArnTwo = 'arn:aws:iam::123456789012:role/OtherRole';
    mockedQuery.mockResolvedValue({
      Items: [
        { PK: `ROLE#${ROLE_ARN}`, team: 'teamA' },
        { PK: `ROLE#${roleArnTwo}`, team: 'teamA' },
      ],
    });

    const result = await listRolesForTeam('teamA', { tableName: TABLE_NAME });

    expect(result).toEqual([ROLE_ARN, roleArnTwo]);
  });

  it('follows pagination via LastEvaluatedKey and aggregates results across pages', async () => {
    const roleArnTwo = 'arn:aws:iam::123456789012:role/OtherRole';
    mockedQuery
      .mockResolvedValueOnce({
        Items: [{ PK: `ROLE#${ROLE_ARN}`, team: 'teamA' }],
        LastEvaluatedKey: { PK: `ROLE#${ROLE_ARN}`, team: 'teamA' },
      })
      .mockResolvedValueOnce({
        Items: [{ PK: `ROLE#${roleArnTwo}`, team: 'teamA' }],
      });

    const result = await listRolesForTeam('teamA', { tableName: TABLE_NAME });

    expect(result).toEqual([ROLE_ARN, roleArnTwo]);
    expect(mockedQuery).toHaveBeenCalledTimes(2);
    expect(mockedQuery.mock.calls[1][0].ExclusiveStartKey).toEqual({
      PK: `ROLE#${ROLE_ARN}`,
      team: 'teamA',
    });
  });
});
