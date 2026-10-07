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
 * CUR 2.0 surfaces IAM principal tags (from the role making the Bedrock call)
 * as nested `resource_tags` columns. The tag key appears as
 * `resource_tags['user:<key>']` in the CUR 2.0 nested schema.
 *
 * @param teamTagKey The tag key used to identify teams (default: "team").
 */
export function buildPerTeamCostQuery(
  curTable: string,
  billingPeriod: string,
  teamTagKey = 'team'
): string {
  const tagColumn = `resource_tags['user:${teamTagKey}']`;
  return `
    SELECT
      ${tagColumn} AS team,
      line_item_usage_type,
      SUM(CAST(line_item_unblended_cost AS double)) AS total_unblended_cost,
      SUM(CAST(line_item_usage_amount AS double)) AS total_usage_amount
    FROM "${curTable}"
    WHERE line_item_product_code = 'AmazonBedrock'
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
