import { billingPeriodForDate, buildPerTeamCostQuery } from './curAthenaQueries';

describe('buildPerTeamCostQuery', () => {
  it('uses the team tag column', () => {
    const sql = buildPerTeamCostQuery('mydb.cur2', '2026-10', 'team');
    expect(sql).toContain("resource_tags['user:team']");
    expect(sql).toContain('AS team');
    expect(sql).toContain("'AmazonBedrock'");
    expect(sql).toContain("billing_period = '2026-10'");
  });

  it('uses a custom tag key', () => {
    const sql = buildPerTeamCostQuery('mydb.cur2', '2026-10', 'CostCenter');
    expect(sql).toContain("resource_tags['user:CostCenter']");
  });
});

describe('billingPeriodForDate', () => {
  it('returns YYYY-MM', () => {
    expect(billingPeriodForDate(new Date('2026-10-15T12:00:00Z'))).toBe('2026-10');
    expect(billingPeriodForDate(new Date('2025-01-01T00:00:00Z'))).toBe('2025-01');
  });
});
