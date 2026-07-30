/**
 * Utilities for resolving IAM principal ARNs (as seen in Bedrock Model
 * Invocation Log entries and CloudTrail `userIdentity` fields) to the
 * underlying IAM role ARN.
 *
 * Requirements: 2.2, 2.6
 */

/**
 * Matches an STS assumed-role session ARN:
 *   arn:aws:sts::<account>:assumed-role/<RoleName>/<SessionName>
 *
 * Captures the account ID, role name, and session name.
 */
const ASSUMED_ROLE_ARN_PATTERN =
  /^arn:aws:sts::(\d{12}):assumed-role\/([^/]+)\/([^/]+)$/;

/**
 * Resolves a principal ARN to the underlying IAM role ARN.
 *
 * If `principalArn` is an STS assumed-role session ARN of the form
 * `arn:aws:sts::<account>:assumed-role/<RoleName>/<SessionName>`, this
 * returns the underlying IAM role ARN
 * `arn:aws:iam::<account>:role/<RoleName>`.
 *
 * Any other ARN (already an IAM role/user ARN, or any other principal ARN
 * shape) is returned unchanged.
 *
 * @param principalArn The invoking principal ARN from a log entry.
 * @returns The resolved underlying IAM role ARN, or `principalArn` unchanged.
 */
export function resolveUnderlyingRoleArn(principalArn: string): string {
  const match = ASSUMED_ROLE_ARN_PATTERN.exec(principalArn);
  if (!match) {
    return principalArn;
  }

  const [, accountId, roleName] = match;
  return `arn:aws:iam::${accountId}:role/${roleName}`;
}

/**
 * Extracts the role name from an IAM role ARN of the form
 * `arn:aws:iam::<account>:role/<RoleName>` (including roles with a path,
 * e.g. `arn:aws:iam::<account>:role/path/to/<RoleName>`), for use in IAM
 * API calls that take a `RoleName` rather than a full ARN (e.g.
 * `PutRolePolicy`, `GetRole`).
 */
export function extractRoleNameFromArn(roleArn: string): string {
  const marker = ':role/';
  const markerIndex = roleArn.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Not an IAM role ARN: ${roleArn}`);
  }
  const afterMarker = roleArn.slice(markerIndex + marker.length);
  const lastSlashIndex = afterMarker.lastIndexOf('/');
  return lastSlashIndex === -1 ? afterMarker : afterMarker.slice(lastSlashIndex + 1);
}
