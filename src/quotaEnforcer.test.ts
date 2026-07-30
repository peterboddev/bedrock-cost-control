import { AttributeValue } from '@aws-sdk/client-dynamodb';
import * as fc from 'fast-check';

import {
  buildModelDenyPolicyDocument,
  buildModelDenyPolicyName,
  evaluateUsageAggregationChange,
  getBlockedState,
  handleUsageAggregationStreamEvent,
  UsageAggregationStreamEvent,
} from './quotaEnforcer';
import * as dynamoDbClient from './clients/dynamoDbClient';
import * as iamClient from './clients/iamClient';
import * as teamRoleCache from './teamRoleCache';
import * as quotaConfigStore from './quotaConfigStore';
import * as auditLog from './auditLog';
import * as notifications from './notifications';

jest.mock('./clients/dynamoDbClient', () => ({
  getItem: jest.fn(),
  putItem: jest.fn(),
  deleteItem: jest.fn(),
}));

jest.mock('./clients/iamClient', () => ({
  putRolePolicy: jest.fn(),
  deleteRolePolicy: jest.fn(),
}));

jest.mock('./teamRoleCache', () => ({
  listRolesForTeam: jest.fn(),
}));

jest.mock('./quotaConfigStore', () => ({
  getQuota: jest.fn(),
}));

jest.mock('./auditLog', () => ({
  writeAuditEntry: jest.fn(),
}));

jest.mock('./notifications', () => ({
  publishNotification: jest.fn(),
}));

const mockedGetItem = dynamoDbClient.getItem as jest.Mock;
const mockedPutItem = dynamoDbClient.putItem as jest.Mock;
const mockedDeleteItem = dynamoDbClient.deleteItem as jest.Mock;
const mockedPutRolePolicy = iamClient.putRolePolicy as jest.Mock;
const mockedDeleteRolePolicy = iamClient.deleteRolePolicy as jest.Mock;
const mockedListRolesForTeam = teamRoleCache.listRolesForTeam as jest.Mock;
const mockedGetQuota = quotaConfigStore.getQuota as jest.Mock;
const mockedWriteAuditEntry = auditLog.writeAuditEntry as jest.Mock;
const mockedPublishNotification = notifications.publishNotification as jest.Mock;

const BASE_OPTIONS = {
  quotaConfigTableName: 'QuotaConfiguration',
  blockedStateTableName: 'BlockedState',
  teamRoleCacheTableName: 'TeamRoleCache',
  auditLogTableName: 'AuditLog',
  now: () => new Date('2025-01-15T12:00:00.000Z'),
};

describe('buildModelDenyPolicyDocument', () => {
  it('denies exactly the four Bedrock invocation actions, scoped to the specific model', () => {
    const doc = buildModelDenyPolicyDocument('anthropic.claude-v2');

    expect(doc.Version).toBe('2012-10-17');
    expect(doc.Statement).toHaveLength(1);
    expect(doc.Statement[0].Sid).toBe('BedrockTeamTokenQuotaDeny');
    expect(doc.Statement[0].Effect).toBe('Deny');
    expect(doc.Statement[0].Action).toEqual([
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
      'bedrock:Converse',
      'bedrock:ConverseStream',
    ]);
    expect(doc.Statement[0].Resource).toBe(
      'arn:aws:bedrock:*::foundation-model/anthropic.claude-v2'
    );
  });

  it('uses an already-ARN model identifier as-is for the Resource', () => {
    const arnModel = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/my-profile';
    const doc = buildModelDenyPolicyDocument(arnModel);
    expect(doc.Statement[0].Resource).toBe(arnModel);
  });
});

describe('buildModelDenyPolicyName', () => {
  it('is deterministic for the same model', () => {
    expect(buildModelDenyPolicyName('anthropic.claude-v2')).toBe(
      buildModelDenyPolicyName('anthropic.claude-v2')
    );
  });

  it('differs for different models', () => {
    expect(buildModelDenyPolicyName('anthropic.claude-v2')).not.toBe(
      buildModelDenyPolicyName('anthropic.claude-3')
    );
  });
});

