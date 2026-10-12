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
import { DynamoEventSource, SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { ArnPrincipal, CompositePrincipal, Effect, FederatedPrincipal, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  AccountRecovery,
  CfnIdentityPool,
  CfnIdentityPoolRoleAttachment,
  CfnUserPoolGroup,
  Mfa,
  UserPool,
  UserPoolClient,
} from "aws-cdk-lib/aws-cognito";
import { BlockPublicAccess, Bucket, BucketEncryption, EventType, IBucket } from "aws-cdk-lib/aws-s3";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { CfnDatabase, CfnTable } from "aws-cdk-lib/aws-glue";
import { CfnWorkGroup } from "aws-cdk-lib/aws-athena";
import {
  AccessLogFormat,
  AuthorizationType,
  Cors,
  LambdaIntegration,
  LogGroupLogDestination,
  MethodLoggingLevel,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  CfnDataSource as QuickSightDataSource,
  CfnDataSet as QuickSightDataSet,
  CfnDashboard as QuickSightDashboard,
} from "aws-cdk-lib/aws-quicksight";

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
const LAMBDA_RUNTIME = Runtime.NODEJS_22_X;

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
  /**
   * Optional QuickSight principal ARN (user or group) granted ownership of
   * the cost dashboard datasets. When omitted, the Glue/Athena analytics
   * layer is still created but the QuickSight resources are skipped — a
   * QuickSight subscription and principal are deploy-time prerequisites
   * (requirements.md assumption A-3), so dashboards are opt-in via this prop.
   */
  readonly quickSightPrincipalArn?: string;
  /**
   * CUR 2.0 (AWS Data Exports) Glue database name where the CUR table lives.
   * When both `curDatabaseName` and `curTableName` are provided, the stack
   * deploys one additional Lambda:
   *   CUR Per-Team Cost — extracts actual billed dollars per team from CUR
   *   2.0 (via the `team` cost-allocation tag) and writes them to the
   *   analytics bucket for QuickSight. This is the ONLY source of dollar-
   *   denominated cost — the token pipeline handles enforcement only.
   *
   * The CUR 2.0 Data Export must be set up in the account with Bedrock
   * usage and the `team` IAM tag activated as a cost-allocation tag.
   */
  readonly curDatabaseName?: string;
  /** CUR 2.0 Glue table name within `curDatabaseName`. */
  readonly curTableName?: string;
  /**
   * Name of the S3 bucket the CUR 2.0 export delivers to. REQUIRED when
   * `curDatabaseName` + `curTableName` are set: Athena reads the CUR Parquet
   * with the cost Lambda's own credentials, so the Lambda's role must be
   * granted read on this bucket (the stack cannot discover it from the Glue
   * table at synth time). Without it the Lambda fails with
   * "not authorized to perform: s3:ListBucket".
   */
  readonly curBucketName?: string;
}

