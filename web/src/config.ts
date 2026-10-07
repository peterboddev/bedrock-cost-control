/**
 * Runtime configuration, injected at build time from Vite env vars
 * (see web/.env, generated from the CDK stack outputs).
 */
export const config = {
  region: import.meta.env.VITE_AWS_REGION ?? "us-east-2",
  adminApiEndpoint: import.meta.env.VITE_ADMIN_API_ENDPOINT ?? "",
  userPoolId: import.meta.env.VITE_USER_POOL_ID ?? "",
  userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID ?? "",
  identityPoolId: import.meta.env.VITE_IDENTITY_POOL_ID ?? "",
};

export function assertConfigured(): string | null {
  const missing = Object.entries(config)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return missing.length ? `Missing configuration: ${missing.join(", ")}` : null;
}
