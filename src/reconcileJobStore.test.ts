import * as dynamoDbClient from './clients/dynamoDbClient';
import {
  completeReconcileJob,
  createReconcileJob,
  failReconcileJob,
  getReconcileJob,
  recordReconcileProgress,
} from './reconcileJobStore';

jest.mock('./clients/dynamoDbClient', () => ({
  getItem: jest.fn(),
  putItem: jest.fn(),
  updateItem: jest.fn(),
}));

const mockedGetItem = dynamoDbClient.getItem as jest.Mock;
const mockedPutItem = dynamoDbClient.putItem as jest.Mock;
const mockedUpdateItem = dynamoDbClient.updateItem as jest.Mock;

const TABLE_NAME = 'Reconcile_Job';
const FIXED_NOW = new Date('2026-01-02T03:04:05.000Z');
const now = () => FIXED_NOW;

describe('reconcileJobStore', () => {
  beforeEach(() => {
    mockedGetItem.mockReset().mockResolvedValue({ Item: undefined });
    mockedPutItem.mockReset().mockResolvedValue({});
    mockedUpdateItem.mockReset().mockResolvedValue({});
  });

  it('createReconcileJob writes a running row with zeroed counters, a JOB# key, and a TTL', async () => {
    const job = await createReconcileJob('job-1', { tableName: TABLE_NAME, now });

    expect(job).toMatchObject({
      jobId: 'job-1',
      status: 'running',
      rolesProcessed: 0,
      pageCount: 0,
      startedAt: FIXED_NOW.toISOString(),
      updatedAt: FIXED_NOW.toISOString(),
    });
    const putArg = mockedPutItem.mock.calls[0][0];
    expect(putArg.TableName).toBe(TABLE_NAME);
    expect(putArg.Item.PK).toBe('JOB#job-1');
    expect(putArg.Item.ttl).toBe(Math.floor(FIXED_NOW.getTime() / 1000) + 24 * 60 * 60);
  });

  it('recordReconcileProgress ADDs counters and keeps the job running (no status change)', async () => {
    await recordReconcileProgress(
      'job-1',
      { rolesProcessed: 100, pageCount: 1 },
      { tableName: TABLE_NAME, now }
    );

    const arg = mockedUpdateItem.mock.calls[0][0];
    expect(arg.Key).toEqual({ PK: 'JOB#job-1' });
    expect(arg.UpdateExpression).toContain('ADD rolesProcessed :roles, pageCount :pages');
    expect(arg.UpdateExpression).not.toContain('#status');
    expect(arg.ExpressionAttributeValues[':roles']).toBe(100);
    expect(arg.ExpressionAttributeValues[':pages']).toBe(1);
  });

  it('completeReconcileJob folds in the final counts and flips status to complete', async () => {
    await completeReconcileJob(
      'job-1',
      { rolesProcessed: 42, pageCount: 1 },
      { tableName: TABLE_NAME, now }
    );

    const arg = mockedUpdateItem.mock.calls[0][0];
    expect(arg.UpdateExpression).toContain('ADD rolesProcessed :roles, pageCount :pages');
    expect(arg.UpdateExpression).toContain('#status = :status');
    expect(arg.UpdateExpression).toContain('completedAt = :completedAt');
    expect(arg.ExpressionAttributeValues[':status']).toBe('complete');
    expect(arg.ExpressionAttributeValues[':completedAt']).toBe(FIXED_NOW.toISOString());
  });

  it('failReconcileJob sets status=failed with the error message', async () => {
    await failReconcileJob('job-1', 'IAM throttled', { tableName: TABLE_NAME, now });

    const arg = mockedUpdateItem.mock.calls[0][0];
    expect(arg.ExpressionAttributeValues[':status']).toBe('failed');
    expect(arg.ExpressionAttributeValues[':error']).toBe('IAM throttled');
  });

  it('getReconcileJob returns the mapped job when the row exists', async () => {
    mockedGetItem.mockResolvedValue({
      Item: {
        PK: 'JOB#job-1',
        jobId: 'job-1',
        status: 'complete',
        rolesProcessed: 7,
        pageCount: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:05.000Z',
        completedAt: '2026-01-01T00:00:05.000Z',
        ttl: 123,
      },
    });

    const job = await getReconcileJob('job-1', { tableName: TABLE_NAME });

    expect(mockedGetItem.mock.calls[0][0].Key).toEqual({ PK: 'JOB#job-1' });
    expect(job).toEqual({
      jobId: 'job-1',
      status: 'complete',
      rolesProcessed: 7,
      pageCount: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:05.000Z',
      completedAt: '2026-01-01T00:00:05.000Z',
      error: undefined,
    });
  });

  it('getReconcileJob returns undefined when no row exists', async () => {
    mockedGetItem.mockResolvedValue({ Item: undefined });
    const job = await getReconcileJob('missing', { tableName: TABLE_NAME });
    expect(job).toBeUndefined();
  });
});
