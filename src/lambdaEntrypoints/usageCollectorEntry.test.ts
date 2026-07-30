import { gzipSync } from 'zlib';

import { sdkStreamMixin } from '@smithy/util-stream';
import { Readable } from 'stream';

import * as s3Client from '../clients/s3Client';
import * as usageCollector from '../usageCollector';
import { handler } from './usageCollectorEntry';

jest.mock('../clients/s3Client', () => ({
  getObject: jest.fn(),
}));

jest.mock('../usageCollector', () => ({
  parseInvocationLogEntry: jest.fn(),
  processInvocationLogEntry: jest.fn(),
}));

const mockedGetObject = s3Client.getObject as jest.Mock;
const mockedParse = usageCollector.parseInvocationLogEntry as jest.Mock;
const mockedProcess = usageCollector.processInvocationLogEntry as jest.Mock;

function bodyFromBuffer(buffer: Buffer) {
  return sdkStreamMixin(Readable.from(buffer));
}

function buildS3Event(bucket: string, key: string) {
  return {
    Records: [
      {
        s3: {
          bucket: { name: bucket },
          object: { key },
        },
      },
    ],
  } as unknown as import('aws-lambda').S3Event;
}

const REQUIRED_ENV = {
  TEAM_TAG_KEY: 'team',
  TEAM_ROLE_CACHE_TABLE_NAME: 'Team_Role_Cache',
  USAGE_AGGREGATION_TABLE_NAME: 'Usage_Aggregation',
  PROCESSED_REQUESTS_TABLE_NAME: 'Processed_Requests',
};

describe('usageCollectorEntry handler - gzip decompression', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, ...REQUIRED_ENV };
    mockedParse.mockReturnValue(null);
    mockedProcess.mockResolvedValue(undefined);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('decompresses a gzip-compressed S3 object (the real Bedrock Model Invocation Logging delivery format) before parsing', async () => {
    const entry = { requestId: 'req-1', modelId: 'model-1' };
    const gzipped = gzipSync(Buffer.from(`${JSON.stringify(entry)}\n`, 'utf-8'));

    mockedGetObject.mockResolvedValue({ Body: bodyFromBuffer(gzipped) });
    mockedParse.mockReturnValue({
      requestId: 'req-1',
      roleArn: 'arn:aws:iam::123456789012:role/Test',
      modelId: 'model-1',
      inputTokenCount: 1,
      outputTokenCount: 1,
      timestamp: '2025-01-15T00:00:00.000Z',
    });

    await handler(buildS3Event('my-bucket', 'AWSLogs/123/BedrockModelInvocationLogs/file.json.gz'));

    expect(mockedParse).toHaveBeenCalledWith(entry);
    expect(mockedProcess).toHaveBeenCalledTimes(1);
  });

  it('passes plain-text (non-gzip) JSON through unchanged, for non-Bedrock-delivered test uploads', async () => {
    const entry = { requestId: 'req-2', modelId: 'model-2' };
    const plainText = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf-8');

    mockedGetObject.mockResolvedValue({ Body: bodyFromBuffer(plainText) });
    mockedParse.mockReturnValue({
      requestId: 'req-2',
      roleArn: 'arn:aws:iam::123456789012:role/Test',
      modelId: 'model-2',
      inputTokenCount: 1,
      outputTokenCount: 1,
      timestamp: '2025-01-15T00:00:00.000Z',
    });

    await handler(buildS3Event('my-bucket', 'manual-upload.json'));

    expect(mockedParse).toHaveBeenCalledWith(entry);
    expect(mockedProcess).toHaveBeenCalledTimes(1);
  });

  it('skips malformed lines within a batch without throwing', async () => {
    const validEntry = { requestId: 'req-3' };
    const contents = `not-json\n${JSON.stringify(validEntry)}\n`;
    const gzipped = gzipSync(Buffer.from(contents, 'utf-8'));

    mockedGetObject.mockResolvedValue({ Body: bodyFromBuffer(gzipped) });
    mockedParse.mockReturnValue(null);

    await expect(
      handler(buildS3Event('my-bucket', 'file.json.gz'))
    ).resolves.toBeUndefined();

    expect(mockedParse).toHaveBeenCalledWith(validEntry);
    expect(mockedProcess).not.toHaveBeenCalled();
  });

  it('handles a missing response Body gracefully (no entries processed)', async () => {
    mockedGetObject.mockResolvedValue({ Body: undefined });

    await expect(
      handler(buildS3Event('my-bucket', 'file.json.gz'))
    ).resolves.toBeUndefined();

    expect(mockedProcess).not.toHaveBeenCalled();
  });
});
