/**
 * CUR 2.0 reports Bedrock `line_item_usage_amount` in the line item's
 * `pricing_unit`, which for token usage types is "1K tokens" (verified against
 * a live CUR 2.0 export: e.g. 46.361 for Claude output means 46,361 tokens).
 * Treating that amount as a raw token count under-reports by 1000x, and the
 * Glue `bigint` column then truncates the fraction to 0.
 *
 * Converts a CUR usage amount to an absolute token count using the pricing
 * unit. Unknown or missing units are returned unchanged (1 token per unit).
 */
export function usageAmountToTokens(amount: number, pricingUnit?: string): number {
  if (!Number.isFinite(amount)) return 0;
  const unit = (pricingUnit ?? '').trim().toLowerCase();
  if (/^1\s*k\b/.test(unit)) return amount * 1_000;
  if (/^1\s*m\b/.test(unit)) return amount * 1_000_000;
  return amount;
}
