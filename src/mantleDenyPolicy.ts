/**
 * Mantle Model_Deny_Policy (requirements.md FR-5.2).
 *
 * Blocks a team's access to a specific Mantle model by denying
 * `bedrock-mantle:CreateInference`, scoped to that one model via the
 * `bedrock-mantle:Model` condition key. Because short-term Bedrock API
 * keys inherit the permissions of the IAM principal that generated them,
 * attaching this deny to the team's IAM role blocks both SigV4 and
 * API-key/bearer-token callers (FR-3.3) — no separate bearer-token deny
 * (which would be all-or-nothing across every model) is needed.
 */
import { createHash } from 'crypto';

import { Model } from './types';

/** The Mantle inference action denied by a Mantle Model_Deny_Policy. */
const DENIED_MANTLE_ACTIONS = ['bedrock-mantle:CreateInference'];

/** Prefix for the deterministic, per-model Mantle inline policy name. */
const MANTLE_DENY_POLICY_NAME_PREFIX = 'bedrock-mantle-quota-deny-';

/** The IAM inline policy document shape attached to a blocked team's role for a Mantle model. */
export interface MantleModelDenyPolicyDocument {
  Version: '2012-10-17';
  Statement: [
    {
      Sid: 'BedrockMantleTeamTokenQuotaDeny';
      Effect: 'Deny';
      Action: string[];
      Resource: string;
      Condition: { StringEquals: { 'bedrock-mantle:Model': string } };
    },
  ];
}

/**
 * Validates a model identifier for safe use in IAM policy documents.
 * Same validation as quotaEnforcer.ts's validateModelForPolicy — defense-in-
 * depth against characters that would alter IAM policy semantics.
 */
function validateModelForPolicy(model: Model): void {
  if (!model || /[\s"'\\*?{}[\]]/.test(model)) {
    throw new Error(`Model identifier "${model}" contains characters unsafe for IAM policy generation`);
  }
}

/**
 * Builds the Mantle Model_Deny_Policy document for a specific model: denies
 * `bedrock-mantle:CreateInference` across all Mantle projects, narrowed to
 * the one model via the `bedrock-mantle:Model` condition key so other
 * models remain usable.
 */
export function buildMantleDenyPolicyDocument(model: Model): MantleModelDenyPolicyDocument {
  validateModelForPolicy(model);
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'BedrockMantleTeamTokenQuotaDeny',
        Effect: 'Deny',
        Action: [...DENIED_MANTLE_ACTIONS],
        Resource: 'arn:aws:bedrock-mantle:*:*:project/*',
        Condition: { StringEquals: { 'bedrock-mantle:Model': model } },
      },
    ],
  };
}

/**
 * Builds a deterministic inline policy name for a Mantle model's deny
 * policy. Uses a distinct prefix from the Converse (bedrock-runtime) deny
 * policy so a model available on both endpoints gets two independent,
 * non-colliding policies on the same role.
 */
export function buildMantleDenyPolicyName(model: Model): string {
  const hash = createHash('sha256').update(model).digest('hex').slice(0, 32);
  return `${MANTLE_DENY_POLICY_NAME_PREFIX}${hash}`;
}
