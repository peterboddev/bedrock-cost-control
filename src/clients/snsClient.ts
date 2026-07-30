/**
 * Thin AWS SDK v3 wrapper around the SNS client.
 *
 * Centralizing client construction here lets every component share one
 * configured client (and lets tests substitute a mock/fake) without each
 * module reaching into the SDK directly.
 */
import {
  SNSClient,
  PublishCommand,
  PublishCommandInput,
  PublishCommandOutput,
} from "@aws-sdk/client-sns";

let snsClient: SNSClient | undefined;

/**
 * Returns a process-wide singleton SNS client.
 */
export function getSnsClient(): SNSClient {
  if (!snsClient) {
    snsClient = new SNSClient({});
  }
  return snsClient;
}

/**
 * Allows tests to inject a fake/mock SNS client.
 */
export function setSnsClient(client: SNSClient): void {
  snsClient = client;
}

export async function publish(input: PublishCommandInput): Promise<PublishCommandOutput> {
  return getSnsClient().send(new PublishCommand(input));
}
