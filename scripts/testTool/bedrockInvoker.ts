/**
 * Sends real Bedrock Converse invocations using the assumed
 * Bedrock_Test_Role's temporary credentials, and reports the token usage
 * from each response.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConversationRole,
} from '@aws-sdk/client-bedrock-runtime';

import { AssumedCredentials } from './assumeRole';

export interface InvocationResult {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  outputPreview: string;
}

/**
 * Builds a `BedrockRuntimeClient` authenticated as the assumed test role's
 * temporary credentials, rather than the operator's own identity - this is
 * what makes the test tool exercise the exact same attribution path a real
 * application's Bedrock calls would (CloudTrail/Model Invocation Logging's
 * `identity.arn` will show the assumed-role session, and Usage_Collector
 * resolves it back to the underlying Bedrock_Test_Role, per Requirement 2.6).
 */
export function buildBedrockRuntimeClient(
  credentials: AssumedCredentials,
  region: string
): BedrockRuntimeClient {
  return new BedrockRuntimeClient({
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });
}

/**
 * Sends a single Converse invocation with a fixed, deliberately verbose
 * prompt (so each call consumes a meaningful, non-trivial number of
 * tokens, making it practical to reach a small test quota in a handful of
 * calls) and returns the token usage reported in the response.
 */
export async function invokeOnce(
  client: BedrockRuntimeClient,
  modelId: string,
  promptText: string
): Promise<InvocationResult> {
  const response = await client.send(
    new ConverseCommand({
      modelId,
      messages: [
        {
          role: ConversationRole.USER,
          content: [{ text: promptText }],
        },
      ],
      inferenceConfig: { maxTokens: 256 },
    })
  );

  const usage = response.usage;
  const outputText =
    response.output?.message?.content
      ?.map((block) => block.text)
      .filter((text): text is string => typeof text === 'string')
      .join(' ') ?? '';

  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
    outputPreview: outputText.slice(0, 160),
  };
}
