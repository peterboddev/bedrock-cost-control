/**
 * Thin wrapper for invoking the deployed AdminApiFunction Lambda
 * (src/adminApi.ts's handlers, via src/lambdaEntrypoints/adminApiEntry.ts)
 * from the CLI test tool, using the operator's own AWS credentials (not
 * the assumed Bedrock_Test_Role - the test role is scoped to Bedrock
 * invocation only and has no Lambda/DynamoDB permissions).
 */
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

export type AdminApiOperation = 'putQuota' | 'listQuotas' | 'listAuditEntries' | 'removeDenyPolicy';

export interface AdminApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Invokes the AdminApiFunction Lambda synchronously with the given
 * operation and payload, and returns its structured `AdminApiResult`.
 * Throws if the Lambda invocation itself fails (network/permissions), as
 * opposed to the operation returning `{ ok: false, error }` (a normal,
 * expected outcome the caller should handle).
 */
export async function invokeAdminApi<T = unknown>(
  functionName: string,
  region: string,
  operation: AdminApiOperation,
  payload: Record<string, unknown>
): Promise<AdminApiResult<T>> {
  const client = new LambdaClient({ region });

  const response = await client.send(
    new InvokeCommand({
      FunctionName: functionName,
      Payload: Buffer.from(JSON.stringify({ operation, payload })),
    })
  );

  if (response.FunctionError) {
    const errorPayload = response.Payload ? Buffer.from(response.Payload).toString('utf-8') : '';
    throw new Error(`AdminApiFunction invocation failed (${response.FunctionError}): ${errorPayload}`);
  }

  if (!response.Payload) {
    throw new Error('AdminApiFunction returned no payload');
  }

  return JSON.parse(Buffer.from(response.Payload).toString('utf-8')) as AdminApiResult<T>;
}
