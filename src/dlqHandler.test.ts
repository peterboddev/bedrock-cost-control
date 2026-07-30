import { processUsageCollectorBatch, SqsBatchEvent } from './dlqHandler';

const validEntry = {
  requestId: 'req-valid',
  identity: { arn: 'arn:aws:iam::123456789012:role/MyRole' },
  modelId: 'anthropic.claude-v2',
  timestamp: '2025-01-15T10:00:00.000Z',
  input: { inputTokenCount: 10 },
  output: { outputTokenCount: 20 },
};

describe('processUsageCollectorBatch', () => {
  // _Requirements: 2.1
  test('malformed entries in a batch are individually routed as failures while valid entries succeed', () => {
    const event: SqsBatchEvent = {
      Records: [
        { messageId: 'msg-1', body: JSON.stringify(validEntry) },
        { messageId: 'msg-2', body: JSON.stringify({ requestId: 'only-a-request-id' }) },
        { messageId: 'msg-3', body: JSON.stringify({ ...validEntry, requestId: 'req-valid-2' }) },
        { messageId: 'msg-4', body: 'not valid json{{' },
        { messageId: 'msg-5', body: JSON.stringify({}) },
      ],
    };

    const result = processUsageCollectorBatch(event);

    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: 'msg-2' },
      { itemIdentifier: 'msg-4' },
      { itemIdentifier: 'msg-5' },
    ]);
  });

  test('returns no batch item failures when every entry in the batch is valid', () => {
    const event: SqsBatchEvent = {
      Records: [
        { messageId: 'msg-1', body: JSON.stringify(validEntry) },
        { messageId: 'msg-2', body: JSON.stringify({ ...validEntry, requestId: 'req-valid-2' }) },
      ],
    };

    const result = processUsageCollectorBatch(event);

    expect(result.batchItemFailures).toEqual([]);
  });

  test('reports every item as failed when every entry in the batch is malformed', () => {
    const event: SqsBatchEvent = {
      Records: [
        { messageId: 'msg-1', body: JSON.stringify({}) },
        { messageId: 'msg-2', body: 'not json' },
        { messageId: 'msg-3', body: JSON.stringify(null) },
      ],
    };

    const result = processUsageCollectorBatch(event);

    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: 'msg-1' },
      { itemIdentifier: 'msg-2' },
      { itemIdentifier: 'msg-3' },
    ]);
  });

  test('returns an empty batchItemFailures array for an empty batch', () => {
    const result = processUsageCollectorBatch({ Records: [] });

    expect(result.batchItemFailures).toEqual([]);
  });

  test('does not throw when a record body is malformed JSON, and still reports the item as failed', () => {
    const event: SqsBatchEvent = {
      Records: [{ messageId: 'msg-1', body: '{unterminated' }],
    };

    expect(() => processUsageCollectorBatch(event)).not.toThrow();
    expect(processUsageCollectorBatch(event).batchItemFailures).toEqual([{ itemIdentifier: 'msg-1' }]);
  });
});
