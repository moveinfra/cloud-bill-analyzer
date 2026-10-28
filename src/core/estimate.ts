// Turns an Aggregate (what the bill contains) into a monthly comparison with each EU-owned provider.
import type { Aggregate, ExcludedKind } from './aggregate';
import { FORMAT_LABELS } from './analyze';
import { type PriceData, type Server, egressCost, prices as defaultPrices } from './prices';
import { HOURS_PER_MONTH, isoDay } from './util';

export type CategoryId = 'compute' | 'database' | 'block' | 'object' | 'egress' | 'loadBalancer' | 'kubernetes';

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  compute: 'Servers',
  database: 'Managed databases',
  block: 'Block storage',
  object: 'Object storage',
  egress: 'Internet egress',
  loadBalancer: 'Load balancers',
  kubernetes: 'Kubernetes control plane',
};

export const EXCLUDED_LABELS: Record<ExcludedKind, string> = {
  credit: 'Credits and promotions',
  refund: 'Refunds and adjustments',
  tax: 'Tax',
  support: 'Support plans',
  discount: 'Contract discounts',
  commitment: 'Reservation and savings plan purchases',
};

/** An estimate for one provider. low === high unless the estimate is rough. */
export interface Cell {
  low: number;
  high: number;
  detail?: string;
}

export interface Item {
  label: string;
  /** Monthly quantity in this item's unit. */
  quantity: number;
  unit: string;
  current: number;
  rough: boolean;
  estimates: Record<string, Cell>;
}

export interface CategoryRow {
  id: CategoryId;
  label: string;
  current: number;
  quantity?: number;
  unit?: string;
  rough: boolean;
  items: Item[];
  estimates: Record<string, Cell>;
}

export interface ProviderTotal {
  id: string;
  name: string;
  low: number;
  high: number;
  /** Savings on the compared part, as a fraction (0.4 = 40% cheaper). */
  savingsLow: number;
  savingsHigh: number;
}

export interface Result {
  tool: { name: string; version: string; url: string };
  format: { id: string; label: string };
  cloud: string;
  rows: number;
  currency: { bill: string; rate: number; converted: boolean; warning?: string };
  period: { start?: string; end?: string; hours: number; days: number; factor: number; scaled: boolean; assumed: boolean };
  current: { total: number; compared: number; notCompared: number };
  comparedShare: number;
  categories: CategoryRow[];
  providers: ProviderTotal[];
  notCompared: { service: string; cost: number; reason: string }[];
  excluded: { kind: ExcludedKind; label: string; cost: number }[];
  assumptions: string[];
  prices: { generated: string; source: string; fx: { usdPerEur: number; date: string } };
}

export interface EstimateOptions {
  /** Units of the bill currency per euro, for bills not in EUR or USD. */
  rate?: number;
  /** Restrict the comparison to these provider ids. */
  providers?: string[];
  prices?: PriceData;
}

export const VERSION = '0.1.0';

const SERVER_CATEGORIES = new Set(['general', 'compute', 'memory']);

interface Match {
  server: Server;
  count: number;
}

/**
 * Cheapest server with at least vcpu and memory. When none is large enough, the requirement is split over 2..8 equal
 * servers. Shared-core servers are only allowed when the source was shared-core or burstable too.
 */
export function matchServer(pool: Server[], vcpu: number, mem: number, arch: 'x86' | 'arm', allowShared = false): Match | null {
  for (let k = 1; k <= 8; k++) {
    let best: Server | null = null;
    for (const s of pool) {
      if (!(SERVER_CATEGORIES.has(s.category) || (allowShared && s.category === 'shared'))) continue;
      if (s.arch !== 'x86' && !(arch === 'arm' && s.arch === 'arm')) continue;
      if (s.vcpu < vcpu / k || s.memoryGiB < mem / k) continue;
      if (!best || s.monthly < best.monthly) best = s;
    }
    if (best) return { server: best, count: k };
  }
  return null;
}

function specIndex(servers: Server[]): Map<string, Server> {
  const m = new Map<string, Server>();
  for (const s of servers) m.set(s.name.toLowerCase(), s);
  return m;
}

