// Azure cost details export (Cost Management -> Exports, or "Download usage details").
// EA, MCA and pay-as-you-go use different column names; they are matched case- and punctuation-insensitively.
import { type Aggregate, addCompute, addNotCompared, dbCostOnly, dbEntry, newAggregate, seeCurrency, seeDates } from './aggregate';
import { columns } from './columns';
import { GB_PER_GIB, HOURS_PER_MONTH, NO_EQUIVALENT, num, parseDate, reasonFor } from './util';

/** Managed disk tiers (P10, E10, S10, ...) -> provisioned GiB. */
const DISK_TIER_GIB: Record<string, number> = {
  '1': 4, '2': 8, '3': 16, '4': 32, '6': 64, '10': 128, '15': 256, '20': 512, '30': 1024,
  '40': 2048, '50': 4096, '60': 8192, '70': 16384, '80': 32767,
};

/** "100 Hours" -> 100, "1 GB/Month" -> 1, "10K" -> 10000. */
export function unitMultiplier(u: string): number {
  const m = /^\s*([\d.,]+)\s*([KkMm])?\b/.exec(u || '');
  if (!m) return 1;
  let v = Number(m[1].replace(/,/g, ''));
  if (!v) return 1;
  if (m[2] === 'K' || m[2] === 'k') v *= 1000;
  if (m[2] === 'M' || m[2] === 'm') v *= 1e6;
  return v;
}

/** "D4s v5" -> "Standard_D4s_v5"; "D2 v3/D2s v3" -> "Standard_D2_v3". */
export function vmSizeFromMeter(meterName: string): string {
  const base = meterName.split('/')[0].replace(/\b(Spot|Low Priority)\b/gi, '').trim();
  if (!/^[A-Z]+\d/i.test(base)) return '';
  return 'Standard_' + base.replace(/\s+/g, '_');
}

function parseInfo(s: string): Record<string, string> {
  if (!s || s[0] !== '{') return {};
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) out[k.toLowerCase()] = String(v);
    return out;
  } catch {
    return {};
  }
}

