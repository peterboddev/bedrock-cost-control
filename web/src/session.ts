/**
 * Bridges Amplify's authenticated session to the Admin API client.
 *
 * After a user signs in, the Cognito Identity Pool vends short-lived AWS
 * credentials for the scoped authenticated role. We read those fresh on every
 * call (Amplify refreshes them transparently when they near expiry) and hand
 * them, plus the configured endpoint/region, to the SigV4 client.
 */
import { fetchAuthSession } from "aws-amplify/auth";

import { AdminConnection } from "./api";
import { config } from "./config";

export async function currentConnection(): Promise<AdminConnection> {
  const session = await fetchAuthSession();
  const creds = session.credentials;
  if (!creds) {
    throw new Error(
      "No AWS credentials in session. Sign out and sign in again."
    );
  }
  return {
    endpoint: config.adminApiEndpoint,
    region: config.region,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  };
}
