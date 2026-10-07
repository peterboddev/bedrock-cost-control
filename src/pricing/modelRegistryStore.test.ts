import * as dynamoDbClient from '../clients/dynamoDbClient';
import {
  getModelRegistryEntry,
  loadModelRegistry,
  putModelRegistryEntry,
  removeModelRegistryEntry,
} from './modelRegistryStore';
import { Endpoint } from './types';

jest.mock('../clients/dynamoDbClient', () => ({
  getItem: jest.fn(),
  putItem: jest.fn(),
  deleteItem: jest.fn(),
  query: jest.fn(),
}));

const mockedGetItem = dynamoDbClient.getItem as jest.Mock;
const mockedPutItem = dynamoDbClient.putItem as jest.Mock;
const mockedDeleteItem = dynamoDbClient.deleteItem as jest.Mock;
const mockedQuery = dynamoDbClient.query as jest.Mock;

const TABLE = 'Model_Registry';

describe('modelRegistryStore - endpoint-inclusive key', () => {
  beforeEach(() => {
    mockedGetItem.mockReset().mockResolvedValue({ Item: undefined });
    mockedPutItem.mockReset().mockResolvedValue({});
    mockedDeleteItem.mockReset().mockResolvedValue({});
    mockedQuery.mockReset().mockResolvedValue({ Items: [] });
  });

  it('keys the SK as MODEL#<endpoint>#<region>#<modelId> (region sentinel when absent)', async () => {
    await putModelRegistryEntry(
      { modelId: 'openai.gpt-oss-120b-1:0', endpoint: Endpoint.BedrockMantle, provider: 'openai' },
      { tableName: TABLE }
    );
    const item = mockedPutItem.mock.calls[0][0].Item;
    expect(item.PK).toBe('MODEL');
    expect(item.SK).toBe('MODEL#bedrock-mantle#-#openai.gpt-oss-120b-1:0');
    expect(item.endpoint).toBe(Endpoint.BedrockMantle);
  });

  it('includes the region in the SK and stores it as an attribute', async () => {
    await putModelRegistryEntry(
      {
        modelId: 'us.openai.gpt-6-sol',
        endpoint: Endpoint.BedrockRuntime,
        provider: 'openai',
        scope: 'cross-region',
        region: 'us-east-2',
      },
      { tableName: TABLE }
    );
    const item = mockedPutItem.mock.calls[0][0].Item;
    expect(item.SK).toBe('MODEL#bedrock-runtime#us-east-2#us.openai.gpt-6-sol');
    expect(item.region).toBe('us-east-2');
    expect(item.scope).toBe('cross-region');
  });

  it('the SAME id in two regions writes two distinct SKs (no collision)', async () => {
    await putModelRegistryEntry(
      { modelId: 'anthropic.claude', endpoint: Endpoint.BedrockRuntime, provider: 'anthropic', region: 'us-east-2' },
      { tableName: TABLE }
    );
    await putModelRegistryEntry(
      { modelId: 'anthropic.claude', endpoint: Endpoint.BedrockRuntime, provider: 'anthropic', region: 'eu-central-1' },
      { tableName: TABLE }
    );
    const sk1 = mockedPutItem.mock.calls[0][0].Item.SK;
    const sk2 = mockedPutItem.mock.calls[1][0].Item.SK;
    expect(sk1).not.toBe(sk2);
    expect(sk1).toBe('MODEL#bedrock-runtime#us-east-2#anthropic.claude');
    expect(sk2).toBe('MODEL#bedrock-runtime#eu-central-1#anthropic.claude');
  });

  it('getModelRegistryEntry looks up by (modelId, endpoint, region)', async () => {
    await getModelRegistryEntry('m1', Endpoint.BedrockRuntime, { tableName: TABLE }, 'us-east-2');
    expect(mockedGetItem.mock.calls[0][0].Key).toEqual({
      PK: 'MODEL',
      SK: 'MODEL#bedrock-runtime#us-east-2#m1',
    });
  });

  it('removeModelRegistryEntry deletes the exact (modelId, endpoint, region) row', async () => {
    await removeModelRegistryEntry('m1', Endpoint.BedrockMantle, { tableName: TABLE }, 'eu-central-1');
    expect(mockedDeleteItem.mock.calls[0][0].Key).toEqual({
      PK: 'MODEL',
      SK: 'MODEL#bedrock-mantle#eu-central-1#m1',
    });
  });

  it('loadModelRegistry queries the single MODEL partition (never a Scan)', async () => {
    mockedQuery.mockResolvedValueOnce({
      Items: [
        { PK: 'MODEL', SK: 'MODEL#bedrock-runtime#m1', modelId: 'm1', endpoint: 'bedrock-runtime', provider: 'p' },
        { PK: 'MODEL', SK: 'MODEL#bedrock-mantle#m1', modelId: 'm1', endpoint: 'bedrock-mantle', provider: 'p' },
      ],
    });
    const registry = await loadModelRegistry({ tableName: TABLE });
    expect(mockedQuery.mock.calls[0][0].KeyConditionExpression).toBe('PK = :pk');
    expect(registry.list()).toHaveLength(2);
    expect(registry.endpointsFor('m1').sort()).toEqual(
      [Endpoint.BedrockMantle, Endpoint.BedrockRuntime].sort()
    );
  });
});
