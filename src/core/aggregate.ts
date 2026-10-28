// What a bill boils down to: quantities per comparable category, in the bill's own currency and period.
// Parsers fill an Aggregate; estimate() turns it into a monthly comparison.

export type Cloud = 'aws' | 'azure' | 'gcp';

export type FormatId = 'aws-cur' | 'aws-cur2' | 'azure' | 'gcp-bigquery' | 'gcp-console';

export type ExcludedKind = 'credit' | 'refund' | 'tax' | 'support' | 'discount' | 'commitment';

export interface ComputeEntry {
  /** Instance type as named in the price index (m6i.xlarge, Standard_D4s_v5, n2-standard-4). */
  type: string;
  hours: number;
  /** Google Cloud bills vCPU-hours; instance hours are derived from the machine spec. */
  vcpuHours: number;
  cost: number;
  spotHours: number;
  committedHours: number;
}

/** Google Cloud bills vCPU and memory per machine family, not per machine. */
export interface PooledComputeEntry {
  family: string;
  arch: 'x86' | 'arm';
  vcpuHours: number;
  memGiBHours: number;
  cost: number;
  spot: boolean;
}

export interface DatabaseEntry {
  key: string;
  engine: string;
  /** Instance class when the bill names one (db.m6g.large, Standard_D2ds_v5). */
  instanceClass?: string;
  instanceHours: number;
  vcpuHours: number;
  memGiBHours: number;
  storageGBMonth: number;
  /** Multi-AZ / zone-redundant / regional: a standby node is running too. */
  ha: boolean;
  cost: number;
}

export interface Aggregate {
  cloud: Cloud;
  format: FormatId;
  rows: number;
  /** Rows that produced a cost or quantity. */
  usedRows: number;
  currencies: Record<string, number>;
  /** Currency guessed from a header like "Cost (€)" when there is no currency column. */
  headerCurrency?: string;
  start?: number;
  end?: number;
  maxStart?: number;
  allMidnight: boolean;
  compute: Record<string, ComputeEntry>;
  pooledCompute: Record<string, PooledComputeEntry>;
  database: Record<string, DatabaseEntry>;
  block: { gbMonth: number; cost: number };
  object: { gbMonth: number; cost: number };
  egress: { gb: number; cost: number };
  loadBalancer: { hours: number; cost: number };
  kubernetes: { hours: number; cost: number };
  /** Service name -> cost and the reasons lines ended up here. */
  notCompared: Record<string, { cost: number; reasons: Record<string, number> }>;
  excluded: Record<ExcludedKind, number>;
  flags: {
    spot: boolean;
    reserved: boolean;
    savingsPlan: boolean;
    commitmentFeesSkipped: number;
    zeroCostReserved: boolean;
    licensedOs: boolean;
    cdnEgress: boolean;
  };
}

export function newAggregate(cloud: Cloud, format: FormatId): Aggregate {
  return {
    cloud,
    format,
    rows: 0,
    usedRows: 0,
    currencies: {},
    allMidnight: true,
    compute: {},
    pooledCompute: {},
    database: {},
    block: { gbMonth: 0, cost: 0 },
    object: { gbMonth: 0, cost: 0 },
    egress: { gb: 0, cost: 0 },
    loadBalancer: { hours: 0, cost: 0 },
    kubernetes: { hours: 0, cost: 0 },
    notCompared: {},
    excluded: { credit: 0, refund: 0, tax: 0, support: 0, discount: 0, commitment: 0 },
    flags: {
      spot: false,
      reserved: false,
      savingsPlan: false,
      commitmentFeesSkipped: 0,
      zeroCostReserved: false,
      licensedOs: false,
      cdnEgress: false,
    },
  };
}

export function seeDates(a: Aggregate, start?: number, end?: number): void {
  if (start == null || Number.isNaN(start)) return;
  if (a.start == null || start < a.start) a.start = start;
  if (a.maxStart == null || start > a.maxStart) a.maxStart = start;
  if (start % 86400000 !== 0) a.allMidnight = false;
  if (end != null && end > start && (a.end == null || end > a.end)) a.end = end;
}

export function seeCurrency(a: Aggregate, c: string | undefined, cost: number): void {
  const code = (c || '').trim().toUpperCase();
  if (!code) return;
  a.currencies[code] = (a.currencies[code] || 0) + Math.abs(cost) + 1e-9;
}

export function addNotCompared(a: Aggregate, service: string, cost: number, reason: string): void {
  if (cost === 0) return;
  const s = (a.notCompared[service] ||= { cost: 0, reasons: {} });
  s.cost += cost;
  s.reasons[reason] = (s.reasons[reason] || 0) + cost;
}

export function addCompute(
  a: Aggregate,
  type: string,
  hours: number,
  cost: number,
  opts: { spot?: boolean; committed?: boolean; vcpuHours?: number } = {},
): void {
  const e = (a.compute[type] ||= { type, hours: 0, vcpuHours: 0, cost: 0, spotHours: 0, committedHours: 0 });
  e.hours += hours;
  e.vcpuHours += opts.vcpuHours ?? 0;
  e.cost += cost;
  if (opts.spot) e.spotHours += hours;
  if (opts.committed) e.committedHours += hours;
}

export function dbEntry(a: Aggregate, engine: string, instanceClass: string | undefined, ha: boolean): DatabaseEntry {
  const key = `${engine}|${instanceClass ?? ''}|${ha ? 'ha' : ''}`;
  return (a.database[key] ||= {
    key,
    engine,
    instanceClass,
    instanceHours: 0,
    vcpuHours: 0,
    memGiBHours: 0,
    storageGBMonth: 0,
    ha,
    cost: 0,
  });
}

/** Database storage and I/O lines that cannot be tied to one instance go to an engine-level entry. */
export function dbCostOnly(a: Aggregate, engine: string, cost: number, storageGBMonth = 0): void {
  const e = dbEntry(a, engine, undefined, false);
  e.cost += cost;
  e.storageGBMonth += storageGBMonth;
}

/** Total of every line that counts towards the current bill (usage at effective cost, not credits/tax/etc.). */
export function currentTotal(a: Aggregate): number {
  let t = a.block.cost + a.object.cost + a.egress.cost + a.loadBalancer.cost + a.kubernetes.cost;
  for (const e of Object.values(a.compute)) t += e.cost;
  for (const e of Object.values(a.pooledCompute)) t += e.cost;
  for (const e of Object.values(a.database)) t += e.cost;
  for (const e of Object.values(a.notCompared)) t += e.cost;
  return t;
}
