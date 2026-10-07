import {
  handlePutQuota,
  handleListQuotas,
  handleListAuditEntries,
  handleRemoveDenyPolicy,
  handlePutModelRegistryEntry,
  handleListModelRegistry,
  handlePutTeamProjectMapping,
  handleListTeamProjectMappings,
  AdminApiOptions,
} from './adminApi';
import * as quotaConfigStore from './quotaConfigStore';
import * as auditLog from './auditLog';
import * as dailyReset from './dailyReset';
import * as modelRegistryStore from './pricing/modelRegistryStore';
import * as teamProjectMapping from './teamProjectMapping';
import * as reconcileJobStore from './reconcileJobStore';
import * as sqsClient from './clients/sqsClient';
import * as teamRoleCache from './teamRoleCache';
import * as bedrockClient from './clients/bedrockClient';
import * as mantleModelsClient from './clients/mantleModelsClient';
import {
  handleReconcileTeamRoles,
  handleGetReconcileJob,
  handleListTeams,
  handleListTeamRoleMappings,
  handleListModelCatalog,
  handleDeleteModelRegistryEntry,
} from './adminApi';
import { ModelRegistry } from './pricing/modelRegistry';
import { Endpoint } from './pricing/types';

jest.mock('./quotaConfigStore', () => ({
  putQuota: jest.fn(),
  listQuotas: jest.fn(),
  listTeams: jest.fn(),
}));

jest.mock('./auditLog', () => ({
  listAuditEntries: jest.fn(),
}));

jest.mock('./dailyReset', () => ({
  removeDenyPolicy: jest.fn(),
}));

jest.mock('./pricing/modelRegistryStore', () => ({
  putModelRegistryEntry: jest.fn(),
  loadModelRegistry: jest.fn(),
  removeModelRegistryEntry: jest.fn(),
}));

jest.mock('./clients/bedrockClient', () => ({
  listFoundationModels: jest.fn(),
  listInferenceProfiles: jest.fn(),
}));

jest.mock('./clients/mantleModelsClient', () => ({
  listMantleModels: jest.fn(),
}));

jest.mock('./teamProjectMapping', () => ({
  putTeamProjectMapping: jest.fn(),
  listTeamProjectMappings: jest.fn(),
}));

jest.mock('./reconcileJobStore', () => ({
  createReconcileJob: jest.fn(),
  getReconcileJob: jest.fn(),
}));

jest.mock('./clients/sqsClient', () => ({
  sendMessage: jest.fn(),
}));

jest.mock('./teamRoleCache', () => ({
  cacheRoleTeam: jest.fn(),
  listDiscoveredTeams: jest.fn(),
  listTeamRoleMappings: jest.fn(),
}));

const mockedPutQuota = quotaConfigStore.putQuota as jest.Mock;
const mockedListQuotas = quotaConfigStore.listQuotas as jest.Mock;
const mockedListAuditEntries = auditLog.listAuditEntries as jest.Mock;
const mockedRemoveDenyPolicy = dailyReset.removeDenyPolicy as jest.Mock;
const mockedPutModelRegistryEntry = modelRegistryStore.putModelRegistryEntry as jest.Mock;
const mockedLoadModelRegistry = modelRegistryStore.loadModelRegistry as jest.Mock;
const mockedPutTeamProjectMapping = teamProjectMapping.putTeamProjectMapping as jest.Mock;
const mockedListTeamProjectMappings = teamProjectMapping.listTeamProjectMappings as jest.Mock;
const mockedCreateReconcileJob = reconcileJobStore.createReconcileJob as jest.Mock;
const mockedGetReconcileJob = reconcileJobStore.getReconcileJob as jest.Mock;
const mockedSendMessage = sqsClient.sendMessage as jest.Mock;
const mockedQuotaListTeams = quotaConfigStore.listTeams as jest.Mock;
const mockedListDiscoveredTeams = teamRoleCache.listDiscoveredTeams as jest.Mock;
const mockedListTeamRoleMappings = teamRoleCache.listTeamRoleMappings as jest.Mock;
const mockedRemoveModelRegistryEntry = modelRegistryStore.removeModelRegistryEntry as jest.Mock;
const mockedListFoundationModels = bedrockClient.listFoundationModels as jest.Mock;
const mockedListInferenceProfiles = bedrockClient.listInferenceProfiles as jest.Mock;
const mockedListMantleModels = mantleModelsClient.listMantleModels as jest.Mock;

