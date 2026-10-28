import raw from '../../data/prices.json';

export type Category = 'general' | 'compute' | 'memory' | 'shared' | 'burstable' | 'storage' | 'other';

export interface Server {
  name: string;
  vcpu: number;
  memoryGiB: number;
  monthly: number;
  category: Category;
  arch: 'x86' | 'arm';
  estimated?: boolean;
}

export interface UnitPrice {
  price: number;
  product: string;
}

export interface Egress {
  freeGB: number;
  perServer: boolean;
  tiers: { fromGB: number; toGB: number | null; perGB: number }[] | null;
}

export interface Services {
  blockStorageGBMonth: UnitPrice | null;
  objectStorageGBMonth: UnitPrice | null;
  loadBalancerMonthly: UnitPrice | null;
  kubernetesMonthly: UnitPrice | null;
  postgres2vCPU8GBMonthly: UnitPrice | null;
  egress: Egress | null;
}

export interface Provider {
  id: string;
  name: string;
  euOwned: boolean;
  region: string;
  location: string;
}

export interface PriceData {
  source: string;
  generated: string;
  fx: { usdPerEur: number; date: string };
  providers: Provider[];
  servers: Record<string, Server[]>;
  services: Record<string, Services>;
}

type RawRow = [string, number, number, number, Category, 'x86' | 'arm', number?];

interface RawData extends Omit<PriceData, 'servers'> {
  servers: Record<string, RawRow[]>;
}

export function loadPrices(data: RawData = raw as unknown as RawData): PriceData {
  const servers: Record<string, Server[]> = {};
  for (const [p, rows] of Object.entries(data.servers)) {
    servers[p] = rows.map((r) => ({
      name: r[0],
      vcpu: r[1],
      memoryGiB: r[2],
      monthly: r[3],
      category: r[4],
      arch: r[5],
      ...(r[6] ? { estimated: true } : {}),
    }));
  }
  return { ...data, servers };
}

let cached: PriceData | undefined;
export function prices(): PriceData {
  return (cached ||= loadPrices());
}

/** Price of `gb` of internet egress per month, given the provider's allowance and how many servers come with one. */
export function egressCost(e: Egress | null, gb: number, servers: number): number | null {
  if (!e) return null;
  const free = e.perServer ? e.freeGB * servers : e.freeGB;
  const billable = Math.max(0, gb - free);
  let cost = 0;
  for (const t of e.tiers || []) {
    const hi = t.toGB ?? Infinity;
    if (billable > t.fromGB) cost += (Math.min(billable, hi) - t.fromGB) * t.perGB;
  }
  return cost;
}
