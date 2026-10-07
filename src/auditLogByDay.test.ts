import { listAuditEntriesByDay, writeAuditEntry } from './auditLog';
import * as dynamoDbClient from './clients/dynamoDbClient';

jest.mock('./clients/dynamoDbClient', () => ({ putItem: jest.fn(), query: jest.fn() }));
const mockedPutItem = dynamoDbClient.putItem as jest.Mock;
const mockedQuery = dynamoDbClient.query as jest.Mock;

beforeEach(() => {
  mockedPutItem.mockReset();
  mockedQuery.mockReset();
});

describe('writeAuditEntry auditDay', () => {
  it('stores the UTC date of the timestamp as auditDay (GSI partition key)', async () => {
    mockedPutItem.mockResolvedValue({});
    await writeAuditEntry(
      'teamA', 'modelX', 'arn:aws:iam::123456789012:role/R', 'ATTACH_DENY', 1000, 500,
      '2025-01-15T23:59:59.999Z', { tableName: 'AuditLog', uuid: () => 'uuid-1' }
    );
    expect(mockedPutItem.mock.calls[0][0].Item.auditDay).toBe('2025-01-15');
  });
});

describe('listAuditEntriesByDay', () => {
  it('queries AuditDayIndex and recovers team from the PK', async () => {
    mockedQuery.mockResolvedValueOnce({
      Items: [
        { PK: 'TEAM#teamA', SK: 'TS#...', model: 'm', roleArn: 'r', action: 'ATTACH_DENY', runningTotalTokens: 10, dailyTokenQuota: 5, timestamp: '2025-01-15T00:00:00.000Z', auditDay: '2025-01-15' },
      ],
    });

    const entries = await listAuditEntriesByDay('2025-01-15', { tableName: 'AuditLog' });

    expect(mockedQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'AuditLog',
        IndexName: 'AuditDayIndex',
        ExpressionAttributeValues: { ':auditDay': '2025-01-15' },
      })
    );
    expect(entries[0]).toEqual({
      team: 'teamA', model: 'm', roleArn: 'r', action: 'ATTACH_DENY',
      runningTotalTokens: 10, dailyTokenQuota: 5, timestamp: '2025-01-15T00:00:00.000Z',
    });
  });
});