export class BedrockTeamTokenQuotaStack extends Stack {
  public readonly usageAggregationTable: Table;
  public readonly processedRequestsTable: Table;
  public readonly teamRoleCacheTable: Table;
  public readonly quotaConfigurationTable: Table;
  public readonly blockedStateTable: Table;
  public readonly auditLogTable: Table;
  public readonly reconcileJobTable: Table;

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
  public readonly adminApiFunction: NodejsFunction;
  public readonly dlqHandlerFunction: NodejsFunction;
  public readonly reconcileWorkerFunction: NodejsFunction;
  /** SQS queue driving the on-demand Team_Role_Cache reconciliation fan-out. */
  public readonly reconcileQueue: Queue;

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
    // UsageDayIndex GSI (PK=usageDay) so the analytics/cost export can Query
    // every (team, model) bucket for a given day via a single-partition
    // Query, never a Scan (requirements.md FR-7.1).
    this.usageAggregationTable.addGlobalSecondaryIndex({
      indexName: "UsageDayIndex",
      partitionKey: { name: "usageDay", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
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
    // RoleListIndex: constant PK (`roleListPk` = "ROLE") + SK = team, so the
    // admin API can enumerate EVERY role→team mapping (listTeamRoleMappings)
    // and the distinct discovered teams (listDiscoveredTeams) via one bounded,
    // single-partition Query — never a Scan — mirroring Quota_Configuration's
    // TeamListIndex. Projects PK (the ROLE#<arn>) + team, which is all those
    // reads need.
    // KEYS_ONLY is sufficient: the GSI's own keys (roleListPk, team) plus the
    // base table key (PK = ROLE#<arn>) are always projected, and those are the
    // only attributes listTeamRoleMappings/listDiscoveredTeams read.
    this.teamRoleCacheTable.addGlobalSecondaryIndex({
      indexName: "RoleListIndex",
      partitionKey: { name: "roleListPk", type: AttributeType.STRING },
      sortKey: { name: "team", type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });

    // Reconcile_Job: PK=JOB#<jobId>. Tracks the status/progress of an
    // on-demand Team_Role_Cache reconciliation (the SQS fan-out below) so the
    // budget UI can poll "running -> complete/failed" after firing a job,
    // rather than holding an HTTP request open for the whole multi-page sweep.
    // TTL ('ttl') auto-expires finished job rows (24h) so the table never
    // grows unbounded. Accessed only by targeted GetItem/PutItem/UpdateItem on
    // the JOB# partition key — never a Scan.
    this.reconcileJobTable = new Table(this, "ReconcileJobTable", {
      ...commonTableProps,
      tableName: "Reconcile_Job",
      partitionKey: { name: "PK", type: AttributeType.STRING },
      timeToLiveAttribute: "ttl",
    });

    // Quota_Configuration: PK=TEAM#<team>, SK=MODEL#<model>. Persistent
    // administrator-managed config; no TTL.
    this.quotaConfigurationTable = new Table(this, "QuotaConfigurationTable", {
      ...commonTableProps,
      tableName: "Quota_Configuration",
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
    });
    // TeamListIndex: constant PK (`teamListPk` = "TEAM") + SK = raw team name,
    // so the admin API can enumerate the distinct set of teams with budgets
    // via one bounded single-partition Query (never a Scan). KEYS_ONLY keeps
    // the index small — the team name is the index sort key, all we need.
    this.quotaConfigurationTable.addGlobalSecondaryIndex({
      indexName: "TeamListIndex",
      partitionKey: { name: "teamListPk", type: AttributeType.STRING },
      sortKey: { name: "team", type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
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
    // StatusIndex GSI (PK=status) so the analytics export can list all
    // currently-blocked (team, model) pairs across every team via a Query
    // (never a Scan) for the admin "currently blocked" view. `status` is a
    // low-cardinality value already written on each item.
    this.blockedStateTable.addGlobalSecondaryIndex({
      indexName: "StatusIndex",
      partitionKey: { name: "status", type: AttributeType.STRING },
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
    // AuditDayIndex GSI (PK=auditDay) so the analytics export can read all
    // teams' enforcement actions for a day via a Query (never a Scan) for the
    // admin enforcement-activity view.
    this.auditLogTable.addGlobalSecondaryIndex({
      indexName: "AuditDayIndex",
      partitionKey: { name: "auditDay", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // -------------------------------------------------------------------
    // Bedrock/Mantle reconciliation + cost-dashboard config tables
    // (requirements.md FR-1, FR-4.1, FR-3.1). All persistent admin config
    // (no TTL), single-partition for Scan-free listing.
    // -------------------------------------------------------------------

    // Team_Project_Mapping: PK=`MAPPING`, SK=`PROJECT#<projectId>`. Maps a
    // Mantle project to the Team it belongs to, so AWS/BedrockMantle metrics
    // (which carry a Project dimension) can be attributed per team.
    const teamProjectMappingTable = new Table(this, "TeamProjectMappingTable", {
      ...commonTableProps,
      tableName: "Team_Project_Mapping",
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
    });

    // Model_Registry: PK=`MODEL`, SK=`MODEL#<modelId>`. Classifies each model
    // by serving endpoint (bedrock-runtime vs bedrock-mantle) + provider.
    const modelRegistryTable = new Table(this, "ModelRegistryTable", {
      ...commonTableProps,
      tableName: "Model_Registry",
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
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
        [ENV_VAR_NAMES.TEAM_ROLE_CACHE_TABLE_NAME]: this.teamRoleCacheTable.tableName,
      },
    });
    this.tagRoleFunction.addToRolePolicy(
      grantExactTableActions(this.blockedStateTable, ["Query"], {
        sid: "QueryBlockedModelsForNewlyTaggedRolesTeam",
      })
    );
    // Warm the Team_Role_Cache on tag so the newly tagged role is immediately
    // enforceable (closes the Mantle-only enforcement gap). The reverse
    // TeamIndex GSI is maintained automatically as a projection of this write.
    this.tagRoleFunction.addToRolePolicy(
      grantExactTableActions(this.teamRoleCacheTable, ["PutItem"], {
        sid: "WarmTeamRoleCacheOnTag",
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
    // Team_Role_Cache reconciliation (on-demand SQS fan-out)
    //
    // There is intentionally NO automatic schedule. A periodic full
    // `iam:ListRoles` sweep (each role needing GetRole + ListRoleTags) is
    // wasteful and hits IAM throttle limits on accounts with many roles.
    // Reconciliation instead runs ON-DEMAND, triggered deliberately from the
    // UI, as a background SQS fan-out:
    //
    //   Admin API (starter)  --enqueue {jobId}-->  ReconcileQueue
    //                                                   |
    //                                                   v  (batchSize 1)
    //                                          ReconcileWorkerFunction
    //                                          (one iam:ListRoles page/run;
    //                                           re-enqueues {jobId, nextMarker}
    //                                           until all pages processed)
    //
    // The starter returns a `jobId` immediately (sub-second HTTP response); the
    // worker walks pages one at a time (reserved concurrency 1 => serial, gentle
    // on IAM) and records progress on the Reconcile_Job row the UI polls. This
    // makes the run timeout-safe for accounts with thousands of roles. A direct
    // `mapRoleToTeam` Admin API operation still registers a single role with no
    // IAM scan at all.
    //
    // Dead-letter queue: messages that fail repeatedly (e.g. a persistent IAM
    // error) land in ReconcileDlq after maxReceiveCount, so a poison page never
    // blocks the queue forever; the worker also marks the job `failed` so the
    // UI surfaces the terminal state.
    // ---------------------------------------------------------------------
    const reconcileDlq = new Queue(this, "ReconcileDlq", {
      queueName: "BedrockTeamTokenQuota-ReconcileDLQ",
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    // Visibility timeout must exceed the worker's Lambda timeout (30s) so a
    // message is not redelivered while a worker is still processing it; AWS
    // requires visibilityTimeout >= function timeout for SQS event sources.
    this.reconcileQueue = new Queue(this, "ReconcileQueue", {
      queueName: "BedrockTeamTokenQuota-Reconcile",
      visibilityTimeout: Duration.seconds(180),
      retentionPeriod: Duration.days(1),
      enforceSSL: true,
      deadLetterQueue: { queue: reconcileDlq, maxReceiveCount: 3 },
    });

    // Reconcile worker Lambda: one iam:ListRoles page per invocation, then
    // re-enqueues the next marker. reservedConcurrentExecutions=1 keeps the
    // chain strictly serial (never two pages in flight), which bounds IAM read
    // pressure and makes progress deterministic.
    this.reconcileWorkerFunction = new NodejsFunction(this, "ReconcileWorkerFunction", {
      ...commonFunctionProps,
      entry: path.join(entryDir, "reconcileWorkerEntry.ts"),
      handler: "handler",
      reservedConcurrentExecutions: 1,
      environment: {
        [ENV_VAR_NAMES.TEAM_TAG_KEY]: teamTagKey,
        [ENV_VAR_NAMES.TEAM_ROLE_CACHE_TABLE_NAME]: this.teamRoleCacheTable.tableName,
        [ENV_VAR_NAMES.RECONCILE_JOB_TABLE_NAME]: this.reconcileJobTable.tableName,
        [ENV_VAR_NAMES.RECONCILE_QUEUE_URL]: this.reconcileQueue.queueUrl,
      },
    });
    // Worker grants:
    //  - iam: ListRoles/GetRole/ListRoleTags — read-only role enumeration +
    //    per-role tag resolution (resolveTeamFromIam).
    //  - dynamodb: PutItem/DeleteItem on Team_Role_Cache (the sweep UPSERTS a
    //    row for a role that has a `team` tag and DELETES the row for a role
    //    that has none — it never reads the cache, so no GetItem), and
    //    GetItem/PutItem/UpdateItem on the Reconcile_Job table (progress/
    //    complete/fail updates).
    //  - sqs: consume from ReconcileQueue (event source) + SendMessage back to
    //    it (re-enqueue the next page's marker).
    this.reconcileWorkerFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "EnumerateRolesAndTagsForReconcileWorker",
        effect: Effect.ALLOW,
        actions: ["iam:ListRoles", "iam:GetRole", "iam:ListRoleTags"],
        resources: ["*"],
      })
    );
    this.reconcileWorkerFunction.addToRolePolicy(
      grantExactTableActions(this.teamRoleCacheTable, ["PutItem", "DeleteItem"], {
        sid: "WriteTeamRoleCacheFromReconcileWorker",
      })
    );
    this.reconcileWorkerFunction.addToRolePolicy(
      grantExactTableActions(this.reconcileJobTable, ["GetItem", "PutItem", "UpdateItem"], {
        sid: "ReadWriteReconcileJobFromWorker",
      })
    );
    // Event source: one message (= one IAM page) per invocation. Combined with
    // reservedConcurrency 1, this walks pages strictly serially.
    this.reconcileWorkerFunction.addEventSource(
      new SqsEventSource(this.reconcileQueue, { batchSize: 1 })
    );
    // The worker re-enqueues continuation messages onto the same queue.
    this.reconcileQueue.grantSendMessages(this.reconcileWorkerFunction);

    // ---------------------------------------------------------------------
    // Admin API Lambda (adminApi.ts handlers)
    //
    // On-demand reconcile STARTER lives here: it enqueues one message onto
    // ReconcileQueue and creates the Reconcile_Job row, then returns the
    // jobId. The heavy lifting is done by ReconcileWorkerFunction above. A
    // direct `mapRoleToTeam` operation registers a single role without any
    // IAM scan.
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
        // Team tag key — the reconcile starter fail-fasts if it is unset.
        [ENV_VAR_NAMES.TEAM_TAG_KEY]: teamTagKey,
        // On-demand reconcile fan-out: queue the starter enqueues onto + the
        // job-status table it creates rows in (and getReconcileJob reads).
        [ENV_VAR_NAMES.RECONCILE_QUEUE_URL]: this.reconcileQueue.queueUrl,
        [ENV_VAR_NAMES.RECONCILE_JOB_TABLE_NAME]: this.reconcileJobTable.tableName,
        [ENV_VAR_NAMES.NOTIFICATION_TOPIC_ARN]: this.notificationTopic.topicArn,
        // Config stores managed via the Admin API (requirements.md FR-6).
        [ENV_VAR_NAMES.MODEL_REGISTRY_TABLE_NAME]: modelRegistryTable.tableName,
        [ENV_VAR_NAMES.TEAM_PROJECT_MAPPING_TABLE_NAME]: teamProjectMappingTable.tableName,
      },
    });
    // Team<->role mapping operations (reconcileTeamRoles / mapRoleToTeam):
    //  - iam: ListRoles/GetRole/ListRoleTags for the on-demand bulk reconcile
    // Team<->role mapping operations:
    //  - reconcileTeamRoles is now just a STARTER — it does NO IAM scan
    //    itself (the ReconcileWorkerFunction holds iam:ListRoles/GetRole/
    //    ListRoleTags), so the Admin API role is NOT granted any iam:* role-
    //    enumeration actions. It only needs to enqueue the starter message
    //    and create/read the Reconcile_Job row.
    //  - mapRoleToTeam writes a single Team_Role_Cache entry directly
    //    (cacheRoleTeam = PutItem), so PutItem on Team_Role_Cache is granted.
    //  - sqs: SendMessage to the reconcile queue (enqueue the starter).
    //  - dynamodb: GetItem/PutItem/UpdateItem on Reconcile_Job (createReconcileJob
    //    writes the row; getReconcileJob reads it for UI polling).
    this.adminApiFunction.addToRolePolicy(
      grantExactTableActions(this.teamRoleCacheTable, ["PutItem"], {
        sid: "WriteTeamRoleCacheFromAdminApi",
      })
    );
    // Query RoleListIndex to enumerate role→team mappings (listTeamRoleMappings)
    // and the distinct discovered teams unioned into listTeams — Scan-free.
    this.adminApiFunction.addToRolePolicy(
      grantExactTableActions(this.teamRoleCacheTable, ["Query"], {
        indexName: "RoleListIndex",
        sid: "ListRoleMappingsAndDiscoveredTeamsFromAdminApi",
      })
    );
    this.adminApiFunction.addToRolePolicy(
      grantExactTableActions(this.reconcileJobTable, ["GetItem", "PutItem", "UpdateItem"], {
        sid: "ReadWriteReconcileJobFromAdminApi",
      })
    );
    this.reconcileQueue.grantSendMessages(this.adminApiFunction);
    this.adminApiFunction.addToRolePolicy(
      grantExactTableActions(this.quotaConfigurationTable, ["Query"], {
        indexName: "TeamListIndex",
        sid: "ListTeamsFromQuotaConfiguration",
      })
    );
    this.adminApiFunction.addToRolePolicy(
      grantExactTableActions(this.quotaConfigurationTable, ["PutItem", "Query"], {
        sid: "ManageQuotaConfiguration",
      })
    );
    // Admin API manages the Bedrock/Mantle config stores (PutItem to upsert,
    // Query to list) - exact actions only, no Scan.
    this.adminApiFunction.addToRolePolicy(
      grantExactTableActions(modelRegistryTable, ["PutItem", "Query", "DeleteItem"], {
        sid: "ManageModelRegistry",
      })
    );
    // List the live Bedrock foundation-model catalog for the admin "Allowed
    // models" picker. ListFoundationModels is an account/region-level read with
    // no resource-level ARN to scope to, so Resource is "*"; the action list is
    // restricted to exactly this one read (no invoke, no model-access mutation).
    // Converse (bedrock-runtime) catalog: control-plane reads (no resource ARN).
    this.adminApiFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "ListRuntimeCatalogForAllowList",
        effect: Effect.ALLOW,
        actions: ["bedrock:ListFoundationModels", "bedrock:ListInferenceProfiles"],
        resources: ["*"],
      })
    );
    // Mantle catalog: the GET /v1/models call is made with a short-lived,
    // IAM-derived bearer token (see mantleModelsClient.ts). Authorizing a
    // bearer-token mantle call requires BOTH:
    //   - bedrock-mantle:CallWithBearerToken (authorizes using the bearer
    //     token at all — Resource "*"), and
    //   - the operation action (ListModels) scoped to the project resource;
    //     the OpenAI-compatible /v1/models runs under the account's default
    //     project, so this is scoped to project ARNs in this account/region.
    // Mirrors AWS's AmazonBedrockMantleInferenceAccess managed policy shape.
    this.adminApiFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "MantleCallWithBearerTokenForAllowList",
        effect: Effect.ALLOW,
        actions: ["bedrock-mantle:CallWithBearerToken"],
        resources: ["*"],
      })
    );
    this.adminApiFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "MantleListModelsForAllowList",
        effect: Effect.ALLOW,
        actions: ["bedrock-mantle:ListModels", "bedrock-mantle:GetModel"],
        resources: ["arn:aws:bedrock-mantle:*:*:project/*"],
      })
    );
    this.adminApiFunction.addToRolePolicy(
      grantExactTableActions(teamProjectMappingTable, ["PutItem", "Query"], {
        sid: "ManageTeamProjectMapping",
      })
    );

    // ---------------------------------------------------------------------
    // Admin API HTTP surface (API Gateway REST + IAM authorization)
    //
    // Fronts the Admin API Lambda with API Gateway so admins/tools can call
    // it over HTTPS with SigV4-signed (IAM) requests, instead of only via
    // lambda:Invoke. authorizationType=IAM means every request must be
    // signed by a principal that is explicitly allowed execute-api:Invoke on
    // this API — no unauthenticated access (requirements.md NFR-2.3,
    // SECURITY-08). Access logging is enabled to a dedicated log group
    // (SECURITY-02). The same Lambda handles both direct invoke and the
    // API Gateway proxy event (it detects the event shape), so no extra IAM
    // grants are needed here.
    // ---------------------------------------------------------------------
    const adminApiAccessLogGroup = new LogGroup(this, "AdminApiAccessLogs", {
      retention: RetentionDays.THREE_MONTHS,
      removalPolicy,
    });
    const adminApi = new RestApi(this, "AdminApi", {
      restApiName: "BedrockTeamTokenQuota-AdminApi",
      description: "Administrative API for Bedrock/Mantle quota, rate card, model registry, and project mappings.",
      deployOptions: {
        stageName: "prod",
        accessLogDestination: new LogGroupLogDestination(adminApiAccessLogGroup),
        accessLogFormat: AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
        loggingLevel: MethodLoggingLevel.ERROR,
        metricsEnabled: true,
      },
    });
    const adminResource = adminApi.root.addResource("admin");
    // Allow the browser-based budget UI to call this API cross-origin. The POST
    // itself stays IAM-authorized (SigV4); only the unauthenticated OPTIONS
    // preflight is added here. SigV4 uses the Authorization header (not cookies),
    // so a wildcard origin does not expose credentialed requests.
    adminResource.addCorsPreflight({
      allowOrigins: Cors.ALL_ORIGINS,
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Amz-Date",
        "X-Amz-Security-Token",
        "X-Amz-Content-Sha256",
      ],
    });
    adminResource.addMethod("POST", new LambdaIntegration(this.adminApiFunction, { proxy: true }), {
      authorizationType: AuthorizationType.IAM,
    });
    new CfnOutput(this, "AdminApiEndpointOutput", {
      value: `${adminApi.url}admin`,
      description: "POST (SigV4-signed) endpoint for the Admin API, body: {operation, payload}.",
    });

