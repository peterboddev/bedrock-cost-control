import * as fc from 'fast-check';
import { computeTtl } from './ttl';

const MIN_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('computeTtl', () => {
  // Validates: Requirements 3.5, 8.2
  test('Property 23: Retention TTL correctness - result is always at least minRetentionDays after referenceDate', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01T00:00:00.000Z'), max: new Date('2100-01-01T00:00:00.000Z') }),
        fc.integer({ min: 0, max: 3650 }),
        (referenceDate, minRetentionDays) => {
          const ttlSeconds = computeTtl(referenceDate, minRetentionDays);
          const referenceMs = referenceDate.getTime();
          const requiredMs = referenceMs + minRetentionDays * DAY_MS;

          expect(ttlSeconds * 1000).toBeGreaterThanOrEqual(requiredMs);
        },
      ),
    );
  });

  test('Property 23: Retention TTL correctness - fixed 90-day retention is always satisfied', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01T00:00:00.000Z'), max: new Date('2100-01-01T00:00:00.000Z') }),
        (referenceDate) => {
          const ttlSeconds = computeTtl(referenceDate, MIN_RETENTION_DAYS);
          const requiredMs = referenceDate.getTime() + MIN_RETENTION_DAYS * DAY_MS;

          expect(ttlSeconds * 1000).toBeGreaterThanOrEqual(requiredMs);
        },
      ),
    );
  });

  test('accepts a UsageDay-style date-only string', () => {
    const ttlSeconds = computeTtl('2025-01-15', 90);
    const expectedMinMs = new Date('2025-01-15T00:00:00.000Z').getTime() + 90 * DAY_MS;

    expect(ttlSeconds * 1000).toBeGreaterThanOrEqual(expectedMinMs);
  });

  test('accepts epoch milliseconds', () => {
    const referenceMs = Date.UTC(2025, 0, 15);
    const ttlSeconds = computeTtl(referenceMs, 90);

    expect(ttlSeconds * 1000).toBeGreaterThanOrEqual(referenceMs + 90 * DAY_MS);
  });

  test('rejects negative minRetentionDays', () => {
    expect(() => computeTtl(new Date(), -1)).toThrow();
  });

  test('rejects non-finite minRetentionDays', () => {
    expect(() => computeTtl(new Date(), NaN)).toThrow();
  });

  test('rejects an invalid referenceDate string', () => {
    expect(() => computeTtl('not-a-date', 90)).toThrow();
  });
});
