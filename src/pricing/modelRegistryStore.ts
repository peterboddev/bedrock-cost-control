/**
 * DynamoDB-backed loader/writer for the model registry (requirements.md
 * FR-1, FR-6.1). Keeps the registry data-driven so new models require no
 * code change (NFR-5).
 *
 * Table key schema (single-partition for Scan-free listing):
 *   PK = `MODEL`
 *   SK = `MODEL#<endpoint>#<modelId>`
 *   attributes: modelId, endpoint, provider
 *
 * The sort key folds in the endpoint so (model, endpoint) is the unique row
 * identity: the same model id can be allowed on BOTH `bedrock-runtime` and
 * `bedrock-mantle` as two independent whitelist entries (the admin decides per
 * endpoint). Writing the same (modelId, endpoint) overwrites in place.
 */
import { deleteItem, getItem, putItem, query } from '../clients/dynamoDbClient';
import { ModelRegistry, ModelRegistryEntry } from './modelRegistry';
import { Endpoint } from './types';

const PARTITION_KEY = 'MODEL';
const SORT_KEY_PREFIX = 'MODEL#';
/**
 * Sentinel region segment for the sort key when an entry carries no region
 * (backward compatibility with rows written before region was part of the
 * key). New whitelist entries always set a real region.
 */
const NO_REGION = '-';

export interface ModelRegistryStoreOptions {
  tableName: string;
}

interface ModelItem {
  PK: string;
  SK: string;
  modelId: string;
  endpoint: Endpoint;
  provider: string;
  scope?: string;
  region?: string;
}

/**
 * Sort key folds endpoint + region + modelId so (modelId, endpoint, region) is
 * the unique whitelist identity: a model can be allowed on both endpoints and
 * in multiple regions, each a distinct entry.
 */
function buildSortKey(modelId: string, endpoint: Endpoint, region?: string): string {
  return `${SORT_KEY_PREFIX}${endpoint}#${region ?? NO_REGION}#${modelId}`;
}

/** Upserts one model registry entry, keyed by (modelId, endpoint, region). */
export async function putModelRegistryEntry(
  entry: ModelRegistryEntry,
  options: ModelRegistryStoreOptions
): Promise<void> {
  const item: ModelItem = {
    PK: PARTITION_KEY,
    SK: buildSortKey(entry.modelId, entry.endpoint, entry.region),
    modelId: entry.modelId,
    endpoint: entry.endpoint,
    provider: entry.provider,
    ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
    ...(entry.region !== undefined ? { region: entry.region } : {}),
  };
  await putItem({ TableName: options.tableName, Item: item });
}

/** Reads a single model entry for a (modelId, endpoint, region), or undefined. */
export async function getModelRegistryEntry(
  modelId: string,
  endpoint: Endpoint,
  options: ModelRegistryStoreOptions,
  region?: string
): Promise<ModelRegistryEntry | undefined> {
  const response = await getItem({
    TableName: options.tableName,
    Key: { PK: PARTITION_KEY, SK: buildSortKey(modelId, endpoint, region) },
  });
  const item = response.Item as ModelItem | undefined;
  return item ? toEntry(item) : undefined;
}

/** Removes a single model registry entry (un-whitelists a model on one endpoint+region). */
export async function removeModelRegistryEntry(
  modelId: string,
  endpoint: Endpoint,
  options: ModelRegistryStoreOptions,
  region?: string
): Promise<void> {
  await deleteItem({
    TableName: options.tableName,
    Key: { PK: PARTITION_KEY, SK: buildSortKey(modelId, endpoint, region) },
  });
}

/** Loads the full registry via a bounded single-partition Query (never a Scan). */
export async function loadModelRegistry(
  options: ModelRegistryStoreOptions
): Promise<ModelRegistry> {
  const entries: ModelRegistryEntry[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const response = await query({
      TableName: options.tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': PARTITION_KEY },
      ExclusiveStartKey: exclusiveStartKey,
    });
    for (const item of (response.Items ?? []) as ModelItem[]) {
      entries.push(toEntry(item));
    }
    exclusiveStartKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return ModelRegistry.fromList(entries);
}

function toEntry(item: ModelItem): ModelRegistryEntry {
  return {
    modelId: item.modelId,
    endpoint: item.endpoint,
    provider: item.provider,
    ...(item.scope !== undefined ? { scope: item.scope as ModelRegistryEntry['scope'] } : {}),
    ...(item.region !== undefined ? { region: item.region } : {}),
  };
}
