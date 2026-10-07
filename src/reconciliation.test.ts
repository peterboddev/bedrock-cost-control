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
  deleteItem: jest.fn(),
  query: jest.fn(),
}));

const mockedListRoles = iamClient.listRoles as jest.Mock;
const mockedGetRole = iamClient.getRole as jest.Mock;
const mockedListRoleTags = iamClient.listRoleTags as jest.Mock;
const mockedGetItem = dynamoDbClient.getItem as jest.Mock;
const mockedPutItem = dynamoDbClient.putItem as jest.Mock;
const mockedDeleteItem = dynamoDbClient.deleteItem as jest.Mock;

const TABLE_NAME = 'TeamRoleCache';
const TEAM_TAG_KEY = 'team';

describe('reconcileTeamRoleCache', () => {
  beforeEach(() => {
    mockedListRoles.mockReset();
    mockedGetRole.mockReset();
    mockedListRoleTags.mockReset();
    mockedGetItem.mockReset();
    mockedPutItem.mockReset();
    mockedDeleteItem.mockReset();

    mockedGetRole.mockResolvedValue({});
    mockedGetItem.mockResolvedValue({ Item: undefined });
    mockedPutItem.mockResolvedValue({});
    mockedDeleteItem.mockResolvedValue({});
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
  it('reads tags straight from IAM and upserts, regardless of any existing cache entry (no cache read)', async () => {
    const roleArn = 'arn:aws:iam::123456789012:role/MyRole';
    const now = new Date('2025-01-15T12:00:00.000Z');
    mockedListRoles.mockResolvedValueOnce({
      Roles: [{ Arn: roleArn }],
      IsTruncated: false,
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
    // The sweep upserts straight from IAM — it never READS the cache first.
    expect(mockedGetItem).not.toHaveBeenCalled();
    expect(mockedPutItem.mock.calls[0][0]).toMatchObject({
      Item: { PK: `ROLE#${roleArn}`, team: 'freshTeam' },
    });
    expect(result.reconciledRoles).toEqual([{ roleArn, team: 'freshTeam' }]);
  });

  // Validates: Requirements 1.5
  it('DELETES the cache row (does not cache UNMAPPED) for a role with no team tag, and excludes it from reconciledRoles', async () => {
    const taggedArn = 'arn:aws:iam::123456789012:role/Tagged';
    const untaggedArn = 'arn:aws:iam::123456789012:role/Untagged';
    mockedListRoles.mockResolvedValueOnce({
      Roles: [{ Arn: taggedArn }, { Arn: untaggedArn }],
      IsTruncated: false,
    });
    mockedListRoleTags.mockImplementation(({ RoleName }: { RoleName: string }) =>
      RoleName === 'Tagged'
        ? Promise.resolve({ Tags: [{ Key: TEAM_TAG_KEY, Value: 'teamX' }] })
        : Promise.resolve({ Tags: [] })
    );

    const result = await reconcileTeamRoleCache({
      teamTagKey: TEAM_TAG_KEY,
      teamRoleCacheTableName: TABLE_NAME,
    });

    // Tagged role upserted; untagged role's row deleted (drift correction), not cached as UNMAPPED.
    expect(mockedPutItem).toHaveBeenCalledTimes(1);
    expect(mockedPutItem.mock.calls[0][0]).toMatchObject({
      Item: { PK: `ROLE#${taggedArn}`, team: 'teamX' },
    });
    expect(mockedDeleteItem).toHaveBeenCalledTimes(1);
    expect(mockedDeleteItem.mock.calls[0][0]).toMatchObject({
      Key: { PK: `ROLE#${untaggedArn}` },
    });
    // Only the genuinely mapped role is reported.
    expect(result.reconciledRoles).toEqual([{ roleArn: taggedArn, team: 'teamX' }]);
  });

  // Validates: Requirements 1.5
  it('never uses a DynamoDB Scan', async () => {
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

  it('stops early and returns nextMarker when maxPages is reached with more pages remaining', async () => {
    const roleA = { Arn: 'arn:aws:iam::123456789012:role/A' };
    const roleB = { Arn: 'arn:aws:iam::123456789012:role/B' };
    // Page 1 (truncated) then page 2 (truncated) — but maxPages=1 stops after page 1.
    mockedListRoles.mockResolvedValueOnce({ Roles: [roleA], IsTruncated: true, Marker: 'after-page-1' });
    mockedGetItem.mockResolvedValue({});
    mockedGetRole.mockResolvedValue({});
    mockedListRoleTags.mockResolvedValue({ Tags: [{ Key: TEAM_TAG_KEY, Value: 'teamA' }] });

    const result = await reconcileTeamRoleCache({
      teamTagKey: TEAM_TAG_KEY,
      teamRoleCacheTableName: TABLE_NAME,
      maxPages: 1,
    });

    expect(result.complete).toBe(false);
    expect(result.nextMarker).toBe('after-page-1');
    expect(result.pageCount).toBe(1);
    expect(result.reconciledRoles.map((r) => r.roleArn)).toEqual([roleA.Arn]);
    // Only one ListRoles call happened — the second page was NOT fetched.
    expect(mockedListRoles).toHaveBeenCalledTimes(1);
    void roleB;
  });

  it('resumes from a provided startMarker', async () => {
    mockedListRoles.mockResolvedValueOnce({ Roles: [], IsTruncated: false });

    const result = await reconcileTeamRoleCache({
      teamTagKey: TEAM_TAG_KEY,
      teamRoleCacheTableName: TABLE_NAME,
      startMarker: 'resume-here',
    });

    expect(mockedListRoles.mock.calls[0][0]).toMatchObject({ Marker: 'resume-here' });
    expect(result.complete).toBe(true);
    expect(result.nextMarker).toBeUndefined();
  });

  it('marks complete=true when pagination exhausts within maxPages', async () => {
    mockedListRoles.mockResolvedValueOnce({ Roles: [], IsTruncated: false });

    const result = await reconcileTeamRoleCache({
      teamTagKey: TEAM_TAG_KEY,
      teamRoleCacheTableName: TABLE_NAME,
      maxPages: 5,
    });

    expect(result.complete).toBe(true);
    expect(result.nextMarker).toBeUndefined();
  });
});
