import { describe, expect, it } from 'vitest';
import { newAggregate } from '../src/core/aggregate';
import { analyzeText } from '../src/core/analyze';
import { estimate, matchServer } from '../src/core/estimate';
import { egressCost, prices, type Server } from '../src/core/prices';
import { toJson, toMarkdown, toTable } from '../src/core/report';
import { agg } from './helpers';

const P = prices();
const srv = (name: string, vcpu: number, mem: number, monthly: number, category: Server['category'] = 'general', arch: Server['arch'] = 'x86'): Server => ({
  name, vcpu, memoryGiB: mem, monthly, category, arch,
});

describe('price data', () => {
  it('is bundled with the four EU providers and the hyperscaler spec tables', () => {
    expect(P.providers.filter((p) => p.euOwned).map((p) => p.id).sort()).toEqual(['hetzner', 'ovhcloud', 'scaleway', 'upcloud']);
    expect(P.servers.aws.find((s) => s.name === 'm6i.xlarge')).toMatchObject({ vcpu: 4, memoryGiB: 16 });
    expect(P.servers.azure.find((s) => s.name === 'Standard_D4s_v5')).toMatchObject({ vcpu: 4, memoryGiB: 16 });
    expect(P.servers.gcp.find((s) => s.name === 'n2-standard-4')).toMatchObject({ vcpu: 4, memoryGiB: 16 });
    expect(P.fx.usdPerEur).toBeGreaterThan(0.5);
  });
});

describe('matchServer', () => {
  const pool = [
    srv('small', 2, 4, 5, 'shared'),
    srv('g4', 4, 16, 40),
    srv('c4', 4, 8, 30, 'compute'),
    srv('m4', 4, 32, 60, 'memory'),
    srv('a4', 4, 16, 20, 'general', 'arm'),
    srv('g8', 8, 32, 80),
  ];
  it('picks the cheapest x86 server with enough vCPU and memory', () => {
    expect(matchServer(pool, 4, 16, 'x86')!.server.name).toBe('g4');
    expect(matchServer(pool, 4, 8, 'x86')!.server.name).toBe('c4');
    expect(matchServer(pool, 2, 20, 'x86')!.server.name).toBe('m4');
  });
  it('allows Arm only when the source was Arm', () => {
    expect(matchServer(pool, 4, 16, 'arm')!.server.name).toBe('a4');
  });
  it('allows shared-core servers only for shared or burstable sources', () => {
    expect(matchServer(pool, 2, 4, 'x86')!.server.name).toBe('c4');
    expect(matchServer(pool, 2, 4, 'x86', true)!.server.name).toBe('small');
  });
  it('splits a server that is too large into several', () => {
    expect(matchServer(pool, 16, 64, 'x86')).toMatchObject({ count: 2, server: { name: 'g8' } });
  });
  it('matches real index data: m6i.xlarge on Hetzner is a CCX23', () => {
    expect(matchServer(P.servers.hetzner, 4, 16, 'x86')!.server.name).toBe('CCX23');
  });
});

describe('egressCost', () => {
  it('applies the allowance once, then the tiers (AWS)', () => {
    const e = P.services.aws.egress!;
    const t0 = e.tiers![0].perGB;
    expect(egressCost(e, 50, 1)).toBe(0);
    expect(egressCost(e, 1000, 1)).toBeCloseTo((1000 - e.freeGB) * t0, 6);
    expect(egressCost(e, 1000, 5)).toBeCloseTo((1000 - e.freeGB) * t0, 6); // not per server
  });
  it('crosses tier boundaries', () => {
    const e = { freeGB: 0, perServer: false, tiers: [{ fromGB: 0, toGB: 100, perGB: 1 }, { fromGB: 100, toGB: null, perGB: 0.5 }] };
    expect(egressCost(e, 300, 1)).toBe(100 + 100);
  });
  it('multiplies per-server allowances (Hetzner)', () => {
    const e = P.services.hetzner.egress!;
    expect(e.perServer).toBe(true);
    expect(egressCost(e, e.freeGB * 2, 2)).toBe(0);
    expect(egressCost(e, e.freeGB + 1000, 1)).toBeCloseTo(1000 * e.tiers![0].perGB, 6);
  });
  it('is zero where traffic is included, and null where unknown', () => {
    expect(egressCost(P.services.scaleway.egress, 50000, 1)).toBe(0);
    expect(egressCost(null, 10, 1)).toBeNull();
  });
});

