/**
 * Reads Blocked_State across all teams for the admin "currently blocked"
 * view (requirements.md C1 admins-see-all, FR-7).
 *
 * Blocked_State items already carry a low-cardinality `status`
 * (`BLOCKED` | `PENDING_RESET`). A `StatusIndex` GSI (PK = `status`) lets
 * the analytics export read every active block via a bounded
 * single-partition Query — never a table Scan. Block/unblock are infrequent
 * events, so the two-value partition is not a hot-write concern.
 */
import { query } from './clients/dynamoDbClient';
import { Endpoint } from './pricing/types';
import { Model, Team } from './types';

/** Name of the GSI (PK = `status`) over Blocked_State. */
export const BLOCKED_STATUS_INDEX_NAME = 'StatusIndex';

export type BlockedStatus = 'BLOCKED' | 'PENDING_RESET';

/** One currently-recorded block, flattened for the admin view. */
export interface ActiveBlock {
  team: Team;
  model: Model;
  status: BlockedStatus;
  blockedUsageDay: string;
  blockedAt: string;
  endpoint: Endpoint;
}

interface BlockedStateItem {
  PK: string;
  SK: string;
  status: BlockedStatus;
  blockedUsageDay: string;
  blockedAt: string;
  endpoint?: Endpoint;
}

const TEAM_PARTITION_KEY_PREFIX = 'TEAM#';
const MODEL_SORT_KEY_PREFIX = 'MODEL#';

function extractTeam(pk: string): Team {
  return pk.startsWith(TEAM_PARTITION_KEY_PREFIX) ? pk.slice(TEAM_PARTITION_KEY_PREFIX.length) : pk;
}

function extractModel(sk: string): Model {
  return sk.startsWith(MODEL_SORT_KEY_PREFIX) ? sk.slice(MODEL_SORT_KEY_PREFIX.length) : sk;
}

export interface ListBlockedStatesOptions {
  /** Name of the DynamoDB table backing Blocked_State. */
  tableName: string;
  /** Name of the StatusIndex GSI; defaults to `StatusIndex`. */
  indexName?: string;
}

/**
 * Lists every Blocked_State row with the given status across all teams,
 * via a bounded single-partition Query on the `StatusIndex` GSI.
 */
export async function listBlockedStatesByStatus(
  status: BlockedStatus,
  options: ListBlockedStatesOptions
): Promise<ActiveBlock[]> {
  const blocks: ActiveBlock[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const response = await query({
      TableName: options.tableName,
      IndexName: options.indexName ?? BLOCKED_STATUS_INDEX_NAME,
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status },
      ExclusiveStartKey: exclusiveStartKey,
    });

    for (const item of (response.Items ?? []) as BlockedStateItem[]) {
      blocks.push({
        team: extractTeam(item.PK),
        model: extractModel(item.SK),
        status: item.status,
        blockedUsageDay: item.blockedUsageDay,
        blockedAt: item.blockedAt,
        endpoint: item.endpoint === Endpoint.BedrockMantle ? Endpoint.BedrockMantle : Endpoint.BedrockRuntime,
      });
    }

    exclusiveStartKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return blocks;
}

/** Lists all currently-recorded blocks (both BLOCKED and PENDING_RESET). */
export async function listAllActiveBlocks(options: ListBlockedStatesOptions): Promise<ActiveBlock[]> {
  const [blocked, pending] = await Promise.all([
    listBlockedStatesByStatus('BLOCKED', options),
    listBlockedStatesByStatus('PENDING_RESET', options),
  ]);
  return [...blocked, ...pending];
}
