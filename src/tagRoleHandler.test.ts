import * as fc from 'fast-check';

import { handleTagRoleEvent, TagRoleEvent, TagRoleHandlerOptions } from './tagRoleHandler';
import { buildModelDenyPolicyDocument, buildModelDenyPolicyName } from './quotaEnforcer';
import * as dynamoDbClient from './clients/dynamoDbClient';
import * as iamClient from './clients/iamClient';

jest.mock('./clients/dynamoDbClient', () => ({
  query: jest.fn(),
}));

jest.mock('./clients/iamClient', () => ({
  putRolePolicy: jest.fn(),
}));

const mockedQuery = dynamoDbClient.query as jest.Mock;
const mockedPutRolePolicy = iamClient.putRolePolicy as jest.Mock;

const BLOCKED_STATE_TABLE = 'BlockedState';
const TEAM_TAG_KEY = 'team';
const ACCOUNT_ID = '123456789012';
const ROLE_NAME = 'NewRole';

const noRetryDelay = { sleep: async () => {} };

const baseOptions: TagRoleHandlerOptions = {
  teamTagKey: TEAM_TAG_KEY,
  blockedStateTableName: BLOCKED_STATE_TABLE,
  retryOptions: { maxAttempts: 3, ...noRetryDelay },
};

function buildTagRoleEvent(
  team: string | undefined,
  overrides: Partial<TagRoleEvent['detail']> = {}
): TagRoleEvent {
  return {
    detail: {
      eventName: 'TagRole',
      eventSource: 'iam.amazonaws.com',
      recipientAccountId: ACCOUNT_ID,
      requestParameters: {
        roleName: ROLE_NAME,
        tags: team === undefined ? [] : [{ key: TEAM_TAG_KEY, value: team }],
      },
      ...overrides,
    },
  };
}

function mockBlockedModels(models: string[]): void {
  mockedQuery.mockImplementation(async () => ({
    Items: models.map((model) => ({
      PK: 'TEAM#teamA',
      SK: `MODEL#${model}`,
      status: 'BLOCKED',
    })),
  }));
}

describe('handleTagRoleEvent (unit)', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
    mockedPutRolePolicy.mockReset();
    mockedPutRolePolicy.mockResolvedValue({});
  });

  it('attaches the Model_Deny_Policy for every currently blocked Model to the newly tagged role', async () => {
    mockBlockedModels(['modelX', 'modelY']);

    const event = buildTagRoleEvent('teamA');
    await handleTagRoleEvent(event, baseOptions);

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    expect(mockedQuery.mock.calls[0][0]).toMatchObject({
      TableName: BLOCKED_STATE_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'TEAM#teamA' },
    });

    expect(mockedPutRolePolicy).toHaveBeenCalledTimes(2);
    expect(mockedPutRolePolicy.mock.calls[0][0]).toMatchObject({
      RoleName: ROLE_NAME,
      PolicyName: buildModelDenyPolicyName('modelX'),
      PolicyDocument: JSON.stringify(buildModelDenyPolicyDocument('modelX')),
    });
    expect(mockedPutRolePolicy.mock.calls[1][0]).toMatchObject({
      RoleName: ROLE_NAME,
      PolicyName: buildModelDenyPolicyName('modelY'),
      PolicyDocument: JSON.stringify(buildModelDenyPolicyDocument('modelY')),
    });
  });

  it('is a no-op when the Team has no Models currently in Blocked_State', async () => {
    mockBlockedModels([]);

    const event = buildTagRoleEvent('teamA');
    await handleTagRoleEvent(event, baseOptions);

    expect(mockedPutRolePolicy).not.toHaveBeenCalled();
  });

  it('is a no-op when the new tags do not include the configured Team_Tag_Key', async () => {
    const event = buildTagRoleEvent(undefined);
    await handleTagRoleEvent(event, baseOptions);

    expect(mockedQuery).not.toHaveBeenCalled();
    expect(mockedPutRolePolicy).not.toHaveBeenCalled();
  });

  it('is a no-op for UntagRole events', async () => {
    mockBlockedModels(['modelX']);

    const event = buildTagRoleEvent('teamA', { eventName: 'UntagRole' });
    await handleTagRoleEvent(event, baseOptions);

    expect(mockedQuery).not.toHaveBeenCalled();
    expect(mockedPutRolePolicy).not.toHaveBeenCalled();
  });

  it('ignores Blocked_State entries with status PENDING_RESET', async () => {
    mockedQuery.mockResolvedValue({
      Items: [
        { PK: 'TEAM#teamA', SK: 'MODEL#modelX', status: 'BLOCKED' },
        { PK: 'TEAM#teamA', SK: 'MODEL#modelY', status: 'PENDING_RESET' },
      ],
    });

    const event = buildTagRoleEvent('teamA');
    await handleTagRoleEvent(event, baseOptions);

    expect(mockedPutRolePolicy).toHaveBeenCalledTimes(1);
    expect(mockedPutRolePolicy.mock.calls[0][0]).toMatchObject({
      PolicyName: buildModelDenyPolicyName('modelX'),
    });
  });
});

const teamArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);
const modelArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);

describe('handleTagRoleEvent - Property 15: Newly mapped role inherits an existing block', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
    mockedPutRolePolicy.mockReset();
    mockedPutRolePolicy.mockResolvedValue({});
  });

  // Validates: Requirements 5.4
  it('attaches the Model_Deny_Policy for every Model in the Team\'s blocked subset to the newly mapped role', async () => {
    await fc.assert(
      fc.asyncProperty(
        teamArb,
        fc.uniqueArray(modelArb, { minLength: 0, maxLength: 8 }),
        async (team, blockedModels) => {
          mockedQuery.mockReset();
          mockedPutRolePolicy.mockReset();
          mockedPutRolePolicy.mockResolvedValue({});

          mockedQuery.mockImplementation(async () => ({
            Items: blockedModels.map((model) => ({
              PK: `TEAM#${team}`,
              SK: `MODEL#${model}`,
              status: 'BLOCKED',
            })),
          }));

          const event = buildTagRoleEvent(team);
          await handleTagRoleEvent(event, baseOptions);

          expect(mockedPutRolePolicy).toHaveBeenCalledTimes(blockedModels.length);

          const attachedPolicyNames = mockedPutRolePolicy.mock.calls.map(
            (call) => call[0].PolicyName
          );
          const expectedPolicyNames = blockedModels.map((model) => buildModelDenyPolicyName(model));
          expect(new Set(attachedPolicyNames)).toEqual(new Set(expectedPolicyNames));

          for (const call of mockedPutRolePolicy.mock.calls) {
            expect(call[0].RoleName).toBe(ROLE_NAME);
          }

          for (const model of blockedModels) {
            const matchingCall = mockedPutRolePolicy.mock.calls.find(
              (call) => call[0].PolicyName === buildModelDenyPolicyName(model)
            );
            expect(matchingCall![0].PolicyDocument).toBe(
              JSON.stringify(buildModelDenyPolicyDocument(model))
            );
          }
        }
      )
    );
  });
});
