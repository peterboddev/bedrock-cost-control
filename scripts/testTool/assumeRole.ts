/**
 * Assumes the given IAM role (the Bedrock_Test_Role this stack creates,
 * or any other role the operator points the test tool at) via
 * `sts:AssumeRole`, and returns temporary credentials suitable for
 * constructing a `BedrockRuntimeClient`.
 */
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

export interface AssumedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

const SESSION_NAME_PREFIX = 'bedrock-token-quota-test';

export async function assumeTestRole(
  roleArn: string,
  region: string,
  durationSeconds = 3600
): Promise<AssumedCredentials> {
  const client = new STSClient({ region });

  const response = await client.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `${SESSION_NAME_PREFIX}-${Date.now()}`,
      DurationSeconds: durationSeconds,
    })
  );

  const credentials = response.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
    throw new Error(`AssumeRole for ${roleArn} did not return usable credentials`);
  }

  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
    expiration: credentials.Expiration,
  };
}