const baseOptions: AdminApiOptions = {
  quotaConfigTableName: 'QuotaConfiguration',
  auditLogTableName: 'AuditLog',
  blockedStateTableName: 'BlockedState',
  teamRoleCacheTableName: 'TeamRoleCache',
  modelRegistryTableName: 'ModelRegistry',
  teamProjectMappingTableName: 'TeamProjectMapping',
};

beforeEach(() => {
  mockedPutQuota.mockReset();
  mockedListQuotas.mockReset();
  mockedListAuditEntries.mockReset();
  mockedRemoveDenyPolicy.mockReset();
  mockedPutModelRegistryEntry.mockReset();
  mockedLoadModelRegistry.mockReset();
  mockedPutTeamProjectMapping.mockReset();
  mockedListTeamProjectMappings.mockReset();
  mockedCreateReconcileJob.mockReset().mockResolvedValue(undefined);
  mockedGetReconcileJob.mockReset();
  mockedSendMessage.mockReset().mockResolvedValue(undefined);
  mockedQuotaListTeams.mockReset().mockResolvedValue([]);
  mockedListDiscoveredTeams.mockReset().mockResolvedValue([]);
  mockedListTeamRoleMappings.mockReset().mockResolvedValue([]);
  mockedRemoveModelRegistryEntry.mockReset().mockResolvedValue(undefined);
  mockedListFoundationModels.mockReset();
  mockedListInferenceProfiles.mockReset().mockResolvedValue({ inferenceProfileSummaries: [] });
  mockedListMantleModels.mockReset().mockResolvedValue([]);
});