describe('getBlockedState', () => {
  beforeEach(() => {
    mockedGetItem.mockReset();
  });

  it('reads via a targeted GetItem on the Blocked_State primary key', async () => {
    mockedGetItem.mockResolvedValue({
      Item: {
        PK: 'TEAM#teamA',
        SK: 'MODEL#modelX',
        status: 'BLOCKED',
        blockedUsageDay: '2025-01-15',
        blockedAt: '2025-01-15T00:00:00.000Z',
        statusDay: 'BLOCKED#2025-01-15',
      },
    });

    const result = await getBlockedState('teamA', 'modelX', 'BlockedState');

    expect(mockedGetItem).toHaveBeenCalledWith({
      TableName: 'BlockedState',
      Key: { PK: 'TEAM#teamA', SK: 'MODEL#modelX' },
    });
    expect(result?.status).toBe('BLOCKED');
  });

  it('returns undefined when no Blocked_State entry exists', async () => {
    mockedGetItem.mockResolvedValue({});
    const result = await getBlockedState('teamA', 'modelX', 'BlockedState');
    expect(result).toBeUndefined();
  });
});

describe('evaluateUsageAggregationChange', () => {
  beforeEach(() => {
    mockedGetItem.mockReset();
    mockedPutItem.mockReset();
    mockedPutRolePolicy.mockReset();
    mockedListRolesForTeam.mockReset();
    mockedGetQuota.mockReset();
    mockedWriteAuditEntry.mockReset();
    mockedPublishNotification.mockReset();

    // Not Blocked_State by default, so the remove-on-config-change path
    // (which also reads Blocked_State) is a no-op unless a test overrides this.
    mockedGetItem.mockResolvedValue({});
    mockedPutItem.mockResolvedValue({});
    mockedPutRolePolicy.mockResolvedValue({});
    mockedWriteAuditEntry.mockResolvedValue(undefined);
    mockedPublishNotification.mockResolvedValue(undefined);
  });

  it('takes no action when no quota is configured', async () => {
    mockedGetQuota.mockResolvedValue(undefined);

    await evaluateUsageAggregationChange('teamA', 'modelX', '2025-01-15', 999999, BASE_OPTIONS);

    expect(mockedListRolesForTeam).not.toHaveBeenCalled();
    expect(mockedPutRolePolicy).not.toHaveBeenCalled();
    expect(mockedPutItem).not.toHaveBeenCalled();
    expect(mockedPublishNotification).not.toHaveBeenCalled();
  });

  it('takes no action when the configured quota is zero', async () => {
    mockedGetQuota.mockResolvedValue(0);

    await evaluateUsageAggregationChange('teamA', 'modelX', '2025-01-15', 999999, BASE_OPTIONS);

    expect(mockedListRolesForTeam).not.toHaveBeenCalled();
    expect(mockedPutRolePolicy).not.toHaveBeenCalled();
  });

  it('takes no action when the running total is below the quota', async () => {
    mockedGetQuota.mockResolvedValue(1000);

    await evaluateUsageAggregationChange('teamA', 'modelX', '2025-01-15', 500, BASE_OPTIONS);

    expect(mockedListRolesForTeam).not.toHaveBeenCalled();
    expect(mockedPutRolePolicy).not.toHaveBeenCalled();
  });

  it('takes no action when the team is already Blocked_State for the model', async () => {
    mockedGetQuota.mockResolvedValue(1000);
    mockedGetItem.mockResolvedValue({
      Item: { PK: 'TEAM#teamA', SK: 'MODEL#modelX', status: 'BLOCKED' },
    });

    await evaluateUsageAggregationChange('teamA', 'modelX', '2025-01-15', 1500, BASE_OPTIONS);

    expect(mockedListRolesForTeam).not.toHaveBeenCalled();
    expect(mockedPutRolePolicy).not.toHaveBeenCalled();
  });

  it('attaches the deny policy to every mapped role, records Blocked_State, audits, and notifies on breach', async () => {
    mockedGetQuota.mockResolvedValue(1000);
    mockedGetItem.mockResolvedValue({});
    mockedListRolesForTeam.mockResolvedValue([
      'arn:aws:iam::123456789012:role/RoleA',
      'arn:aws:iam::123456789012:role/RoleB',
    ]);

    await evaluateUsageAggregationChange('teamA', 'modelX', '2025-01-15', 1500, BASE_OPTIONS);

    expect(mockedListRolesForTeam).toHaveBeenCalledWith('teamA', { tableName: 'TeamRoleCache' });

    expect(mockedPutRolePolicy).toHaveBeenCalledTimes(2);
    expect(mockedPutRolePolicy).toHaveBeenNthCalledWith(1, {
      RoleName: 'RoleA',
      PolicyName: expect.stringContaining('bedrock-quota-deny-'),
      PolicyDocument: expect.stringContaining('BedrockTeamTokenQuotaDeny'),
    });
    expect(mockedPutRolePolicy).toHaveBeenNthCalledWith(2, {
      RoleName: 'RoleB',
      PolicyName: expect.stringContaining('bedrock-quota-deny-'),
      PolicyDocument: expect.stringContaining('BedrockTeamTokenQuotaDeny'),
    });

    expect(mockedWriteAuditEntry).toHaveBeenCalledTimes(2);
    expect(mockedWriteAuditEntry).toHaveBeenNthCalledWith(
      1,
      'teamA',
      'modelX',
      'arn:aws:iam::123456789012:role/RoleA',
      'ATTACH_DENY',
      1500,
      1000,
      '2025-01-15T12:00:00.000Z',
      { tableName: 'AuditLog' }
    );
    expect(mockedWriteAuditEntry).toHaveBeenNthCalledWith(
      2,
      'teamA',
      'modelX',
      'arn:aws:iam::123456789012:role/RoleB',
      'ATTACH_DENY',
      1500,
      1000,
      '2025-01-15T12:00:00.000Z',
      { tableName: 'AuditLog' }
    );

    expect(mockedPutItem).toHaveBeenCalledTimes(1);
    const blockedStateCall = mockedPutItem.mock.calls[0][0];
    expect(blockedStateCall.TableName).toBe('BlockedState');
    expect(blockedStateCall.Item).toMatchObject({
      PK: 'TEAM#teamA',
      SK: 'MODEL#modelX',
      status: 'BLOCKED',
      blockedUsageDay: '2025-01-15',
      statusDay: 'BLOCKED#2025-01-15',
    });

    expect(mockedPublishNotification).toHaveBeenCalledWith('blocked', 'teamA', 'modelX', 1000, {
      topicArn: undefined,
    });
  });

  it('treats running total exactly equal to the quota as a breach', async () => {
    mockedGetQuota.mockResolvedValue(1000);
    mockedGetItem.mockResolvedValue({});
    mockedListRolesForTeam.mockResolvedValue(['arn:aws:iam::123456789012:role/RoleA']);

    await evaluateUsageAggregationChange('teamA', 'modelX', '2025-01-15', 1000, BASE_OPTIONS);

    expect(mockedPutRolePolicy).toHaveBeenCalledTimes(1);
    expect(mockedPutItem).toHaveBeenCalledTimes(1);
  });

  it('records a permanent-failure audit entry per role when PutRolePolicy exhausts retries', async () => {
    mockedGetQuota.mockResolvedValue(1000);
    mockedGetItem.mockResolvedValue({});
    mockedListRolesForTeam.mockResolvedValue(['arn:aws:iam::123456789012:role/RoleA']);
    mockedPutRolePolicy.mockRejectedValue(new Error('AccessDenied'));

    await evaluateUsageAggregationChange('teamA', 'modelX', '2025-01-15', 1500, {
      ...BASE_OPTIONS,
      retryOptions: { maxAttempts: 1, sleep: async () => {} },
    });

    expect(mockedWriteAuditEntry).toHaveBeenCalledTimes(1);
    expect(mockedWriteAuditEntry).toHaveBeenCalledWith(
      'teamA',
      'modelX',
      'arn:aws:iam::123456789012:role/RoleA',
      'ATTACH_DENY_FAILED',
      1500,
      1000,
      '2025-01-15T12:00:00.000Z',
      { tableName: 'AuditLog' }
    );
    // Blocked_State is still recorded and the notification is still published,
    // matching design.md's sequence diagram (the Blocked_State write and
    // notification happen once after the per-role loop).
    expect(mockedPutItem).toHaveBeenCalledTimes(1);
    expect(mockedPublishNotification).toHaveBeenCalledTimes(1);
  });
});

