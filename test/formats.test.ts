import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BillError, analyzeText, detectFormat } from '../src/core/analyze';
import { readBill } from '../src/cli/read';
import { agg, sample } from './helpers';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps * Math.max(1, Math.abs(b)));

describe('format detection', () => {
  it.each([
    ['aws-cur-legacy.csv', 'aws-cur'],
    ['aws-cur2.csv', 'aws-cur2'],
    ['azure-cost-details.csv', 'azure'],
    ['gcp-bigquery-export.csv', 'gcp-bigquery'],
    ['gcp-console-cost-table.csv', 'gcp-console'],
  ])('%s is %s', (file, fmt) => {
    expect(detectFormat(sample(file).split('\n')[0].split(','))).toBe(fmt);
  });

  it('detects Azure EA headers in PascalCase', () => {
    expect(detectFormat(['Date', 'MeterCategory', 'MeterSubCategory', 'MeterName', 'Quantity', 'Cost', 'Currency'])).toBe('azure');
  });

  it('rejects unknown CSVs and non-CSV files with a clear message', () => {
    expect(() => analyzeText('name,amount\nfoo,1\n')).toThrow(BillError);
    expect(() => analyzeText('PAR1\u0000\u0000')).toThrow(/Parquet/);
    expect(() => analyzeText('PK\u0003\u0004xxxx')).toThrow(/ZIP/);
    expect(() => analyzeText('lineItem/ProductCode,lineItem/UsageType\n')).toThrow(/no rows/);
  });
});

describe('AWS legacy CUR', () => {
  const a = agg('aws-cur-legacy.csv');
  it('reads the period and currency', () => {
    expect(a.start).toBe(Date.UTC(2026, 9, 1));
    expect(a.end).toBe(Date.UTC(2026, 9, 8));
    expect(Object.keys(a.currencies)).toEqual(['USD']);
  });
  it('counts instance hours per type, with reserved and spot usage', () => {
    expect(a.compute['m6i.xlarge'].hours).toBe(504);
    expect(a.compute['t3.medium'].hours).toBe(168);
    expect(a.compute['r6g.large'].hours).toBe(336);
    expect(a.compute['r6g.large'].committedHours).toBe(336);
    close(a.compute['r6g.large'].cost, 336 * 0.0712, 1e-4); // effective cost, not the zero unblended cost
    expect(a.compute['c6i.2xlarge'].spotHours).toBe(336);
    expect(a.compute['m5.large']).toBeUndefined(); // Windows
    expect(a.flags.licensedOs).toBe(true);
  });
  it('maps storage, egress, load balancers, EKS and RDS', () => {
    close(a.block.gbMonth, (2000 / 31) * 7, 1e-4);
    close(a.object.gbMonth, (5000 / 31) * 7, 1e-4);
    expect(a.egress.gb).toBe((95 + 20) * 7); // EC2 and S3 to the internet; not CloudFront, not inter-AZ
    expect(a.loadBalancer.hours).toBe(336);
    expect(a.kubernetes.hours).toBe(168);
    const db = Object.values(a.database).find((d) => d.instanceClass === 'db.m6g.large')!;
    expect(db.engine).toBe('postgresql');
    expect(db.ha).toBe(true);
    expect(db.instanceHours).toBe(168);
  });
  it('keeps credits, support and fee lines out of the comparison', () => {
    expect(a.excluded.support).toBe(100);
    expect(a.excluded.credit).toBe(-50);
    expect(a.flags.commitmentFeesSkipped).toBeGreaterThan(0);
    expect(a.notCompared['Amazon CloudFront'].cost).toBeGreaterThan(0);
    expect(a.notCompared['AWS Lambda'].cost).toBeGreaterThan(0);
  });
});

describe('AWS CUR 2.0', () => {
  const a = agg('aws-cur2.csv');
  it('uses savings plan effective cost and skips the negation', () => {
    expect(a.compute['m7g.xlarge'].hours).toBe(6 * 720);
    close(a.compute['m7g.xlarge'].cost, 6 * 720 * 0.1404, 1e-4);
    expect(a.flags.savingsPlan).toBe(true);
  });
  it('reads the engine from the product map column', () => {
    const mysql = Object.values(a.database).find((d) => d.instanceClass === 'db.r6g.xlarge')!;
    expect(mysql.engine).toBe('mysql');
    expect(Object.values(a.database).some((d) => d.instanceClass === 'db.r5.large')).toBe(false); // Oracle
    expect(a.notCompared['Amazon Relational Database Service'].cost).toBeCloseTo(720 * 0.67, 4);
  });
  it('counts only internet egress', () => {
    expect(a.egress.gb).toBe(12500);
    expect(a.excluded.discount).toBe(-180);
  });
});

