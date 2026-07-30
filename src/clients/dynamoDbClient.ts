/**
 * Thin AWS SDK v3 wrapper around the DynamoDB Document client.
 *
 * Centralizing client construction here lets every component share one
 * configured client (and lets tests substitute a mock/fake) without each
 * module reaching into the SDK directly.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  GetCommandInput,
  GetCommandOutput,
  PutCommand,
  PutCommandInput,
  PutCommandOutput,
  UpdateCommand,
  UpdateCommandInput,
  UpdateCommandOutput,
  QueryCommand,
  QueryCommandInput,
  QueryCommandOutput,
  TransactWriteCommand,
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
  DeleteCommand,
  DeleteCommandInput,
  DeleteCommandOutput,
} from "@aws-sdk/lib-dynamodb";

let documentClient: DynamoDBDocumentClient | undefined;

/**
 * Returns a process-wide singleton DynamoDB Document client.
 */
export function getDynamoDbDocumentClient(): DynamoDBDocumentClient {
  if (!documentClient) {
    const baseClient = new DynamoDBClient({});
    documentClient = DynamoDBDocumentClient.from(baseClient, {
      marshallOptions: {
        removeUndefinedValues: true,
      },
    });
  }
  return documentClient;
}

/**
 * Allows tests to inject a fake/mock Document client.
 */
export function setDynamoDbDocumentClient(client: DynamoDBDocumentClient): void {
  documentClient = client;
}

export async function getItem(input: GetCommandInput): Promise<GetCommandOutput> {
  return getDynamoDbDocumentClient().send(new GetCommand(input));
}

export async function putItem(input: PutCommandInput): Promise<PutCommandOutput> {
  return getDynamoDbDocumentClient().send(new PutCommand(input));
}

export async function updateItem(input: UpdateCommandInput): Promise<UpdateCommandOutput> {
  return getDynamoDbDocumentClient().send(new UpdateCommand(input));
}

export async function query(input: QueryCommandInput): Promise<QueryCommandOutput> {
  return getDynamoDbDocumentClient().send(new QueryCommand(input));
}

export async function transactWrite(
  input: TransactWriteCommandInput
): Promise<TransactWriteCommandOutput> {
  return getDynamoDbDocumentClient().send(new TransactWriteCommand(input));
}

export async function deleteItem(input: DeleteCommandInput): Promise<DeleteCommandOutput> {
  return getDynamoDbDocumentClient().send(new DeleteCommand(input));
}