describe('handleListModelCatalog', () => {
  it('runtime: merges foundation models (regional) + inference profiles split by scope', async () => {
    mockedListFoundationModels.mockResolvedValue({
      modelSummaries: [{ modelId: 'anthropic.claude-sonnet-4', providerName: 'Anthropic' }],
    });
    mockedListInferenceProfiles.mockResolvedValue({
      inferenceProfileSummaries: [
        { inferenceProfileId: 'us.openai.gpt-6-sol' },
        { inferenceProfileId: 'global.anthropic.claude-opus' },
      ],
    });

    const result = await handleListModelCatalog(
      { endpoint: Endpoint.BedrockRuntime, region: 'us-east-2' },
      baseOptions
    );

    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: Array<{ id: string; scope: string; provider: string }> }).data;
    expect(data).toContainEqual({ id: 'anthropic.claude-sonnet-4', scope: 'regional', provider: 'anthropic' });
    expect(data).toContainEqual({ id: 'us.openai.gpt-6-sol', scope: 'cross-region', provider: 'openai' });
    expect(data).toContainEqual({ id: 'global.anthropic.claude-opus', scope: 'global', provider: 'anthropic' });
    // region threaded to the control-plane calls
    expect(mockedListFoundationModels).toHaveBeenCalledWith({}, 'us-east-2');
  });

  it('runtime: excludes INFERENCE_PROFILE-only models from the regional list', async () => {
    // Mirrors anthropic.claude-sonnet-5-5 in eu-central-1: present in the
    // foundation-model catalog but ON_DEMAND is NOT supported, so the bare id
    // is not invokable regionally. It must appear only via its eu./global.
    // profiles, never under the Regional scope.
    mockedListFoundationModels.mockResolvedValue({
      modelSummaries: [
        { modelId: 'anthropic.claude-sonnet-4', providerName: 'Anthropic', inferenceTypesSupported: ['ON_DEMAND'] },
        { modelId: 'anthropic.claude-sonnet-5-5', providerName: 'Anthropic', inferenceTypesSupported: ['INFERENCE_PROFILE'] },
      ],
    });
    mockedListInferenceProfiles.mockResolvedValue({
      inferenceProfileSummaries: [
        { inferenceProfileId: 'eu.anthropic.claude-sonnet-5-5' },
        { inferenceProfileId: 'global.anthropic.claude-sonnet-5-5' },
      ],
    });

    const result = await handleListModelCatalog(
      { endpoint: Endpoint.BedrockRuntime, region: 'eu-central-1' },
      baseOptions
    );

    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: Array<{ id: string; scope: string }> }).data;
    // on-demand model is present as regional
    expect(data).toContainEqual({ id: 'anthropic.claude-sonnet-4', scope: 'regional', provider: 'anthropic' });
    // profile-only model is NOT offered as a bare regional id
    expect(data).not.toContainEqual(
      expect.objectContaining({ id: 'anthropic.claude-sonnet-5-5', scope: 'regional' })
    );
    // but it IS available through its cross-region / global profiles
    expect(data).toContainEqual({ id: 'eu.anthropic.claude-sonnet-5-5', scope: 'cross-region', provider: 'anthropic' });
    expect(data).toContainEqual({ id: 'global.anthropic.claude-sonnet-5-5', scope: 'global', provider: 'anthropic' });
  });

  it('mantle: lists the endpoint model list, all regional, no inference profiles', async () => {
    mockedListMantleModels.mockResolvedValue(['openai.gpt-oss-120b-1:0', 'anthropic.claude']);

    const result = await handleListModelCatalog(
      { endpoint: Endpoint.BedrockMantle, region: 'us-east-2' },
      baseOptions
    );

    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: Array<{ id: string; scope: string }> }).data;
    expect(data.every((m) => m.scope === 'regional')).toBe(true);
    expect(data.map((m) => m.id).sort()).toEqual(['anthropic.claude', 'openai.gpt-oss-120b-1:0']);
    expect(mockedListMantleModels).toHaveBeenCalledWith('us-east-2');
    // Mantle must NOT consult inference profiles.
    expect(mockedListInferenceProfiles).not.toHaveBeenCalled();
  });

  it('rejects a missing region', async () => {
    const result = await handleListModelCatalog(
      { endpoint: Endpoint.BedrockRuntime, region: undefined },
      baseOptions
    );
    expect(result.ok).toBe(false);
  });
});

describe('handlePutModelRegistryEntry (scope + region)', () => {
  it('persists scope and region on the entry', async () => {
    mockedPutModelRegistryEntry.mockResolvedValue(undefined);
    const result = await handlePutModelRegistryEntry(
      {
        modelId: 'us.openai.gpt-6-sol',
        endpoint: Endpoint.BedrockRuntime,
        provider: 'openai',
        scope: 'cross-region',
        region: 'us-east-2',
      },
      baseOptions
    );
    expect(result.ok).toBe(true);
    expect(mockedPutModelRegistryEntry).toHaveBeenCalledWith(
      {
        modelId: 'us.openai.gpt-6-sol',
        endpoint: Endpoint.BedrockRuntime,
        provider: 'openai',
        scope: 'cross-region',
        region: 'us-east-2',
      },
      { tableName: 'ModelRegistry' }
    );
  });

  it('rejects an invalid scope', async () => {
    const result = await handlePutModelRegistryEntry(
      { modelId: 'm', endpoint: Endpoint.BedrockRuntime, provider: 'p', scope: 'nope' },
      baseOptions
    );
    expect(result.ok).toBe(false);
    expect(mockedPutModelRegistryEntry).not.toHaveBeenCalled();
  });
});

