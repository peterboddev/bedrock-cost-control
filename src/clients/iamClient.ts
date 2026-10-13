/**
 * Thin AWS SDK v3 wrapper around the IAM client.
 *
 * Centralizing client construction here lets every component share one
 * configured client (and lets tests substitute a mock/fake) without each
 * module reaching into the SDK directly.
 */
import {
  IAMClient,
  GetRoleCommand,
  GetRoleCommandInput,
  GetRoleCommandOutput,
  ListRoleTagsCommand,
  ListRoleTagsCommandInput,
  ListRoleTagsCommandOutput,
  PutRolePolicyCommand,
  PutRolePolicyCommandInput,
  PutRolePolicyCommandOutput,
  DeleteRolePolicyCommand,
  DeleteRolePolicyCommandInput,
  DeleteRolePolicyCommandOutput,
  ListRolesCommand,
  ListRolesCommandInput,
  ListRolesCommandOutput,
} from "@aws-sdk/client-iam";

let iamClient: IAMClient | undefined;

/**
 * Returns a process-wide singleton IAM client.
 */
export function getIamClient(): IAMClient {
  if (!iamClient) {
    iamClient = new IAMClient({});
  }
  return iamClient;
}

/**
 * Allows tests to inject a fake/mock IAM client.
 */
export function setIamClient(client: IAMClient): void {
  iamClient = client;
}

export async function getRole(input: GetRoleCommandInput): Promise<GetRoleCommandOutput> {
  return getIamClient().send(new GetRoleCommand(input));
}

export async function listRoleTags(
  input: ListRoleTagsCommandInput
): Promise<ListRoleTagsCommandOutput> {
  return getIamClient().send(new ListRoleTagsCommand(input));
}

export async function putRolePolicy(
  input: PutRolePolicyCommandInput
): Promise<PutRolePolicyCommandOutput> {
  return getIamClient().send(new PutRolePolicyCommand(input));
}

export async function deleteRolePolicy(
  input: DeleteRolePolicyCommandInput
): Promise<DeleteRolePolicyCommandOutput> {
  try {
    return await getIamClient().send(new DeleteRolePolicyCommand(input));
  } catch (error) {
    // Idempotent delete: an inline deny policy that is already absent (or whose
    // role is gone) is the desired end state for every caller here (Daily_Reset,
    // the admin `removeDenyPolicy` override, and the enforcer's
    // remove-on-config-change). Treating `NoSuchEntity` as success stops a
    // never-attached or already-removed policy from failing the reset and
    // stranding Blocked_State in PENDING_RESET. See
    // MANTLE_ENFORCEMENT_PROPOSAL.md Finding C.
    if ((error as { name?: string } | undefined)?.name === "NoSuchEntityException") {
      return {} as DeleteRolePolicyCommandOutput;
    }
    throw error;
  }
}

export async function listRoles(
  input: ListRolesCommandInput
): Promise<ListRolesCommandOutput> {
  return getIamClient().send(new ListRolesCommand(input));
}
