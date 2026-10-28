import { describe, expect, it } from 'vitest';
import { unitMultiplier, vmSizeFromMeter } from '../src/core/azure';
import { gcpConvert } from '../src/core/gcp';
import { normKey, num, parseDate } from '../src/core/util';

describe('normKey', () => {
  it('maps legacy CUR, CUR 2.0, Azure and GCP spellings to one key', () => {
    expect(normKey('lineItem/UsageType')).toBe(normKey('line_item_usage_type'));
    expect(normKey('MeterCategory')).toBe(normKey('meterCategory'));
    expect(normKey('service.description')).toBe(normKey('Service description'));
    expect(normKey('Cost (€)')).toBe('cost');
  });
});

describe('parseDate', () => {
  const d = Date.UTC(2026, 9, 1);
  it.each([
    ['2026-10-01', d],
    ['2026-10-01T00:00:00Z', d],
    ['2026-10-01T00:00:00.000Z', d],
    ['2026-10-01 00:00:00 UTC', d],
    ['2026-10-01T02:00:00+02:00', d],
    ['10/01/2026', d],
    ['10/01/2026 13:00', d + 13 * 3600000],
  ])('%s', (s, want) => expect(parseDate(s)).toBe(want));
  it('returns undefined for garbage', () => expect(parseDate('soon')).toBeUndefined());
});

describe('num', () => {
  it('reads plain, grouped and negative numbers', () => {
    expect(num('12.5')).toBe(12.5);
    expect(num('1,234.50')).toBe(1234.5);
    expect(num('(3.20)')).toBe(-3.2);
    expect(num('')).toBe(0);
    expect(num('1e-3')).toBe(0.001);
  });
});

describe('Azure units and sizes', () => {
  it('reads the multiplier in UnitOfMeasure', () => {
    expect(unitMultiplier('100 Hours')).toBe(100);
    expect(unitMultiplier('1 GB/Month')).toBe(1);
    expect(unitMultiplier('10K')).toBe(10000);
    expect(unitMultiplier('Hours')).toBe(1);
  });
  it('derives the VM size from the meter name', () => {
    expect(vmSizeFromMeter('D4s v5')).toBe('Standard_D4s_v5');
    expect(vmSizeFromMeter('D2 v3/D2s v3')).toBe('Standard_D2_v3');
    expect(vmSizeFromMeter('E8s v5 Spot')).toBe('Standard_E8s_v5');
    expect(vmSizeFromMeter('vCore')).toBe('');
  });
});

describe('Google Cloud units', () => {
  it('converts seconds, byte-seconds and bytes', () => {
    expect(gcpConvert(7200, 'seconds', 'hour')).toBe(2);
    expect(gcpConvert(2 ** 30 * 3600, 'byte-seconds', 'gibHour')).toBe(1);
    expect(gcpConvert(2 ** 30 * 3600 * 730, 'byte-seconds', 'gibMonth')).toBe(1);
    expect(gcpConvert(2 ** 31, 'bytes', 'gib')).toBe(2);
    expect(gcpConvert(5, 'gibibyte month', 'gibMonth')).toBe(5);
    expect(Number.isNaN(gcpConvert(5, 'requests', 'hour'))).toBe(true);
  });
});