describe('handleDeleteModelRegistryEntry', () => {
  it('removes the exact (modelId, endpoint, region) entry', async () => {
    const result = await handleDeleteModelRegistryEntry(
      { modelId: 'openai.gpt-oss-120b-1:0', endpoint: Endpoint.BedrockMantle, region: 'us-east-2' },
      baseOptions
    );
    expect(result.ok).toBe(true);
    expect(mockedRemoveModelRegistryEntry).toHaveBeenCalledWith(
      'openai.gpt-oss-120b-1:0',
      Endpoint.BedrockMantle,
      { tableName: 'ModelRegistry' },
      'us-east-2'
    );
  });

  it('rejects an invalid endpoint', async () => {
    const result = await handleDeleteModelRegistryEntry(
      { modelId: 'm', endpoint: 'nope' },
      baseOptions
    );
    expect(result.ok).toBe(false);
    expect(mockedRemoveModelRegistryEntry).not.toHaveBeenCalled();
  });
});

describe('handleListTeams (union of budgeted + discovered)', () => {
  it('unions teams-with-budgets and teams-discovered-from-IAM, deduped and sorted', async () => {
    mockedQuotaListTeams.mockResolvedValue(['data-science', 'alpha']);
    mockedListDiscoveredTeams.mockResolvedValue(['alpha', 'beta', 'gamma']);

    const result = await handleListTeams(baseOptions);

    expect(result.ok).toBe(true);
    expect((result as { ok: true; data: string[] }).data).toEqual([
      'alpha',
      'beta',
      'data-science',
      'gamma',
    ]);
  });

  it('returns discovered teams even when no budgets exist yet', async () => {
    mockedQuotaListTeams.mockResolvedValue([]);
    mockedListDiscoveredTeams.mockResolvedValue(['alpha']);

    const result = await handleListTeams(baseOptions);

    expect((result as { ok: true; data: string[] }).data).toEqual(['alpha']);
  });
});

describe('handleListTeamRoleMappings', () => {
  it('returns the role->team mappings from the cache', async () => {
    mockedListTeamRoleMappings.mockResolvedValue([
      { roleArn: 'arn:aws:iam::1:role/A', team: 'alpha' },
    ]);

    const result = await handleListTeamRoleMappings(baseOptions);

    expect(result.ok).toBe(true);
    expect((result as { ok: true; data: unknown[] }).data).toEqual([
      { roleArn: 'arn:aws:iam::1:role/A', team: 'alpha' },
    ]);
    expect(mockedListTeamRoleMappings).toHaveBeenCalledWith({
      tableName: baseOptions.teamRoleCacheTableName,
    });
  });
});

const reconcileOptions: AdminApiOptions = {
  ...baseOptions,
  teamTagKey: 'team',
  reconcileQueueUrl: 'https://sqs.example/queue',
  reconcileJobTableName: 'Reconcile_Job',
};

describe('handleReconcileTeamRoles (starter)', () => {
  it('creates a job row, enqueues a starter message, and returns the jobId', async () => {
    const result = await handleReconcileTeamRoles({}, reconcileOptions);

    expect(result.ok).toBe(true);
    const jobId = (result as { ok: true; data: { jobId: string } }).data.jobId;
    expect(typeof jobId).toBe('string');
    expect(jobId.length).toBeGreaterThan(0);

    // Job row created before the message is enqueued (so an immediate poll sees it).
    expect(mockedCreateReconcileJob).toHaveBeenCalledWith(
      jobId,
      expect.objectContaining({ tableName: 'Reconcile_Job' })
    );
    const sendArg = mockedSendMessage.mock.calls[0][0];
    expect(sendArg.QueueUrl).toBe('https://sqs.example/queue');
    expect(JSON.parse(sendArg.MessageBody)).toEqual({ jobId });
  });

  it('fails fast when the queue URL is not configured', async () => {
    const result = await handleReconcileTeamRoles(
      {},
      { ...reconcileOptions, reconcileQueueUrl: undefined }
    );
    expect(result.ok).toBe(false);
    expect(mockedCreateReconcileJob).not.toHaveBeenCalled();
    expect(mockedSendMessage).not.toHaveBeenCalled();
  });

  it('fails fast when the team tag key is not configured', async () => {
    const result = await handleReconcileTeamRoles(
      {},
      { ...reconcileOptions, teamTagKey: undefined }
    );
    expect(result.ok).toBe(false);
    expect(mockedSendMessage).not.toHaveBeenCalled();
  });
});

