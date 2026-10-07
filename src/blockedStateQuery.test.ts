import { listAllActiveBlocks, listBlockedStatesByStatus } from './blockedStateQuery';
import * as dynamoDbClient from './clients/dynamoDbClient';
import { Endpoint } from './pricing/types';

jest.mock('./clients/dynamoDbClient', () => ({ query: jest.fn() }));
const mockedQuery = dynamoDbClient.query as jest.Mock;

beforeEach(() => mockedQuery.mockReset());

describe('listBlockedStatesByStatus', () => {
  it('queries the StatusIndex and flattens items', async () => {
    mockedQuery.mockResolvedValueOnce({
      Items: [
        { PK: 'TEAM#teamA', SK: 'MODEL#openai.gpt-6-sol', status: 'BLOCKED', blockedUsageDay: '2025-01-15', blockedAt: '2025-01-15T10:00:00.000Z', endpoint: 'bedrock-mantle' },
        { PK: 'TEAM#teamB', SK: 'MODEL#anthropic.claude', status: 'BLOCKED', blockedUsageDay: '2025-01-15', blockedAt: '2025-01-15T11:00:00.000Z' },
      ],
    });

    const blocks = await listBlockedStatesByStatus('BLOCKED', { tableName: 'BlockedState' });

    expect(mockedQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'BlockedState',
        IndexName: 'StatusIndex',
        ExpressionAttributeValues: { ':status': 'BLOCKED' },
      })
    );
    expect(blocks[0]).toEqual({
      team: 'teamA', model: 'openai.gpt-6-sol', status: 'BLOCKED',
      blockedUsageDay: '2025-01-15', blockedAt: '2025-01-15T10:00:00.000Z', endpoint: Endpoint.BedrockMantle,
    });
    // Missing endpoint defaults to bedrock-runtime.
    expect(blocks[1].endpoint).toBe(Endpoint.BedrockRuntime);
  });

  it('paginates until LastEvaluatedKey is exhausted', async () => {
    mockedQuery
      .mockResolvedValueOnce({ Items: [{ PK: 'TEAM#t', SK: 'MODEL#m', status: 'BLOCKED', blockedUsageDay: 'd', blockedAt: 'a' }], LastEvaluatedKey: { k: 1 } })
      .mockResolvedValueOnce({ Items: [{ PK: 'TEAM#t2', SK: 'MODEL#m2', status: 'BLOCKED', blockedUsageDay: 'd', blockedAt: 'a' }] });
    const blocks = await listBlockedStatesByStatus('BLOCKED', { tableName: 'BlockedState' });
    expect(blocks).toHaveLength(2);
    expect(mockedQuery).toHaveBeenCalledTimes(2);
  });
});

describe('listAllActiveBlocks', () => {
  it('combines BLOCKED and PENDING_RESET', async () => {
    mockedQuery
      .mockResolvedValueOnce({ Items: [{ PK: 'TEAM#a', SK: 'MODEL#m', status: 'BLOCKED', blockedUsageDay: 'd', blockedAt: 'a' }] })
      .mockResolvedValueOnce({ Items: [{ PK: 'TEAM#b', SK: 'MODEL#m', status: 'PENDING_RESET', blockedUsageDay: 'd', blockedAt: 'a' }] });
    const blocks = await listAllActiveBlocks({ tableName: 'BlockedState' });
    expect(blocks.map((b) => b.status).sort()).toEqual(['BLOCKED', 'PENDING_RESET']);
  });
});
