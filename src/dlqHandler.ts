/**
 * DLQ routing for malformed Usage_Collector entries.
 *
 * Wraps a batch of SQS-delivered records — each wrapping a raw Bedrock
 * Model Invocation Log entry as its JSON body — and reports per-item batch
 * failures (Lambda's SQS "partial batch response" shape) so that only
 * malformed/failed items are redriven to the queue's configured DLQ;
 * successfully processed items in the same batch are left untouched and are
 * never reprocessed/redelivered.
 *
 * See design.md's Error Handling entries for "Malformed or partial log
 * entry delivered to Usage_Collector" and "Lambda cold start or timeout
 * mid-batch (S3/CloudWatch Logs event batch)".
 *
 * _Requirements: 2.1_
 */

import { parseInvocationLogEntry } from './usageCollector';

/** A single record in an SQS-delivered batch, as passed to a Lambda handler. */
export interface SqsBatchRecord {
  messageId: string;
  body: string;
}

/** The event shape Lambda passes to a handler for an SQS event source. */
export interface SqsBatchEvent {
  Records: SqsBatchRecord[];
}

/**
 * Lambda's SQS partial batch failure reporting response shape: listing an
 * item here tells Lambda to treat only that item as failed (subject to the
 * queue's redrive policy / DLQ), leaving every other item in the batch
 * marked as successfully processed.
 */
export interface BatchItemFailuresResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

/**
 * Processes a batch of SQS records, each wrapping a raw Bedrock Model
 * Invocation Log entry as its JSON `body`.
 *
 * For each record, the entry is parsed via `parseInvocationLogEntry`
 * (task 6.1). A record is reported as a batch item failure — causing it
 * (and only it) to be redriven per the queue's DLQ/redrive policy — when:
 *  - its `body` is not valid JSON, or
 *  - `parseInvocationLogEntry` returns `null` (malformed/partial entry).
 *
 * This function never throws for the batch as a whole: any unexpected
 * error while processing a single record is caught and reported as a
 * failure for that record alone, so successfully processed records in the
 * same batch are not blocked or redriven.
 */
export function processUsageCollectorBatch(event: SqsBatchEvent): BatchItemFailuresResponse {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const rawEntry = JSON.parse(record.body);
      const parsed = parseInvocationLogEntry(rawEntry);

      if (parsed === null) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