describe('evaluateUsageAggregationChange - remove-on-config-change path', () => {
  beforeEach(() => {
    mockedGetItem.mockReset();
    mockedPutItem.mockReset();
    mockedDeleteItem.mockReset();
    mockedPutRolePolicy.mockReset();
    mockedDeleteRolePolicy.mockReset();
    mockedListRolesForTeam.mockReset();
    mockedGetQuota.mockReset();
    mockedWriteAuditEntry.mockReset();
    mockedPublishNotification.mockReset();

    mockedDeleteItem.mockResolvedValue({});
    mockedDeleteRolePolicy.mockResolvedValue({});
    mockedWriteAuditEntry.mockResolvedValue(undefined);
    mockedPublishNotification.mockResolvedValue(undefined);
  });

  it('removes the deny policy from every mapped role and clears Blocked_State when the quota is removed', async () => {
    mockedGetQuota.mockResolvedValue(undefined);
    mockedGetItem.mockResolvedValue({ Item: { status: 'BLOCKED' } });
    mockedListRolesForTeam.mockResolvedValue([
      'arn:aws:iam::123456789012:role/RoleA',
      'arn:aws:iam::123456789012:role/RoleB',
    ]);

    await evaluateUsageAggregationChange('teamA', 'modelX', '2025-01-15', 1500, BASE_OPTIONS);

    expect(mockedDeleteRolePolicy).toHaveBeenCalledTimes(2);
    expect(mockedDeleteRolePolicy).toHaveBeenNthCalledWith(1, {
      RoleName: 'RoleA',
      PolicyName: buildModelDenyPolicyName('modelX'),
    });
    expect(mockedDeleteRolePolicy).toHaveBeenNthCalledWith(2, {
      RoleName: 'RoleB',
      PolicyName: buildModelDenyPolicyName('modelX'),
    });

    expect(mockedWriteAuditEntry).toHaveBeenCalledTimes(2);
    expect(mockedWriteAuditEntry).toHaveBeenNthCalledWith(
      1,
      'teamA',
      'modelX',
      'arn:aws:iam::123456789012:role/RoleA',
      'REMOVE_DENY',
      1500,
      null,
      '2025-01-15T12:00:00.000Z',
      { tableName: 'AuditLog' }
    );

    expect(mockedDeleteItem).toHaveBeenCalledTimes(1);
    expect(mockedDeleteItem).toHaveBeenCalledWith({
      TableName: 'BlockedState',
      Key: { PK: 'TEAM#teamA', SK: 'MODEL#modelX' },
    });

    expect(mockedPublishNotification).toHaveBeenCalledWith('restored', 'teamA', 'modelX', undefined, {
      topicArn: undefined,
    });
    expect(mockedPutRolePolicy).not.toHaveBeenCalled();
  });

  it('removes the deny policy and clears Blocked_State when the running total drops below the quota', async () => {
    mockedGetQuota.mockResolvedValue(1000);
    mockedGetItem.mockResolvedValue({ Item: { status: 'BLOCKED' } });
    mockedListRolesForTeam.mockResolvedValue(['arn:aws:iam::123456789012:role/RoleA']);

    await evaluateUsageAggregationChange('teamA', 'modelX', '2025-01-15', 500, BASE_OPTIONS);

    expect(mockedDeleteRolePolicy).toHaveBeenCalledTimes(1);
    expect(mockedDeleteItem).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the quota is removed but the team is not currently Blocked_State for the model', async () => {
    mockedGetQuota.mockResolvedValue(undefined);
    mockedGetItem.mockResolvedValue({});

    await evaluateUsageAggregationChange('teamA', 'modelX', '2025-01-15', 1500, BASE_OPTIONS);

    expect(mockedListRolesForTeam).not.toHaveBeenCalled();
    expect(mockedDeleteRolePolicy).not.toHaveBeenCalled();
    expect(mockedDeleteItem).not.toHaveBeenCalled();
  });

  it('leaves Blocked_State in place and writes REMOVE_DENY_FAILED when DeleteRolePolicy permanently fails', async () => {
    mockedGetQuota.mockResolvedValue(undefined);
    mockedGetItem.mockResolvedValue({ Item: { status: 'BLOCKED' } });
    mockedListRolesForTeam.mockResolvedValue(['arn:aws:iam::123456789012:role/RoleA']);
    mockedDeleteRolePolicy.mockRejectedValue(new Error('AccessDenied'));

    await evaluateUsageAggregationChange('teamA', 'modelX', '2025-01-15', 1500, {
      ...BASE_OPTIONS,
      retryOptions: { maxAttempts: 1, sleep: async () => {} },
    });

    expect(mockedWriteAuditEntry).toHaveBeenCalledWith(
      'teamA',
      'modelX',
      'arn:aws:iam::123456789012:role/RoleA',
      'REMOVE_DENY_FAILED',
      1500,
      null,
      '2025-01-15T12:00:00.000Z',
      { tableName: 'AuditLog' }
    );
    expect(mockedDeleteItem).not.toHaveBeenCalled();
    expect(mockedPublishNotification).not.toHaveBeenCalled();
  });
});

const teamArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);
const modelArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => s.trim().length > 0 && !s.startsWith('arn:'));
const roleArnArb = fc
  .tuple(
    fc.stringOf(fc.constantFrom(...'0123456789'), { minLength: 12, maxLength: 12 }),
    fc.stringOf(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'), {
      minLength: 1,
      maxLength: 20,
    })
  )
  .map(([account, roleName]) => `arn:aws:iam::${account}:role/${roleName}`);

describe('evaluateUsageAggregationChange - Property 16: Per-model policy isolation on attach and remove', () => {
  const ROLE_ARN = 'arn:aws:iam::123456789012:role/RoleA';

  beforeEach(() => {
    mockedGetItem.mockReset();
    mockedPutItem.mockReset();
    mockedDeleteItem.mockReset();
    mockedPutRolePolicy.mockReset();
    mockedDeleteRolePolicy.mockReset();
    mockedListRolesForTeam.mockReset();
    mockedGetQuota.mockReset();
    mockedWriteAuditEntry.mockReset();
    mockedPublishNotification.mockReset();

    mockedPutItem.mockResolvedValue({});
    mockedDeleteItem.mockResolvedValue({});
    mockedWriteAuditEntry.mockResolvedValue(undefined);
    mockedPublishNotification.mockResolvedValue(undefined);
    mockedListRolesForTeam.mockResolvedValue([ROLE_ARN]);
  });

  const preexistingModelsArb = fc.uniqueArray(modelArb, { minLength: 1, maxLength: 5 });

  // Validates: Requirements 5.3, 6.3
  it('attaching a deny for one Model leaves every other Model already denied on that role unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(teamArb, preexistingModelsArb, modelArb, async (team, preexistingModels, targetModel) => {
        fc.pre(!preexistingModels.includes(targetModel));

        mockedPutRolePolicy.mockReset();
        mockedDeleteRolePolicy.mockReset();
        mockedPutRolePolicy.mockResolvedValue({});
        mockedDeleteRolePolicy.mockResolvedValue({});

        mockedGetQuota.mockResolvedValue(100);
        mockedGetItem.mockResolvedValue({});

        await evaluateUsageAggregationChange(team, targetModel, '2025-01-15', 200, BASE_OPTIONS);

        expect(mockedPutRolePolicy).toHaveBeenCalledTimes(1);
        expect(mockedPutRolePolicy.mock.calls[0][0]).toMatchObject({
          PolicyName: buildModelDenyPolicyName(targetModel),
        });

        for (const model of preexistingModels) {
          const policyName = buildModelDenyPolicyName(model);
          const wasTouched = [...mockedPutRolePolicy.mock.calls, ...mockedDeleteRolePolicy.mock.calls].some(
            (call) => call[0].PolicyName === policyName
          );
          expect(wasTouched).toBe(false);
        }
      })
    );
  });

  // Validates: Requirements 5.3, 6.3
  it('removing a deny for one Model leaves every other Model already denied on that role unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(teamArb, preexistingModelsArb, fc.nat(), async (team, preexistingModels, rawIndex) => {
        mockedPutRolePolicy.mockReset();
        mockedDeleteRolePolicy.mockReset();
        mockedPutRolePolicy.mockResolvedValue({});
        mockedDeleteRolePolicy.mockResolvedValue({});

        const targetIndex = rawIndex % preexistingModels.length;
        const targetModel = preexistingModels[targetIndex];
        const otherModels = preexistingModels.filter((_, i) => i !== targetIndex);

        mockedGetQuota.mockResolvedValue(undefined);
        mockedGetItem.mockResolvedValue({ Item: { status: 'BLOCKED' } });

        await evaluateUsageAggregationChange(team, targetModel, '2025-01-15', 1500, BASE_OPTIONS);

        expect(mockedDeleteRolePolicy).toHaveBeenCalledTimes(1);
        expect(mockedDeleteRolePolicy.mock.calls[0][0]).toMatchObject({
          PolicyName: buildModelDenyPolicyName(targetModel),
        });

        for (const model of otherModels) {
          const policyName = buildModelDenyPolicyName(model);
          const wasTouched = [...mockedPutRolePolicy.mock.calls, ...mockedDeleteRolePolicy.mock.calls].some(
            (call) => call[0].PolicyName === policyName
          );
          expect(wasTouched).toBe(false);
        }
      })
    );
  });
});