describe('currency', () => {
  it('converts USD bills with the index rate', () => {
    const r = estimate(agg('aws-cur2.csv'));
    expect(r.currency).toMatchObject({ bill: 'USD', converted: true, rate: P.fx.usdPerEur });
    const ec2 = r.categories.find((c) => c.id === 'compute')!.items.find((i) => i.label.startsWith('m7g.xlarge'))!;
    expect(ec2.current).toBeCloseTo(((6 * 720 * 0.1404) / P.fx.usdPerEur) * (730 / 720), 4);
  });
  it('leaves EUR bills alone', () => {
    const r = estimate(agg('azure-cost-details.csv'));
    expect(r.currency).toMatchObject({ bill: 'EUR', converted: false, rate: 1 });
    expect(r.currency.warning).toBeUndefined();
  });
  const sek = [
    'date,meterCategory,meterSubCategory,meterName,quantity,unitOfMeasure,costInBillingCurrency,billingCurrency,additionalInfo',
    '10/01/2026,Virtual Machines,Dsv5 Series,D4s v5,24,1 Hour,55,SEK,',
  ].join('\n');
  it('warns for other currencies and converts with a given rate', () => {
    const a = analyzeText(sek);
    const r = estimate(a);
    expect(r.currency.warning).toMatch(/SEK/);
    expect(r.current.total).toBeCloseTo(55 * 30.4167, 2);
    const r2 = estimate(a, { rate: 11 });
    expect(r2.currency.warning).toBeUndefined();
    expect(r2.current.total).toBeCloseTo((55 / 11) * 30.4167, 2);
  });
});

describe('period normalisation', () => {
  it('scales a 7-day bill to 730 hours', () => {
    const r = estimate(agg('aws-cur-legacy.csv'));
    expect(r.period).toMatchObject({ start: '2026-10-01', end: '2026-10-07', hours: 168, scaled: true });
    expect(r.period.factor).toBeCloseTo(730 / 168, 9);
    const m6i = r.categories[0].items.find((i) => i.label.startsWith('m6i.xlarge'))!;
    expect(m6i.quantity).toBe(3); // average running
    const ccx = P.servers.hetzner.find((s) => s.name === 'CCX23')!;
    expect(m6i.estimates.hetzner.low).toBeCloseTo(3 * ccx.monthly, 6);
    expect(r.assumptions.join(' ')).toMatch(/scaled to a 730-hour month/);
  });
  it('does not scale a full month noticeably', () => {
    const r = estimate(agg('gcp-console-cost-table.csv'));
    expect(r.period.days).toBe(30);
    expect(r.period.scaled).toBe(false);
  });
  it('assumes one month when there are no dates', () => {
    const a = newAggregate('aws', 'aws-cur');
    a.rows = 1;
    a.notCompared.x = { cost: 10, reasons: { r: 10 } };
    a.currencies.EUR = 10;
    const r = estimate(a);
    expect(r.period.assumed).toBe(true);
    expect(r.current.total).toBeCloseTo(10, 9);
  });
  it('infers hourly granularity when end dates are missing', () => {
    const a = newAggregate('aws', 'aws-cur');
    a.start = Date.UTC(2026, 9, 1, 0);
    a.maxStart = Date.UTC(2026, 9, 1, 23);
    a.allMidnight = false;
    expect(estimate(a).period.hours).toBe(24);
  });
});