    // ---------------------------------------------------------------------
    // Cognito authentication for the budget-control UI.
    //
    // Browser flow: user signs in against the User Pool -> the Identity Pool
    // exchanges that login for short-lived AWS credentials assuming an IAM
    // role scoped to ONLY `execute-api:Invoke` on this Admin API's POST
    // method. The UI then SigV4-signs its calls with those temporary
    // credentials. No long-lived credentials ever reach the browser, and the
    // User Pool is the authorization boundary for who may manage budgets.
    // ---------------------------------------------------------------------
    const adminUserPool = new UserPool(this, "AdminUserPool", {
      userPoolName: "bedrock-team-token-quota-admins",
      // Budget administration controls spend, so accounts are provisioned by
      // an operator (admin-create-user), never open self-signup.
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      // MFA is OFF to keep first-login friction-free for demos. For a
      // production rollout flip this to Mfa.REQUIRED (TOTP already enabled
      // below) to force a second factor.
      mfa: Mfa.OFF,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      // DESTROY matches this stack's dev/sandbox default so `cdk destroy`
      // cleans up the pool. Production should use RETAIN to preserve users.
      removalPolicy: DEFAULT_REMOVAL_POLICY,
    });

    const adminUserPoolClient = new UserPoolClient(this, "AdminUserPoolClient", {
      userPool: adminUserPool,
      userPoolClientName: "budget-ui",
      generateSecret: false, // public SPA client
      // SRP auth is what the Amplify Authenticator UI uses.
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    // Optional group for future role-based access control. Membership is not
    // required today (any pool member is an admin), but it gives operators a
    // handle to tighten access later via Identity Pool role mapping.
    new CfnUserPoolGroup(this, "BudgetAdminsGroup", {
      userPoolId: adminUserPool.userPoolId,
      groupName: "budget-admins",
      description: "Members allowed to manage per-team Bedrock token budgets.",
    });

    const adminIdentityPool = new CfnIdentityPool(this, "AdminIdentityPool", {
      identityPoolName: "bedrock_team_token_quota_admins",
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: adminUserPoolClient.userPoolClientId,
          providerName: adminUserPool.userPoolProviderName,
          serverSideTokenCheck: true,
        },
      ],
    });