describe('evaluateUsageAggregationChange - Property 17: Deny attachment retries and records permanent failure', () => {
  beforeEach(() => {
    mockedGetItem.mockReset();
    mockedPutItem.mockReset();
    mockedDeleteItem.mockReset();
    mockedPutRolePolicy.mockReset();
    mockedDeleteRolePolicy.mockReset();
    mockedListRolesForTeam.mockReset();
    mockedGetQuota.mockReset();
    mockedWriteAuditEntry.mockReset();
    mockedPublishNotification.mockReset();

    mockedPutItem.mockResolvedValue({});
    mockedWriteAuditEntry.mockResolvedValue(undefined);
    mockedPublishNotification.mockResolvedValue(undefined);
  });

  const maxAttemptsArb = fc.integer({ min: 1, max: 5 });
  const failuresBeforeSuccessArb = fc.integer({ min: 0, max: 8 });

  // Validates: Requirements 5.5
  it('retries PutRolePolicy on each failure, succeeding within budget or recording a permanent failure once exhausted', async () => {
    await fc.assert(
      fc.asyncProperty(
        teamArb,
        modelArb,
        maxAttemptsArb,
        failuresBeforeSuccessArb,
        async (team, model, maxAttempts, failuresBeforeSuccess) => {
          mockedGetItem.mockReset();
          mockedPutRolePolicy.mockReset();
          mockedWriteAuditEntry.mockReset();
          mockedGetItem.mockResolvedValue({});
          mockedWriteAuditEntry.mockResolvedValue(undefined);

          mockedGetQuota.mockResolvedValue(100);
          mockedListRolesForTeam.mockResolvedValue(['arn:aws:iam::123456789012:role/RoleA']);

          let calls = 0;
          mockedPutRolePolicy.mockImplementation(async () => {
            calls += 1;
            if (calls <= failuresBeforeSuccess) {
              throw new Error(`Simulated failure #${calls}`);
            }
            return {};
          });

          const willSucceedWithinBudget = failuresBeforeSuccess < maxAttempts;

          await evaluateUsageAggregationChange(team, model, '2025-01-15', 200, {
            ...BASE_OPTIONS,
            retryOptions: { maxAttempts, initialDelayMs: 0, maxDelayMs: 0, sleep: async () => {} },
          });

          const expectedCalls = willSucceedWithinBudget ? failuresBeforeSuccess + 1 : maxAttempts;
          expect(mockedPutRolePolicy).toHaveBeenCalledTimes(expectedCalls);

          expect(mockedWriteAuditEntry).toHaveBeenCalledTimes(1);
          const auditAction = mockedWriteAuditEntry.mock.calls[0][3];
          expect(auditAction).toBe(willSucceedWithinBudget ? 'ATTACH_DENY' : 'ATTACH_DENY_FAILED');
        }
      )
    );
  });
});

