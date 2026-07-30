import * as fc from 'fast-check';

import { resolveUnderlyingRoleArn } from './arnResolver';

const accountId = () => fc.stringOf(fc.constantFrom(...'0123456789'), { minLength: 12, maxLength: 12 });

const iamNameSegment = () =>
  fc.stringOf(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+=,.@_-'),
    { minLength: 1, maxLength: 30 },
  );

const nonAssumedRoleArn = () =>
  fc.oneof(
    fc.tuple(accountId(), iamNameSegment()).map(([account, roleName]) => `arn:aws:iam::${account}:role/${roleName}`),
    fc.tuple(accountId(), iamNameSegment()).map(([account, userName]) => `arn:aws:iam::${account}:user/${userName}`),
    fc.constantFrom('not-an-arn', '', 'arn:aws:sts::123456789012:assumed-role/', 'arn:aws:sts::123:assumed-role/Foo/Bar'),
  );

describe('resolveUnderlyingRoleArn', () => {
  // Validates: Requirements 2.2, 2.6
  test('Property 7: Assumed-role ARN resolution - assumed-role session ARNs resolve to the underlying IAM role ARN', () => {
    fc.assert(
      fc.property(accountId(), iamNameSegment(), iamNameSegment(), (account, roleName, sessionName) => {
        const principalArn = `arn:aws:sts::${account}:assumed-role/${roleName}/${sessionName}`;
        const resolved = resolveUnderlyingRoleArn(principalArn);

        expect(resolved).toBe(`arn:aws:iam::${account}:role/${roleName}`);
      }),
    );
  });

  // Validates: Requirements 2.2, 2.6
  test('Property 7: Assumed-role ARN resolution - non-assumed-role ARNs are returned unchanged', () => {
    fc.assert(
      fc.property(nonAssumedRoleArn(), (principalArn) => {
        const resolved = resolveUnderlyingRoleArn(principalArn);

        expect(resolved).toBe(principalArn);
      }),
    );
  });

  test('resolves a concrete example assumed-role session ARN', () => {
    const resolved = resolveUnderlyingRoleArn(
      'arn:aws:sts::123456789012:assumed-role/MyRole/session-name',
    );

    expect(resolved).toBe('arn:aws:iam::123456789012:role/MyRole');
  });

  test('returns an already-resolved IAM role ARN unchanged', () => {
    const roleArn = 'arn:aws:iam::123456789012:role/MyRole';

    expect(resolveUnderlyingRoleArn(roleArn)).toBe(roleArn);
  });

  test('returns an IAM user ARN unchanged', () => {
    const userArn = 'arn:aws:iam::123456789012:user/alice';

    expect(resolveUnderlyingRoleArn(userArn)).toBe(userArn);
  });
});
