/**
 * Lambda entry-point adapter for DLQ routing of malformed Usage_Collector
 * entries: wired to an SQS event source with partial batch response
 * reporting enabled (design.md's Error Handling table, "Malformed or
 * partial log entry delivered to Usage_Collector" row; task 19.3).
 *
 * Delegates entirely to `processUsageCollectorBatch` in
 * `../dlqHandler.ts`, which never throws and always returns a structured
 * `batchItemFailures` response so only failed items are redriven.
 */
import { BatchItemFailuresResponse, processUsageCollectorBatch, SqsBatchEvent } from '../dlqHandler';

export async function handler(event: SqsBatchEvent): Promise<BatchItemFailuresResponse> {
  return processUsageCollectorBatch(event);
}
