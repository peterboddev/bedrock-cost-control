import { cacheRoleTeam } from './teamRoleCache';
import * as dynamoDbClient from './clients/dynamoDbClient';

jest.mock('./clients/dynamoDbClient', () => ({
  getItem: jest.fn(),
  putItem: jest.fn(),
  query: jest.fn(),
}));

const mockedPutItem = dynamoDbClient.putItem as jest.Mock;

beforeEach(() => mockedPutItem.mockReset());

describe('cacheRoleTeam', () => {
  it('upserts a ROLE#<arn> -> team entry with a future TTL (no IAM call)', async () => {
    mockedPutItem.mockResolvedValue({});
    const now = new Date('2025-01-15T12:00:00.000Z');

    await cacheRoleTeam('arn:aws:iam::123456789012:role/R', 'teamA', {
      tableName: 'TeamRoleCache',
      now: () => now,
    });

    expect(mockedPutItem).toHaveBeenCalledTimes(1);
    const arg = mockedPutItem.mock.calls[0][0];
    expect(arg.TableName).toBe('TeamRoleCache');
    expect(arg.Item.PK).toBe('ROLE#arn:aws:iam::123456789012:role/R');
    expect(arg.Item.team).toBe('teamA');
    // Default 15-minute TTL ahead of now.
    expect(arg.Item.ttl).toBe(Math.floor(now.getTime() / 1000) + 15 * 60);
  });
});