describe('handleGetReconcileJob', () => {
  it('returns the job when it exists', async () => {
    mockedGetReconcileJob.mockResolvedValue({
      jobId: 'j1',
      status: 'complete',
      rolesProcessed: 5,
      pageCount: 1,
      startedAt: 'x',
      updatedAt: 'y',
    });

    const result = await handleGetReconcileJob({ jobId: 'j1' }, reconcileOptions);

    expect(result.ok).toBe(true);
    expect((result as { ok: true; data: { status: string } }).data.status).toBe('complete');
  });

  it('fails when the jobId is unknown', async () => {
    mockedGetReconcileJob.mockResolvedValue(undefined);
    const result = await handleGetReconcileJob({ jobId: 'missing' }, reconcileOptions);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/missing/);
  });

  it('rejects a missing jobId', async () => {
    const result = await handleGetReconcileJob({ jobId: undefined }, reconcileOptions);
    expect(result.ok).toBe(false);
    expect(mockedGetReconcileJob).not.toHaveBeenCalled();
  });
});

describe('handlePutQuota', () => {
  it('rejects when team is missing', async () => {
    const result = await handlePutQuota(
      { team: undefined, model: 'modelX', dailyTokenQuota: 100 },
      baseOptions
    );

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/team/);
    expect(mockedPutQuota).not.toHaveBeenCalled();
  });

  it('rejects when team has the wrong type', async () => {
    const result = await handlePutQuota(
      { team: 123, model: 'modelX', dailyTokenQuota: 100 },
      baseOptions
    );

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/team/);
    expect(mockedPutQuota).not.toHaveBeenCalled();
  });

  it('rejects when model is missing', async () => {
    const result = await handlePutQuota(
      { team: 'teamA', model: undefined, dailyTokenQuota: 100 },
      baseOptions
    );

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/model/);
    expect(mockedPutQuota).not.toHaveBeenCalled();
  });

  it('rejects when model has the wrong type', async () => {
    const result = await handlePutQuota(
      { team: 'teamA', model: {}, dailyTokenQuota: 100 },
      baseOptions
    );

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/model/);
    expect(mockedPutQuota).not.toHaveBeenCalled();
  });

  it('rejects when dailyTokenQuota is missing', async () => {
    const result = await handlePutQuota(
      { team: 'teamA', model: 'modelX', dailyTokenQuota: undefined },
      baseOptions
    );

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/dailyTokenQuota/);
    expect(mockedPutQuota).not.toHaveBeenCalled();
  });

  it('rejects when dailyTokenQuota has the wrong type', async () => {
    const result = await handlePutQuota(
      { team: 'teamA', model: 'modelX', dailyTokenQuota: '100' },
      baseOptions
    );

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/dailyTokenQuota/);
    expect(mockedPutQuota).not.toHaveBeenCalled();
  });

  it('succeeds for a valid request', async () => {
    mockedPutQuota.mockResolvedValue(undefined);

    const result = await handlePutQuota(
      { team: 'teamA', model: 'modelX', dailyTokenQuota: 100 },
      baseOptions
    );

    expect(result).toEqual({ ok: true, data: undefined });
    expect(mockedPutQuota).toHaveBeenCalledWith(
      'teamA',
      'modelX',
      100,
      expect.objectContaining({ tableName: baseOptions.quotaConfigTableName })
    );
  });

  it("surfaces putQuota's own value-validation error as an AdminApiFailure instead of throwing", async () => {
    mockedPutQuota.mockRejectedValue(
      new Error('dailyTokenQuota must be a positive integer; received a non-positive value: 0')
    );

    const result = await handlePutQuota(
      { team: 'teamA', model: 'modelX', dailyTokenQuota: 0 },
      baseOptions
    );

    expect(result).toEqual({
      ok: false,
      error: 'dailyTokenQuota must be a positive integer; received a non-positive value: 0',
    });
  });
});

