/**
 * Endpoint-aware deny-policy selector (requirements.md FR-5.3).
 *
 * Chooses the correct Model_Deny_Policy (document + inline policy name)
 * based on which endpoint serves the model: `bedrock-runtime` (Converse /
 * InvokeModel) or `bedrock-mantle`. Callers that attach/remove deny
 * policies (Quota_Enforcer, TagRole handler, Daily_Reset) use this so they
 * don't have to branch on endpoint themselves.
 *
 * Importing the runtime builders from quotaEnforcer here (rather than the
 * other way round) keeps the dependency acyclic: quotaEnforcer imports only
 * ./mantleDenyPolicy for its Mantle branch, never this factory.
 */
import { buildMantleDenyPolicyDocument, buildMantleDenyPolicyName } from './mantleDenyPolicy';
import { Endpoint } from './pricing/types';
import { buildModelDenyPolicyDocument, buildModelDenyPolicyName } from './quotaEnforcer';
import { Model } from './types';

/** A resolved deny policy: its inline name and its JSON document string. */
export interface DenyPolicy {
  name: string;
  document: string;
}

/** Returns the inline policy name for a model on the given endpoint. */
export function buildDenyPolicyName(
  model: Model,
  endpoint: Endpoint = Endpoint.BedrockRuntime
): string {
  return endpoint === Endpoint.BedrockMantle
    ? buildMantleDenyPolicyName(model)
    : buildModelDenyPolicyName(model);
}

/** Returns the full deny policy (name + JSON document) for a model on the given endpoint. */
export function buildDenyPolicy(
  model: Model,
  endpoint: Endpoint = Endpoint.BedrockRuntime
): DenyPolicy {
  if (endpoint === Endpoint.BedrockMantle) {
    return {
      name: buildMantleDenyPolicyName(model),
      document: JSON.stringify(buildMantleDenyPolicyDocument(model)),
    };
  }
  return {
    name: buildModelDenyPolicyName(model),
    document: JSON.stringify(buildModelDenyPolicyDocument(model)),
  };
}
