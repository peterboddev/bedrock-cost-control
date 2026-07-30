/**
 * Notification_Channel publishing: publishes "blocked"/"restored"
 * enforcement notifications to an optionally configured SNS topic.
 *
 * See design.md's Quota_Enforcer / Daily_Reset sections ("...publishes an
 * SNS notification for every attach/remove action.") and the Error
 * Handling table entry for "SNS publish fails", which specifies that
 * publishing is best-effort: a notification failure must never block or
 * roll back the underlying enforcement action (attach/remove and audit
 * logging proceed regardless), per Requirement 7's
 * "WHERE a Notification_Channel is configured" phrasing.
 */
import { publish } from './clients/snsClient';
import { retryWithBackoff, RetryOptions } from './retry';
import { Model, Team } from './types';

/** The two enforcement actions that can trigger a notification. */
export type NotificationAction = 'blocked' | 'restored';

export interface PublishNotificationOptions {
  /**
   * ARN of the configured Notification_Channel SNS topic. If undefined or
   * empty, the Notification_Channel is treated as unconfigured and
   * `publishNotification` is a safe no-op (Requirement 7's "WHERE a
   * Notification_Channel is configured" qualifier).
   */
  topicArn?: string;
  /** Bounded retry options for the underlying SNS publish call. */
  retryOptions?: RetryOptions;
}

/** Shape of the JSON message body published to the Notification_Channel. */
export interface NotificationMessage {
  action: NotificationAction;
  team: Team;
  model: Model;
  /** Present only for "blocked" notifications (Requirement 7.1). */
  dailyTokenQuota?: number;
}

function buildSubject(action: NotificationAction, team: Team, model: Model): string {
  return action === 'blocked'
    ? `Bedrock quota exceeded: ${team} blocked from ${model}`
    : `Bedrock access restored: ${team} restored for ${model}`;
}

function buildMessage(
  action: NotificationAction,
  team: Team,
  model: Model,
  dailyTokenQuota?: number
): NotificationMessage {
  if (action === 'blocked') {
    return { action, team, model, dailyTokenQuota };
  }
  return { action, team, model };
}

/**
 * Publishes a "blocked" or "restored" enforcement notification to the
 * configured Notification_Channel (SNS topic).
 *
 * - `action: 'blocked'` publishes a message identifying the Team, Model,
 *   and the Daily_Token_Quota that was exceeded (Requirement 7.1).
 * - `action: 'restored'` publishes a message identifying the Team and
 *   Model that was restored (Requirement 7.2); `dailyTokenQuota` is
 *   ignored for this action.
 *
 * If no Notification_Channel is configured (`options.topicArn` is
 * undefined/empty), this is a safe no-op.
 *
 * Publishing is best-effort: any failure (including retry exhaustion) is
 * swallowed after being retried a bounded number of times, and never
 * throws, so it can never block or roll back the underlying enforcement
 * action.
 *
 * Validates: Requirements 7.1, 7.2
 */
export async function publishNotification(
  action: NotificationAction,
  team: Team,
  model: Model,
  dailyTokenQuota?: number,
  options: PublishNotificationOptions = {}
): Promise<void> {
  const { topicArn, retryOptions } = options;

  if (!topicArn) {
    return;
  }

  const message = buildMessage(action, team, model, dailyTokenQuota);

  try {
    await retryWithBackoff(
      () =>
        publish({
          TopicArn: topicArn,
          Subject: buildSubject(action, team, model),
          Message: JSON.stringify(message),
        }),
      retryOptions
    );
  } catch (error) {
    // Best-effort: log and swallow. Notification failures must never
    // block or roll back the underlying enforcement action.
    // eslint-disable-next-line no-console
    console.error('Failed to publish Notification_Channel message', {
      action,
      team,
      model,
      error,
    });
  }
}
