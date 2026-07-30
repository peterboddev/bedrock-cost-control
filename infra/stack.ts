/**
 * CDK stack defining the DynamoDB tables, Lambda functions, and event
 * wiring that back the bedrock-team-token-quota system, per design.md's
 * "Data Models" and "Components and Interfaces" sections:
 *
 *  - Usage_Aggregation   (Streams NEW_AND_OLD_IMAGES, TTL)
 *  - Processed_Requests  (dedup index, TTL)
 *  - Team_Role_Cache     (TeamIndex GSI, TTL)
 *  - Quota_Configuration (no TTL - persistent admin config)
 *  - Blocked_State       (StatusDayIndex GSI, no TTL - current state)
 *  - Audit_Log           (TTL)
 *
 *  - Usage_Collector Lambda   (S3 ObjectCreated event source)
 *  - Quota_Enforcer Lambda    (Usage_Aggregation DynamoDB Streams + TagRole/UntagRole EventBridge rule)
 *  - Daily_Reset Lambda       (00:00 UTC scheduled EventBridge rule)
 *  - Reconciliation Lambda    (15-minute scheduled EventBridge rule)
 *  - Admin API Lambda         (adminApi.ts handlers; no trigger wired here - callable via SDK/future API Gateway)
 *  - Notification_Channel SNS topic
 *
 * Every Lambda's execution role is scoped to exactly the DynamoDB
 * tables/actions and IAM/SNS actions it needs, per design.md's component
 * responsibilities - see the per-Lambda comments below for the specific
 * least-privilege grants applied and why.
 *
 * NOTE: RemovalPolicy defaults to DESTROY, which is appropriate for a
 * dev/sandbox deployment of this stack. Production deployments should
 * override this (e.g. via a stack prop) to RemovalPolicy.RETAIN so that
 * usage history, audit trail, and quota configuration are not deleted on
 * stack teardown/replacement.
 */
import * as path from "path";

