import { buildDenyPolicy, buildDenyPolicyName } from './denyPolicyFactory';
import { buildMantleDenyPolicyName } from './mantleDenyPolicy';
import { buildModelDenyPolicyName } from './quotaEnforcer';
import { Endpoint } from './pricing/types';

describe('denyPolicyFactory', () => {
  it('defaults to the bedrock-runtime (Converse) policy', () => {
    expect(buildDenyPolicyName('m')).toBe(buildModelDenyPolicyName('m'));
    expect(buildDenyPolicy('m').name).toBe(buildModelDenyPolicyName('m'));
    expect(buildDenyPolicy('m').document).toContain('BedrockTeamTokenQuotaDeny');
  });

  it('selects the Mantle policy for bedrock-mantle models', () => {
    expect(buildDenyPolicyName('m', Endpoint.BedrockMantle)).toBe(buildMantleDenyPolicyName('m'));
    const policy = buildDenyPolicy('m', Endpoint.BedrockMantle);
    expect(policy.name).toBe(buildMantleDenyPolicyName('m'));
    expect(policy.document).toContain('bedrock-mantle:CreateInference');
    expect(policy.document).toContain('bedrock-mantle:Model');
  });

  it('runtime and mantle names never collide for the same model', () => {
    expect(buildDenyPolicyName('m', Endpoint.BedrockRuntime)).not.toBe(
      buildDenyPolicyName('m', Endpoint.BedrockMantle)
    );
  });
});
