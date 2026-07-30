/**
 * Lambda entry-point adapter for the Usage_Collector: wired to an S3
 * `ObjectCreated` event notification on the Bedrock Model Invocation
 * Logging delivery bucket (design.md's "Usage_Collector" component,
 * "Trigger" paragraph).
 *
 * This adapter is intentionally thin: it fetches each delivered S3 object,
 * decompresses it (Bedrock Model Invocation Logging delivers S3 objects as
 * gzipped batches of newline-delimited JSON `ModelInvocationLog` entries -
 * object keys end in `.json.gz` - so every object is gunzipped before
 * parsing; a handful of non-gzip environments such as local/manual test
 * uploads may deliver plain-text JSON instead, which is detected via the
 * gzip magic byte header and passed through unchanged rather than failing),
 * splits it into newline-delimited JSON entries, and delegates all
 * parsing/processing logic to `parseInvocationLogEntry` (task 6.1) and
 * `processInvocationLogEntry` (task 7.1) in `../usageCollector.ts`.
 * Malformed lines are skipped without blocking the rest of the batch
 * (Requirement 2.1); this Lambda has no SQS batch-item-failure reporting of
 * its own since S3 event notifications are not a batch-item-failure-capable
 * event source (that reporting model is implemented separately for the
 * CloudWatch Logs/SQS DLQ path, see `dlqHandlerEntry.ts` / `../dlqHandler.ts`,
 * task 19.3).
 */
import { gunzipSync } from 'zlib';

import type { S3Event } from 'aws-lambda';

import { getObject } from '../clients/s3Client';
import { ENV_VAR_NAMES, requiredEnv } from '../envConfig';
import { parseInvocationLogEntry, processInvocationLogEntry } from '../usageCollector';

/** The two-byte gzip magic header (`0x1f 0x8b`), used to detect whether a delivered object is gzip-compressed. */
const GZIP_MAGIC_BYTES = Buffer.from([0x1f, 0x8b]);

function isGzipCompressed(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes.subarray(0, 2).equals(GZIP_MAGIC_BYTES);
}

async function readObjectAsString(bucket: string, key: string): Promise<string> {
  const response = await getObject({ Bucket: bucket, Key: decodeURIComponent(key.replace(/\+/g, ' ')) });
  const body = response.Body;
  if (!body) {
    return '';
  }

  const bytes = Buffer.from(await body.transformToByteArray());
  const decompressed = isGzipCompressed(bytes) ? gunzipSync(bytes) : bytes;
  return decompressed.toString('utf-8');
}

export async function handler(event: S3Event): Promise<void> {
  const teamTagKey = requiredEnv(ENV_VAR_NAMES.TEAM_TAG_KEY);
  const teamRoleCacheTableName = requiredEnv(ENV_VAR_NAMES.TEAM_ROLE_CACHE_TABLE_NAME);
  const usageAggregationTableName = requiredEnv(ENV_VAR_NAMES.USAGE_AGGREGATION_TABLE_NAME);
  const processedRequestsTableName = requiredEnv(ENV_VAR_NAMES.PROCESSED_REQUESTS_TABLE_NAME);

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = record.s3.object.key;

    const contents = await readObjectAsString(bucket, key);
    const lines = contents.split('\n').filter((line) => line.trim().length > 0);

    for (const line of lines) {
      let rawEntry: unknown;
      try {
        rawEntry = JSON.parse(line);
      } catch {
        continue;
      }

      const parsed = parseInvocationLogEntry(rawEntry);
      if (parsed === null) {
        continue;
      }

      await processInvocationLogEntry(parsed, {
        teamTagKey,
        teamRoleCacheTableName,
        usageAggregationTableName,
        processedRequestsTableName,
      });
    }
  }
}
