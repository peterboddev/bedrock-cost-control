import {
  handlePutQuota,
  handleListQuotas,
  handleListAuditEntries,
  handleRemoveDenyPolicy,
  AdminApiOptions,
} from './adminApi';
import * as quotaConfigStore from './quotaConfigStore';
import * as auditLog from './auditLog';
import * as dailyReset from './dailyReset';

jest.mock('./quotaConfigStore', () => ({
  putQuota: jest.fn(),
  listQuotas: jest.fn(),
}));

jest.mock('./auditLog', () => ({
  listAuditEntries: jest.fn(),
}));

jest.mock('./dailyReset', () => ({
  removeDenyPolicy: jest.fn(),
}));

const mockedPutQuota = quotaConfigStore.putQuota as jest.Mock;
const mockedListQuotas = quotaConfigStore.listQuotas as jest.Mock;
const mockedListAuditEntries = auditLog.listAuditEntries as jest.Mock;
const mockedRemoveDenyPolicy = dailyReset.removeDenyPolicy as jest.Mock;

const baseOptions: AdminApiOptions = {
  quotaConfigTableName: 'QuotaConfiguration',
  auditLogTableName: 'AuditLog',
  blockedStateTableName: 'BlockedState',
  teamRoleCacheTableName: 'TeamRoleCache',
};

beforeEach(() => {
  mockedPutQuota.mockReset();
  mockedListQuotas.mockReset();
  mockedListAuditEntries.mockReset();
  mockedRemoveDenyPolicy.mockReset();
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

    expect(result).toEqual({ ok: false, error: 'throttled' });
  });
});
