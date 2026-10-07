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
  ListFoundationModelsCommand,
  ListFoundationModelsCommandInput,
  ListFoundationModelsCommandOutput,
  ListInferenceProfilesCommand,
  ListInferenceProfilesCommandInput,
  ListInferenceProfilesCommandOutput,
} from "@aws-sdk/client-bedrock";

let bedrockClient: BedrockClient | undefined;
/** Per-region Bedrock clients, so the admin model-catalog can list any region. */
const regionalClients = new Map<string, BedrockClient>();

/**
 * Returns a Bedrock (control-plane) client. With no `region`, returns a
 * process-wide singleton bound to the Lambda's own region. With a `region`,
 * returns (and caches) a client bound to that region — used by the admin
 * model-catalog, which lists models for an admin-chosen region.
 */
export function getBedrockClient(region?: string): BedrockClient {
  if (region) {
    let client = regionalClients.get(region);
    if (!client) {
      client = new BedrockClient({ region });
      regionalClients.set(region, client);
    }
    return client;
  }
  if (!bedrockClient) {
    bedrockClient = new BedrockClient({});
  }
  return bedrockClient;
}

/**
 * Allows tests to inject a fake/mock Bedrock client (the default,
 * region-less singleton).
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

export async function listFoundationModels(
  input: ListFoundationModelsCommandInput = {},
  region?: string
): Promise<ListFoundationModelsCommandOutput> {
  return getBedrockClient(region).send(new ListFoundationModelsCommand(input));
}

export async function listInferenceProfiles(
  input: ListInferenceProfilesCommandInput = {},
  region?: string
): Promise<ListInferenceProfilesCommandOutput> {
  return getBedrockClient(region).send(new ListInferenceProfilesCommand(input));
}
