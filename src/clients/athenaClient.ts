/**
 * Thin AWS SDK v3 wrapper around the Athena client.
 *
 * Centralizing client construction here lets every component share one
 * configured client (and lets tests substitute a mock/fake) without each
 * module reaching into the SDK directly. Follows the same pattern as
 * `dynamoDbClient.ts` and `s3Client.ts`.
 */
import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';

let client: AthenaClient | undefined;

export function getAthenaClient(): AthenaClient {
  if (!client) {
    client = new AthenaClient({});
  }
  return client;
}

export function setAthenaClient(c: AthenaClient): void {
  client = c;
}

export interface AthenaQueryOptions {
  /** The Athena workgroup to run queries in. */
  workGroup: string;
  /** Maximum seconds to wait for query completion before giving up. */
  timeoutSeconds?: number;
  /** Polling interval in milliseconds. */
  pollIntervalMs?: number;
}

export interface AthenaRow {
  [column: string]: string | undefined;
}

/**
 * Executes an Athena SQL query, polls for completion, and returns the
 * result rows as simple key-value objects (column name → string value).
 *
 * Throws on query failure or timeout. Handles pagination via NextToken.
 */
export async function executeAthenaQuery(
  sql: string,
  options: AthenaQueryOptions
): Promise<AthenaRow[]> {
  const athena = getAthenaClient();
  const timeoutMs = (options.timeoutSeconds ?? 120) * 1000;
  const pollMs = options.pollIntervalMs ?? 3000;

  // Start the query.
  const startResult = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      WorkGroup: options.workGroup,
    })
  );
  const queryExecutionId = startResult.QueryExecutionId;
  if (!queryExecutionId) {
    throw new Error('Athena StartQueryExecution returned no QueryExecutionId');
  }

  // Poll for completion.
  const deadline = Date.now() + timeoutMs;
  let state: string | undefined;
  while (Date.now() < deadline) {
    const exec = await athena.send(
      new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId })
    );
    state = exec.QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      const reason = exec.QueryExecution?.Status?.StateChangeReason ?? 'unknown';
      throw new Error(`Athena query ${state}: ${reason}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (state !== 'SUCCEEDED') {
    throw new Error(`Athena query timed out after ${options.timeoutSeconds ?? 120}s (state: ${state})`);
  }

  // Fetch all result pages.
  const rows: AthenaRow[] = [];
  let nextToken: string | undefined;
  let headerNames: string[] | undefined;

  do {
    const results = await athena.send(
      new GetQueryResultsCommand({
        QueryExecutionId: queryExecutionId,
        NextToken: nextToken,
      })
    );

    const resultRows = results.ResultSet?.Rows ?? [];
    if (!headerNames && resultRows.length > 0) {
      // First row is the header.
      headerNames = resultRows[0].Data?.map((d) => d.VarCharValue ?? '') ?? [];
    }

    const dataRows = headerNames ? resultRows.slice(rows.length === 0 ? 1 : 0) : [];
    for (const row of dataRows) {
      const obj: AthenaRow = {};
      const cells = row.Data ?? [];
      for (let i = 0; i < (headerNames?.length ?? 0); i++) {
        obj[headerNames![i]] = cells[i]?.VarCharValue;
      }
      rows.push(obj);
    }

    nextToken = results.NextToken;
  } while (nextToken);

  return rows;
}
