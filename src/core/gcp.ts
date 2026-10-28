// Google Cloud billing export: BigQuery standard usage cost export flattened to CSV ("service.description",
// "usage.amount", "cost", "credits"), and the console Reports / cost table CSV ("Service description", "Cost (€)").
import { type Aggregate, addCompute, addNotCompared, dbEntry, newAggregate, seeCurrency, seeDates } from './aggregate';
import { columns } from './columns';
import { GB_PER_GIB, HOURS_PER_MONTH, NO_EQUIVALENT, num, parseDate, reasonFor } from './util';

const GIB = 2 ** 30;

/** Usage converted to a target unit; NaN when the unit does not fit. */
export function gcpConvert(amount: number, unit: string, to: 'hour' | 'gibHour' | 'gibMonth' | 'gib'): number {
  const u = unit.trim().toLowerCase();
  switch (to) {
    case 'hour':
      if (u === 'seconds' || u === 's') return amount / 3600;
      if (u === 'hour' || u === 'hours' || u === 'h') return amount;
      break;
    case 'gibHour':
      if (u === 'byte-seconds') return amount / GIB / 3600;
      if (u === 'gibibyte hour' || u === 'gibibyte-hour' || u === 'gib-hour') return amount;
      break;
    case 'gibMonth':
      if (u === 'byte-seconds') return amount / GIB / 3600 / HOURS_PER_MONTH;
      if (u === 'gibibyte month' || u === 'gibibyte-month' || u === 'gib-month') return amount;
      if (u === 'gibibyte hour') return amount / HOURS_PER_MONTH;
      break;
    case 'gib':
      if (u === 'bytes' || u === 'byte') return amount / GIB;
      if (u === 'gibibyte' || u === 'gib') return amount;
      if (u === 'tebibyte') return amount * 1024;
      break;
  }
  return NaN;
}

interface Credit {
  amount?: number | string;
  type?: string;
  name?: string;
}

/** Credits that lower the price of this line (committed/sustained use, contract discounts) vs. free money (promotions, free tier). */
const PRICE_CREDIT = /COMMITTED_US|SUSTAINED_US|^DISCOUNT$|SUBSCRIPTION_BENEFIT|RESELLER_MARGIN|FEE_UTILIZATION_OFFSET/i;

/** "n2-standard-4" from system labels in any of the shapes a flattened export produces. */
function machineSpec(s: string): string {
  if (!s) return '';
  const m = /machine_spec"?\s*[,:=]\s*(?:"value"\s*:\s*)?"?([a-z0-9]+-[a-z0-9-]+)/i.exec(s);
  return m ? m[1].toLowerCase() : '';
}

