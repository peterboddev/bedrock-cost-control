/**
 * Custom resource Lambda that enables (on CREATE/UPDATE) or disables (on
 * DELETE) Amazon Bedrock Model Invocation Logging for the current account
 * and region, via `bedrock:PutModelInvocationLoggingConfiguration` /
 * `bedrock:DeleteModelInvocationLoggingConfiguration`.
 *
 * Model Invocation Logging has no native `AWS::Bedrock::*` CloudFormation
 * resource type (it is an account/region-level singleton configuration, not
 * a discrete resource) - AWS's own reference pattern for provisioning it via
 * infrastructure-as-code is a custom resource backed by exactly these two
 * control-plane API calls. See
 * https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/configure-bedrock-invocation-logging-cloudformation.html
 *
 * This is a hard prerequisite for the whole bedrock-team-token-quota
 * pipeline: without it, Bedrock never delivers `ModelInvocationLog` entries
 * (containing `inputTokenCount`/`outputTokenCount`) to the S3 bucket that
 * triggers Usage_Collector, so no usage is ever recorded and no quota is
 * ever enforced. CloudTrail alone is not sufficient - it records that an
 * `InvokeModel`/`Converse` call happened and which IAM principal made it,
 * but never the token counts (Bedrock always reports CloudTrail's
 * `responseElements` as `null`).
 *
 * On DELETE, the logging configuration is removed so that destroying this
 * stack in a sandbox account also cleans up the account-level Bedrock
 * setting it created, rather than leaving it dangling.
 */
import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from 'aws-lambda';

import {
  deleteModelInvocationLoggingConfiguration,
  putModelInvocationLoggingConfiguration,
} from '../clients/bedrockClient';

const PHYSICAL_RESOURCE_ID = 'BedrockModelInvocationLoggingConfiguration';

export async function handler(
  event: CdkCustomResourceEvent
): Promise<CdkCustomResourceResponse> {
  if (event.RequestType === 'Delete') {
    try {
      await deleteModelInvocationLoggingConfiguration({});
    } catch (error) {
      // Best-effort on delete: if the configuration was already removed (or
      // never fully applied), do not fail stack teardown over it.
      // eslint-disable-next-line no-console
      console.warn('DeleteModelInvocationLoggingConfiguration failed (continuing)', error);
    }
    return { PhysicalResourceId: PHYSICAL_RESOURCE_ID };
  }

  const bucketName = event.ResourceProperties.bucketName as string;
  const keyPrefix = event.ResourceProperties.keyPrefix as string | undefined;

  await putModelInvocationLoggingConfiguration({
    loggingConfig: {
      s3Config: {
        bucketName,
        keyPrefix,
      },
      textDataDeliveryEnabled: true,
      imageDataDeliveryEnabled: false,
      embeddingDataDeliveryEnabled: false,
    },
  });

  return { PhysicalResourceId: PHYSICAL_RESOURCE_ID };
}