describe('handleListQuotas', () => {
  it('rejects when team is missing', async () => {
    const result = await handleListQuotas({ team: undefined }, baseOptions);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/team/);
    expect(mockedListQuotas).not.toHaveBeenCalled();
  });

  it('rejects when team has the wrong type', async () => {
    const result = await handleListQuotas({ team: 42 }, baseOptions);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/team/);
    expect(mockedListQuotas).not.toHaveBeenCalled();
  });

  it('returns the mocked quota list on success', async () => {
    const quotas = [{ model: 'modelX', dailyTokenQuota: 100 }];
    mockedListQuotas.mockResolvedValue(quotas);

    const result = await handleListQuotas({ team: 'teamA' }, baseOptions);

    expect(result).toEqual({ ok: true, data: quotas });
    expect(mockedListQuotas).toHaveBeenCalledWith(
      'teamA',
      expect.objectContaining({ tableName: baseOptions.quotaConfigTableName })
    );
  });
});

describe('handleListAuditEntries', () => {
  it('rejects when team is missing', async () => {
    const result = await handleListAuditEntries(
      { team: undefined, startDate: '2025-01-01', endDate: '2025-01-31' },
      baseOptions
    );

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/team/);
    expect(mockedListAuditEntries).not.toHaveBeenCalled();
  });

  it('rejects when startDate is missing', async () => {
    const result = await handleListAuditEntries(
      { team: 'teamA', startDate: undefined, endDate: '2025-01-31' },
      baseOptions
    );

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/startDate/);
    expect(mockedListAuditEntries).not.toHaveBeenCalled();
  });

  it('rejects when endDate has the wrong type', async () => {
    const result = await handleListAuditEntries(
      { team: 'teamA', startDate: '2025-01-01', endDate: 20250131 },
      baseOptions
    );

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/endDate/);
    expect(mockedListAuditEntries).not.toHaveBeenCalled();
  });

  it('returns the mocked audit entries on success', async () => {
    const entries = [
      {
        team: 'teamA',
        model: 'modelX',
        roleArn: 'arn:aws:iam::123456789012:role/RoleA',
        action: 'ATTACH_DENY' as const,
        runningTotalTokens: 1000,
        dailyTokenQuota: 500,
        timestamp: '2025-01-15T00:00:00.000Z',
      },
    ];
    mockedListAuditEntries.mockResolvedValue(entries);

    const result = await handleListAuditEntries(
      { team: 'teamA', startDate: '2025-01-01', endDate: '2025-01-31' },
      baseOptions
    );

    expect(result).toEqual({ ok: true, data: entries });
    expect(mockedListAuditEntries).toHaveBeenCalledWith(
      'teamA',
      '2025-01-01',
      '2025-01-31',
      expect.objectContaining({ tableName: baseOptions.auditLogTableName })
    );
  });
});

describe('handleRemoveDenyPolicy', () => {
  it('rejects when team is missing', async () => {
    const result = await handleRemoveDenyPolicy({ team: undefined, model: 'modelX' }, baseOptions);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/team/);
    expect(mockedRemoveDenyPolicy).not.toHaveBeenCalled();
  });

  it('rejects when model has the wrong type', async () => {
    const result = await handleRemoveDenyPolicy({ team: 'teamA', model: [] }, baseOptions);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/model/);
    expect(mockedRemoveDenyPolicy).not.toHaveBeenCalled();
  });

  it('succeeds for a valid request', async () => {
    mockedRemoveDenyPolicy.mockResolvedValue(undefined);

    const result = await handleRemoveDenyPolicy({ team: 'teamA', model: 'modelX' }, baseOptions);

    expect(result).toEqual({ ok: true, data: undefined });
    expect(mockedRemoveDenyPolicy).toHaveBeenCalledWith(
      'teamA',
      'modelX',
      expect.objectContaining({
        blockedStateTableName: baseOptions.blockedStateTableName,
        teamRoleCacheTableName: baseOptions.teamRoleCacheTableName,
        auditLogTableName: baseOptions.auditLogTableName,
      })
    );
  });

  it('surfaces an underlying dailyReset.removeDenyPolicy failure as an AdminApiFailure instead of throwing', async () => {
    mockedRemoveDenyPolicy.mockRejectedValue(new Error('throttled'));

    const result = await handleRemoveDenyPolicy({ team: 'teamA', model: 'modelX' }, baseOptions);

    // Unexpected (non-validation) errors are not forwarded to the caller;
    // the runHandler wrapper returns a generic message instead (L-4 hardening).
    expect(result).toEqual({ ok: false, error: 'Internal error processing request' });
  });
});