export function createGcpClassifier(headers: string[], format: 'gcp-bigquery' | 'gcp-console', a: Aggregate = newAggregate('gcp', format)) {
  const c = columns(headers);
  const g = c.get;
  const costHeader = headers.find((h) => /^\s*(unrounded\s+)?cost\s*\(/i.test(h)) || '';
  if (/€|EUR/i.test(costHeader)) a.headerCurrency = 'EUR';
  else if (/\$|USD/i.test(costHeader)) a.headerCurrency = 'USD';
  else if (/£|GBP/i.test(costHeader)) a.headerCurrency = 'GBP';
  const costKeys = ['cost', 'Unrounded cost', 'Cost'];
  // console CSV: "Cost (€)" normalises to "cost" too; prefer unrounded when present
  if (c.has('unroundedcost')) costKeys.unshift('unroundedcost');
  const pricingUnits = c.has('usage.amount_in_pricing_units');

  return {
    aggregate: a,
    row(r: string[]): void {
      a.rows++;
      const service = g(r, 'service.description', 'Service description', 'service');
      const sku = g(r, 'sku.description', 'SKU description', 'sku');
      let amount = num(g(r, 'usage.amount', 'Usage amount'));
      let unit = g(r, 'usage.unit', 'Usage unit');
      if (pricingUnits && g(r, 'usage.pricing_unit')) {
        amount = num(g(r, 'usage.amount_in_pricing_units'));
        unit = g(r, 'usage.pricing_unit');
      }
      const listCost = num(g(r, ...costKeys));
      const costType = g(r, 'cost_type', 'Cost type').toLowerCase();
      const creditType = g(r, 'Credit type');
      let end = parseDate(g(r, 'usage_end_time', 'Usage end date'));
      // the console's "Usage end date" is a calendar day and inclusive
      if (format === 'gcp-console' && end != null && end % 86400000 === 0) end += 86400000;
      seeDates(a, parseDate(g(r, 'usage_start_time', 'Usage start date')), end);

      if (costType === 'tax') {
        a.excluded.tax += listCost;
        a.usedRows++;
        return;
      }
      if (costType === 'adjustment' || costType === 'rounding_error') {
        a.excluded.refund += listCost;
        a.usedRows++;
        return;
      }
      if (creditType) {
        // console CSV with credits as their own rows
        if (PRICE_CREDIT.test(creditType.replace(/\s+/g, '_'))) a.excluded.discount += listCost;
        else a.excluded.credit += listCost;
        a.usedRows++;
        return;
      }

      // Credits on the line: discounts lower this line's cost, promotions and free tier are shown separately.
      let cost = listCost;
      const credits = g(r, 'credits');
      if (credits && credits[0] === '[') {
        try {
          for (const cr of JSON.parse(credits) as Credit[]) {
            const v = num(String(cr.amount ?? 0));
            if (PRICE_CREDIT.test(cr.type || '')) {
              cost += v;
              if (/COMMITTED/i.test(cr.type || '')) a.flags.reserved = true;
            } else a.excluded.credit += v;
          }
        } catch {
          /* ignore malformed credits */
        }
      }
      const discounts = num(g(r, 'Discounts'));
      const promos = num(g(r, 'Promotions and others', 'Promotions'));
      cost += discounts;
      a.excluded.credit += promos;

      seeCurrency(a, g(r, 'currency', 'Currency'), cost);
      if (cost === 0 && amount === 0) return;
      a.usedRows++;

      if (/^(cloud )?support$/i.test(service) || /^Support/i.test(sku)) {
        a.excluded.support += cost;
        return;
      }

      // --- compute
      if (service === 'Compute Engine') {
        if (/^Commitment/i.test(sku)) {
          a.flags.reserved = true;
          addNotCompared(a, 'Compute Engine commitments', cost, 'committed use fees (the covered usage is billed net of them)');
          return;
        }
        const core = /^(?:(Spot Preemptible|Preemptible|Spot)\s+)?(.+?)\s+(Instance\s+)?(Core|Ram)\b.*running in/i.exec(sku);
        if (core && !/GPU|Licen[cs]|Sole Tenancy|Local SSD/i.test(sku)) {
          const spot = !!core[1];
          if (spot) a.flags.spot = true;
          const isCore = /core/i.test(core[4]);
          const spec = (g(r, 'machine_spec', 'machine_type').trim().toLowerCase() || machineSpec(g(r, 'system_labels', 'System labels', 'labels'))).replace(/^.*\//, '');
          if (spec) {
            const h = isCore ? gcpConvert(amount, unit, 'hour') : 0;
            addCompute(a, spec, 0, cost, { spot, vcpuHours: Number.isNaN(h) ? 0 : h });
            return;
          }
          const family = core[2].replace(/\s+(Predefined|Custom)$/i, '').trim();
          const key = `${family}${spot ? ' (spot)' : ''}`;
          const e = (a.pooledCompute[key] ||= {
            family,
            arch: /T2A|C4A|Arm|Axion/i.test(family) ? 'arm' : 'x86',
            vcpuHours: 0,
            memGiBHours: 0,
            cost: 0,
            spot,
          });
          const q = gcpConvert(amount, unit, isCore ? 'hour' : 'gibHour');
          if (!Number.isNaN(q)) {
            if (isCore) e.vcpuHours += q;
            else e.memGiBHours += q;
          }
          e.cost += cost;
          return;
        }
        if (/PD Capacity|Hyperdisk .*Capacity|PD Capacity/i.test(sku) && !/snapshot/i.test(sku)) {
          const q = gcpConvert(amount, unit, 'gibMonth');
          if (!Number.isNaN(q)) a.block.gbMonth += q * GB_PER_GIB;
          a.block.cost += cost;
          return;
        }
        if (/Hyperdisk .*(IOPS|Throughput)/i.test(sku)) {
          a.block.cost += cost;
          return;
        }
        if (/Licen[cs]/i.test(sku)) a.flags.licensedOs = true;
      }

      // --- internet egress, from any service
      if (/\binternet\b.*(egress|data transfer out)/i.test(sku) || /^Download (Worldwide|APAC|China|Australia)/i.test(sku)) {
        const q = gcpConvert(amount, unit, 'gib');
        a.egress.gb += Number.isNaN(q) ? 0 : q * GB_PER_GIB;
        a.egress.cost += cost;
        return;
      }

      // --- load balancing
      if (/Forwarding Rule Minimum/i.test(sku)) {
        const q = gcpConvert(amount, unit, 'hour');
        if (!Number.isNaN(q)) a.loadBalancer.hours += q;
        a.loadBalancer.cost += cost;
        return;
      }
      if (/load balanc|forwarding rule/i.test(sku)) {
        a.loadBalancer.cost += cost;
        return;
      }

      // --- object storage: Standard class only
      if (service === 'Cloud Storage' && /^(Standard|Regional|Multi-Regional) Storage/i.test(sku)) {
        const q = gcpConvert(amount, unit, 'gibMonth');
        if (!Number.isNaN(q)) a.object.gbMonth += q * GB_PER_GIB;
        a.object.cost += cost;
        return;
      }

      // --- GKE cluster management fee
      if (service === 'Kubernetes Engine' && /Kubernetes Clusters?\b/i.test(sku) && !/Autopilot.*(Pod|mCPU|Memory)/i.test(sku)) {
        const q = gcpConvert(amount, unit, 'hour');
        if (!Number.isNaN(q)) a.kubernetes.hours += q;
        a.kubernetes.cost += cost;
        return;
      }

      // --- Cloud SQL
      if (service === 'Cloud SQL') {
        const m = /Cloud SQL for (PostgreSQL|MySQL|SQL Server)/i.exec(sku);
        const engine = m ? (/postgres/i.test(m[1]) ? 'postgresql' : /mysql/i.test(m[1]) ? 'mysql' : '') : /^DB /i.test(sku) ? 'mysql' : '';
        if (!engine) {
          addNotCompared(a, service, cost, 'licensed database engine (SQL Server)');
          return;
        }
        const ha = /Regional|\bHA\b/i.test(sku);
        if (/backup/i.test(sku)) {
          addNotCompared(a, service, cost, 'backups');
          return;
        }
        if (/vCPU|CORE/i.test(sku)) {
          const q = gcpConvert(amount, unit, 'hour');
          const e = dbEntry(a, engine, undefined, ha);
          if (!Number.isNaN(q)) e.vcpuHours += q;
          e.cost += cost;
          return;
        }
        if (/RAM|Memory/i.test(sku)) {
          const q = gcpConvert(amount, unit, 'gibHour');
          const e = dbEntry(a, engine, undefined, ha);
          if (!Number.isNaN(q)) e.memGiBHours += q;
          e.cost += cost;
          return;
        }
        if (/storage/i.test(sku)) {
          const q = gcpConvert(amount, unit, 'gibMonth');
          const e = dbEntry(a, engine, undefined, ha);
          if (!Number.isNaN(q)) e.storageGBMonth += q * GB_PER_GIB;
          e.cost += cost;
          return;
        }
        addNotCompared(a, service, cost, 'other Cloud SQL charges');
        return;
      }

      addNotCompared(a, service || 'Other', cost, reasonFor(sku) ?? NO_EQUIVALENT);
    },
  };
}