export function createAzureClassifier(headers: string[], a: Aggregate = newAggregate('azure', 'azure')) {
  const { get: g } = columns(headers);

  return {
    aggregate: a,
    row(r: string[]): void {
      a.rows++;
      const category = g(r, 'MeterCategory', 'ServiceName');
      const sub = g(r, 'MeterSubCategory');
      const meter = g(r, 'MeterName');
      const unit = g(r, 'UnitOfMeasure');
      const qty = num(g(r, 'Quantity', 'UsageQuantity', 'ConsumedQuantity')) * unitMultiplier(unit);
      const cost = num(g(r, 'CostInBillingCurrency', 'PreTaxCost', 'Cost', 'CostInBillingCurrencyAmount'));
      const chargeType = g(r, 'ChargeType').toLowerCase();
      const pricing = g(r, 'PricingModel').toLowerCase();
      const publisher = g(r, 'PublisherType').toLowerCase();
      const date = parseDate(g(r, 'Date', 'UsageDateTime', 'UsageDate'));
      seeDates(a, date, date != null ? date + 86400000 : undefined);

      if (chargeType === 'purchase') {
        a.excluded.commitment += cost;
        a.usedRows++;
        return;
      }
      if (chargeType === 'refund') {
        a.excluded.refund += cost;
        a.usedRows++;
        return;
      }
      if (chargeType === 'tax') {
        a.excluded.tax += cost;
        a.usedRows++;
        return;
      }
      seeCurrency(a, g(r, 'BillingCurrency', 'BillingCurrencyCode', 'Currency'), cost);
      if (cost === 0 && qty === 0) return;
      a.usedRows++;
      if (pricing === 'reservation' || pricing === 'savingsplan') {
        if (pricing === 'reservation') a.flags.reserved = true;
        else a.flags.savingsPlan = true;
        if (cost === 0 && qty > 0) a.flags.zeroCostReserved = true;
      }
      if (chargeType.startsWith('unused')) {
        addNotCompared(a, 'Unused reservations and savings plans', cost, 'commitment not used');
        return;
      }
      if (publisher === 'marketplace') {
        addNotCompared(a, `Marketplace: ${category || meter}`, cost, 'third-party software');
        return;
      }
      if (/^support/i.test(category)) {
        a.excluded.support += cost;
        return;
      }
      const committed = pricing === 'reservation' || pricing === 'savingsplan';

      // --- compute
      if (category === 'Virtual Machines') {
        const info = parseInfo(g(r, 'AdditionalInfo'));
        if (/windows/i.test(sub) || /windows/i.test(meter) || /_SW$/i.test(info.usagetype || '')) {
          a.flags.licensedOs = true;
          addNotCompared(a, 'Virtual machines with a licensed OS', cost, 'Windows licence included in the price');
          return;
        }
        if (/hour/i.test(unit)) {
          const size = info.servicetype || info.vmsize || vmSizeFromMeter(meter);
          if (!size) {
            addNotCompared(a, 'Virtual Machines', cost, 'VM size missing');
            return;
          }
          const spot = /spot|low priority/i.test(meter) || pricing === 'spot';
          if (spot) a.flags.spot = true;
          addCompute(a, size, qty, cost, { spot, committed });
          return;
        }
        addNotCompared(a, 'Virtual Machines', cost, 'not billed per hour');
        return;
      }
      if (category === 'Virtual Machines Licenses') {
        a.flags.licensedOs = true;
        addNotCompared(a, category, cost, 'OS licences');
        return;
      }

      // --- storage: managed disks and blobs
      if (category === 'Storage') {
        if (/snapshot/i.test(sub + ' ' + meter)) {
          addNotCompared(a, 'Storage: snapshots', cost, 'snapshots');
          return;
        }
        const tier = /^([PES])(\d+)\s.*Disk$/i.exec(meter);
        if (tier && /month/i.test(unit)) {
          a.block.gbMonth += qty * (DISK_TIER_GIB[tier[2]] ?? 0) * GB_PER_GIB;
          a.block.cost += cost;
          return;
        }
        if (/Premium SSD v2|Ultra/i.test(sub) && /Provisioned Capacity/i.test(meter)) {
          a.block.gbMonth += (/hour/i.test(unit) ? qty / HOURS_PER_MONTH : qty) * GB_PER_GIB;
          a.block.cost += cost;
          return;
        }
        if (/Managed Disks|Premium SSD v2|Ultra/i.test(sub)) {
          a.block.cost += cost; // disk operations, IOPS, throughput, bursting
          return;
        }
        if (/Hot (LRS|ZRS) Data Stored/i.test(meter) && /blob/i.test(sub)) {
          a.object.gbMonth += qty;
          a.object.cost += cost;
          return;
        }
        addNotCompared(a, `Storage: ${sub || meter}`, cost, /Data Stored/i.test(meter) ? 'cool, archive or geo-redundant tier' : (reasonFor(meter) ?? 'other storage charges'));
        return;
      }

      // --- internet egress
      if (category === 'Bandwidth') {
        if (/data transfer out/i.test(meter) && !/inter|intra|region|continent|zone|peering|vnet/i.test(sub + ' ' + meter)) {
          a.egress.gb += qty;
          a.egress.cost += cost;
          return;
        }
        addNotCompared(a, 'Bandwidth: between regions and zones', cost, 'not internet traffic');
        return;
      }

      // --- load balancers
      if (category === 'Load Balancer' || category === 'Application Gateway') {
        if (/hour/i.test(unit) && /Included LB Rules|Fixed Cost|Gateway$|Basic|Standard$/i.test(meter)) {
          a.loadBalancer.hours += qty;
        }
        a.loadBalancer.cost += cost;
        return;
      }

      // --- AKS control plane (the free tier has no meter)
      if (category === 'Azure Kubernetes Service') {
        if (/Uptime SLA|^Standard$/i.test(meter) && /hour/i.test(unit)) {
          a.kubernetes.hours += qty;
          a.kubernetes.cost += cost;
          return;
        }
        addNotCompared(a, category, cost, 'long-term support or other AKS charges');
        return;
      }

      // --- managed PostgreSQL / MySQL
      const dbm = /^Azure Database for (PostgreSQL|MySQL|MariaDB)/i.exec(category);
      if (dbm) {
        const engine = /postgres/i.test(dbm[1]) ? 'postgresql' : 'mysql';
        if (/backup/i.test(sub + ' ' + meter)) {
          addNotCompared(a, category, cost, 'backups');
          return;
        }
        if (/storage|data stored/i.test(sub + ' ' + meter) && /GB|GiB/i.test(unit)) {
          dbCostOnly(a, engine, cost, /month/i.test(unit) ? qty : 0);
          return;
        }
        if (/vCore/i.test(meter) && /hour/i.test(unit)) {
          const ratio = /memory optimi[sz]ed/i.test(sub) ? 8 : /general purpose/i.test(sub) ? 4 : 0;
          const e = dbEntry(a, engine, undefined, false);
          e.vcpuHours += qty;
          e.memGiBHours += qty * ratio;
          e.cost += cost;
          return;
        }
        if (/hour/i.test(unit) && vmSizeFromMeter(meter)) {
          const e = dbEntry(a, engine, vmSizeFromMeter(meter), false);
          e.instanceHours += qty;
          e.cost += cost;
          return;
        }
        dbCostOnly(a, engine, cost);
        return;
      }

      addNotCompared(a, category || meter || 'Other', cost, reasonFor(`${sub} ${meter}`) ?? NO_EQUIVALENT);
    },
  };
}
