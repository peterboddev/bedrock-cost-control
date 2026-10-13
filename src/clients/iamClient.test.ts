import type { IAMClient } from '@aws-sdk/client-iam';
import { deleteRolePolicy, setIamClient } from './iamClient';

/** Minimal fake IAM client whose `send` is driven by the provided impl. */
function fakeIamClient(send: () => Promise<unknown>): IAMClient {
  return { send: jest.fn(send) } as unknown as IAMClient;
}

describe('deleteRolePolicy (idempotent)', () => {
  it('resolves when the inline policy is already absent (NoSuchEntityException)', async () => {
    const err = Object.assign(new Error('policy not found'), { name: 'NoSuchEntityException' });
    setIamClient(fakeIamClient(async () => Promise.reject(err)));

    // A never-attached / already-removed deny policy must NOT throw — otherwise
    // Daily_Reset / removeDenyPolicy strands Blocked_State in PENDING_RESET.
    await expect(
      deleteRolePolicy({ RoleName: 'R', PolicyName: 'bedrock-mantle-quota-deny-x' })
    ).resolves.toBeDefined();
  });

  it('rethrows errors other than NoSuchEntityException', async () => {
    const err = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    setIamClient(fakeIamClient(async () => Promise.reject(err)));

    await expect(
      deleteRolePolicy({ RoleName: 'R', PolicyName: 'P' })
    ).rejects.toThrow('Rate exceeded');
  });

  it('returns the SDK output on success', async () => {
    const output = { $metadata: { httpStatusCode: 200 } };
    setIamClient(fakeIamClient(async () => output));

    await expect(deleteRolePolicy({ RoleName: 'R', PolicyName: 'P' })).resolves.toEqual(output);
  });
});
