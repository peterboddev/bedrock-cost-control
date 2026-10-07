/**
 * Lists the models available on the Amazon Bedrock **Mantle** endpoint
 * (`bedrock-mantle.{region}.api.aws`) via its OpenAI-compatible
 * `GET /v1/models` operation.
 *
 * Unlike the control-plane `ListFoundationModels`/`ListInferenceProfiles`
 * calls (which are AWS SDK / SigV4), the Mantle model-list endpoint is a
 * data-plane HTTP API that authenticates with a **bearer token**. We mint a
 * SHORT-LIVED, IAM-derived Bedrock bearer token with the official
 * `@aws/bedrock-token-generator` (`getToken`) using the Lambda's own
 * credentials — so there is NO long-lived stored secret: the token is created
 * on demand from the execution role and expires within 12 hours.
 *
 * Mantle has no cross-region/global inference profiles (that is a
 * bedrock-runtime capability), so every id returned here is a plain,
 * `regional` model id named directly in a request.
 */
import { getToken } from '@aws/bedrock-token-generator';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';

/** A minimal shape of the OpenAI-compatible `GET /v1/models` response. */
interface OpenAiModelsResponse {
  data?: Array<{ id?: string }>;
}

/** Injectable seams so tests don't perform real network / token calls. */
export interface ListMantleModelsDeps {
  /** Mints a bearer token; defaults to the IAM-derived `@aws/bedrock-token-generator`. */
  mintToken?: (region: string) => Promise<string>;
  /** HTTP fetch; defaults to the global `fetch` (Node 20+/Lambda nodejs22). */
  fetchFn?: typeof fetch;
  /** AWS credentials/provider for token minting; defaults to the ambient chain. */
  credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider;
}

function mantleBaseUrl(region: string): string {
  return `https://bedrock-mantle.${region}.api.aws`;
}

/**
 * Returns the model ids available on the Mantle endpoint in `region`.
 * Throws if the token mint or HTTP call fails (the caller surfaces it as an
 * AdminApiFailure).
 */
export async function listMantleModels(
  region: string,
  deps: ListMantleModelsDeps = {}
): Promise<string[]> {
  const fetchFn = deps.fetchFn ?? fetch;
  const mintToken =
    deps.mintToken ??
    ((r: string) =>
      getToken({
        region: r,
        // When no explicit credentials are provided, fall back to the ambient
        // provider chain (the Lambda execution role). A no-arg provider that
        // defers to the default chain keeps us free of an extra SDK dep.
        credentials:
          deps.credentials ??
          (defaultCredentialsProvider as AwsCredentialIdentityProvider),
      }));

  const token = await mintToken(region);
  const response = await fetchFn(`${mantleBaseUrl(region)}/v1/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await safeText(response);
    throw new Error(`Mantle GET /v1/models failed: HTTP ${response.status} ${body.slice(0, 200)}`);
  }

  const json = (await response.json()) as OpenAiModelsResponse;
  return (json.data ?? [])
    .map((m) => m.id ?? '')
    .filter((id) => id.length > 0);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * A credentials provider that defers to the AWS SDK's ambient resolution (the
 * same chain the SDK clients use in Lambda: the execution-role credentials
 * from the environment). Implemented by reading from `process.env` via the
 * standard variables the Lambda runtime injects, with the token generator
 * handling the actual signing. If richer resolution is needed, callers can
 * pass an explicit `credentials` provider in deps.
 */
const defaultCredentialsProvider: AwsCredentialIdentityProvider = async () => {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'No AWS credentials available in the environment to mint a Mantle bearer token'
    );
  }
  return { accessKeyId, secretAccessKey, sessionToken };
};
