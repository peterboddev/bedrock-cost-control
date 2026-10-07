import { buildMantleDenyPolicyDocument, buildMantleDenyPolicyName } from './mantleDenyPolicy';

describe('buildMantleDenyPolicyDocument', () => {
  it('denies bedrock-mantle:CreateInference scoped to the model via the condition key', () => {
    const doc = buildMantleDenyPolicyDocument('openai.gpt-6-sol');
    expect(doc.Version).toBe('2012-10-17');
    expect(doc.Statement).toHaveLength(1);
    expect(doc.Statement[0].Effect).toBe('Deny');
    expect(doc.Statement[0].Action).toEqual(['bedrock-mantle:CreateInference']);
    expect(doc.Statement[0].Resource).toBe('arn:aws:bedrock-mantle:*:*:project/*');
    expect(doc.Statement[0].Condition.StringEquals['bedrock-mantle:Model']).toBe('openai.gpt-6-sol');
  });

  it('rejects model identifiers with characters unsafe for IAM policy generation', () => {
    for (const unsafe of ['', 'model with space', 'model*', 'a"b', "a'b", 'a\\b', 'a?b', 'a{b}', 'a[b]']) {
      expect(() => buildMantleDenyPolicyDocument(unsafe)).toThrow(/unsafe for IAM policy/);
    }
  });

  it('accepts realistic model ids (alphanumerics, dot, colon, dash, slash)', () => {
    expect(() => buildMantleDenyPolicyDocument('openai.gpt-oss-120b-1:0')).not.toThrow();
    expect(() => buildMantleDenyPolicyDocument('us.anthropic.claude-opus-4-5-20251101-v1:0')).not.toThrow();
  });
});

describe('buildMantleDenyPolicyName', () => {
  it('is deterministic and differs per model', () => {
    expect(buildMantleDenyPolicyName('openai.gpt-6-sol')).toBe(buildMantleDenyPolicyName('openai.gpt-6-sol'));
    expect(buildMantleDenyPolicyName('openai.gpt-6-sol')).not.toBe(buildMantleDenyPolicyName('minimax.m2-5'));
  });

  it('uses a distinct prefix from the Converse deny policy so both can coexist on one role', () => {
    expect(buildMantleDenyPolicyName('m')).toMatch(/^bedrock-mantle-quota-deny-/);
  });
});