describe('handlePutModelRegistryEntry', () => {
  it('rejects an invalid endpoint', async () => {
    const result = await handlePutModelRegistryEntry(
      { modelId: 'm', endpoint: 'not-an-endpoint', provider: 'openai' },
      baseOptions
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/endpoint/);
    expect(mockedPutModelRegistryEntry).not.toHaveBeenCalled();
  });

  it('rejects when modelId is missing', async () => {
    const result = await handlePutModelRegistryEntry(
      { modelId: '', endpoint: Endpoint.BedrockMantle, provider: 'openai' },
      baseOptions
    );
    expect(result.ok).toBe(false);
    expect(mockedPutModelRegistryEntry).not.toHaveBeenCalled();
  });

  it('fails when the model registry table is not configured', async () => {
    const result = await handlePutModelRegistryEntry(
      { modelId: 'm', endpoint: Endpoint.BedrockMantle, provider: 'openai' },
      { ...baseOptions, modelRegistryTableName: undefined }
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/modelRegistryTableName/);
  });

  it('upserts a valid entry', async () => {
    mockedPutModelRegistryEntry.mockResolvedValue(undefined);
    const result = await handlePutModelRegistryEntry(
      { modelId: 'openai.gpt-6-sol', endpoint: Endpoint.BedrockMantle, provider: 'openai' },
      baseOptions
    );
    expect(result).toEqual({ ok: true, data: undefined });
    expect(mockedPutModelRegistryEntry).toHaveBeenCalledWith(
      { modelId: 'openai.gpt-6-sol', endpoint: Endpoint.BedrockMantle, provider: 'openai' },
      { tableName: 'ModelRegistry' }
    );
  });
});

describe('handleListModelRegistry', () => {
  it('returns the registry entries', async () => {
    const entries = [
      { modelId: 'openai.gpt-6-sol', endpoint: Endpoint.BedrockMantle, provider: 'openai' },
    ];
    mockedLoadModelRegistry.mockResolvedValue(ModelRegistry.fromList(entries));
    const result = await handleListModelRegistry(baseOptions);
    expect(result).toEqual({ ok: true, data: entries });
  });
});

describe('handlePutTeamProjectMapping', () => {
  it('rejects when projectId is missing', async () => {
    const result = await handlePutTeamProjectMapping({ projectId: '', team: 'teamA' }, baseOptions);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/projectId/);
    expect(mockedPutTeamProjectMapping).not.toHaveBeenCalled();
  });

  it('upserts a valid mapping', async () => {
    mockedPutTeamProjectMapping.mockResolvedValue(undefined);
    const result = await handlePutTeamProjectMapping(
      { projectId: 'proj-a', team: 'teamA' },
      baseOptions
    );
    expect(result).toEqual({ ok: true, data: undefined });
    expect(mockedPutTeamProjectMapping).toHaveBeenCalledWith('proj-a', 'teamA', {
      tableName: 'TeamProjectMapping',
    });
  });
});

describe('handleListTeamProjectMappings', () => {
  it('returns the mappings', async () => {
    const mappings = [{ projectId: 'proj-a', team: 'teamA' }];
    mockedListTeamProjectMappings.mockResolvedValue(mappings);
    const result = await handleListTeamProjectMappings(baseOptions);
    expect(result).toEqual({ ok: true, data: mappings });
  });
});
