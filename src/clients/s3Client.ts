/**
 * Thin AWS SDK v3 wrapper around the S3 client.
 *
 * Centralizing client construction here lets every component share one
 * configured client (and lets tests substitute a mock/fake) without each
 * module reaching into the SDK directly.
 */
import {
  S3Client,
  GetObjectCommand,
  GetObjectCommandInput,
  GetObjectCommandOutput,
} from "@aws-sdk/client-s3";

let s3Client: S3Client | undefined;

/**
 * Returns a process-wide singleton S3 client.
 */
export function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({});
  }
  return s3Client;
}

/**
 * Allows tests to inject a fake/mock S3 client.
 */
export function setS3Client(client: S3Client): void {
  s3Client = client;
}

export async function getObject(input: GetObjectCommandInput): Promise<GetObjectCommandOutput> {
  return getS3Client().send(new GetObjectCommand(input));
}
