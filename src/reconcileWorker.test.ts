import * as reconciliation from './reconciliation';
import * as jobStore from './reconcileJobStore';
import * as sqsClient from './clients/sqsClient';
import { processReconcileMessage } from './reconcileWorker';

jest.mock('./reconciliation', () => ({ reconcileTeamRoleCache: jest.fn() }));
jest.mock('./reconcileJobStore', () => ({
  recordReconcileProgress: jest.fn(),
  completeReconcileJob: jest.fn(),
  failReconcileJob: jest.fn(),
}));
jest.mock('./clients/sqsClient', () => ({ sendMessage: jest.fn() }));

const mockedReconcile = reconciliation.reconcileTeamRoleCache as jest.Mock;
const mockedProgress = jobStore.recordReconcileProgress as jest.Mock;
const mockedComplete = jobStore.completeReconcileJob as jest.Mock;
const mockedFail = jobStore.failReconcileJob as jest.Mock;
const mockedSend = sqsClient.sendMessage as jest.Mock;

const OPTIONS = {
  teamTagKey: 'team',
  teamRoleCacheTableName: 'Team_Role_Cache',
  reconcileJobTableName: 'Reconcile_Job',
  reconcileQueueUrl: 'https://sqs.example/queue',
};

describe('processReconcileMessage', () => {
  beforeEach(() => {
    mockedReconcile.mockReset();
    mockedProgress.mockReset().mockResolvedValue(undefined);
    mockedComplete.mockReset().mockResolvedValue(undefined);
    mockedFail.mockReset().mockResolvedValue(undefined);
    mockedSend.mockReset().mockResolvedValue(undefined);
  });

  it('processes exactly one page (maxPages=1) resuming from the message marker', async () => {
    mockedReconcile.mockResolvedValue({ reconciledRoles: [], pageCount: 1, complete: true });

    await processReconcileMessage({ jobId: 'j1', marker: 'page-2' }, OPTIONS);

    const arg = mockedReconcile.mock.calls[0][0];
    expect(arg.maxPages).toBe(1);
    expect(arg.startMarker).toBe('page-2');
    expect(arg.teamTagKey).toBe('team');
  });

  it('when more pages remain: records progress and re-enqueues the next marker (stays running)', async () => {
    mockedReconcile.mockResolvedValue({
      reconciledRoles: [{ roleArn: 'arn:a', team: 't' }],
      pageCount: 1,
      complete: false,
      nextMarker: 'next-123',
    });

    await processReconcileMessage({ jobId: 'j1' }, OPTIONS);

    expect(mockedProgress).toHaveBeenCalledWith(
      'j1',
      { rolesProcessed: 1, pageCount: 1 },
      expect.objectContaining({ tableName: 'Reconcile_Job' })
    );
    expect(mockedComplete).not.toHaveBeenCalled();
    const sendArg = mockedSend.mock.calls[0][0];
    expect(sendArg.QueueUrl).toBe('https://sqs.example/queue');
    expect(JSON.parse(sendArg.MessageBody)).toEqual({ jobId: 'j1', marker: 'next-123' });
  });

  it('on the last page: completes the job and does NOT re-enqueue', async () => {
    mockedReconcile.mockResolvedValue({
      reconciledRoles: [{ roleArn: 'arn:a', team: 't' }],
      pageCount: 1,
      complete: true,
    });

    await processReconcileMessage({ jobId: 'j1', marker: 'last' }, OPTIONS);

    expect(mockedComplete).toHaveBeenCalledWith(
      'j1',
      { rolesProcessed: 1, pageCount: 1 },
      expect.objectContaining({ tableName: 'Reconcile_Job' })
    );
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedProgress).not.toHaveBeenCalled();
  });

  it('on failure: marks the job failed with the error message, then rethrows (for SQS redrive/DLQ)', async () => {
    mockedReconcile.mockRejectedValue(new Error('IAM throttled'));

    await expect(processReconcileMessage({ jobId: 'j1' }, OPTIONS)).rejects.toThrow(
      'IAM throttled'
    );
    expect(mockedFail).toHaveBeenCalledWith(
      'j1',
      'IAM throttled',
      expect.objectContaining({ tableName: 'Reconcile_Job' })
    );
  });
});
