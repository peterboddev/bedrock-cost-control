/**
 * Thin AWS SDK v3 wrapper around the CloudWatch (metrics) client.
 *
 * Used by the Mantle usage collector to pull `AWS/BedrockMantle` metrics
 * (`TotalInputTokens`/`TotalOutputTokens` by `Project`+`ModelId`) via
 * `GetMetricData`. Centralizing construction here keeps the collector pure
 * and lets tests inject a fake.
 */
import {
  CloudWatchClient,
  GetMetricDataCommand,
  GetMetricDataCommandInput,
  GetMetricDataCommandOutput,
} from "@aws-sdk/client-cloudwatch";

let cloudWatchClient: CloudWatchClient | undefined;

/** Returns a process-wide singleton CloudWatch client. */
export function getCloudWatchClient(): CloudWatchClient {
  if (!cloudWatchClient) {
    cloudWatchClient = new CloudWatchClient({});
  }
  return cloudWatchClient;
}

/** Allows tests to inject a fake/mock CloudWatch client. */
export function setCloudWatchClient(client: CloudWatchClient): void {
  cloudWatchClient = client;
}

export async function getMetricData(
  input: GetMetricDataCommandInput
): Promise<GetMetricDataCommandOutput> {
  return getCloudWatchClient().send(new GetMetricDataCommand(input));
}
