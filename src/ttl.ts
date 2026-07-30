/**
 * Retention TTL computation utility.
 *
 * Used by Usage_Aggregation records (TTL at least 90 days after the record's
 * Usage_Day, per Requirement 3.5) and Audit_Log entries (TTL at least 90 days
 * after the entry's timestamp, per Requirement 8.2).
 */

/**
 * A reference point in time. Accepts:
 * - a date-only string such as a `UsageDay` (`"YYYY-MM-DD"`), interpreted as
 *   00:00:00 UTC on that date
 * - a full ISO-8601 timestamp string
 * - a `Date` instance
 * - a number of epoch milliseconds
 */
export type ReferenceDate = Date | string | number;

/**
 * Computes a DynamoDB `ttl` attribute value (epoch seconds) that is
 * guaranteed to be at least `minRetentionDays` days after `referenceDate`.
 *
 * @param referenceDate - The date/timestamp the retention period is measured
 *   from (e.g. a Usage_Day or an Audit_Log entry's timestamp).
 * @param minRetentionDays - The minimum number of days that must elapse
 *   after `referenceDate` before the computed TTL is reached. Must be a
 *   non-negative finite number.
 * @returns The TTL as epoch seconds (integer), always >= the exact
 *   `referenceDate + minRetentionDays` instant (rounded up when the input
 *   does not land on a whole second).
 */
export function computeTtl(referenceDate: ReferenceDate, minRetentionDays: number): number {
  if (!Number.isFinite(minRetentionDays) || minRetentionDays < 0) {
    throw new Error(`minRetentionDays must be a non-negative finite number, got: ${minRetentionDays}`);
  }

  const referenceMs = toEpochMillis(referenceDate);
  const retentionMs = minRetentionDays * 24 * 60 * 60 * 1000;

  return Math.ceil((referenceMs + retentionMs) / 1000);
}

function toEpochMillis(referenceDate: ReferenceDate): number {
  if (referenceDate instanceof Date) {
    const ms = referenceDate.getTime();
    if (Number.isNaN(ms)) {
      throw new Error('referenceDate is an invalid Date');
    }
    return ms;
  }

  if (typeof referenceDate === 'number') {
    if (!Number.isFinite(referenceDate)) {
      throw new Error(`referenceDate must be a finite number of epoch milliseconds, got: ${referenceDate}`);
    }
    return referenceDate;
  }

  const parsed = new Date(referenceDate);
  const ms = parsed.getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`referenceDate could not be parsed as a valid date/timestamp: ${referenceDate}`);
  }
  return ms;
}
