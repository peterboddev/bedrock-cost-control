/**
 * Thin AWS SDK v3 wrapper around the SQS client.
 *
 * Centralizing client construction here lets every component share one
 * configured client (and lets tests substitute a mock/fake) without each
 * module reaching into the SDK directly.
 */
import {
  SQSClient,
  SendMessageCommand,
  SendMessageCommandInput,
  SendMessageCommandOutput,
} from "@aws-sdk/client-sqs";

let sqsClient: SQSClient | undefined;

/**
 * Returns a process-wide singleton SQS client.
 */
export function getSqsClient(): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({});
  }
  return sqsClient;
}

/**
 * Allows tests to inject a fake/mock SQS client.
 */
export function setSqsClient(client: SQSClient): void {
  sqsClient = client;
}

export async function sendMessage(
  input: SendMessageCommandInput
): Promise<SendMessageCommandOutput> {
  return getSqsClient().send(new SendMessageCommand(input));
}
