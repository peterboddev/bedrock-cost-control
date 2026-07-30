import { publishNotification } from './notifications';
import * as snsClient from './clients/snsClient';

jest.mock('./clients/snsClient', () => ({
  publish: jest.fn(),
}));

const mockedPublish = snsClient.publish as jest.Mock;

describe('publishNotification', () => {
  beforeEach(() => {
    mockedPublish.mockReset();
    mockedPublish.mockResolvedValue({});
  });

  it('is a no-op when no topicArn is configured', async () => {
    await publishNotification('blocked', 'teamA', 'modelX', 1000, {});
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it('is a no-op when topicArn is an empty string', async () => {
    await publishNotification('restored', 'teamA', 'modelX', undefined, { topicArn: '' });
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it('publishes a "blocked" message with team, model, and dailyTokenQuota', async () => {
    await publishNotification('blocked', 'teamA', 'modelX', 1000, {
      topicArn: 'arn:aws:sns:us-east-1:123456789012:quota-topic',
    });

    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const call = mockedPublish.mock.calls[0][0];
    expect(call.TopicArn).toBe('arn:aws:sns:us-east-1:123456789012:quota-topic');
    const body = JSON.parse(call.Message);
    expect(body).toEqual({ action: 'blocked', team: 'teamA', model: 'modelX', dailyTokenQuota: 1000 });
  });

  it('publishes a "restored" message with team and model only, omitting dailyTokenQuota', async () => {
    await publishNotification('restored', 'teamA', 'modelX', undefined, {
      topicArn: 'arn:aws:sns:us-east-1:123456789012:quota-topic',
    });

    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const call = mockedPublish.mock.calls[0][0];
    const body = JSON.parse(call.Message);
    expect(body).toEqual({ action: 'restored', team: 'teamA', model: 'modelX' });
  });

  it('never throws when the SNS publish call fails, even after retries are exhausted', async () => {
    mockedPublish.mockRejectedValue(new Error('simulated SNS failure'));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      publishNotification('blocked', 'teamA', 'modelX', 1000, {
        topicArn: 'arn:aws:sns:us-east-1:123456789012:quota-topic',
        retryOptions: { maxAttempts: 1 },
      })
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });

  it('retries the SNS publish call according to the configured retry options', async () => {
    let calls = 0;
    mockedPublish.mockImplementation(async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error('transient failure');
      }
      return {};
    });

    await publishNotification('restored', 'teamA', 'modelX', undefined, {
      topicArn: 'arn:aws:sns:us-east-1:123456789012:quota-topic',
      retryOptions: { maxAttempts: 3, initialDelayMs: 0, sleep: async () => {} },
    });

    expect(calls).toBe(3);
  });
});
