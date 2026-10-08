/**
 * Athena SQL query builders for CUR 2.0 Bedrock line items.
 *
 * Each function returns a parameterized SQL string targeting the CUR 2.0
 * Glue table. The caller provides the fully-qualified table name
 * ({database}.{table}) and the billing period filter.
 *
 * Pure — no SDK calls. The actual Athena execution lives in the entrypoints.
 */

/**
 * Builds the Athena SQL to extract per-team Bedrock billed cost from CUR
 * cost-allocation tags. Requires the `team` tag to be activated as a cost
 * allocation tag in the AWS Billing console.
 *
 * Bedrock attributes cost to the calling IAM principal. Per the AWS docs, IAM
 * principal tags appear in the CUR 2.0 `tags` map with the `iamPrincipal/`
 * prefix, i.e. `tags['iamPrincipal/<key>']`. This requires BOTH (a) the CUR 2.0
 * export to have INCLUDE_IAM_PRINCIPAL_DATA=TRUE and (b) the tag activated in
 * Billing under its prefixed name (`iamPrincipal/<key>`, not the bare key).
 * See https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/iam-principal-cost-allocation.html
 *
 * Bedrock bills under TWO CUR product codes: `AmazonBedrock` (first-party and
 * most open-weight models, e.g. Nova, Llama, gpt-oss) and `AmazonBedrockService`
 * (Anthropic Claude, incl. Mantle-served Claude). Verified against a live CUR 2.0
 * export where `AmazonBedrockService` was ~99% of the cost, so both are required.
 *
 * @param teamTagKey The tag key used to identify teams (default: "team").
 */
export function buildPerTeamCostQuery(
  curTable: string,
  billingPeriod: string,
  teamTagKey = 'team'
): string {
  const tagColumn = `tags['iamPrincipal/${teamTagKey}']`;
  // Quote each identifier part separately: "db"."table". Quoting the whole
  // `db.table` string makes Athena look for ONE table literally named
  // "db.table" and fail with TABLE_NOT_FOUND (verified against live Athena).
  const quotedTable = curTable
    .split('.')
    .map((part) => `"${part}"`)
    .join('.');
  return `
    SELECT
      ${tagColumn} AS team,
      line_item_usage_type,
      SUM(CAST(line_item_unblended_cost AS double)) AS total_unblended_cost,
      SUM(CAST(line_item_usage_amount AS double)) AS total_usage_amount
    FROM ${quotedTable}
    WHERE line_item_product_code IN ('AmazonBedrock', 'AmazonBedrockService')
      AND line_item_line_item_type = 'Usage'
      AND billing_period = '${billingPeriod}'
    GROUP BY ${tagColumn}, line_item_usage_type
  `.trim();
}

/**
 * Returns the billing period string (YYYY-MM) for a given date.
 * CUR 2.0 partitions by billing_period in this format.
 */
export function billingPeriodForDate(date: Date): string {
  return date.toISOString().slice(0, 7);
}