function lookupSpec(idx: Map<string, Server>, name: string): Server | undefined {
  const n = name.toLowerCase().trim();
  return idx.get(n) ?? idx.get(n.replace(/^db\./, '')) ?? idx.get('standard_' + n) ?? idx.get(n.replace(/^standard_/, ''));
}

const fmtN = (n: number, d = 1) => (Math.round(n * 10 ** d) / 10 ** d).toLocaleString('en-US');

function dominantCurrency(a: Aggregate): string {
  let best = '';
  let v = -1;
  for (const [c, n] of Object.entries(a.currencies)) {
    if (n > v) {
      best = c;
      v = n;
    }
  }
  return best || a.headerCurrency || '';
}

export function estimate(a: Aggregate, opts: EstimateOptions = {}): Result {
  const P = opts.prices ?? defaultPrices();
  const assumptions: string[] = [];
  const eu = P.providers.filter((p) => p.euOwned && (!opts.providers?.length || opts.providers.includes(p.id)));
  if (!eu.length) throw new Error(`Unknown provider. Choose from: ${P.providers.filter((p) => p.euOwned).map((p) => p.id).join(', ')}`);

  // --- currency
  const bill = dominantCurrency(a);
  let rate = 1;
  let converted = false;
  let warning: string | undefined;
  if (bill === 'USD') {
    rate = P.fx.usdPerEur;
    converted = true;
    assumptions.push(`USD converted to EUR at ${P.fx.usdPerEur} USD per EUR (ECB, ${P.fx.date}).`);
  } else if (bill === 'EUR') {
    // as is
  } else if (opts.rate && opts.rate > 0) {
    rate = opts.rate;
    converted = true;
    assumptions.push(`${bill || 'Bill currency'} converted to EUR at ${opts.rate} per EUR (rate you entered).`);
  } else {
    warning = bill
      ? `The bill is in ${bill}. Amounts are shown as if they were euros; enter an exchange rate (${bill} per EUR) to convert.`
      : 'The bill has no currency column. Amounts are shown as if they were euros.';
  }
  if (Object.keys(a.currencies).length > 1) {
    const list = Object.keys(a.currencies).join(', ');
    warning = (warning ? warning + ' ' : '') + `The file mixes currencies (${list}); all amounts were treated as ${bill}.`;
  }

  // --- period
  let start = a.start;
  let end = a.end;
  if (start != null && end == null && a.maxStart != null) end = a.maxStart + (a.allMidnight ? 86400000 : 3600000);
  let hours = start != null && end != null ? (end - start) / 3600000 : 0;
  const assumed = !(hours > 0);
  if (assumed) {
    hours = HOURS_PER_MONTH;
    start = end = undefined;
    assumptions.push('The file has no usage dates, so it is assumed to cover one month.');
  }
  const factor = HOURS_PER_MONTH / hours;
  const days = hours / 24;
  const scaled = Math.abs(factor - 1) > 0.03;
  if (!assumed) {
    const span = `${isoDay(start!)} to ${isoDay(end! - 1)}`;
    assumptions.push(
      scaled
        ? `The bill covers ${fmtN(days)} days (${span}). Every amount is scaled to a 730-hour month (×${fmtN(factor, 2)}).`
        : `The bill covers ${fmtN(days)} days (${span}), shown as a 730-hour month.`,
    );
  }
  const money = (x: number) => (x / rate) * factor;

  const src = specIndex(P.servers[a.cloud] || []);
  const pools = Object.fromEntries(eu.map((p) => [p.id, P.servers[p.id] || []]));
  const svc = (id: string) => P.services[id];
  const notCompared = new Map<string, { cost: number; reasons: Map<string, number> }>();
  const addNC = (service: string, cost: number, reason: string) => {
    if (Math.abs(cost) < 1e-9) return;
    const e = notCompared.get(service) || { cost: 0, reasons: new Map() };
    e.cost += cost;
    e.reasons.set(reason, (e.reasons.get(reason) || 0) + cost);
    notCompared.set(service, e);
  };
  for (const [service, v] of Object.entries(a.notCompared)) {
    for (const [reason, c] of Object.entries(v.reasons)) addNC(service, money(c), reason);
  }

  const servers: Record<string, number> = Object.fromEntries(eu.map((p) => [p.id, 0]));
  const categories: CategoryRow[] = [];
  const cell = (low: number, high = low, detail?: string): Cell => ({ low, high, ...(detail ? { detail } : {}) });

  // --- compute
  {
    const items: Item[] = [];
    let spotNote = false;
    const sorted = Object.values(a.compute).sort((x, y) => y.cost - x.cost);
    for (const e of sorted) {
      const spec = lookupSpec(src, e.type);
      const cost = money(e.cost);
      if (!spec || !(spec.memoryGiB > 0)) {
        addNC(`Servers: ${e.type}`, cost, 'instance type not in the price index');
        continue;
      }
      const instHours = e.hours > 0 ? e.hours : e.vcpuHours / spec.vcpu;
      const avg = instHours / hours;
      if (!(avg > 0)) {
        addNC(`Servers: ${e.type}`, cost, 'no running hours in the bill');
        continue;
      }
      if (e.spotHours > 0) spotNote = true;
      const allowShared = spec.category === 'shared' || spec.category === 'burstable';
      const est: Record<string, Cell> = {};
      const counts: Record<string, number> = {};
      let missing = false;
      for (const p of eu) {
        const m = matchServer(pools[p.id], spec.vcpu, spec.memoryGiB, spec.arch, allowShared);
        if (!m) {
          missing = true;
          break;
        }
        counts[p.id] = avg * m.count;
        est[p.id] = cell(counts[p.id] * m.server.monthly, undefined, `${m.count > 1 ? `${m.count} × ` : ''}${m.server.name}`);
      }
      if (missing) {
        addNC(`Servers: ${e.type}`, cost, 'no EU server of this size');
        continue;
      }
      for (const p of eu) servers[p.id] += counts[p.id];
      items.push({
        label: `${e.type} (${spec.vcpu} vCPU, ${fmtN(spec.memoryGiB)} GiB)${e.spotHours > 0 ? ', spot' : ''}`,
        quantity: avg,
        unit: 'servers',
        current: cost,
        rough: false,
        estimates: est,
      });
    }
    // Google Cloud: vCPU and memory per machine family
    for (const e of Object.values(a.pooledCompute).sort((x, y) => y.cost - x.cost)) {
      const cost = money(e.cost);
      const V = e.vcpuHours / hours;
      let M = e.memGiBHours / hours;
      if (!(V > 0)) {
        addNC(`Compute Engine: ${e.family}`, cost, 'no vCPU hours in the bill');
        continue;
      }
      if (!(M > 0)) {
        M = V * 4;
        assumptions.push(`${e.family}: no memory lines found, assumed 4 GiB per vCPU.`);
      }
      if (e.spot) spotNote = true;
      const est: Record<string, Cell> = {};
      let missing = false;
      for (const p of eu) {
        let low = Infinity;
        let high = Infinity;
        let lowName = '';
        let n = 0;
        for (const s of pools[p.id]) {
          if (!SERVER_CATEGORIES.has(s.category)) continue;
          if (s.arch !== 'x86' && !(e.arch === 'arm' && s.arch === 'arm')) continue;
          const need = Math.max(V / s.vcpu, M / s.memoryGiB);
          if (need * s.monthly < low) {
            low = need * s.monthly;
            lowName = s.name;
            n = need;
          }
          high = Math.min(high, Math.ceil(need - 1e-9) * s.monthly);
        }
        if (!Number.isFinite(low)) {
          missing = true;
          break;
        }
        servers[p.id] += Math.max(1, n);
        est[p.id] = cell(low, Math.max(low, high), `≈ ${fmtN(n)} × ${lowName}`);
      }
      if (missing) {
        addNC(`Compute Engine: ${e.family}`, cost, 'no EU server family to compare');
        continue;
      }
      items.push({
        label: `${e.family} VMs, ${fmtN(V)} vCPU and ${fmtN(M)} GiB on average${e.spot ? ', spot' : ''}`,
        quantity: V,
        unit: 'vCPU',
        current: cost,
        rough: true,
        estimates: est,
      });
    }
    if (items.length) {
      categories.push(sumCategory('compute', items, eu.map((p) => p.id)));
      assumptions.push(
        'Servers: each instance type is matched to the cheapest EU server with at least the same vCPU and memory (general-purpose, compute- or memory-optimised, x86 unless the source was Arm). The count is the average number running over the period.',
      );
      if (Object.keys(a.pooledCompute).length)
        assumptions.push(
          'Google Cloud bills vCPU and memory per machine family, not per VM. Those are priced as a pool: the low end assumes the capacity divides evenly over EU servers, the high end rounds up to whole servers.',
        );
      if (spotNote) assumptions.push('Spot or preemptible capacity is counted at the price you paid; the EU estimate uses on-demand servers.');
    }
  }

  // --- managed databases
  {
    const items: Item[] = [];
    let mysql = false;
    let selfManaged = false;
    for (const e of Object.values(a.database).sort((x, y) => y.cost - x.cost)) {
      const cost = money(e.cost);
      const engineLabel = e.engine === 'postgresql' ? 'PostgreSQL' : e.engine === 'aurora' ? 'Aurora' : 'MySQL';
      let V = 0;
      let M = 0;
      let count = 0;
      let label = '';
      if (e.instanceClass) {
        const spec = lookupSpec(src, e.instanceClass);
        if (!spec) {
          addNC(`Database: ${e.instanceClass}`, cost, 'instance class not in the price index');
          continue;
        }
        V = spec.vcpu;
        M = spec.memoryGiB;
        count = (e.instanceHours / hours) * (e.ha ? 2 : 1);
        label = `${engineLabel} ${e.instanceClass}${e.ha ? ', with standby' : ''}`;
      } else if (e.vcpuHours > 0) {
        V = Math.ceil((e.vcpuHours / hours) * 10) / 10;
        M = e.memGiBHours / hours;
        count = e.ha ? 2 : 1;
        label = `${engineLabel}, ${fmtN(V)} vCPU${M > 0 ? `, ${fmtN(M)} GiB` : ''}${e.ha ? ', with standby' : ''}`;
      }
      const storage = e.storageGBMonth * factor;
      if (!(count > 0) && !(storage > 0)) {
        addNC(`Database: ${engineLabel}`, cost, 'I/O, backups or charges without a size');
        continue;
      }
      if (!(count > 0)) label = `${engineLabel} storage`;
      if (e.engine !== 'postgresql') mysql = true;
      const est: Record<string, Cell> = {};
      let missing = false;
      for (const p of eu) {
        const s = svc(p.id);
        const store = storage * (s.blockStorageGBMonth?.price ?? 0);
        if (!(count > 0)) {
          est[p.id] = cell(store, store, 'block storage price');
          continue;
        }
        const pg = s.postgres2vCPU8GBMonthly;
        if (pg) {
          const low = pg.price * Math.max(V / 2, 0.5) * count;
          const high = M > 0 ? Math.max(low, pg.price * Math.max(M / 8, 0.5) * count) : low;
          est[p.id] = cell(low + store, high + store, `${pg.product}, scaled`);
        } else {
          const m = matchServer(pools[p.id], V, M > 0 ? M : V * 4, 'x86');
          if (!m) {
            missing = true;
            break;
          }
          selfManaged = true;
          servers[p.id] += count * m.count;
          const c = count * m.count * m.server.monthly + store;
          est[p.id] = cell(c, c, `self-managed on ${m.count > 1 ? `${m.count} × ` : ''}${m.server.name}`);
        }
      }
      if (missing) {
        addNC(`Database: ${engineLabel}`, cost, 'no EU option of this size');
        continue;
      }
      items.push({
        label,
        quantity: count > 0 ? count : storage,
        unit: count > 0 ? 'instances' : 'GB',
        current: cost,
        rough: true,
        estimates: est,
      });
    }
    if (items.length) {
      categories.push(sumCategory('database', items, eu.map((p) => p.id)));
      assumptions.push(
        "Managed databases are rough: each provider's managed PostgreSQL price for 2 vCPU and 8 GB is scaled by vCPU / 2 (low end) and memory / 8 GB (high end). Multi-AZ, zone-redundant and regional instances count twice. Database storage is priced at the provider's block storage rate.",
      );
      if (mysql) assumptions.push('MySQL, MariaDB and Aurora are compared with managed PostgreSQL prices, as the index has no MySQL prices.');
      if (selfManaged) assumptions.push('Where a provider has no managed PostgreSQL, the database runs on a server of the same size that you manage yourself.');
    }
  }

  // --- unit-priced categories
  const unitCategory = (
    id: CategoryId,
    qty: number,
    curCost: number,
    unit: string,
    price: (p: string) => Cell | null,
    missingReason: string,
  ) => {
    const cost = money(curCost);
    if (!(qty > 0)) {
      addNC(CATEGORY_LABELS[id], cost, missingReason);
      return;
    }
    const est: Record<string, Cell> = {};
    for (const p of eu) {
      const c = price(p.id);
      if (!c) {
        addNC(CATEGORY_LABELS[id], cost, 'not offered by every provider');
        return;
      }
      est[p.id] = c;
    }
    const item: Item = { label: CATEGORY_LABELS[id], quantity: qty, unit, current: cost, rough: false, estimates: est };
    categories.push({ ...sumCategory(id, [item], eu.map((p) => p.id)), quantity: qty, unit });
  };

  const blockGB = a.block.gbMonth * factor;
  unitCategory('block', blockGB, a.block.cost, 'GB', (p) => {
    const u = svc(p).blockStorageGBMonth;
    return u ? cell(blockGB * u.price, undefined, u.product) : null;
  }, 'charges without a capacity');

  const objGB = a.object.gbMonth * factor;
  unitCategory('object', objGB, a.object.cost, 'GB', (p) => {
    const u = svc(p).objectStorageGBMonth;
    return u ? cell(objGB * u.price, undefined, u.product) : null;
  }, 'charges without a capacity');

  const lbCount = a.loadBalancer.hours / hours;
  unitCategory('loadBalancer', lbCount, a.loadBalancer.cost, 'load balancers', (p) => {
    const u = svc(p).loadBalancerMonthly;
    return u ? cell(lbCount * u.price, undefined, u.product) : null;
  }, 'charges without load balancer hours');

  const clusters = a.kubernetes.hours / hours;
  let selfK8s = false;
  unitCategory('kubernetes', clusters, a.kubernetes.cost, 'clusters', (p) => {
    const u = svc(p).kubernetesMonthly;
    if (u) return cell(clusters * u.price, undefined, u.product);
    const m = matchServer(pools[p], 2, 4, 'x86', true);
    if (!m) return null;
    selfK8s = true;
    servers[p] += 3 * clusters;
    return cell(clusters * 3 * m.server.monthly, undefined, `no managed Kubernetes; 3 × ${m.server.name} control plane`);
  }, 'charges without cluster hours');
  if (selfK8s)
    assumptions.push('Where a provider has no managed Kubernetes, the control plane is priced as three small servers you run yourself (for example with k3s or Talos).');

  // egress last: per-server allowances depend on the servers above
  const egGB = a.egress.gb * factor;
  unitCategory('egress', egGB, a.egress.cost, 'GB', (p) => {
    const e = svc(p).egress;
    const n = Math.max(1, Math.round(servers[p]));
    const c = egressCost(e, egGB, n);
    if (c == null) return null;
    const allowance = e!.perServer ? e!.freeGB * n : e!.freeGB;
    return cell(c, undefined, !e!.tiers ? 'included with servers' : allowance > 0 ? `${fmtN(allowance, 0)} GB included` : undefined);
  }, 'charges without a volume');
  if (egGB > 0)
    assumptions.push(
      "Internet egress uses each provider's free allowance (per server where the provider includes traffic with every server) and its price tiers. Traffic between regions and zones and CDN traffic are not compared.",
    );

  // --- order, totals
  const order: CategoryId[] = ['compute', 'database', 'block', 'object', 'egress', 'loadBalancer', 'kubernetes'];
  categories.sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));
  const compared = categories.reduce((s, c) => s + c.current, 0);
  const nc = [...notCompared.entries()]
    .flatMap(([service, v]) => [...v.reasons.entries()].map(([reason, cost]) => ({ service, cost, reason })))
    .filter((x) => Math.abs(x.cost) >= 0.005)
    .sort((x, y) => y.cost - x.cost);
  const ncTotal = nc.reduce((s, x) => s + x.cost, 0);
  const total = compared + ncTotal;

  const providers: ProviderTotal[] = eu.map((p) => {
    const low = categories.reduce((s, c) => s + (c.estimates[p.id]?.low ?? 0), 0);
    const high = categories.reduce((s, c) => s + (c.estimates[p.id]?.high ?? 0), 0);
    return {
      id: p.id,
      name: p.name,
      low,
      high,
      savingsLow: compared > 0 ? 1 - high / compared : 0,
      savingsHigh: compared > 0 ? 1 - low / compared : 0,
    };
  });

  const excluded = (Object.keys(a.excluded) as ExcludedKind[])
    .map((kind) => ({ kind, label: EXCLUDED_LABELS[kind], cost: money(a.excluded[kind]) }))
    .filter((x) => Math.abs(x.cost) >= 0.005);

  if (a.flags.reserved || a.flags.savingsPlan)
    assumptions.push(
      'Reserved instances, savings plans and committed use discounts: the current cost is the effective (amortised) cost you paid for each line. EU prices are on-demand list prices; several EU providers offer cheaper monthly or committed terms.',
    );
  if (a.flags.zeroCostReserved)
    assumptions.push(
      'Some reserved usage shows a cost of zero, which happens in the Azure "actual cost" export. Export the "amortized cost" dataset to see what that usage really costs.',
    );
  if (a.flags.commitmentFeesSkipped)
    assumptions.push('Reservation and savings plan fee lines are skipped, because the covered usage already carries the amortised cost.');
  if (a.flags.licensedOs) assumptions.push('Servers with a Windows or other licensed OS are not compared: EU list prices are for Linux.');
  if (excluded.length) assumptions.push('Credits, refunds, tax, support and contract discounts are listed separately and left out of the comparison.');
  assumptions.push(
    `EU prices are list prices in EUR excluding VAT from the EU Cloud Price Index of ${P.generated}. Your bill reflects whatever discounts you have. Real performance per vCPU differs between providers; benchmark before you decide.`,
  );

  return {
    tool: { name: 'cloud-bill-analyzer', version: VERSION, url: 'https://github.com/moveinfra/cloud-bill-analyzer' },
    format: { id: a.format, label: FORMAT_LABELS[a.format] },
    cloud: a.cloud,
    rows: a.rows,
    currency: { bill: bill || 'unknown', rate, converted, ...(warning ? { warning } : {}) },
    period: {
      ...(start != null ? { start: isoDay(start) } : {}),
      ...(end != null ? { end: isoDay(end - 1) } : {}),
      hours,
      days,
      factor,
      scaled,
      assumed,
    },
    current: { total, compared, notCompared: ncTotal },
    comparedShare: total > 0 ? Math.max(0, Math.min(1, compared / total)) : 0,
    categories,
    providers,
    notCompared: nc,
    excluded,
    assumptions,
    prices: { generated: P.generated, source: P.source, fx: { usdPerEur: P.fx.usdPerEur, date: P.fx.date } },
  };
}

function sumCategory(id: CategoryId, items: Item[], providerIds: string[]): CategoryRow {
  const estimates: Record<string, Cell> = {};
  for (const p of providerIds) {
    let low = 0;
    let high = 0;
    for (const it of items) {
      low += it.estimates[p]?.low ?? 0;
      high += it.estimates[p]?.high ?? 0;
    }
    const detail = items.length === 1 ? items[0].estimates[p]?.detail : undefined;
    estimates[p] = { low, high, ...(detail ? { detail } : {}) };
  }
  return {
    id,
    label: CATEGORY_LABELS[id],
    current: items.reduce((s, i) => s + i.current, 0),
    rough: items.some((i) => i.rough),
    items,
    estimates,
  };
}
