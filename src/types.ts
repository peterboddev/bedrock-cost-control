/**
 * Core domain types shared across the bedrock-team-token-quota system.
 * See design.md's "Data Models" section for the full data model.
 */

/** A Team is identified by the value of the configured Team_Tag_Key on an IAM Role. */
export type Team = string;

/** Sentinel Team value used when an IAM Role has no Team_Tag_Key tag. */
export const UNMAPPED_ROLE = 'UNMAPPED';

/** An Amazon Bedrock foundation model identifier (model ID or inference profile ARN). */
export type Model = string;

/** A UTC calendar date string in ISO 8601 date form, e.g. "2025-01-15". */
export type UsageDay = string;

/**
 * A single normalized record produced by the Usage_Collector representing one
 * successful Bedrock model invocation.
 */
export interface TokenUsageRecord {
  requestId: string;
  roleArn: string;
  model: Model;
  inputTokens: number;
  outputTokens: number;
  timestamp: string;
  usageDay: UsageDay;
}