describe('estimate', () => {
  it.each(['aws-cur-legacy.csv', 'aws-cur2.csv', 'azure-cost-details.csv', 'gcp-bigquery-export.csv', 'gcp-console-cost-table.csv'])(
    '%s: totals add up and every provider is priced',
    (file) => {
      const r = estimate(agg(file));
      const sum = r.categories.reduce((s, c) => s + c.current, 0);
      expect(r.current.compared).toBeCloseTo(sum, 6);
      expect(r.current.total).toBeCloseTo(r.current.compared + r.current.notCompared, 6);
      expect(r.comparedShare).toBeGreaterThan(0.5);
      expect(r.comparedShare).toBeLessThanOrEqual(1);
      expect(r.providers).toHaveLength(4);
      for (const p of r.providers) {
        expect(p.low).toBeGreaterThan(0);
        expect(p.high).toBeGreaterThanOrEqual(p.low);
        for (const c of r.categories) expect(c.estimates[p.id]).toBeDefined();
      }
      expect(r.prices.generated).toBe(P.generated);
    },
  );
  it('restricts to one provider', () => {
    const r = estimate(agg('aws-cur2.csv'), { providers: ['hetzner'] });
    expect(r.providers.map((p) => p.id)).toEqual(['hetzner']);
    expect(() => estimate(agg('aws-cur2.csv'), { providers: ['nope'] })).toThrow(/Unknown provider/);
  });
  it('puts unknown instance types in "not compared"', () => {
    const csv = [
      'lineItem/LineItemType,lineItem/UsageStartDate,lineItem/UsageEndDate,lineItem/ProductCode,lineItem/UsageType,lineItem/UsageAmount,lineItem/UnblendedCost,lineItem/CurrencyCode,product/instanceType',
      'Usage,2026-10-01T00:00:00Z,2026-10-02T00:00:00Z,AmazonEC2,EUC1-BoxUsage:zz9.mega,24,10,EUR,zz9.mega',
    ].join('\n');
    const r = estimate(analyzeText(csv));
    expect(r.categories).toHaveLength(0);
    expect(r.notCompared[0]).toMatchObject({ service: 'Servers: zz9.mega', reason: 'instance type not in the price index' });
    expect(r.comparedShare).toBe(0);
  });
  it('prices Hetzner Kubernetes and PostgreSQL as self-managed', () => {
    const r = estimate(agg('aws-cur-legacy.csv'));
    expect(r.categories.find((c) => c.id === 'kubernetes')!.estimates.hetzner.detail).toMatch(/no managed Kubernetes/);
    expect(r.categories.find((c) => c.id === 'database')!.items[0].estimates.hetzner.detail).toMatch(/self-managed/);
  });
  it('counts a Multi-AZ database twice', () => {
    const r = estimate(agg('aws-cur-legacy.csv'));
    const db = r.categories.find((c) => c.id === 'database')!.items.find((i) => i.label.includes('db.m6g.large'))!;
    expect(db.quantity).toBe(2);
    const pg = P.services.upcloud.postgres2vCPU8GBMonthly!.price;
    expect(db.estimates.upcloud.low).toBeCloseTo(2 * pg, 6); // 2 vCPU, 8 GiB = one unit, twice
  });
});

describe('reports', () => {
  const r = estimate(agg('azure-cost-details.csv'));
  it('rounds money to whole euros in JSON', () => {
    const j = JSON.parse(toJson(r));
    expect(Number.isInteger(j.current.total)).toBe(true);
    expect(Number.isInteger(j.providers[0].low)).toBe(true);
  });
  it('writes Markdown and a table with every provider', () => {
    for (const out of [toMarkdown(r), toTable(r)]) {
      for (const p of ['UpCloud', 'Hetzner', 'Scaleway', 'OVHcloud']) expect(out).toContain(p);
      expect(out).toMatch(/could compare/);
      expect(out).toContain('EU Cloud Price Index');
    }
  });
});
