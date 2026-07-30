import * as bedrockClient from '../clients/bedrockClient';
import { handler } from './modelInvocationLoggingCustomResourceEntry';

jest.mock('../clients/bedrockClient', () => ({
  putModelInvocationLoggingConfiguration: jest.fn(),
  deleteModelInvocationLoggingConfiguration: jest.fn(),
}));

const mockedPut = bedrockClient.putModelInvocationLoggingConfiguration as jest.Mock;
const mockedDelete = bedrockClient.deleteModelInvocationLoggingConfiguration as jest.Mock;

function buildEvent(requestType: 'Create' | 'Update' | 'Delete', props: Record<string, unknown> = {}) {
  return {
    RequestType: requestType,
    ResourceProperties: {
      ServiceToken: 'token',
      bucketName: 'my-log-bucket',
      keyPrefix: 'bedrock-logs',
      ...props,
    },
  } as unknown as import('aws-lambda').CdkCustomResourceEvent;
}

describe('modelInvocationLoggingCustomResourceEntry handler', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('enables model invocation logging with the given S3 bucket and prefix on Create', async () => {
    mockedPut.mockResolvedValue({});

    const result = await handler(buildEvent('Create'));

    expect(result.PhysicalResourceId).toBe('BedrockModelInvocationLoggingConfiguration');
    expect(mockedPut).toHaveBeenCalledWith({
      loggingConfig: {
        s3Config: {
          bucketName: 'my-log-bucket',
          keyPrefix: 'bedrock-logs',
        },
        textDataDeliveryEnabled: true,
        imageDataDeliveryEnabled: false,
        embeddingDataDeliveryEnabled: false,
      },
    });
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it('re-applies the logging configuration on Update', async () => {
    mockedPut.mockResolvedValue({});

    const result = await handler(buildEvent('Update'));

    expect(result.PhysicalResourceId).toBe('BedrockModelInvocationLoggingConfiguration');
    expect(mockedPut).toHaveBeenCalledTimes(1);
  });

  it('deletes the logging configuration on Delete', async () => {
    mockedDelete.mockResolvedValue({});

    const result = await handler(buildEvent('Delete'));

    expect(result.PhysicalResourceId).toBe('BedrockModelInvocationLoggingConfiguration');
    expect(mockedDelete).toHaveBeenCalledTimes(1);
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it('does not throw if Delete fails (best-effort teardown)', async () => {
    mockedDelete.mockRejectedValue(new Error('already deleted'));

    await expect(handler(buildEvent('Delete'))).resolves.toEqual({
      PhysicalResourceId: 'BedrockModelInvocationLoggingConfiguration',
    });
  });
});