describe('Azure cost details', () => {
  const a = agg('azure-cost-details.csv');
  it('reads MM/DD/YYYY dates as a 7-day period', () => {
    expect(a.start).toBe(Date.UTC(2026, 9, 1));
    expect(a.end).toBe(Date.UTC(2026, 9, 8));
    expect(Object.keys(a.currencies)).toEqual(['EUR']);
  });
  it('takes the VM size from AdditionalInfo and leaves Windows out', () => {
    expect(a.compute['Standard_D4s_v5'].hours).toBe(3 * 24 * 7);
    expect(a.compute['Standard_E8s_v5'].committedHours).toBe(2 * 24 * 7);
    expect(a.compute['Standard_B2ms'].hours).toBe(168);
    expect(a.compute['Standard_D2s_v5']).toBeUndefined();
  });
  it('turns disk tiers into GB and counts hot blob storage only', () => {
    close(a.block.gbMonth, ((5 * 1024 + 2 * 128) / 31) * 7 * 1.073741824, 1e-4);
    close(a.object.gbMonth, (6000 / 31) * 7, 1e-4);
    expect(a.egress.gb).toBe(110 * 7);
    expect(a.loadBalancer.hours).toBe(168);
    expect(a.kubernetes.hours).toBe(168);
  });
  it('reads PostgreSQL flexible server vCores', () => {
    const pg = Object.values(a.database).find((d) => d.vcpuHours > 0)!;
    expect(pg.vcpuHours).toBe(96 * 7);
    expect(pg.memGiBHours).toBe(96 * 7 * 4);
    expect(a.excluded.commitment).toBe(0);
  });
});

describe('Google Cloud BigQuery export', () => {
  const a = agg('gcp-bigquery-export.csv');
  it('reads UTC timestamps', () => {
    expect(a.start).toBe(Date.UTC(2026, 9, 1));
    expect(a.end).toBe(Date.UTC(2026, 9, 8));
  });
  it('pools vCPU and memory per machine family, from seconds and byte-seconds', () => {
    close(a.pooledCompute['N2'].vcpuHours, 12 * 24 * 7, 1e-6);
    close(a.pooledCompute['N2'].memGiBHours, 48 * 24 * 7, 1e-6);
    expect(a.pooledCompute['N2D AMD (spot)'].spot).toBe(true);
  });
  it('applies sustained use discounts to the line and keeps promotions apart', () => {
    const list = (12 * 24 * 0.0346 + 48 * 24 * 0.00464) * 7;
    expect(a.pooledCompute['N2'].cost).toBeLessThan(list);
    expect(a.excluded.credit).toBeCloseTo(-40 - 2.25, 6);
  });
  it('maps disks, storage, egress, LB, GKE and Cloud SQL', () => {
    close(a.block.gbMonth, ((1500 * 24) / 730) * 7 * 1.073741824, 1e-6);
    close(a.egress.gb, 100 * 7 * 1.073741824, 1e-6);
    expect(a.loadBalancer.hours).toBeCloseTo(168, 6);
    expect(a.kubernetes.hours).toBeCloseTo(168, 6);
    const sql = Object.values(a.database)[0];
    expect(sql.ha).toBe(true);
    expect(sql.vcpuHours).toBeCloseTo(4 * 24 * 7, 6);
  });
});

describe('Google Cloud console cost table', () => {
  const a = agg('gcp-console-cost-table.csv');
  it('takes the currency from the cost header and treats the end date as inclusive', () => {
    expect(a.headerCurrency).toBe('USD');
    expect(((a.end ?? 0) - (a.start ?? 0)) / 3600000).toBe(720);
  });
  it('marks Arm families and books credit rows separately', () => {
    expect(a.pooledCompute['T2A'].arch).toBe('arm');
    expect(a.excluded.credit).toBeCloseTo(-72, 6);
    expect(a.excluded.discount).toBeLessThan(0);
  });
});

describe('reading files', () => {
  it('reads gzip-compressed exports, with or without the .gz name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cba-'));
    const gz = gzipSync(sample('aws-cur2.csv'));
    writeFileSync(join(dir, 'bill.csv.gz'), gz);
    writeFileSync(join(dir, 'bill.csv'), gz);
    const plain = agg('aws-cur2.csv');
    for (const f of ['bill.csv.gz', 'bill.csv']) {
      const a = await readBill(join(dir, f));
      expect(a.rows).toBe(plain.rows);
      expect(a.compute['m7g.xlarge'].hours).toBe(plain.compute['m7g.xlarge'].hours);
    }
  });
});

describe('split exports', () => {
  it('adds up several files of the same export, each with its own header', async () => {
    const lines = sample('aws-cur-legacy.csv').trimEnd().split('\n');
    const [head, ...body] = lines;
    const half = Math.floor(body.length / 2);
    const dir = mkdtempSync(join(tmpdir(), 'cba-'));
    writeFileSync(join(dir, 'part1.csv'), [head, ...body.slice(0, half)].join('\n') + '\n');
    writeFileSync(join(dir, 'part2.csv.gz'), gzipSync([head, ...body.slice(half)].join('\n') + '\n'));
    const a = await readBill(join(dir, 'part1.csv'), join(dir, 'part2.csv.gz'));
    const whole = agg('aws-cur-legacy.csv');
    expect(a.rows).toBe(whole.rows);
    expect(a.compute['m6i.xlarge'].hours).toBe(whole.compute['m6i.xlarge'].hours);
    expect(a.egress.gb).toBe(whole.egress.gb);
  });
  it('refuses to mix clouds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cba-'));
    writeFileSync(join(dir, 'a.csv'), sample('aws-cur2.csv'));
    writeFileSync(join(dir, 'b.csv'), sample('azure-cost-details.csv'));
    await expect(readBill(join(dir, 'a.csv'), join(dir, 'b.csv'))).rejects.toThrow(/different clouds/);
  });
});