import { Stack, StackProps, RemovalPolicy, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  StreamViewType,
  Table,
  TableProps,
} from "aws-cdk-lib/aws-dynamodb";
import { CustomResource, CfnOutput, Tags } from "aws-cdk-lib";
import { Provider } from "aws-cdk-lib/custom-resources";
import { EventPattern, Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction as LambdaEventTarget } from "aws-cdk-lib/aws-events-targets";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { ArnPrincipal, CompositePrincipal, Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { BlockPublicAccess, Bucket, BucketEncryption, EventType, IBucket } from "aws-cdk-lib/aws-s3";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import { Topic } from "aws-cdk-lib/aws-sns";

import { ENV_VAR_NAMES } from "../src/envConfig";

/**
 * Removal policy applied to every table in this stack. Defaults to DESTROY
 * for dev/sandbox convenience; pass RemovalPolicy.RETAIN via stack props for
 * production deployments.
 */
const DEFAULT_REMOVAL_POLICY = RemovalPolicy.DESTROY;

/**
 * Name of the IAM tag key (on IAM Roles) that identifies a role's Team,
 * per Requirement 1.1. Configurable via stack props since it is an
 * administrator-controlled convention, not a hardcoded value (design.md's
 * Team_Role_Cache section, Requirement 1.1's unit test intent carried
 * through to infra configuration).
 */
const DEFAULT_TEAM_TAG_KEY = "team";

/** Node.js Lambda runtime used by every function in this stack. */
const LAMBDA_RUNTIME = Runtime.NODEJS_20_X;

/** Default Lambda timeout applied to every function in this stack. */
const DEFAULT_LAMBDA_TIMEOUT = Duration.seconds(30);

/**
 * Builds a `PolicyStatement` granting exactly the given DynamoDB actions on
 * a single table (and, when `indexName` is given, on that one GSI only).
 *
 * This deliberately replaces CDK's `Table.grantReadData` /
 * `grantWriteData` / `grantReadWriteData` convenience methods everywhere in
 * this stack: those methods unconditionally include `dynamodb:Scan` (plus
 * `BatchGetItem`/`BatchWriteItem`/`DescribeTable`/`ConditionCheckItem`,
 * none of which any handler in this codebase ever calls) in the generated
 * policy, regardless of which operations the granted code actually
 * performs. Every DynamoDB access pattern in this codebase is a targeted
 * `GetItem`/`PutItem`/`UpdateItem`/`DeleteItem`/`Query` against a known key
 * or a single-partition GSI query - never a `Scan` - so the IAM policy
 * should say exactly that and nothing more.
 */
function grantExactTableActions(
  table: Table,
  actions: string[],
  options?: { indexName?: string; sid?: string }
): PolicyStatement {
  const resources: string[] = [table.tableArn];
  if (options?.indexName) {
    resources.push(`${table.tableArn}/index/${options.indexName}`);
  }
  return new PolicyStatement({
    sid: options?.sid,
    effect: Effect.ALLOW,
    actions: actions.map((action) => `dynamodb:${action}`),
    resources,
  });
}

export interface BedrockTeamTokenQuotaStackProps extends StackProps {
  /**
   * Removal policy applied to all tables in this stack. Defaults to DESTROY
   * (suitable for dev/sandbox). Production deployments should pass
   * RemovalPolicy.RETAIN so usage history, audit trail, and quota
   * configuration survive stack deletion/replacement.
   */
  readonly tableRemovalPolicy?: RemovalPolicy;
  /**
   * The IAM tag key (on IAM Roles) that identifies a role's Team
   * (Requirement 1.1). Defaults to `"team"`.
   */
  readonly teamTagKey?: string;
  /**
   * The S3 bucket that Bedrock Model Invocation Logging delivers log
   * objects to. If omitted, a new bucket is created for this purpose.
   */
  readonly modelInvocationLogBucket?: IBucket;
  /**
   * The value of the Team_Tag_Key tag applied to the dedicated
   * Bedrock_Test_Role this stack creates for the interactive CLI test tool
   * (`npm run test:tokens`). Defaults to `"test-team"`. The test tool's
   * README documents assuming this role, sending real Bedrock invocations
   * through it, and observing the resulting Usage_Aggregation counters and
   * Blocked_State transitions end to end.
   */
  readonly testRoleTeamTagValue?: string;
  /**
   * The exact IAM principal ARN(s) (an IAM user, role, or `<account>:root`
   * if you deliberately want account-wide access) allowed to assume the
   * Bedrock_Test_Role via `sts:AssumeRole`, for the interactive CLI test
   * tool. Required - there is no default - so that deploying this stack
   * never silently grants assume-role trust to every principal in the
   * account. Pass the ARN of whichever specific user/role you (or your
   * CI) will run `npm run test:tokens` as, e.g.
   * `arn:aws:iam::123456789012:user/your-username`.
   */
  readonly testRoleTrustedPrincipalArns: string[];
}

export class BedrockTeamTokenQuotaStack extends Stack {
  public readonly usageAggregationTable: Table;
  public readonly processedRequestsTable: Table;
  public readonly teamRoleCacheTable: Table;
  public readonly quotaConfigurationTable: Table;
  public readonly blockedStateTable: Table;
  public readonly auditLogTable: Table;

  /** The S3 bucket Bedrock Model Invocation Logging delivers log objects to, triggering Usage_Collector. */
  public readonly modelInvocationLogBucket: IBucket;
  /** The Notification_Channel SNS topic (design.md's "Notification_Channel"). */
  public readonly notificationTopic: Topic;
  /**
   * A dedicated IAM role, tagged with the configured Team_Tag_Key, that the
   * interactive CLI test tool assumes via `sts:AssumeRole` to send real
   * Bedrock invocations and observe quota enforcement end to end. Not used
   * by any production component - purely a test fixture provisioned by
   * this stack so the test tool has a role to assume without requiring the
   * operator to hand-create one.
   */
  public readonly testRole: Role;

  public readonly usageCollectorFunction: NodejsFunction;
  public readonly quotaEnforcerStreamFunction: NodejsFunction;
  public readonly tagRoleFunction: NodejsFunction;
  public readonly dailyResetFunction: NodejsFunction;
  public readonly reconciliationFunction: NodejsFunction;
  public readonly adminApiFunction: NodejsFunction;
  public readonly dlqHandlerFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: BedrockTeamTokenQuotaStackProps) {
    super(scope, id, props);

    const removalPolicy = props.tableRemovalPolicy ?? DEFAULT_REMOVAL_POLICY;

    const commonTableProps: Pick<TableProps, "billingMode" | "removalPolicy"> = {
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    };

    // Usage_Aggregation: PK=TEAM#<team>#MODEL#<model>, SK=DAY#<usageDay>
    // Streams enabled to drive the Quota_Enforcer; TTL for 90-day retention.
    this.usageAggregationTable = new Table(this, "UsageAggregationTable", {
      ...commonTableProps,
      tableName: "Usage_Aggregation",
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      timeToLiveAttribute: "ttl",
      stream: StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // Processed_Requests: PK=REQ#<requestId>, dedup index for the
    // Usage_Collector's conditional-write exactly-once guarantee.
    this.processedRequestsTable = new Table(this, "ProcessedRequestsTable", {
      ...commonTableProps,
      tableName: "Processed_Requests",
      partitionKey: { name: "PK", type: AttributeType.STRING },
      timeToLiveAttribute: "ttl",
    });

    // Team_Role_Cache: PK=ROLE#<roleArn>, with a TeamIndex GSI (PK=team) to
    // support listRolesForTeam via a single-partition Query, never a Scan.
    this.teamRoleCacheTable = new Table(this, "TeamRoleCacheTable", {
      ...commonTableProps,
      tableName: "Team_Role_Cache",
      partitionKey: { name: "PK", type: AttributeType.STRING },
      timeToLiveAttribute: "ttl",
    });
    this.teamRoleCacheTable.addGlobalSecondaryIndex({
      indexName: "TeamIndex",
      partitionKey: { name: "team", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // Quota_Configuration: PK=TEAM#<team>, SK=MODEL#<model>. Persistent
    // administrator-managed config; no TTL.
    this.quotaConfigurationTable = new Table(this, "QuotaConfigurationTable", {
      ...commonTableProps,
      tableName: "Quota_Configuration",
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
    });

    // Blocked_State: PK=TEAM#<team>, SK=MODEL#<model>, with a StatusDayIndex
    // GSI (PK=statusDay) to support Daily_Reset's bounded Query for
    // "BLOCKED#<day>" / "PENDING_RESET#<day>" pairs, never a Scan. Current
    // state, not historical data, so no TTL.
    this.blockedStateTable = new Table(this, "BlockedStateTable", {
      ...commonTableProps,
      tableName: "Blocked_State",
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
    });
    this.blockedStateTable.addGlobalSecondaryIndex({
      indexName: "StatusDayIndex",
      partitionKey: { name: "statusDay", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // Audit_Log: PK=TEAM#<team>, SK=TS#<isoTimestamp>#<uuid>. TTL for
    // 90+ day retention (Requirement 8.2).
    this.auditLogTable = new Table(this, "AuditLogTable", {
      ...commonTableProps,
      tableName: "Audit_Log",
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      timeToLiveAttribute: "ttl",
    });

    const teamTagKey = props.teamTagKey ?? DEFAULT_TEAM_TAG_KEY;

    // Notification_Channel: SNS topic that Quota_Enforcer and Daily_Reset
    // publish "blocked"/"restored" notifications to (Requirements 7.1, 7.2).
    this.notificationTopic = new Topic(this, "NotificationTopic", {
      topicName: "BedrockTeamTokenQuota-Notifications",
    });

    // S3 bucket that Bedrock Model Invocation Logging delivers log objects
    // to; an ObjectCreated event notification triggers Usage_Collector.
    this.modelInvocationLogBucket =
      props.modelInvocationLogBucket ??
      new Bucket(this, "ModelInvocationLogBucket", {
        removalPolicy,
        autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
        // This bucket holds full Bedrock invocation logs, which include the
        // complete prompt/completion text (textDataDeliveryEnabled: true in
        // modelInvocationLoggingCustomResourceEntry.ts), not just token
        // counts - see README.md's "Data captured by this system" section.
        // enforceSSL rejects any non-TLS access; S3_MANAGED encryption
        // ensures data is encrypted at rest by default.
        enforceSSL: true,
        encryption: BucketEncryption.S3_MANAGED,
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        lifecycleRules: [
          {
            // Bounds how long full prompt/completion text is retained in
            // this bucket, independent of the 90-day retention applied to
            // the aggregated token-count data in DynamoDB (Usage_Aggregation,
            // Audit_Log). Adjust to match your organization's data
            // retention policy for LLM conversation content.
            expiration: Duration.days(90),
          },
        ],
      });

    const entryDir = path.join(__dirname, "..", "src", "lambdaEntrypoints");
    const depsLockFilePath = path.join(__dirname, "..", "package-lock.json");

    const commonFunctionProps = {
      runtime: LAMBDA_RUNTIME,
      timeout: DEFAULT_LAMBDA_TIMEOUT,
      depsLockFilePath,
      bundling: { minify: false, sourceMap: false },
    };

    // ---------------------------------------------------------------------
    // Model Invocation Logging (custom resource)
    //
    // Enables Amazon Bedrock Model Invocation Logging for this account and
    // region on deploy, and disables it on stack teardown. This is a hard
    // prerequisite for the entire pipeline: Bedrock only ever emits
    // ModelInvocationLog entries (containing inputTokenCount/
    // outputTokenCount) to the configured S3 destination once this
    // configuration is applied. CloudTrail alone never carries token
    // counts (its `responseElements` for Bedrock calls is always null), so
    // without this custom resource the Usage_Collector Lambda would never
    // be invoked and no usage would ever be recorded.
    //
    // Least-privilege IAM applied: the handler is granted exactly
    // bedrock:PutModelInvocationLoggingConfiguration and
    // bedrock:DeleteModelInvocationLoggingConfiguration, Resource: "*"
    // (these are account/region-level singleton settings with no ARN to
    // scope to - Bedrock does not expose a resource-level ARN for the
    // logging configuration itself). No other Bedrock or IAM permissions
    // are granted to this function.
    // ---------------------------------------------------------------------
    const modelInvocationLoggingHandler = new NodejsFunction(
      this,
      "ModelInvocationLoggingHandler",
      {
        ...commonFunctionProps,
        entry: path.join(entryDir, "modelInvocationLoggingCustomResourceEntry.ts"),
        handler: "handler",
      }
    );
    modelInvocationLoggingHandler.addToRolePolicy(
      new PolicyStatement({
        sid: "ManageModelInvocationLoggingConfiguration",
        effect: Effect.ALLOW,
        actions: [
          "bedrock:PutModelInvocationLoggingConfiguration",
          "bedrock:DeleteModelInvocationLoggingConfiguration",
        ],
        resources: ["*"],
      })
    );

    const modelInvocationLoggingProvider = new Provider(
      this,
      "ModelInvocationLoggingProvider",
      { onEventHandler: modelInvocationLoggingHandler }
    );

    const modelInvocationLoggingResource = new CustomResource(
      this,
      "ModelInvocationLoggingConfiguration",
      {
        serviceToken: modelInvocationLoggingProvider.serviceToken,
        properties: {
          bucketName: this.modelInvocationLogBucket.bucketName,
          keyPrefix: "bedrock-model-invocation-logs",
        },
      }
    );
    // Bedrock must be able to write into the bucket before the logging
    // configuration that targets it is applied (and the bucket must still
    // exist when the configuration is torn down on delete).
    modelInvocationLoggingResource.node.addDependency(this.modelInvocationLogBucket);

    // Bucket policy granting bedrock.amazonaws.com permission to deliver
    // logs, scoped to this account and to Bedrock calls originating from
    // this account/region only, per AWS's documented Model Invocation
    // Logging S3 destination policy
    // (https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html).
    this.modelInvocationLogBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: "AmazonBedrockLogsWrite",
        effect: Effect.ALLOW,
        principals: [new ServicePrincipal("bedrock.amazonaws.com")],
        actions: ["s3:PutObject"],
        resources: [
          `${this.modelInvocationLogBucket.bucketArn}/bedrock-model-invocation-logs/AWSLogs/${this.account}/BedrockModelInvocationLogs/*`,
        ],
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": `arn:${this.partition}:bedrock:${this.region}:${this.account}:*` },
        },
      })
    );

    // ---------------------------------------------------------------------
    // Bedrock_Test_Role (test fixture only - not used by any production
    // component)
    //
    // A dedicated IAM role that the interactive CLI test tool
    // (`npm run test:tokens`, see README.md) assumes via `sts:AssumeRole`
    // to send real Bedrock invocations. Tagged with the configured
    // Team_Tag_Key so the deployed Team_Role_Cache/Usage_Collector
    // pipeline attributes its usage to a Team exactly as it would for any
    // real caller - the test exercises the same tag-based attribution path
    // production traffic uses, not a special case.
    //
    // Least-privilege IAM applied: only the four Bedrock invocation
    // actions the pipeline tracks (Requirement 5.2's action list), scoped
    // to `foundation-model/*` (any on-demand foundation model) and
    // `inference-profile/*` (any cross-region inference profile) in this
    // account/region, since the test tool lets the operator pick any
    // model at runtime. No other permissions (no DynamoDB, no IAM, no
    // other AWS service) are granted to this role - it exists solely to
    // generate Bedrock usage for the test tool to observe.
    // ---------------------------------------------------------------------
    const testRoleTeamTagValue = props.testRoleTeamTagValue ?? "test-team";

    if (props.testRoleTrustedPrincipalArns.length === 0) {
      throw new Error(
        "testRoleTrustedPrincipalArns must contain at least one IAM principal ARN. " +
          "This stack refuses to default the Bedrock_Test_Role's trust policy to the " +
          "whole account - pass the ARN of the specific user/role that will run " +
          "`npm run test:tokens`."
      );
    }

    this.testRole = new Role(this, "BedrockTestRole", {
      roleName: "Bedrock_Test_Role",
      // Assumable ONLY by the explicit principal ARN(s) passed in via
      // testRoleTrustedPrincipalArns - never a default, and never the
      // whole account. Tightest trust policy possible for a role whose
      // only purpose is letting the CLI test tool generate real Bedrock
      // usage; the operator must consciously name who is allowed to
      // assume it.
      assumedBy: new CompositePrincipal(
        ...props.testRoleTrustedPrincipalArns.map((arn) => new ArnPrincipal(arn))
      ),
      description:
        "Test fixture role for the bedrock-team-token-quota interactive CLI test tool. Not used by any production component.",
    });
    Tags.of(this.testRole).add(teamTagKey, testRoleTeamTagValue);
    this.testRole.addToPolicy(
      new PolicyStatement({
        sid: "InvokeBedrockModelsForTesting",
        effect: Effect.ALLOW,
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:Converse",
          "bedrock:ConverseStream",
        ],
        resources: [
          `arn:${this.partition}:bedrock:${this.region}::foundation-model/*`,
          `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/*`,
        ],
      })
    );

    // ---------------------------------------------------------------------
    // Usage_Collector Lambda
    //
    // Least-privilege IAM applied (exact per-action grants; CDK's
    // grantReadWriteData is NOT used here because it unconditionally adds
    // dynamodb:Scan and other unused actions - see grantExactTableActions
    // above):
    //  - Usage_Aggregation: dynamodb:UpdateItem only (usageCollector.ts's
    //    TransactWriteItems includes an Update action against this table;
    //    per AWS's transaction IAM model, the underlying single-item action
    //    - UpdateItem here - is what must be authorized, not
    //    TransactWriteItems itself, which requires no separate action).
    //  - Processed_Requests: dynamodb:PutItem only (the transaction's
    //    conditional Put action against this table).
    //  - Team_Role_Cache: dynamodb:GetItem/PutItem only (resolveTeam's
    //    cache read and cache-refresh write - never Query/Scan from this
    //    Lambda, which never calls listRolesForTeam).
    //  - iam: GetRole/ListRoleTags with Resource: "*". These are read-only
    //    tag-lookup actions; IAM does not support restricting them to a
    //    specific set of role ARNs via a resource-level condition that
    //    would remain useful here (a Resource-scoped policy would need to
    //    enumerate every role ARN Usage_Collector might ever resolve,
    //    which is unbounded - any IAM role in the account can be tagged
    //    into a Team at any time), so the action list itself is kept to
    //    exactly these two read-only calls with no other IAM permissions.
    //  - s3:GetObject scoped to exactly the `bedrock-model-invocation-logs/`
    //    key prefix in this Lambda's own log bucket (the prefix Model
    //    Invocation Logging is configured to write under - see the
    //    ModelInvocationLoggingConfiguration custom resource's keyPrefix)
    //    - it must be able to read the very object that triggered its own
    //    S3 event notification (usageCollectorEntry.ts's `getObject`
    //    call). The event notification itself is also prefix-filtered to
    //    that same key prefix, so this Lambda is never invoked for (and
    //    never needs access to) any other object in the bucket. No other
    //    bucket, and no other S3 action (no ListBucket, PutObject,
    //    DeleteObject, etc.).
    //  - NOT granted: dynamodb:Scan/Query/BatchGetItem/BatchWriteItem/
    //    DescribeTable on any table, any bedrock:* actions, any other
    //    DynamoDB table, iam:PutRolePolicy/DeleteRolePolicy, sns:Publish,
    //    or any managed policy (e.g. AmazonDynamoDBFullAccess/
    //    IAMReadOnlyAccess) that would have granted broader access.
    // ---------------------------------------------------------------------
    this.usageCollectorFunction = new NodejsFunction(this, "UsageCollectorFunction", {
      ...commonFunctionProps,
      entry: path.join(entryDir, "usageCollectorEntry.ts"),
      handler: "handler",
      environment: {
        [ENV_VAR_NAMES.TEAM_TAG_KEY]: teamTagKey,
        [ENV_VAR_NAMES.TEAM_ROLE_CACHE_TABLE_NAME]: this.teamRoleCacheTable.tableName,
        [ENV_VAR_NAMES.USAGE_AGGREGATION_TABLE_NAME]: this.usageAggregationTable.tableName,
        [ENV_VAR_NAMES.PROCESSED_REQUESTS_TABLE_NAME]: this.processedRequestsTable.tableName,
      },
    });
    this.usageCollectorFunction.addToRolePolicy(
      grantExactTableActions(this.usageAggregationTable, ["UpdateItem"], {
        sid: "UpdateUsageAggregationRunningTotal",
      })
    );
    this.usageCollectorFunction.addToRolePolicy(
      grantExactTableActions(this.processedRequestsTable, ["PutItem"], {
        sid: "WriteProcessedRequestDedupRecord",
      })
    );
    this.usageCollectorFunction.addToRolePolicy(
      grantExactTableActions(this.teamRoleCacheTable, ["GetItem", "PutItem"], {
        sid: "ReadWriteTeamRoleCacheEntry",
      })
    );
    this.usageCollectorFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "ResolveRoleTeamTags",
        effect: Effect.ALLOW,
        actions: ["iam:GetRole", "iam:ListRoleTags"],
        // IAM does not support scoping these read-only tag-lookup calls to
        // specific role ARNs in a way that stays useful here (any role in
        // the account can be tagged into a Team at any time), so Resource
        // is "*" - see comment on this Lambda's permissions above.
        resources: ["*"],
      })
    );
    // s3:GetObject on the delivered log objects only - scoped to the exact
    // key prefix Model Invocation Logging writes to (see the
    // ModelInvocationLoggingConfiguration custom resource's keyPrefix),
    // never the whole bucket. Without this grant Usage_Collector can be
    // triggered by the S3 event but fails every invocation with
    // AccessDenied when it tries to read the delivered object - this is
    // load-bearing, not incidental, since the entire pipeline depends on
    // it being able to read what it was notified about.
    this.usageCollectorFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "ReadDeliveredModelInvocationLogObjects",
        effect: Effect.ALLOW,
        actions: ["s3:GetObject"],
        resources: [`${this.modelInvocationLogBucket.bucketArn}/bedrock-model-invocation-logs/*`],
      })
    );
    this.modelInvocationLogBucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(this.usageCollectorFunction),
      { prefix: "bedrock-model-invocation-logs/" }
    );

    // ---------------------------------------------------------------------
    // DLQ handler Lambda (batch-item-failure routing for malformed
    // Usage_Collector entries delivered via an SQS-backed path, per
    // design.md's Error Handling table). No DynamoDB/IAM/SNS access is
    // needed - this handler only parses/validates message bodies - so no
    // grants are added beyond the AWSLambdaBasicExecutionRole CDK attaches
    // automatically for CloudWatch Logs.
    // ---------------------------------------------------------------------
    this.dlqHandlerFunction = new NodejsFunction(this, "DlqHandlerFunction", {
      ...commonFunctionProps,
      entry: path.join(entryDir, "dlqHandlerEntry.ts"),
      handler: "handler",
    });

    // ---------------------------------------------------------------------
    // Quota_Enforcer Lambda (Trigger 1 - Usage change)
    //
    // Least-privilege IAM applied (exact per-action grants; grantReadData/
    // grantWriteData/grantReadWriteData/grantStreamRead are NOT used here
    // beyond the stream read, since those convenience methods unconditionally
    // add dynamodb:Scan and other unused actions - see grantExactTableActions
    // above):
    //  - dynamodb: read access to the Usage_Aggregation table's Streams
    //    only, via grantStreamRead scoped to that one table's stream ARN
    //    (not the table itself - this Lambda never reads the table
    //    directly, only its stream; grantStreamRead does not add Scan).
    //  - dynamodb: GetItem/PutItem/DeleteItem on Blocked_State only
    //    (quotaEnforcer.ts's getBlockedState/putBlockedState/
    //    clearBlockedState - no Query, since this Lambda never calls
    //    listBlockedModelsForTeam).
    //  - dynamodb: GetItem on Quota_Configuration only (getQuota's single-
    //    item read - no write access, since quota values are
    //    administrator-managed via the Admin API Lambda, not this one).
    //  - dynamodb: Query on the Team_Role_Cache TeamIndex GSI only
    //    (listRolesForTeam - no GetItem/PutItem, since this Lambda never
    //    calls resolveTeam itself).
    //  - dynamodb: PutItem on Audit_Log only (writeAuditEntry - no read
    //    access needed, this Lambda only writes audit entries).
    //  - iam: PutRolePolicy/DeleteRolePolicy only (no other IAM actions).
    //    IAM inline role policy actions cannot be scoped below the role
    //    level via Resource in a way that would meaningfully restrict
    //    "which roles" (Quota_Enforcer must be able to attach/remove a
    //    deny policy on ANY role that gets tagged into ANY Team, which is
    //    not known at deploy time), so Resource is "*" but the action list
    //    is restricted to exactly these two calls - nothing else IAM-
    //    related (no CreateRole, AttachRolePolicy, PassRole, etc.).
    //  - sns: Publish scoped to only the Notification_Channel topic ARN
    //    (via topic.grantPublish, which resource-scopes to that topic).
    //  - NOT granted: dynamodb:Scan/Query/BatchGetItem/BatchWriteItem/
    //    DescribeTable on any table, write access to Quota_Configuration,
    //    read access to Audit_Log, any bedrock:* action, or any broader
    //    IAM managed policy.
    // ---------------------------------------------------------------------
    this.quotaEnforcerStreamFunction = new NodejsFunction(this, "QuotaEnforcerStreamFunction", {
      ...commonFunctionProps,
      entry: path.join(entryDir, "quotaEnforcerStreamEntry.ts"),
      handler: "handler",
      environment: {
        [ENV_VAR_NAMES.QUOTA_CONFIGURATION_TABLE_NAME]: this.quotaConfigurationTable.tableName,
        [ENV_VAR_NAMES.BLOCKED_STATE_TABLE_NAME]: this.blockedStateTable.tableName,
        [ENV_VAR_NAMES.TEAM_ROLE_CACHE_TABLE_NAME]: this.teamRoleCacheTable.tableName,
        [ENV_VAR_NAMES.AUDIT_LOG_TABLE_NAME]: this.auditLogTable.tableName,
        [ENV_VAR_NAMES.NOTIFICATION_TOPIC_ARN]: this.notificationTopic.topicArn,
      },
    });
    this.usageAggregationTable.grantStreamRead(this.quotaEnforcerStreamFunction);
    this.quotaEnforcerStreamFunction.addToRolePolicy(
      grantExactTableActions(this.blockedStateTable, ["GetItem", "PutItem", "DeleteItem"], {
        sid: "ReadWriteBlockedStateForEnforcement",
      })
    );
    this.quotaEnforcerStreamFunction.addToRolePolicy(
      grantExactTableActions(this.quotaConfigurationTable, ["GetItem"], {
        sid: "ReadQuotaConfigurationForEnforcement",
      })
    );
    this.quotaEnforcerStreamFunction.addToRolePolicy(
      grantExactTableActions(this.teamRoleCacheTable, ["Query"], {
        indexName: "TeamIndex",
        sid: "ListRolesForTeamViaTeamIndex",
      })
    );
    this.quotaEnforcerStreamFunction.addToRolePolicy(
      grantExactTableActions(this.auditLogTable, ["PutItem"], {
        sid: "WriteAuditLogFromEnforcement",
      })
    );
    this.notificationTopic.grantPublish(this.quotaEnforcerStreamFunction);
    this.quotaEnforcerStreamFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "ManageModelDenyPolicy",
        effect: Effect.ALLOW,
        actions: ["iam:PutRolePolicy", "iam:DeleteRolePolicy"],
        // See comment on this Lambda's permissions above: IAM inline role
        // policy actions cannot be usefully Resource-scoped here since the
        // set of roles is determined at runtime by Team tag membership,
        // not known at deploy time. The action list itself is the
        // least-privilege boundary - only these two calls, nothing else.
        resources: ["*"],
      })
    );
    this.quotaEnforcerStreamFunction.addEventSource(
      new DynamoEventSource(this.usageAggregationTable, {
        startingPosition: StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 10,
      })
    );

    // ---------------------------------------------------------------------
    // Quota_Enforcer Lambda (Trigger 2 - TagRole/UntagRole)
    //
    // A separate function (rather than reusing quotaEnforcerStreamFunction)
    // so its execution role only carries the permissions this trigger
    // path actually needs, per least-privilege: it never touches
    // Usage_Aggregation, Quota_Configuration, Audit_Log, or SNS, so those
    // grants are correctly omitted here even though the sibling stream
    // function has them.
    //
    // Least-privilege IAM applied:
    //  - dynamodb: Query on Blocked_State only (tagRoleHandler.ts's
    //    listBlockedModelsForTeam, a Query on the table's own primary key
    //    `PK = TEAM#<team>` - no GSI needed here, and no Scan; read-only,
    //    since this path never writes Blocked_State, it only reads which
    //    Models are currently blocked for the newly tagged role's Team).
    //  - iam: PutRolePolicy only (no DeleteRolePolicy - this path only
    //    ever attaches a deny policy to a newly tagged role, never
    //    removes one), Resource: "*" for the same reason described above.
    //  - NOT granted: DeleteRolePolicy, dynamodb:Scan/GetItem/PutItem/
    //    BatchGetItem/BatchWriteItem/DescribeTable, SNS Publish, or access
    //    to Usage_Aggregation/Quota_Configuration/Audit_Log/Team_Role_Cache.
    // ---------------------------------------------------------------------
    this.tagRoleFunction = new NodejsFunction(this, "TagRoleFunction", {
      ...commonFunctionProps,
      entry: path.join(entryDir, "tagRoleEntry.ts"),
      handler: "handler",
      environment: {
        [ENV_VAR_NAMES.TEAM_TAG_KEY]: teamTagKey,
        [ENV_VAR_NAMES.BLOCKED_STATE_TABLE_NAME]: this.blockedStateTable.tableName,
      },
    });
    this.tagRoleFunction.addToRolePolicy(
      grantExactTableActions(this.blockedStateTable, ["Query"], {
        sid: "QueryBlockedModelsForNewlyTaggedRolesTeam",
      })
    );
    this.tagRoleFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "AttachModelDenyPolicyOnNewlyTaggedRole",
        effect: Effect.ALLOW,
        actions: ["iam:PutRolePolicy"],
        resources: ["*"],
      })
    );

    const tagRoleEventPattern: EventPattern = {
      source: ["aws.iam"],
      detailType: ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["iam.amazonaws.com"],
        eventName: ["TagRole", "UntagRole"],
      },
    };
    new Rule(this, "TagRoleEventRule", {
      eventPattern: tagRoleEventPattern,
      targets: [new LambdaEventTarget(this.tagRoleFunction)],
    });

    // ---------------------------------------------------------------------
    // Daily_Reset Lambda (00:00 UTC scheduled reset)
    //
    // Least-privilege IAM applied: identical scoping intent to
    // Quota_Enforcer's removal path (Blocked_State read/write, Team_Role_Cache
    // read, Audit_Log write, DeleteRolePolicy, SNS Publish to the
    // Notification_Channel topic only) - but as its own function/role so
    // Daily_Reset's permissions are not entangled with Quota_Enforcer's
    // attach-path permissions (e.g. Daily_Reset never needs
    // Quota_Configuration read access, so that grant is correctly omitted
    // here even though Quota_Enforcer has it). Exact per-action grants are
    // used throughout (see grantExactTableActions above) instead of CDK's
    // grantReadWriteData/grantReadData/grantWriteData, which unconditionally
    // add dynamodb:Scan.
    //  - dynamodb: GetItem/PutItem/DeleteItem + Query (StatusDayIndex GSI)
    //    on Blocked_State only (dailyReset.ts's queryPairsByStatusDay,
    //    resetBlockedStatePair's PutItem/DeleteItem for PENDING_RESET
    //    marking/clearing, and removeDenyPolicy's getBlockedState GetItem).
    //  - dynamodb: Query on Team_Role_Cache (TeamIndex GSI) only
    //    (listRolesForTeam - no GetItem/PutItem, since this Lambda never
    //    calls resolveTeam itself).
    //  - dynamodb: PutItem on Audit_Log only (writeAuditEntry).
    //  - iam: DeleteRolePolicy only - NOT PutRolePolicy, since Daily_Reset
    //    (dailyReset.ts) only ever calls iam:DeleteRolePolicy, never
    //    iam:PutRolePolicy (attaching a new deny policy is exclusively
    //    Quota_Enforcer's/TagRoleFunction's job). Resource: "*" for the
    //    same reason as Quota_Enforcer (role set determined at runtime).
    //  - sns: Publish scoped to only the Notification_Channel topic ARN.
    //  - NOT granted: iam:PutRolePolicy, dynamodb:Scan/BatchGetItem/
    //    BatchWriteItem/DescribeTable, any access to Usage_Aggregation,
    //    Processed_Requests, or Quota_Configuration, and no read access to
    //    Audit_Log.
    // ---------------------------------------------------------------------
    this.dailyResetFunction = new NodejsFunction(this, "DailyResetFunction", {
      ...commonFunctionProps,
      entry: path.join(entryDir, "dailyResetEntry.ts"),
      handler: "handler",
      environment: {
        [ENV_VAR_NAMES.BLOCKED_STATE_TABLE_NAME]: this.blockedStateTable.tableName,
        [ENV_VAR_NAMES.TEAM_ROLE_CACHE_TABLE_NAME]: this.teamRoleCacheTable.tableName,
        [ENV_VAR_NAMES.AUDIT_LOG_TABLE_NAME]: this.auditLogTable.tableName,
        [ENV_VAR_NAMES.NOTIFICATION_TOPIC_ARN]: this.notificationTopic.topicArn,
      },
    });
    this.dailyResetFunction.addToRolePolicy(
      grantExactTableActions(this.blockedStateTable, ["GetItem", "PutItem", "DeleteItem"], {
        sid: "ReadWriteBlockedStateForDailyReset",
      })
    );
    this.dailyResetFunction.addToRolePolicy(
      grantExactTableActions(this.blockedStateTable, ["Query"], {
        indexName: "StatusDayIndex",
        sid: "QueryPairsPendingResetViaStatusDayIndex",
      })
    );
    this.dailyResetFunction.addToRolePolicy(
      grantExactTableActions(this.teamRoleCacheTable, ["Query"], {
        indexName: "TeamIndex",
        sid: "ListRolesForTeamViaTeamIndexOnReset",
      })
    );
    this.dailyResetFunction.addToRolePolicy(
      grantExactTableActions(this.auditLogTable, ["PutItem"], {
        sid: "WriteAuditLogFromDailyReset",
      })
    );
    this.notificationTopic.grantPublish(this.dailyResetFunction);
    this.dailyResetFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "RemoveModelDenyPolicyOnReset",
        effect: Effect.ALLOW,
        actions: ["iam:DeleteRolePolicy"],
        resources: ["*"],
      })
    );
    new Rule(this, "DailyResetScheduleRule", {
      schedule: Schedule.expression("cron(0 0 * * ? *)"),
      targets: [new LambdaEventTarget(this.dailyResetFunction)],
    });

    // ---------------------------------------------------------------------
    // Reconciliation Lambda (periodic Team_Role_Cache reconciliation)
    //
    // Least-privilege IAM applied:
    //  - iam: ListRoles/GetRole/ListRoleTags, Resource: "*". These are
    //    read-only account-wide enumeration/lookup actions and this
    //    Lambda's entire purpose is to paginate every IAM role in the
    //    account (design.md's Error Handling table: "paginates
    //    iam:ListRoles directly against IAM"), so a Resource scope narrower
    //    than "*" would defeat the reconciliation's purpose; the action
    //    list is nonetheless restricted to exactly these three read-only
    //    calls.
    //  - dynamodb: GetItem/PutItem on Team_Role_Cache only
    //    (reconciliation.ts drives resolveTeam per role, which itself only
    //    ever issues GetItem/PutItem against this table - no Query/Scan;
    //    no other table access - this Lambda never touches
    //    Usage_Aggregation, Quota_Configuration, Blocked_State, or
    //    Audit_Log).
    //  - NOT granted: dynamodb:Scan/Query/BatchGetItem/BatchWriteItem/
    //    DescribeTable, iam:PutRolePolicy/DeleteRolePolicy, any SNS
    //    access, or any table besides Team_Role_Cache.
    // ---------------------------------------------------------------------
    this.reconciliationFunction = new NodejsFunction(this, "ReconciliationFunction", {
      ...commonFunctionProps,
      entry: path.join(entryDir, "reconciliationEntry.ts"),
      handler: "handler",
      timeout: Duration.minutes(5),
      environment: {
        [ENV_VAR_NAMES.TEAM_TAG_KEY]: teamTagKey,
        [ENV_VAR_NAMES.TEAM_ROLE_CACHE_TABLE_NAME]: this.teamRoleCacheTable.tableName,
      },
    });
    this.reconciliationFunction.addToRolePolicy(
      grantExactTableActions(this.teamRoleCacheTable, ["GetItem", "PutItem"], {
        sid: "ReadWriteTeamRoleCacheDuringReconciliation",
      })
    );
    this.reconciliationFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "EnumerateRolesAndTagsForReconciliation",
        effect: Effect.ALLOW,
        actions: ["iam:ListRoles", "iam:GetRole", "iam:ListRoleTags"],
        resources: ["*"],
      })
    );
    new Rule(this, "ReconciliationScheduleRule", {
      schedule: Schedule.rate(Duration.minutes(15)),
      targets: [new LambdaEventTarget(this.reconciliationFunction)],
    });

    // ---------------------------------------------------------------------
    // Admin API Lambda (adminApi.ts handlers)
    //
    // Least-privilege IAM applied (exact per-action grants; CDK's
    // grantReadWriteData/grantReadData are NOT used here since they
    // unconditionally add dynamodb:Scan and other unused actions - see
    // grantExactTableActions above):
    //  - dynamodb: PutItem + Query on Quota_Configuration only
    //    (quotaConfigStore.ts's putQuota - PutItem - and listQuotas - a
    //    Query on the table's own primary key `PK = TEAM#<team>`, no GSI;
    //    no GetItem, since adminApi.ts never calls getQuota).
    //  - dynamodb: Query on Audit_Log only (auditLog.ts's
    //    listAuditEntries - a Query on the table's own primary key, no
    //    GSI), plus PutItem on Audit_Log (writeAuditEntry, invoked
    //    transitively by removeDenyPolicy's resetBlockedStatePair).
    //  - Same removeDenyPolicy permissions as Daily_Reset's removal path
    //    (dailyReset.ts's removeDenyPolicy -> resetBlockedStatePair):
    //    dynamodb GetItem (getBlockedState) + PutItem/DeleteItem
    //    (PENDING_RESET marking / clearing) on Blocked_State - no Query
    //    needed here, since adminApi's removeDenyPolicy path only ever
    //    resets one specific (Team, Model) pair, never the
    //    StatusDayIndex-driven bulk scan Daily_Reset performs; dynamodb
    //    Query on Team_Role_Cache (TeamIndex GSI) for listRolesForTeam;
    //    iam:DeleteRolePolicy only - NOT PutRolePolicy, since
    //    removeDenyPolicy never attaches a new deny policy; sns:Publish
    //    scoped to the Notification_Channel topic only.
    //  - NOT granted: iam:PutRolePolicy, dynamodb:Scan/GetItem(on
    //    Quota_Configuration or Audit_Log)/BatchGetItem/BatchWriteItem/
    //    DescribeTable, any access to Usage_Aggregation or
    //    Processed_Requests, and no broader IAM/DynamoDB managed policies.
    // ---------------------------------------------------------------------
    this.adminApiFunction = new NodejsFunction(this, "AdminApiFunction", {
      ...commonFunctionProps,
      entry: path.join(entryDir, "adminApiEntry.ts"),
      handler: "handler",
      environment: {
        [ENV_VAR_NAMES.QUOTA_CONFIGURATION_TABLE_NAME]: this.quotaConfigurationTable.tableName,
        [ENV_VAR_NAMES.AUDIT_LOG_TABLE_NAME]: this.auditLogTable.tableName,
        [ENV_VAR_NAMES.BLOCKED_STATE_TABLE_NAME]: this.blockedStateTable.tableName,
        [ENV_VAR_NAMES.TEAM_ROLE_CACHE_TABLE_NAME]: this.teamRoleCacheTable.tableName,
        [ENV_VAR_NAMES.NOTIFICATION_TOPIC_ARN]: this.notificationTopic.topicArn,
      },
    });
    this.adminApiFunction.addToRolePolicy(
      grantExactTableActions(this.quotaConfigurationTable, ["PutItem", "Query"], {
        sid: "ManageQuotaConfiguration",
      })
    );
    this.adminApiFunction.addToRolePolicy(
      grantExactTableActions(this.auditLogTable, ["Query", "PutItem"], {
        sid: "ReadWriteAuditLogFromAdminApi",
      })
    );
    this.adminApiFunction.addToRolePolicy(
      grantExactTableActions(this.blockedStateTable, ["GetItem", "PutItem", "DeleteItem"], {
        sid: "ManageBlockedStateForManualRemoval",
      })
    );
    this.adminApiFunction.addToRolePolicy(
      grantExactTableActions(this.teamRoleCacheTable, ["Query"], {
        indexName: "TeamIndex",
        sid: "ListRolesForTeamViaTeamIndexOnManualRemoval",
      })
    );
    this.notificationTopic.grantPublish(this.adminApiFunction);
    this.adminApiFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "ManualRemoveModelDenyPolicy",
        effect: Effect.ALLOW,
        actions: ["iam:DeleteRolePolicy"],
        resources: ["*"],
      })
    );

    // ---------------------------------------------------------------------
    // Stack outputs, consumed by the interactive CLI test tool
    // (npm run test:tokens, see README.md) so it never has to hardcode
    // table names, function names, or the test role's ARN.
    // ---------------------------------------------------------------------
    new CfnOutput(this, "TestRoleArnOutput", {
      value: this.testRole.roleArn,
      description: "ARN of the Bedrock_Test_Role the CLI test tool assumes to send Bedrock invocations.",
    });
    new CfnOutput(this, "TestRoleTeamOutput", {
      value: testRoleTeamTagValue,
      description: `Value of the ${teamTagKey} tag on Bedrock_Test_Role.`,
    });
    new CfnOutput(this, "UsageAggregationTableNameOutput", {
      value: this.usageAggregationTable.tableName,
    });
    new CfnOutput(this, "QuotaConfigurationTableNameOutput", {
      value: this.quotaConfigurationTable.tableName,
    });
    new CfnOutput(this, "BlockedStateTableNameOutput", {
      value: this.blockedStateTable.tableName,
    });
    new CfnOutput(this, "AuditLogTableNameOutput", {
      value: this.auditLogTable.tableName,
    });
    new CfnOutput(this, "AdminApiFunctionNameOutput", {
      value: this.adminApiFunction.functionName,
    });
    new CfnOutput(this, "ModelInvocationLogBucketNameOutput", {
      value: this.modelInvocationLogBucket.bucketName,
    });
  }
}
