import { listMantleModels } from './mantleModelsClient';

describe('listMantleModels', () => {
  it('mints a bearer token and GETs /v1/models on the regional mantle endpoint', async () => {
    const mintToken = jest.fn().mockResolvedValue('tok-123');
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'openai.gpt-oss-120b-1:0' }, { id: 'anthropic.claude' }] }),
    });

    const ids = await listMantleModels('us-east-2', {
      mintToken,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(mintToken).toHaveBeenCalledWith('us-east-2');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://bedrock-mantle.us-east-2.api.aws/v1/models');
    expect(init.headers.Authorization).toBe('Bearer tok-123');
    expect(ids).toEqual(['openai.gpt-oss-120b-1:0', 'anthropic.claude']);
  });

  it('uses the per-call region in the URL', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    await listMantleModels('eu-central-1', {
      mintToken: async () => 't',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn.mock.calls[0][0]).toBe('https://bedrock-mantle.eu-central-1.api.aws/v1/models');
  });

  it('drops entries without an id', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'm1' }, {}, { id: '' }, { id: 'm2' }] }),
    });
    const ids = await listMantleModels('us-east-2', {
      mintToken: async () => 't',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(ids).toEqual(['m1', 'm2']);
  });

  it('throws a descriptive error on a non-OK response', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'AccessDenied',
    });
    await expect(
      listMantleModels('us-east-2', {
        mintToken: async () => 't',
        fetchFn: fetchFn as unknown as typeof fetch,
      })
    ).rejects.toThrow(/HTTP 403/);
  });
});
