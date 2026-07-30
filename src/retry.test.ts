import { retryWithBackoff, createFailThenSucceedOperation } from './retry';

const noopSleep = async () => {};

describe('retryWithBackoff', () => {
  test('succeeds on the first attempt without retrying', async () => {
    const { operation, callCount } = createFailThenSucceedOperation(0, 'ok');

    const result = await retryWithBackoff(operation, { sleep: noopSleep });

    expect(result).toBe('ok');
    expect(callCount()).toBe(1);
  });

  test('retries and eventually succeeds within the retry budget', async () => {
    const { operation, callCount } = createFailThenSucceedOperation(2, 'ok');

    const result = await retryWithBackoff(operation, { maxAttempts: 3, sleep: noopSleep });

    expect(result).toBe('ok');
    expect(callCount()).toBe(3);
  });

  test('throws the last error once the retry budget is exhausted', async () => {
    const { operation, callCount } = createFailThenSucceedOperation(5, 'ok');

    await expect(
      retryWithBackoff(operation, { maxAttempts: 3, sleep: noopSleep })
    ).rejects.toThrow('Simulated failure #3');
    expect(callCount()).toBe(3);
  });

  test('calls onRetry before each retry but not after the final failed attempt', async () => {
    const { operation } = createFailThenSucceedOperation(5, 'ok');
    const retries: number[] = [];

    await expect(
      retryWithBackoff(operation, {
        maxAttempts: 3,
        sleep: noopSleep,
        onRetry: (attempt) => retries.push(attempt),
      })
    ).rejects.toThrow();

    expect(retries).toEqual([1, 2]);
  });

  test('applies exponential backoff delays capped at maxDelayMs', async () => {
    const { operation } = createFailThenSucceedOperation(4, 'ok');
    const delays: number[] = [];

    await expect(
      retryWithBackoff(operation, {
        maxAttempts: 4,
        initialDelayMs: 100,
        backoffMultiplier: 2,
        maxDelayMs: 250,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
        onRetry: () => {},
      })
    ).rejects.toThrow();

    expect(delays).toEqual([100, 200, 250]);
  });

  test('rejects a non-positive maxAttempts', async () => {
    const { operation } = createFailThenSucceedOperation(0, 'ok');

    await expect(retryWithBackoff(operation, { maxAttempts: 0 })).rejects.toThrow();
  });

  test('createFailThenSucceedOperation supports retrying across separate retryWithBackoff calls', async () => {
    const { operation, callCount } = createFailThenSucceedOperation(2, 'restored');

    await expect(retryWithBackoff(operation, { maxAttempts: 1, sleep: noopSleep })).rejects.toThrow();
    await expect(retryWithBackoff(operation, { maxAttempts: 1, sleep: noopSleep })).rejects.toThrow();
    const result = await retryWithBackoff(operation, { maxAttempts: 1, sleep: noopSleep });

    expect(result).toBe('restored');
    expect(callCount()).toBe(3);
  });
});
