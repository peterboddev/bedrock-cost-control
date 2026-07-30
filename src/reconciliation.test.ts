import { reconcileTeamRoleCache } from './reconciliation';
import * as iamClient from './clients/iamClient';
import * as dynamoDbClient from './clients/dynamoDbClient';

jest.mock('./clients/iamClient', () => ({
  listRoles: jest.fn(),
  getRole: jest.fn(),
  listRoleTags: jest.fn(),
}));

jest.mock('./clients/dynamoDbClient', () => ({
  getItem: jest.fn(),
  putItem: jest.fn(),
  query: jest.fn(),
}));

const mockedListRoles = iamClient.listRoles as jest.Mock;
const mockedGetRole = iamClient.getRole as jest.Mock;
const mockedListRoleTags = iamClient.listRoleTags as jest.Mock;
const mockedGetItem = dynamoDbClient.getItem as jest.Mock;
const mockedPutItem = dynamoDbClient.putItem as jest.Mock;

const TABLE_NAME = 'TeamRoleCache';
const TEAM_TAG_KEY = 'team';

describe('reconcileTeamRoleCache', () => {
  beforeEach(() => {
    mockedListRoles.mockReset();
    mockedGetRole.mockReset();
    mockedListRoleTags.mockReset();
    mockedGetItem.mockReset();
    mockedPutItem.mockReset();

    mockedGetRole.mockResolvedValue({});
    mockedGetItem.mockResolvedValue({ Item: undefined });
    mockedPutItem.mockResolvedValue({});
  });

  // Validates: Requirements 1.5
  it('paginates through all IAM roles following Marker/IsTruncated pagination', async () => {
    const roleOne = { Arn: 'arn:aws:iam::123456789012:role/RoleOne' };
    const roleTwo = { Arn: 'arn:aws:iam::123456789012:role/RoleTwo' };
    const roleThree = { Arn: 'arn:aws:iam::123456789012:role/RoleThree' };

    mockedListRoles
      .mockResolvedValueOnce({
        Roles: [roleOne],
        IsTruncated: true,
        Marker: 'page-2-marker',
      })
      .mockResolvedValueOnce({
        Roles: [roleTwo],
        IsTruncated: true,
        Marker: 'page-3-marker',
      })
      .mockResolvedValueOnce({
        Roles: [roleThree],
        IsTruncated: false,
      });

    mockedListRoleTags.mockResolvedValue({
      Tags: [{ Key: TEAM_TAG_KEY, Value: 'teamA' }],
    });

    const result = await reconcileTeamRoleCache({
      teamTagKey: TEAM_TAG_KEY,
      teamRoleCacheTableName: TABLE_NAME,
    });

    expect(mockedListRoles).toHaveBeenCalledTimes(3);
    expect(mockedListRoles.mock.calls[0][0]).toMatchObject({ Marker: undefined });
    expect(mockedListRoles.mock.calls[1][0]).toMatchObject({ Marker: 'page-2-marker' });
    expect(mockedListRoles.mock.calls[2][0]).toMatchObject({ Marker: 'page-3-marker' });

    expect(result.pageCount).toBe(3);
    expect(result.reconciledRoles.map((r) => r.roleArn)).toEqual([
      roleOne.Arn,
      roleTwo.Arn,
      roleThree.Arn,
    ]);
  });

  // Validates: Requirements 1.5
  it('calls resolveTeam (via IAM GetRole/ListRoleTags) for every role found and upserts the cache', async () => {
    const roleArn = 'arn:aws:iam::123456789012:role/MyRole';
    mockedListRoles.mockResolvedValueOnce({
      Roles: [{ Arn: roleArn }],
      IsTruncated: false,
    });
    mockedListRoleTags.mockResolvedValue({
      Tags: [{ Key: TEAM_TAG_KEY, Value: 'teamB' }],
    });

    const result = await reconcileTeamRoleCache({
      teamTagKey: TEAM_TAG_KEY,
      teamRoleCacheTableName: TABLE_NAME,
    });

    expect(mockedGetRole).toHaveBeenCalledWith({ RoleName: 'MyRole' });
    expect(mockedListRoleTags).toHaveBeenCalledWith({ RoleName: 'MyRole' });
    expect(mockedPutItem).toHaveBeenCalledTimes(1);
    expect(mockedPutItem.mock.calls[0][0]).toMatchObject({
      TableName: TABLE_NAME,
      Item: { PK: `ROLE#${roleArn}`, team: 'teamB' },
    });
    expect(result.reconciledRoles).toEqual([{ roleArn, team: 'teamB' }]);
  });

  // Validates: Requirements 1.5
  it('re-resolves via IAM even when a fresh, non-expired cache entry already exists (forceRefresh)', async () => {
    const roleArn = 'arn:aws:iam::123456789012:role/MyRole';
    const now = new Date('2025-01-15T12:00:00.000Z');
    mockedListRoles.mockResolvedValueOnce({
      Roles: [{ Arn: roleArn }],
      IsTruncated: false,
    });
    mockedGetItem.mockResolvedValue({
      Item: {
        PK: `ROLE#${roleArn}`,
        team: 'staleTeam',
        cachedAt: '2025-01-15T11:59:00.000Z',
        ttl: Math.floor(now.getTime() / 1000) + 600,
      },
    });
    mockedListRoleTags.mockResolvedValue({
      Tags: [{ Key: TEAM_TAG_KEY, Value: 'freshTeam' }],
    });

    const result = await reconcileTeamRoleCache({
      teamTagKey: TEAM_TAG_KEY,
      teamRoleCacheTableName: TABLE_NAME,
      now: () => now,
    });

    expect(mockedGetRole).toHaveBeenCalledTimes(1);
    expect(mockedListRoleTags).toHaveBeenCalledTimes(1);
    expect(result.reconciledRoles).toEqual([{ roleArn, team: 'freshTeam' }]);
  });

  // Validates: Requirements 1.5
  it('never uses a DynamoDB Scan (only GetItem/PutItem via resolveTeam)', async () => {
    const roleArn = 'arn:aws:iam::123456789012:role/MyRole';
    mockedListRoles.mockResolvedValueOnce({
      Roles: [{ Arn: roleArn }],
      IsTruncated: false,
    });
    mockedListRoleTags.mockResolvedValue({
      Tags: [{ Key: TEAM_TAG_KEY, Value: 'teamC' }],
    });

    await reconcileTeamRoleCache({
      teamTagKey: TEAM_TAG_KEY,
      teamRoleCacheTableName: TABLE_NAME,
    });

    expect((dynamoDbClient as Record<string, unknown>).scan).toBeUndefined();
    expect(mockedGetItem).toHaveBeenCalled();
    expect(mockedPutItem).toHaveBeenCalled();
  });

  it('skips roles missing an Arn without throwing', async () => {
    mockedListRoles.mockResolvedValueOnce({
      Roles: [{ RoleName: 'NoArnRole' }],
      IsTruncated: false,
    });

    const result = await reconcileTeamRoleCache({
      teamTagKey: TEAM_TAG_KEY,
      teamRoleCacheTableName: TABLE_NAME,
    });

    expect(result.reconciledRoles).toEqual([]);
    expect(mockedGetRole).not.toHaveBeenCalled();
  });

  it('returns an empty result when IAM has no roles at all', async () => {
    mockedListRoles.mockResolvedValueOnce({
      Roles: [],
      IsTruncated: false,
    });

    const result = await reconcileTeamRoleCache({
      teamTagKey: TEAM_TAG_KEY,
      teamRoleCacheTableName: TABLE_NAME,
    });

    expect(result.reconciledRoles).toEqual([]);
    expect(result.pageCount).toBe(1);
  });

  it('forwards an optional pathPrefix to iam:ListRoles', async () => {
    mockedListRoles.mockResolvedValueOnce({
      Roles: [],
      IsTruncated: false,
    });

    await reconcileTeamRoleCache({
      teamTagKey: TEAM_TAG_KEY,
      teamRoleCacheTableName: TABLE_NAME,
      pathPrefix: '/service-role/',
    });

    expect(mockedListRoles.mock.calls[0][0]).toMatchObject({ PathPrefix: '/service-role/' });
  });
});
