/**
 * Team <-> Mantle Project mapping (requirements.md FR-3.1, FR-6.2).
 *
 * The `bedrock-mantle` endpoint has no per-request identity log; its usage
 * is attributed via the `Project` dimension on `AWS/BedrockMantle`
 * CloudWatch metrics. This store maps each Mantle project id to the Team it
 * belongs to, so metric data can be attributed per team regardless of
 * whether the caller authenticated with SigV4 or a Bedrock API key.
 *
 * Table key schema (single-partition for Scan-free listing):
 *   PK = `MAPPING`
 *   SK = `PROJECT#<projectId>`
 *   attribute `team`, `projectId`
 */
import { getItem, putItem, query } from './clients/dynamoDbClient';
import { Team } from './types';

const PARTITION_KEY = 'MAPPING';
const PROJECT_SORT_KEY_PREFIX = 'PROJECT#';

export interface TeamProjectMapping {
  projectId: string;
  team: Team;
}

export interface TeamProjectMappingStoreOptions {
  /** Name of the DynamoDB table backing the mapping store. */
  tableName: string;
}

function buildSortKey(projectId: string): string {
  return `${PROJECT_SORT_KEY_PREFIX}${projectId}`;
}

interface MappingItem {
  PK: string;
  SK: string;
  projectId: string;
  team: Team;
}

/** Upserts a project -> team mapping. */
export async function putTeamProjectMapping(
  projectId: string,
  team: Team,
  options: TeamProjectMappingStoreOptions
): Promise<void> {
  const item: MappingItem = {
    PK: PARTITION_KEY,
    SK: buildSortKey(projectId),
    projectId,
    team,
  };
  await putItem({ TableName: options.tableName, Item: item });
}

/** Resolves the Team for a given Mantle project id via a targeted GetItem (never a Scan). */
export async function resolveTeamForProject(
  projectId: string,
  options: TeamProjectMappingStoreOptions
): Promise<Team | undefined> {
  const response = await getItem({
    TableName: options.tableName,
    Key: { PK: PARTITION_KEY, SK: buildSortKey(projectId) },
  });
  return (response.Item as MappingItem | undefined)?.team;
}

/**
 * Lists all project -> team mappings via a bounded single-partition Query
 * on `PK = MAPPING` (never a Scan). Follows pagination to completion.
 */
export async function listTeamProjectMappings(
  options: TeamProjectMappingStoreOptions
): Promise<TeamProjectMapping[]> {
  const mappings: TeamProjectMapping[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const response = await query({
      TableName: options.tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': PARTITION_KEY },
      ExclusiveStartKey: exclusiveStartKey,
    });
    for (const item of (response.Items ?? []) as MappingItem[]) {
      mappings.push({ projectId: item.projectId, team: item.team });
    }
    exclusiveStartKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return mappings;
}

/** Builds a projectId -> team lookup map from a list of mappings. */
export function toProjectTeamLookup(mappings: TeamProjectMapping[]): Map<string, Team> {
  return new Map(mappings.map((m) => [m.projectId, m.team]));
}