describe('handleUsageAggregationStreamEvent', () => {
  beforeEach(() => {
    mockedGetItem.mockReset();
    mockedPutItem.mockReset();
    mockedPutRolePolicy.mockReset();
    mockedListRolesForTeam.mockReset();
    mockedGetQuota.mockReset();
    mockedWriteAuditEntry.mockReset();
    mockedPublishNotification.mockReset();

    mockedGetItem.mockResolvedValue({});
    mockedPutItem.mockResolvedValue({});
    mockedPutRolePolicy.mockResolvedValue({});
    mockedWriteAuditEntry.mockResolvedValue(undefined);
    mockedPublishNotification.mockResolvedValue(undefined);
  });

  function unmarshalledRecord(
    eventName: 'INSERT' | 'MODIFY' | 'REMOVE',
    item: Record<string, AttributeValue> | undefined
  ) {
    return {
      eventName,
      dynamodb: item ? { NewImage: item } : undefined,
    };
  }

  it('evaluates INSERT/MODIFY records for the current usage day and skips others', async () => {
    mockedGetQuota.mockResolvedValue(1000);
    mockedListRolesForTeam.mockResolvedValue(['arn:aws:iam::123456789012:role/RoleA']);

    const event: UsageAggregationStreamEvent = {
      Records: [
        unmarshalledRecord('INSERT', {
          team: { S: 'teamA' },
          model: { S: 'modelX' },
          usageDay: { S: '2025-01-15' },
          runningTotalTokens: { N: '1500' },
        }),
        unmarshalledRecord('MODIFY', {
          team: { S: 'teamB' },
          model: { S: 'modelY' },
          usageDay: { S: '2024-12-31' },
          runningTotalTokens: { N: '5000' },
        }),
        unmarshalledRecord('REMOVE', {
          team: { S: 'teamC' },
          model: { S: 'modelZ' },
          usageDay: { S: '2025-01-15' },
          runningTotalTokens: { N: '5000' },
        }),
        unmarshalledRecord('INSERT', undefined),
      ],
    };

    await handleUsageAggregationStreamEvent(event, BASE_OPTIONS);

    // Only the first record (INSERT, current usage day) should be evaluated.
    expect(mockedGetQuota).toHaveBeenCalledTimes(1);
    expect(mockedGetQuota).toHaveBeenCalledWith('teamA', 'modelX', {
      tableName: 'QuotaConfiguration',
    });
    expect(mockedPutRolePolicy).toHaveBeenCalledTimes(1);
  });

  it('skips records with a malformed NewImage without throwing', async () => {
    const event: UsageAggregationStreamEvent = {
      Records: [
        unmarshalledRecord('INSERT', {
          team: { S: 'teamA' },
          // model missing
          usageDay: { S: '2025-01-15' },
          runningTotalTokens: { N: '1500' },
        }),
      ],
    };

    await expect(handleUsageAggregationStreamEvent(event, BASE_OPTIONS)).resolves.toBeUndefined();
    expect(mockedGetQuota).not.toHaveBeenCalled();
  });
});
