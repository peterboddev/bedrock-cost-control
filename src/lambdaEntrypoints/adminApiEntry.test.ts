import type { APIGatewayProxyEvent } from 'aws-lambda';

import { handler } from './adminApiEntry';
import * as adminApi from '../adminApi';

jest.mock('../adminApi', () => ({
  handleListModelRegistry: jest.fn(),
  handlePutModelRegistryEntry: jest.fn(),
  handleListQuotas: jest.fn(),
  handlePutQuota: jest.fn(),
  handleListAuditEntries: jest.fn(),
  handleRemoveDenyPolicy: jest.fn(),
  handleListTeams: jest.fn(),
  handleReconcileTeamRoles: jest.fn(),
  handleMapRoleToTeam: jest.fn(),
  handlePutTeamProjectMapping: jest.fn(),
  handleListTeamProjectMappings: jest.fn(),
}));

const mockedListModelRegistry = adminApi.handleListModelRegistry as jest.Mock;
const mockedPutModelRegistryEntry = adminApi.handlePutModelRegistryEntry as jest.Mock;

beforeAll(() => {
  process.env.QUOTA_CONFIGURATION_TABLE_NAME = 'QuotaConfiguration';
  process.env.AUDIT_LOG_TABLE_NAME = 'AuditLog';
  process.env.BLOCKED_STATE_TABLE_NAME = 'BlockedState';
  process.env.TEAM_ROLE_CACHE_TABLE_NAME = 'TeamRoleCache';
  process.env.MODEL_REGISTRY_TABLE_NAME = 'ModelRegistry';
  process.env.TEAM_PROJECT_MAPPING_TABLE_NAME = 'TeamProjectMapping';
});

beforeEach(() => {
  mockedListModelRegistry.mockReset();
  mockedPutModelRegistryEntry.mockReset();
});

function httpEvent(body: string | null): APIGatewayProxyEvent {
  return {
    body,
    httpMethod: 'POST',
    requestContext: {} as never,
  } as unknown as APIGatewayProxyEvent;
}

describe('adminApiEntry handler - direct invoke', () => {
  it('dispatches a direct { operation } invoke and returns the raw result', async () => {
    mockedListModelRegistry.mockResolvedValue({ ok: true, data: [] });
    const result = await handler({ operation: 'listModelRegistry' });
    expect(result).toEqual({ ok: true, data: [] });
    expect(mockedListModelRegistry).toHaveBeenCalledTimes(1);
  });
});

describe('adminApiEntry handler - API Gateway proxy', () => {
  it('returns 400 with security headers for invalid JSON', async () => {
    const res = (await handler(httpEvent('{not json'))) as { statusCode: number; headers: Record<string, string>; body: string };
    expect(res.statusCode).toBe(400);
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(JSON.parse(res.body).ok).toBe(false);
  });

  it('returns 400 when operation is missing', async () => {
    const res = (await handler(httpEvent(JSON.stringify({ payload: {} })))) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/operation/);
  });

  it('returns 200 for a successful operation', async () => {
    mockedPutModelRegistryEntry.mockResolvedValue({ ok: true, data: undefined });
    const res = (await handler(
      httpEvent(JSON.stringify({ operation: 'putModelRegistryEntry', payload: { modelId: 'm', endpoint: 'bedrock-mantle', provider: 'openai' } }))
    )) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, data: undefined });
    expect(mockedPutModelRegistryEntry).toHaveBeenCalledTimes(1);
  });

  it('maps a handler failure to HTTP 400', async () => {
    mockedPutModelRegistryEntry.mockResolvedValue({ ok: false, error: 'bad input' });
    const res = (await handler(
      httpEvent(JSON.stringify({ operation: 'putModelRegistryEntry', payload: {} }))
    )) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'bad input' });
  });
});