    // Role assumed by authenticated Identity Pool users. Scoped to exactly
    // one permission: invoking the Admin API's POST /admin method.
    const adminAuthenticatedRole = new Role(this, "AdminAuthenticatedRole", {
      description: "Assumed by signed-in budget-UI users; may only invoke the Admin API.",
      assumedBy: new FederatedPrincipal(
        "cognito-identity.amazonaws.com",
        {
          StringEquals: {
            "cognito-identity.amazonaws.com:aud": adminIdentityPool.ref,
          },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "authenticated",
          },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
    });
    adminAuthenticatedRole.addToPolicy(
      new PolicyStatement({
        sid: "InvokeAdminApi",
        effect: Effect.ALLOW,
        actions: ["execute-api:Invoke"],
        resources: [adminApi.arnForExecuteApi("POST", "/admin", "prod")],
      })
    );

    new CfnIdentityPoolRoleAttachment(this, "AdminIdentityPoolRoleAttachment", {
      identityPoolId: adminIdentityPool.ref,
      roles: { authenticated: adminAuthenticatedRole.roleArn },
    });

    new CfnOutput(this, "AdminUserPoolIdOutput", {
      value: adminUserPool.userPoolId,
      description: "Cognito User Pool ID for the budget-control UI.",
    });
    new CfnOutput(this, "AdminUserPoolClientIdOutput", {
      value: adminUserPoolClient.userPoolClientId,
      description: "Cognito User Pool App Client ID for the budget-control UI.",
    });
    new CfnOutput(this, "AdminIdentityPoolIdOutput", {
      value: adminIdentityPool.ref,
      description: "Cognito Identity Pool ID that vends scoped AWS credentials to the budget UI.",
    });
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
    // Mantle Usage Collector Lambda (scheduled)
    //
    // Pulls AWS/BedrockMantle CloudWatch metrics (TotalInputTokens/
    // TotalOutputTokens by Project+ModelId) and writes absolute daily totals
    // into Usage_Aggregation (endpoint=bedrock-mantle), attributed per team
    // via the Team_Project_Mapping. Least-privilege:
    //  - cloudwatch:GetMetricData (Resource "*" - GetMetricData has no
    //    resource-level scoping).
    //  - dynamodb: Query/GetItem on Team_Project_Mapping + Query on
    //    Model_Registry (both read-only), UpdateItem on Usage_Aggregation.
    // ---------------------------------------------------------------------
    const mantleUsageCollectorFunction = new NodejsFunction(this, "MantleUsageCollectorFunction", {
      ...commonFunctionProps,
      entry: path.join(entryDir, "mantleUsageCollectorEntry.ts"),
      handler: "handler",
      timeout: Duration.minutes(5),
      environment: {
        [ENV_VAR_NAMES.USAGE_AGGREGATION_TABLE_NAME]: this.usageAggregationTable.tableName,
        [ENV_VAR_NAMES.TEAM_PROJECT_MAPPING_TABLE_NAME]: teamProjectMappingTable.tableName,
        [ENV_VAR_NAMES.MODEL_REGISTRY_TABLE_NAME]: modelRegistryTable.tableName,
      },
    });
    mantleUsageCollectorFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "ReadBedrockMantleMetrics",
        effect: Effect.ALLOW,
        actions: ["cloudwatch:GetMetricData"],
        resources: ["*"],
      })
    );
    mantleUsageCollectorFunction.addToRolePolicy(
      grantExactTableActions(teamProjectMappingTable, ["GetItem", "Query"], {
        sid: "ReadTeamProjectMapping",
      })
    );
    mantleUsageCollectorFunction.addToRolePolicy(
      grantExactTableActions(modelRegistryTable, ["Query"], { sid: "ReadModelRegistryForMantle" })
    );
    mantleUsageCollectorFunction.addToRolePolicy(
      grantExactTableActions(this.usageAggregationTable, ["UpdateItem"], {
        sid: "WriteMantleUsageTotals",
      })
    );
    new Rule(this, "MantleUsageCollectorScheduleRule", {
      // Every 15 minutes: metrics are ~1-min granularity; frequent pulls keep
      // the derived daily total fresh. SET-based writes make this idempotent.
      schedule: Schedule.rate(Duration.minutes(15)),
      targets: [new LambdaEventTarget(mantleUsageCollectorFunction)],
    });

    // ---------------------------------------------------------------------
    // Analytics / cost export bucket + Lambda (scheduled) + Glue/Athena
    //
    // Exports priced usage rows (per team/model/day/endpoint/token-type) as
    // NDJSON to S3, partitioned by dt=<day>, for Athena + QuickSight.
    // ---------------------------------------------------------------------
    const analyticsBucket = new Bucket(this, "AnalyticsExportBucket", {
      removalPolicy,
      autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      // Bound storage growth and retention of exported usage/cost/enforcement
      // data. 365 days is a generous default for cost reporting; adjust to
      // your organization's retention policy.
      lifecycleRules: [{ expiration: Duration.days(365) }],
    });
    const ANALYTICS_PREFIX = "token-usage";

    const analyticsExportFunction = new NodejsFunction(this, "AnalyticsExportFunction", {
      ...commonFunctionProps,
      entry: path.join(entryDir, "analyticsExportEntry.ts"),
      handler: "handler",
      timeout: Duration.minutes(5),
      environment: {
        [ENV_VAR_NAMES.USAGE_AGGREGATION_TABLE_NAME]: this.usageAggregationTable.tableName,
        [ENV_VAR_NAMES.USAGE_DAY_INDEX_NAME]: "UsageDayIndex",
        [ENV_VAR_NAMES.MODEL_REGISTRY_TABLE_NAME]: modelRegistryTable.tableName,
        [ENV_VAR_NAMES.ANALYTICS_EXPORT_BUCKET_NAME]: analyticsBucket.bucketName,
        [ENV_VAR_NAMES.ANALYTICS_EXPORT_PREFIX]: ANALYTICS_PREFIX,
        [ENV_VAR_NAMES.AUDIT_LOG_TABLE_NAME]: this.auditLogTable.tableName,
        [ENV_VAR_NAMES.AUDIT_DAY_INDEX_NAME]: "AuditDayIndex",
        [ENV_VAR_NAMES.BLOCKED_STATE_TABLE_NAME]: this.blockedStateTable.tableName,
        [ENV_VAR_NAMES.BLOCKED_STATUS_INDEX_NAME]: "StatusIndex",
      },
    });
    analyticsExportFunction.addToRolePolicy(
      grantExactTableActions(this.usageAggregationTable, ["Query"], {
        indexName: "UsageDayIndex",
        sid: "QueryUsageByDayForExport",
      })
    );
    analyticsExportFunction.addToRolePolicy(
      grantExactTableActions(modelRegistryTable, ["Query"], { sid: "ReadModelRegistryForExport" })
    );
    // Admin enforcement view: read all teams' audit entries per day and all
    // active blocks, via the day/status GSIs (Query only, never a Scan).
    analyticsExportFunction.addToRolePolicy(
      grantExactTableActions(this.auditLogTable, ["Query"], {
        indexName: "AuditDayIndex",
        sid: "QueryAuditByDayForExport",
      })
    );
    analyticsExportFunction.addToRolePolicy(
      grantExactTableActions(this.blockedStateTable, ["Query"], {
        indexName: "StatusIndex",
        sid: "QueryActiveBlocksForExport",
      })
    );
    analyticsExportFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "WriteAnalyticsExportObjects",
        effect: Effect.ALLOW,
        actions: ["s3:PutObject"],
        // The export writes three partitioned datasets (see analyticsExportEntry.ts):
        // the usage/cost rows, the admin enforcement-audit view, and the
        // current blocked-state view. All three prefixes must be writable.
        resources: [
          `${analyticsBucket.bucketArn}/${ANALYTICS_PREFIX}/*`,
          `${analyticsBucket.bucketArn}/enforcement-audit/*`,
          `${analyticsBucket.bucketArn}/blocked-state/*`,
        ],
      })
    );
    new Rule(this, "AnalyticsExportScheduleRule", {
      schedule: Schedule.rate(Duration.hours(1)),
      targets: [new LambdaEventTarget(analyticsExportFunction)],
    });

    // Glue database + external table over the NDJSON export, partitioned by dt.
    const glueDatabase = new CfnDatabase(this, "AnalyticsGlueDatabase", {
      catalogId: this.account,
      databaseInput: { name: "bedrock_team_token_quota" },
    });
    const analyticsGlueTable = new CfnTable(this, "AnalyticsGlueTable", {
      catalogId: this.account,
      databaseName: "bedrock_team_token_quota",
      tableInput: {
        name: "token_usage",
        tableType: "EXTERNAL_TABLE",
        partitionKeys: [{ name: "dt", type: "string" }],
        parameters: {
          classification: "json",
          has_encrypted_data: "true",
          // Partition projection: Athena auto-resolves dt partitions from the
          // key layout, so no MSCK REPAIR / Glue crawler is needed for new days.
          "projection.enabled": "true",
          "projection.dt.type": "date",
          "projection.dt.range": "2025-01-01,NOW",
          "projection.dt.format": "yyyy-MM-dd",
          "projection.dt.interval": "1",
          "projection.dt.interval.unit": "DAYS",
          "storage.location.template": `s3://${analyticsBucket.bucketName}/${ANALYTICS_PREFIX}/dt=\${dt}/`,
        },
        storageDescriptor: {
          location: `s3://${analyticsBucket.bucketName}/${ANALYTICS_PREFIX}/`,
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          serdeInfo: { serializationLibrary: "org.openx.data.jsonserde.JsonSerDe" },
          columns: [
            { name: "team", type: "string" },
            { name: "model", type: "string" },
            { name: "usageday", type: "string" },
            { name: "endpoint", type: "string" },
            { name: "inputtokens", type: "bigint" },
            { name: "outputtokens", type: "bigint" },
            { name: "cachereadtokens", type: "bigint" },
            { name: "cachewritetokens", type: "bigint" },
            { name: "totaltokens", type: "bigint" },
          ],
        },
      },
    });
    analyticsGlueTable.node.addDependency(glueDatabase);

    // Glue table over the enforcement-audit export (admin enforcement view).
    const enforcementAuditGlueTable = new CfnTable(this, "EnforcementAuditGlueTable", {
      catalogId: this.account,
      databaseName: "bedrock_team_token_quota",
      tableInput: {
        name: "enforcement_audit",
        tableType: "EXTERNAL_TABLE",
        partitionKeys: [{ name: "dt", type: "string" }],
        parameters: {
          classification: "json",
          has_encrypted_data: "true",
          "projection.enabled": "true",
          "projection.dt.type": "date",
          "projection.dt.range": "2025-01-01,NOW",
          "projection.dt.format": "yyyy-MM-dd",
          "projection.dt.interval": "1",
          "projection.dt.interval.unit": "DAYS",
          "storage.location.template": `s3://${analyticsBucket.bucketName}/enforcement-audit/dt=\${dt}/`,
        },
        storageDescriptor: {
          location: `s3://${analyticsBucket.bucketName}/enforcement-audit/`,
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          serdeInfo: { serializationLibrary: "org.openx.data.jsonserde.JsonSerDe" },
          columns: [
            { name: "team", type: "string" },
            { name: "model", type: "string" },
            { name: "rolearn", type: "string" },
            { name: "action", type: "string" },
            { name: "runningtotaltokens", type: "bigint" },
            { name: "dailytokenquota", type: "bigint" },
            { name: "timestamp", type: "string" },
          ],
        },
      },
    });
    enforcementAuditGlueTable.node.addDependency(glueDatabase);

    // Glue table over the currently-blocked snapshot (admin blocked view).
    const blockedStateGlueTable = new CfnTable(this, "BlockedStateGlueTable", {
      catalogId: this.account,
      databaseName: "bedrock_team_token_quota",
      tableInput: {
        name: "blocked_state",
        tableType: "EXTERNAL_TABLE",
        partitionKeys: [{ name: "dt", type: "string" }],
        parameters: {
          classification: "json",
          has_encrypted_data: "true",
          "projection.enabled": "true",
          "projection.dt.type": "date",
          "projection.dt.range": "2025-01-01,NOW",
          "projection.dt.format": "yyyy-MM-dd",
          "projection.dt.interval": "1",
          "projection.dt.interval.unit": "DAYS",
          "storage.location.template": `s3://${analyticsBucket.bucketName}/blocked-state/dt=\${dt}/`,
        },
        storageDescriptor: {
          location: `s3://${analyticsBucket.bucketName}/blocked-state/`,
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          serdeInfo: { serializationLibrary: "org.openx.data.jsonserde.JsonSerDe" },
          columns: [
            { name: "team", type: "string" },
            { name: "model", type: "string" },
            { name: "status", type: "string" },
            { name: "endpoint", type: "string" },
            { name: "blockedusageday", type: "string" },
            { name: "blockedat", type: "string" },
          ],
        },
      },
    });
    blockedStateGlueTable.node.addDependency(glueDatabase);

    const athenaWorkGroup = new CfnWorkGroup(this, "AnalyticsAthenaWorkGroup", {
      name: "bedrock-team-token-quota",
      workGroupConfiguration: {
        resultConfiguration: {
          outputLocation: `s3://${analyticsBucket.bucketName}/athena-results/`,
          encryptionConfiguration: { encryptionOption: "SSE_S3" },
        },
        enforceWorkGroupConfiguration: true,
      },
    });

    // -----------------------------------------------------------------
    // CUR 2.0 integration (opt-in via curDatabaseName + curTableName props)
    //
    // When configured, deploys one scheduled Lambda:
    //   CUR Per-Team Cost: queries CUR for Bedrock billed cost per team
    //   (via IAM principal cost-allocation tags) and writes the result to
    //   cur-team-cost/ in the analytics bucket for QuickSight. This is the
    //   ONLY source of dollar-denominated cost in the system — the token
    //   pipeline (Usage_Aggregation) tracks tokens for enforcement; CUR
    //   provides actual billed dollars from the AWS bill.
    //
    // Prerequisites (external, not created by this stack):
    //   - A CUR 2.0 Data Export with INCLUDE_IAM_PRINCIPAL_DATA, plus a Glue
    //     table over it (AWS Data Exports does not create one).
    //   - The IAM-principal tag activated as the cost-allocation tag
    //     `iamPrincipal/<teamTagKey>` (e.g. `iamPrincipal/team`).
    //   - Athena access to the CUR Glue table.
    //
    // When QuickSight is also enabled, billed dollars are shown on the same
    // dashboards as token usage and enforcement (a "Billed Cost" sheet).
    // -----------------------------------------------------------------
    let curTeamCostGlueTable: CfnTable | undefined;
    if (props.curDatabaseName && props.curTableName) {
      // Fail fast at synth rather than at runtime: Athena reads the CUR files
      // with the Lambda's credentials, which need read on the CUR bucket.
      if (!props.curBucketName) {
        throw new Error(
          "CUR integration is enabled (CUR_DATABASE_NAME + CUR_TABLE_NAME) but CUR_BUCKET_NAME is not set. " +
            "Set CUR_BUCKET_NAME to the S3 bucket your CUR 2.0 export delivers to " +
            "(e.g. bedrock-cur2-export-<account-id>) so the cost Lambda can read it."
        );
      }
      const curBucketName = props.curBucketName;
      // CUR Per-Team Cost Lambda: queries CUR 2.0 for Bedrock billed dollars
      // per team (via the `iamPrincipal/team` cost-allocation tag) and writes them to the
      // analytics bucket under cur-team-cost/ for QuickSight. This is the only
      // source of dollar-denominated cost in the system — the token pipeline
      // handles enforcement, CUR handles cost.
      const curTeamCostFunction = new NodejsFunction(this, "CurTeamCostFunction", {
        ...commonFunctionProps,
        entry: path.join(entryDir, "curTeamCostEntry.ts"),
        handler: "handler",
        timeout: Duration.minutes(5),
        environment: {
          [ENV_VAR_NAMES.CUR_DATABASE_NAME]: props.curDatabaseName,
          [ENV_VAR_NAMES.CUR_TABLE_NAME]: props.curTableName,
          [ENV_VAR_NAMES.CUR_ATHENA_WORKGROUP]: athenaWorkGroup.name,
          [ENV_VAR_NAMES.ANALYTICS_EXPORT_BUCKET_NAME]: analyticsBucket.bucketName,
          [ENV_VAR_NAMES.CUR_TEAM_TAG_KEY]: teamTagKey,
        },
      });
      // Athena: start/get/results queries (no resource-level scoping for Athena).
      curTeamCostFunction.addToRolePolicy(
        new PolicyStatement({
          sid: "RunAthenaQueriesForCurTeamCost",
          effect: Effect.ALLOW,
          actions: [
            "athena:StartQueryExecution",
            "athena:GetQueryExecution",
            "athena:GetQueryResults",
          ],
          resources: ["*"],
        })
      );
      // Glue: read the CUR table metadata.
      curTeamCostFunction.addToRolePolicy(
        new PolicyStatement({
          sid: "ReadCurGlueMetadata",
          effect: Effect.ALLOW,
          actions: ["glue:GetTable", "glue:GetDatabase", "glue:GetPartitions"],
          resources: [
            `arn:${this.partition}:glue:${this.region}:${this.account}:catalog`,
            `arn:${this.partition}:glue:${this.region}:${this.account}:database/${props.curDatabaseName}`,
            `arn:${this.partition}:glue:${this.region}:${this.account}:table/${props.curDatabaseName}/${props.curTableName}`,
          ],
        })
      );
      // S3: read CUR data + write Athena results and the cur-team-cost export.
      curTeamCostFunction.addToRolePolicy(
        new PolicyStatement({
          sid: "ReadCurS3AndWriteTeamCost",
          effect: Effect.ALLOW,
          actions: [
            "s3:GetObject",
            "s3:GetBucketLocation",
            "s3:ListBucket",
            "s3:PutObject",
          ],
          resources: [
            `${analyticsBucket.bucketArn}`,
            `${analyticsBucket.bucketArn}/athena-results/*`,
            `${analyticsBucket.bucketArn}/cur-team-cost/*`,
          ],
        })
      );
      // S3: read the CUR export files themselves. Athena uses the caller's
      // credentials for the data files, so without this the query fails with
      // "not authorized to perform: s3:ListBucket" on the CUR bucket.
      curTeamCostFunction.addToRolePolicy(
        new PolicyStatement({
          sid: "ReadCurExportBucket",
          effect: Effect.ALLOW,
          actions: ["s3:GetObject", "s3:GetBucketLocation", "s3:ListBucket"],
          resources: [
            `arn:${this.partition}:s3:::${curBucketName}`,
            `arn:${this.partition}:s3:::${curBucketName}/*`,
          ],
        })
      );
      new Rule(this, "CurTeamCostScheduleRule", {
        schedule: Schedule.rate(Duration.hours(6)),
        targets: [new LambdaEventTarget(curTeamCostFunction)],
      });

      // Glue table over the CUR per-team cost export (QuickSight cost view).
      curTeamCostGlueTable = new CfnTable(this, "CurTeamCostGlueTable", {
        catalogId: this.account,
        databaseName: "bedrock_team_token_quota",
        tableInput: {
          name: "cur_team_cost",
          tableType: "EXTERNAL_TABLE",
          partitionKeys: [{ name: "dt", type: "string" }],
          parameters: {
            classification: "json",
            has_encrypted_data: "true",
            "projection.enabled": "true",
            "projection.dt.type": "date",
            "projection.dt.range": "2025-01-01,NOW",
            "projection.dt.format": "yyyy-MM-dd",
            "projection.dt.interval": "1",
            "projection.dt.interval.unit": "DAYS",
            "storage.location.template": `s3://${analyticsBucket.bucketName}/cur-team-cost/dt=\${dt}/`,
          },
          storageDescriptor: {
            location: `s3://${analyticsBucket.bucketName}/cur-team-cost/`,
            inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
            outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
            serdeInfo: { serializationLibrary: "org.openx.data.jsonserde.JsonSerDe" },
            columns: [
              { name: "team", type: "string" },
              { name: "model", type: "string" },
              { name: "endpoint", type: "string" },
              { name: "billedcost", type: "double" },
              { name: "totaltokens", type: "bigint" },
              { name: "currency", type: "string" },
              { name: "billingperiod", type: "string" },
            ],
          },
        },
      });
      curTeamCostGlueTable.node.addDependency(glueDatabase);

      new CfnOutput(this, "CurIntegrationStatusOutput", {
        value: `CUR per-team cost enabled: ${props.curDatabaseName}.${props.curTableName}`,
        description: "CUR 2.0 per-team billed-cost extraction is active.",
      });
    }

    // QuickSight (opt-in via prop): an Athena data source + a dataset over the
    // Glue table, with row-level security so each team sees only its own rows.
    // Requires a QuickSight subscription + principal, so it is created only
    // when quickSightPrincipalArn is supplied.
    if (props.quickSightPrincipalArn) {
      const qsPrincipal = props.quickSightPrincipalArn;

      const dataSetActions = [
        "quicksight:DescribeDataSet",
        "quicksight:DescribeDataSetPermissions",
        "quicksight:PassDataSet",
        "quicksight:DescribeIngestion",
        "quicksight:ListIngestions",
        "quicksight:UpdateDataSet",
        "quicksight:DeleteDataSet",
        "quicksight:CreateIngestion",
        "quicksight:CancelIngestion",
        "quicksight:UpdateDataSetPermissions",
      ];

      const dataSource = new QuickSightDataSource(this, "CostDashboardDataSource", {
        awsAccountId: this.account,
        dataSourceId: "bedrock-team-token-quota-athena",
        name: "Bedrock Team Token Quota (Athena)",
        type: "ATHENA",
        dataSourceParameters: { athenaParameters: { workGroup: athenaWorkGroup.name } },
        permissions: [
          {
            principal: qsPrincipal,
            actions: [
              "quicksight:DescribeDataSource",
              "quicksight:DescribeDataSourcePermissions",
              "quicksight:PassDataSource",
              "quicksight:UpdateDataSource",
              "quicksight:DeleteDataSource",
              "quicksight:UpdateDataSourcePermissions",
            ],
          },
        ],
      });
      // QuickSight runs a connection test against the Athena workgroup when the
      // data source is created. On a cold (first-time) deploy the workgroup and
      // the data source can otherwise race, failing the test with "WorkGroup is
      // not found". Force the workgroup (and the Glue DB/table it queries) to be
      // fully created first.
      dataSource.node.addDependency(athenaWorkGroup);
      dataSource.node.addDependency(glueDatabase);
      dataSource.node.addDependency(analyticsGlueTable);

      // Row-Level-Security mapping table (requirements.md FR-7.2, SECURITY-08):
      // a Glue/Athena table under rls/ whose rows are (UserName, team). Each
      // QuickSight user sees only the teams their UserName is mapped to.
      // Admins upload a CSV/JSON mapping to s3://<analyticsBucket>/rls/.
      const rlsGlueTable = new CfnTable(this, "RlsGlueTable", {
        catalogId: this.account,
        databaseName: "bedrock_team_token_quota",
        tableInput: {
          name: "team_access",
          tableType: "EXTERNAL_TABLE",
          parameters: { classification: "json", has_encrypted_data: "true" },
          storageDescriptor: {
            location: `s3://${analyticsBucket.bucketName}/rls/`,
            inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
            outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
            serdeInfo: { serializationLibrary: "org.openx.data.jsonserde.JsonSerDe" },
            columns: [
              { name: "username", type: "string" },
              { name: "team", type: "string" },
            ],
          },
        },
      });
      rlsGlueTable.node.addDependency(glueDatabase);

      const rlsDataSet = new QuickSightDataSet(this, "CostDashboardRlsDataSet", {
        awsAccountId: this.account,
        dataSetId: "bedrock-team-token-quota-rls",
        name: "Team Access (RLS rules)",
        importMode: "DIRECT_QUERY",
        physicalTableMap: {
          teamAccess: {
            relationalTable: {
              dataSourceArn: dataSource.attrArn,
              catalog: "AwsDataCatalog",
              schema: "bedrock_team_token_quota",
              name: "team_access",
              inputColumns: [
                { name: "username", type: "STRING" },
                { name: "team", type: "STRING" },
              ],
            },
          },
        },
        permissions: [{ principal: qsPrincipal, actions: dataSetActions }],
      });

      const mainDataSet = new QuickSightDataSet(this, "CostDashboardDataSet", {
        awsAccountId: this.account,
        dataSetId: "bedrock-team-token-quota-usage-cost",
        name: "Token Usage by Team",
        importMode: "DIRECT_QUERY",
        physicalTableMap: {
          usageCost: {
            relationalTable: {
              dataSourceArn: dataSource.attrArn,
              catalog: "AwsDataCatalog",
              schema: "bedrock_team_token_quota",
              name: "token_usage",
              inputColumns: [
                { name: "team", type: "STRING" },
                { name: "model", type: "STRING" },
                { name: "usageday", type: "STRING" },
                { name: "endpoint", type: "STRING" },
                { name: "inputtokens", type: "INTEGER" },
                { name: "outputtokens", type: "INTEGER" },
                { name: "totaltokens", type: "INTEGER" },
              ],
            },
          },
        },
        // Per-team row-level security: a user only sees rows whose `team`
        // matches a (UserName, team) pair in the rules dataset. This is the
        // supported registered-user RLS mechanism for AWS::QuickSight::DataSet.
        // (CDK marks the prop @deprecated, but that note concerns the
        // unsupported DENY_ACCESS option, not GRANT_ACCESS RLS used here.)
        rowLevelPermissionDataSet: {
          arn: rlsDataSet.attrArn,
          permissionPolicy: "GRANT_ACCESS",
          formatVersion: "VERSION_1",
        },
        permissions: [{ principal: qsPrincipal, actions: dataSetActions }],
      });

      // -----------------------------------------------------------------
      // Billed-cost datasets (only when the CUR integration is enabled).
      //
      // The CUR Lambda writes MONTH-TO-DATE totals into every day's
      // cur-team-cost/dt=<day>/ partition, so summing across partitions would
      // double-count. These datasets therefore read only the LATEST partition
      // that actually has rows. The inner query references a data column
      // (team) so Athena scans real data instead of answering max(dt) from
      // partition-projection metadata (which always returns today), and it is
      // bounded to the last 14 days to avoid listing every projected day.
      // The dashboard therefore shows the current billing period.
      // -----------------------------------------------------------------
      const costSql =
        "SELECT team, model, endpoint, billedcost, totaltokens, currency, billingperiod " +
        "FROM bedrock_team_token_quota.cur_team_cost " +
        "WHERE dt >= date_format(date_add('day', -14, current_date), '%Y-%m-%d') " +
        "AND dt = (SELECT max(dt) FROM bedrock_team_token_quota.cur_team_cost " +
        "WHERE team IS NOT NULL AND dt >= date_format(date_add('day', -14, current_date), '%Y-%m-%d'))";
      const costColumns = [
        { name: "team", type: "STRING" },
        { name: "model", type: "STRING" },
        { name: "endpoint", type: "STRING" },
        { name: "billedcost", type: "DECIMAL" },
        { name: "totaltokens", type: "INTEGER" },
        { name: "currency", type: "STRING" },
        { name: "billingperiod", type: "STRING" },
      ];
      const buildCostDataSet = (
        constructId: string,
        dataSetId: string,
        name: string,
        withRls: boolean
      ): QuickSightDataSet => {
        const ds = new QuickSightDataSet(this, constructId, {
          awsAccountId: this.account,
          dataSetId,
          name,
          importMode: "DIRECT_QUERY",
          physicalTableMap: {
            billedCost: {
              customSql: {
                dataSourceArn: dataSource.attrArn,
                name: "billed_cost_latest",
                sqlQuery: costSql,
                columns: costColumns,
              },
            },
          },
          // Team copy: same per-team RLS as the token dataset. Admin copy: none.
          ...(withRls
            ? {
                rowLevelPermissionDataSet: {
                  arn: rlsDataSet.attrArn,
                  permissionPolicy: "GRANT_ACCESS",
                  formatVersion: "VERSION_1",
                },
              }
            : {}),
          permissions: [{ principal: qsPrincipal, actions: dataSetActions }],
        });
        // The table must exist (and Athena must be able to resolve it) first.
        if (curTeamCostGlueTable) ds.node.addDependency(curTeamCostGlueTable);
        return ds;
      };
      const costEnabled = curTeamCostGlueTable !== undefined;
      const teamCostDataSet = costEnabled
        ? buildCostDataSet("BilledCostDataSet", "bedrock-team-token-quota-billed-cost", "Billed Cost by Team", true)
        : undefined;
      const adminCostDataSet = costEnabled
        ? buildCostDataSet(
            "BilledCostAdminDataSet",
            "bedrock-team-token-quota-billed-cost-admin",
            "Billed Cost (All Teams - admin)",
            false
          )
        : undefined;

      // One "Billed Cost" sheet appended to each dashboard so dollars sit next
      // to tokens (and, for admins, enforcement) in the same place.
      const buildCostSheet = (
        sheetId: string,
        ds: string,
        visualPrefix: string,
        withChart: boolean
      ): QuickSightDashboard.SheetDefinitionProperty => ({
        sheetId,
        name: "Billed Cost",
        visuals: [
          ...(withChart
            ? [
                {
                  barChartVisual: {
                    visualId: `${visualPrefix}CostByTeam`,
                    title: {
                      visibility: "VISIBLE",
                      formatText: { plainText: "Billed Cost by Team (USD, current billing period)" },
                    },
                    chartConfiguration: {
                      fieldWells: {
                        barChartAggregatedFieldWells: {
                          category: [
                            { categoricalDimensionField: { fieldId: "c_team", column: { dataSetIdentifier: ds, columnName: "team" } } },
                          ],
                          values: [
                            {
                              numericalMeasureField: {
                                fieldId: "c_cost",
                                column: { dataSetIdentifier: ds, columnName: "billedcost" },
                                aggregationFunction: { simpleNumericalAggregation: "SUM" },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              ]
            : []),
          {
            tableVisual: {
              visualId: `${visualPrefix}CostTable`,
              title: {
                visibility: "VISIBLE",
                formatText: { plainText: "Billed Cost by Team, Model and Endpoint (USD, from AWS CUR)" },
              },
              chartConfiguration: {
                fieldWells: {
                  tableAggregatedFieldWells: {
                    groupBy: [
                      { categoricalDimensionField: { fieldId: "t_team", column: { dataSetIdentifier: ds, columnName: "team" } } },
                      { categoricalDimensionField: { fieldId: "t_model", column: { dataSetIdentifier: ds, columnName: "model" } } },
                      { categoricalDimensionField: { fieldId: "t_endpoint", column: { dataSetIdentifier: ds, columnName: "endpoint" } } },
                    ],
                    values: [
                      {
                        numericalMeasureField: {
                          fieldId: "t_cost",
                          column: { dataSetIdentifier: ds, columnName: "billedcost" },
                          aggregationFunction: { simpleNumericalAggregation: "SUM" },
                        },
                      },
                      {
                        numericalMeasureField: {
                          fieldId: "t_tokens",
                          column: { dataSetIdentifier: ds, columnName: "totaltokens" },
                          aggregationFunction: { simpleNumericalAggregation: "SUM" },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        ],
      });

      // Dashboard: a single "Cost Overview" sheet with a table of cost by
      // team/model/endpoint. RLS on the dataset ensures each viewer sees only
      // their own team's rows.
      new QuickSightDashboard(this, "CostDashboard", {
        awsAccountId: this.account,
        dashboardId: "bedrock-team-token-quota-cost",
        name: "Bedrock Team Token Usage & Cost",
        definition: {
          dataSetIdentifierDeclarations: [
            { identifier: "usageCost", dataSetArn: mainDataSet.attrArn },
            ...(teamCostDataSet ? [{ identifier: "billedCost", dataSetArn: teamCostDataSet.attrArn }] : []),
          ],
          sheets: [
            {
              sheetId: "overview",
              name: "Token Usage",
              visuals: [
                {
                  tableVisual: {
                    visualId: "tokenTable",
                    title: {
                      visibility: "VISIBLE",
                      formatText: { plainText: "Token Usage by Team, Model and Endpoint" },
                    },
                    chartConfiguration: {
                      fieldWells: {
                        tableAggregatedFieldWells: {
                          groupBy: [
                            { categoricalDimensionField: { fieldId: "team", column: { dataSetIdentifier: "usageCost", columnName: "team" } } },
                            { categoricalDimensionField: { fieldId: "model", column: { dataSetIdentifier: "usageCost", columnName: "model" } } },
                            { categoricalDimensionField: { fieldId: "endpoint", column: { dataSetIdentifier: "usageCost", columnName: "endpoint" } } },
                          ],
                          values: [
                            {
                              numericalMeasureField: {
                                fieldId: "totaltokens",
                                column: { dataSetIdentifier: "usageCost", columnName: "totaltokens" },
                                aggregationFunction: { simpleNumericalAggregation: "SUM" },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              ],
            },
            ...(teamCostDataSet ? [buildCostSheet("team-billed-cost", "billedCost", "team", false)] : []),
          ],
        },
        permissions: [
          {
            principal: qsPrincipal,
            actions: [
              "quicksight:DescribeDashboard",
              "quicksight:ListDashboardVersions",
              "quicksight:UpdateDashboardPermissions",
              "quicksight:QueryDashboard",
              "quicksight:UpdateDashboard",
              "quicksight:DeleteDashboard",
              "quicksight:DescribeDashboardPermissions",
              "quicksight:UpdateDashboardPublishedVersion",
            ],
          },
        ],
      });

      // -----------------------------------------------------------------
      // Admin dashboard: an ALL-TEAMS view (requirements.md C1 "admins see
      // all"). It is backed by a SEPARATE dataset that has NO row-level
      // security, so admins see every team's cost. This dataset/dashboard is
      // shared only with the admin principal; the RLS-restricted team
      // dashboard above is what gets shared with individual teams.
      // -----------------------------------------------------------------
      const adminDataSet = new QuickSightDataSet(this, "CostDashboardAdminDataSet", {
        awsAccountId: this.account,
        dataSetId: "bedrock-team-token-quota-usage-cost-admin",
        name: "Token Usage (All Teams - admin)",
        importMode: "DIRECT_QUERY",
        physicalTableMap: {
          usageCost: {
            relationalTable: {
              dataSourceArn: dataSource.attrArn,
              catalog: "AwsDataCatalog",
              schema: "bedrock_team_token_quota",
              name: "token_usage",
              inputColumns: [
                { name: "team", type: "STRING" },
                { name: "model", type: "STRING" },
                { name: "usageday", type: "STRING" },
                { name: "endpoint", type: "STRING" },
                { name: "inputtokens", type: "INTEGER" },
                { name: "outputtokens", type: "INTEGER" },
                { name: "totaltokens", type: "INTEGER" },
              ],
            },
          },
        },
        // Deliberately NO rowLevelPermissionDataSet: admins see all teams.
        permissions: [{ principal: qsPrincipal, actions: dataSetActions }],
      });

      // Admin-only datasets (no RLS) for the enforcement view.
      const enforcementAuditDataSet = new QuickSightDataSet(this, "EnforcementAuditDataSet", {
        awsAccountId: this.account,
        dataSetId: "bedrock-team-token-quota-enforcement-audit",
        name: "Enforcement Activity (All Teams - admin)",
        importMode: "DIRECT_QUERY",
        physicalTableMap: {
          enforcementAudit: {
            relationalTable: {
              dataSourceArn: dataSource.attrArn,
              catalog: "AwsDataCatalog",
              schema: "bedrock_team_token_quota",
              name: "enforcement_audit",
              inputColumns: [
                { name: "team", type: "STRING" },
                { name: "model", type: "STRING" },
                { name: "rolearn", type: "STRING" },
                { name: "action", type: "STRING" },
                { name: "runningtotaltokens", type: "INTEGER" },
                { name: "dailytokenquota", type: "INTEGER" },
                { name: "timestamp", type: "STRING" },
              ],
            },
          },
        },
        permissions: [{ principal: qsPrincipal, actions: dataSetActions }],
      });

      const blockedStateDataSet = new QuickSightDataSet(this, "BlockedStateDataSet", {
        awsAccountId: this.account,
        dataSetId: "bedrock-team-token-quota-blocked-state",
        name: "Currently Blocked (All Teams - admin)",
        importMode: "DIRECT_QUERY",
        physicalTableMap: {
          blockedState: {
            relationalTable: {
              dataSourceArn: dataSource.attrArn,
              catalog: "AwsDataCatalog",
              schema: "bedrock_team_token_quota",
              name: "blocked_state",
              inputColumns: [
                { name: "team", type: "STRING" },
                { name: "model", type: "STRING" },
                { name: "status", type: "STRING" },
                { name: "endpoint", type: "STRING" },
                { name: "blockedusageday", type: "STRING" },
                { name: "blockedat", type: "STRING" },
              ],
            },
          },
        },
        permissions: [{ principal: qsPrincipal, actions: dataSetActions }],
      });

      new QuickSightDashboard(this, "CostAdminDashboard", {
        awsAccountId: this.account,
        dashboardId: "bedrock-team-token-quota-cost-admin",
        name: "Bedrock Team Token Usage & Cost (Admin - All Teams)",
        definition: {
          dataSetIdentifierDeclarations: [
            { identifier: "usageCostAdmin", dataSetArn: adminDataSet.attrArn },
            { identifier: "blockedState", dataSetArn: blockedStateDataSet.attrArn },
            { identifier: "enforcementAudit", dataSetArn: enforcementAuditDataSet.attrArn },
            ...(adminCostDataSet ? [{ identifier: "billedCostAdmin", dataSetArn: adminCostDataSet.attrArn }] : []),
          ],
          sheets: [
            {
              sheetId: "admin-overview",
              name: "All Teams",
              visuals: [
                {
                  barChartVisual: {
                    visualId: "tokensByTeam",
                    title: {
                      visibility: "VISIBLE",
                      formatText: { plainText: "Total Tokens by Team" },
                    },
                    chartConfiguration: {
                      fieldWells: {
                        barChartAggregatedFieldWells: {
                          category: [
                            { categoricalDimensionField: { fieldId: "team", column: { dataSetIdentifier: "usageCostAdmin", columnName: "team" } } },
                          ],
                          values: [
                            {
                              numericalMeasureField: {
                                fieldId: "totaltokens",
                                column: { dataSetIdentifier: "usageCostAdmin", columnName: "totaltokens" },
                                aggregationFunction: { simpleNumericalAggregation: "SUM" },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
                {
                  tableVisual: {
                    visualId: "adminTokenTable",
                    title: {
                      visibility: "VISIBLE",
                      formatText: { plainText: "Token Usage by Team, Model and Endpoint (all teams)" },
                    },
                    chartConfiguration: {
                      fieldWells: {
                        tableAggregatedFieldWells: {
                          groupBy: [
                            { categoricalDimensionField: { fieldId: "team", column: { dataSetIdentifier: "usageCostAdmin", columnName: "team" } } },
                            { categoricalDimensionField: { fieldId: "model", column: { dataSetIdentifier: "usageCostAdmin", columnName: "model" } } },
                            { categoricalDimensionField: { fieldId: "endpoint", column: { dataSetIdentifier: "usageCostAdmin", columnName: "endpoint" } } },
                          ],
                          values: [
                            {
                              numericalMeasureField: {
                                fieldId: "totaltokensTable",
                                column: { dataSetIdentifier: "usageCostAdmin", columnName: "totaltokens" },
                                aggregationFunction: { simpleNumericalAggregation: "SUM" },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              ],
            },
            {
              sheetId: "admin-enforcement",
              name: "Enforcement",
              visuals: [
                {
                  // Currently-blocked (team, model) pairs across all teams.
                  tableVisual: {
                    visualId: "currentlyBlocked",
                    title: {
                      visibility: "VISIBLE",
                      formatText: { plainText: "Currently Blocked (team / model / status)" },
                    },
                    chartConfiguration: {
                      fieldWells: {
                        tableAggregatedFieldWells: {
                          groupBy: [
                            { categoricalDimensionField: { fieldId: "b_team", column: { dataSetIdentifier: "blockedState", columnName: "team" } } },
                            { categoricalDimensionField: { fieldId: "b_model", column: { dataSetIdentifier: "blockedState", columnName: "model" } } },
                            { categoricalDimensionField: { fieldId: "b_status", column: { dataSetIdentifier: "blockedState", columnName: "status" } } },
                            { categoricalDimensionField: { fieldId: "b_endpoint", column: { dataSetIdentifier: "blockedState", columnName: "endpoint" } } },
                            { categoricalDimensionField: { fieldId: "b_blockedusageday", column: { dataSetIdentifier: "blockedState", columnName: "blockedusageday" } } },
                          ],
                          values: [],
                        },
                      },
                    },
                  },
                },
                {
                  // Recent enforcement activity (ATTACH_DENY / REMOVE_DENY ...).
                  tableVisual: {
                    visualId: "enforcementActivity",
                    title: {
                      visibility: "VISIBLE",
                      formatText: { plainText: "Recent Enforcement Activity" },
                    },
                    chartConfiguration: {
                      fieldWells: {
                        tableAggregatedFieldWells: {
                          groupBy: [
                            { categoricalDimensionField: { fieldId: "a_timestamp", column: { dataSetIdentifier: "enforcementAudit", columnName: "timestamp" } } },
                            { categoricalDimensionField: { fieldId: "a_team", column: { dataSetIdentifier: "enforcementAudit", columnName: "team" } } },
                            { categoricalDimensionField: { fieldId: "a_model", column: { dataSetIdentifier: "enforcementAudit", columnName: "model" } } },
                            { categoricalDimensionField: { fieldId: "a_action", column: { dataSetIdentifier: "enforcementAudit", columnName: "action" } } },
                            { categoricalDimensionField: { fieldId: "a_rolearn", column: { dataSetIdentifier: "enforcementAudit", columnName: "rolearn" } } },
                          ],
                          values: [
                            {
                              numericalMeasureField: {
                                fieldId: "a_count",
                                column: { dataSetIdentifier: "enforcementAudit", columnName: "runningtotaltokens" },
                                aggregationFunction: { simpleNumericalAggregation: "MAX" },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              ],
            },
            ...(adminCostDataSet ? [buildCostSheet("admin-billed-cost", "billedCostAdmin", "admin", true)] : []),
          ],
        },
        permissions: [
          {
            principal: qsPrincipal,
            actions: [
              "quicksight:DescribeDashboard",
              "quicksight:ListDashboardVersions",
              "quicksight:UpdateDashboardPermissions",
              "quicksight:QueryDashboard",
              "quicksight:UpdateDashboard",
              "quicksight:DeleteDashboard",
              "quicksight:DescribeDashboardPermissions",
              "quicksight:UpdateDashboardPublishedVersion",
            ],
          },
        ],
      });

      new CfnOutput(this, "QuickSightDataSourceArnOutput", {
        value: dataSource.attrArn,
        description: "QuickSight Athena data source ARN for the cost dashboards.",
      });
      new CfnOutput(this, "QuickSightTeamDashboardIdOutput", {
        value: "bedrock-team-token-quota-cost",
        description: "QuickSight TEAM dashboard id (per-team RLS; share with team users).",
      });
      new CfnOutput(this, "QuickSightAdminDashboardIdOutput", {
        value: "bedrock-team-token-quota-cost-admin",
        description: "QuickSight ADMIN dashboard id (all teams, no RLS; share with admins only).",
      });
    }

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
