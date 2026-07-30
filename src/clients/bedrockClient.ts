/**
 * Thin AWS SDK v3 wrapper around the Bedrock (control-plane) client.
 *
 * Centralizing client construction here lets every component share one
 * configured client (and lets tests substitute a mock/fake) without each
 * module reaching into the SDK directly.
 */
import {
  BedrockClient,
  PutModelInvocationLoggingConfigurationCommand,
  PutModelInvocationLoggingConfigurationCommandInput,
  PutModelInvocationLoggingConfigurationCommandOutput,
  DeleteModelInvocationLoggingConfigurationCommand,
  DeleteModelInvocationLoggingConfigurationCommandInput,
  DeleteModelInvocationLoggingConfigurationCommandOutput,
} from "@aws-sdk/client-bedrock";

let bedrockClient: BedrockClient | undefined;

/**
 * Returns a process-wide singleton Bedrock (control-plane) client.
 */
export function getBedrockClient(): BedrockClient {
  if (!bedrockClient) {
    bedrockClient = new BedrockClient({});
  }
  return bedrockClient;
}

/**
 * Allows tests to inject a fake/mock Bedrock client.
 */
export function setBedrockClient(client: BedrockClient): void {
  bedrockClient = client;
}

export async function putModelInvocationLoggingConfiguration(
  input: PutModelInvocationLoggingConfigurationCommandInput
): Promise<PutModelInvocationLoggingConfigurationCommandOutput> {
  return getBedrockClient().send(new PutModelInvocationLoggingConfigurationCommand(input));
}

export async function deleteModelInvocationLoggingConfiguration(
  input: DeleteModelInvocationLoggingConfigurationCommandInput = {}
): Promise<DeleteModelInvocationLoggingConfigurationCommandOutput> {
  return getBedrockClient().send(new DeleteModelInvocationLoggingConfigurationCommand(input));
}
