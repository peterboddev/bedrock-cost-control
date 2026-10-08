import { billingPeriodForDate, buildPerTeamCostQuery } from './curAthenaQueries';

describe('buildPerTeamCostQuery', () => {
  it('uses the team tag column', () => {
    const sql = buildPerTeamCostQuery('mydb.cur2', '2026-10', 'team');
    expect(sql).toContain("tags['iamPrincipal/team']");
    expect(sql).not.toContain('resource_tags');
    expect(sql).toContain('AS team');
    // Both Bedrock CUR product codes (Claude bills under AmazonBedrockService).
    expect(sql).toContain("IN ('AmazonBedrock', 'AmazonBedrockService')");
    expect(sql).toContain("billing_period = '2026-10'");
  });

  it('quotes database and table separately, not as one identifier', () => {
    const sql = buildPerTeamCostQuery('cur2_db.data', '2026-10', 'team');
    expect(sql).toContain('FROM "cur2_db"."data"');
    // "cur2_db.data" as a single quoted identifier = TABLE_NOT_FOUND in Athena.
    expect(sql).not.toContain('"cur2_db.data"');
  });

  it('uses a custom tag key', () => {
    const sql = buildPerTeamCostQuery('mydb.cur2', '2026-10', 'CostCenter');
    expect(sql).toContain("tags['iamPrincipal/CostCenter']");
  });
});

describe('billingPeriodForDate', () => {
  it('returns YYYY-MM', () => {
    expect(billingPeriodForDate(new Date('2026-10-15T12:00:00Z'))).toBe('2026-10');
    expect(billingPeriodForDate(new Date('2025-01-01T00:00:00Z'))).toBe('2025-01');
  });
});
