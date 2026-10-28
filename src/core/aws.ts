// AWS Cost and Usage Report: legacy CUR ("lineItem/UsageType") and CUR 2.0 / Data Exports ("line_item_usage_type").
// Both normalise to the same keys (see normKey), so one classifier handles both.
import {
  type Aggregate,
  addCompute,
  addNotCompared,
  dbCostOnly,
  dbEntry,
  newAggregate,
  seeCurrency,
  seeDates,
} from './aggregate';
import { columns } from './columns';
import { NO_EQUIVALENT, num, parseDate, reasonFor } from './util';

const SUPPORT = /^(AWSSupport|OCBPremiumSupport|AWSDeveloperSupport|AWSBusinessSupport|AWSEnterpriseSupport)/i;

/** RDS / Aurora engines we compare against managed PostgreSQL / MySQL. Oracle, SQL Server and Db2 carry licences. */
function dbEngine(raw: string, usageType: string): string | null {
  const e = (raw || '').toLowerCase();
  if (/sql ?server|oracle|db2/.test(e)) return null;
  if (/postgres/.test(e)) return 'postgresql';
  if (/mysql|maria/.test(e)) return 'mysql';
  if (/aurora/.test(e)) return 'mysql';
  if (!e && /Aurora/i.test(usageType)) return 'aurora';
  return null;
}

export function createAwsClassifier(headers: string[], format: 'aws-cur' | 'aws-cur2', a: Aggregate = newAggregate('aws', format)) {
  const c = columns(headers);
  const g = c.get;
  const hasProductJson = c.has('product') && !c.has('productproductname');

  return {
    aggregate: a,
    row(r: string[]): void {
      a.rows++;
      const type = g(r, 'lineItem/LineItemType');
      const product = g(r, 'lineItem/ProductCode');
      const usageType = g(r, 'lineItem/UsageType');
      const operation = g(r, 'lineItem/Operation');
      const amount = num(g(r, 'lineItem/UsageAmount'));
      const unblended = num(g(r, 'lineItem/UnblendedCost'));
      let productName = g(r, 'product/ProductName') || product || 'Other';
      let engineRaw = g(r, 'product/databaseEngine');
      let os = g(r, 'product/operatingSystem');
      if (hasProductJson) {
        const pj = g(r, 'product');
        if (pj && pj[0] === '{') {
          try {
            const p = JSON.parse(pj) as Record<string, string>;
            productName = p.product_name || productName;
            engineRaw = engineRaw || p.database_engine || '';
            os = os || p.operating_system || '';
          } catch {
            /* not JSON: ignore */
          }
        }
      }
      seeDates(a, parseDate(g(r, 'lineItem/UsageStartDate')), parseDate(g(r, 'lineItem/UsageEndDate')));

      // Effective cost: what was actually paid for this line, with reservations and savings plans amortised.
      let cost = unblended;
      let committed = false;
      switch (type) {
        case 'Tax':
          a.excluded.tax += unblended;
          a.usedRows++;
          return;
        case 'Credit':
          a.excluded.credit += unblended;
          a.usedRows++;
          return;
        case 'Refund':
          a.excluded.refund += unblended;
          a.usedRows++;
          return;
        case 'EdpDiscount':
        case 'BundledDiscount':
        case 'PrivateRateDiscount':
        case 'Discount':
        case 'DistributorDiscount':
          a.excluded.discount += unblended;
          a.usedRows++;
          return;
        case 'RIFee':
        case 'SavingsPlanRecurringFee':
        case 'SavingsPlanNegation':
        case 'SavingsPlanUpfrontFee':
          // Covered usage below carries the amortised cost already; counting these would count it twice.
          a.flags.commitmentFeesSkipped += unblended;
          a.usedRows++;
          return;
        case 'DiscountedUsage':
          cost = num(g(r, 'reservation/EffectiveCost'));
          committed = true;
          a.flags.reserved = true;
          break;
        case 'SavingsPlanCoveredUsage':
          cost = num(g(r, 'savingsPlan/SavingsPlanEffectiveCost'));
          committed = true;
          a.flags.savingsPlan = true;
          break;
        case 'Fee':
          if (/upfront|reserv/i.test(g(r, 'lineItem/LineItemDescription'))) {
            a.flags.commitmentFeesSkipped += unblended;
            a.usedRows++;
            return;
          }
          break;
      }
      if (SUPPORT.test(product)) {
        a.excluded.support += cost;
        a.usedRows++;
        return;
      }
      seeCurrency(a, g(r, 'lineItem/CurrencyCode'), cost);
      if (cost === 0 && amount === 0) return;
      a.usedRows++;
      if (g(r, 'bill/BillingEntity') === 'AWS Marketplace') {
        addNotCompared(a, `Marketplace: ${productName}`, cost, 'third-party software');
        return;
      }

      const ut = usageType;
      // --- compute: EC2 instance hours
      if (product === 'AmazonEC2' && /(BoxUsage|SpotUsage|DedicatedUsage|UnusedBox|UnusedDed)(:|$)/.test(ut)) {
        const it = g(r, 'product/instanceType') || ut.split(':')[1] || '';
        // RunInstances:0002 Windows, :0010 RHEL, :000g SUSE, ... (spot uses RunInstances:SV001 and is Linux)
        const licensed = /^RunInstances:0(?!000)[0-9a-z]{3}$/i.test(operation) || (!!os && !/^(linux|na)$/i.test(os));
        if (licensed) {
          a.flags.licensedOs = true;
          addNotCompared(a, 'EC2 instances with a licensed OS', cost, 'Windows, RHEL or SUSE licence included in the price');
          return;
        }
        if (!it) {
          addNotCompared(a, productName, cost, 'instance type missing');
          return;
        }
        const spot = /SpotUsage/.test(ut);
        if (spot) a.flags.spot = true;
        addCompute(a, it, amount, cost, { spot, committed });
        return;
      }
      // --- block storage: EBS volumes (snapshots are not compared)
      if (product === 'AmazonEC2' && /EBS:Volume/.test(ut)) {
        if (/EBS:VolumeUsage/.test(ut)) a.block.gbMonth += amount;
        a.block.cost += cost; // provisioned IOPS and throughput count as block storage spend
        return;
      }
      // --- internet egress (not inter-region, not inter-AZ, not CloudFront)
      if (/(^|-)DataTransfer-Out-Bytes$/.test(ut)) {
        if (product === 'AmazonCloudFront') {
          a.flags.cdnEgress = true;
          addNotCompared(a, productName, cost, 'CDN traffic');
          return;
        }
        a.egress.gb += amount;
        a.egress.cost += cost;
        return;
      }
      // --- object storage: S3 Standard only
      if (product === 'AmazonS3' && /(^|-)TimedStorage-ByteHrs$/.test(ut)) {
        a.object.gbMonth += amount;
        a.object.cost += cost;
        return;
      }
      // --- load balancers
      if ((product === 'AWSELB' || product === 'AmazonEC2') && /LoadBalancerUsage$/.test(ut)) {
        a.loadBalancer.hours += amount;
        a.loadBalancer.cost += cost;
        return;
      }
      if ((product === 'AWSELB' || product === 'AmazonEC2') && /(LCUUsage|DataProcessing-Bytes)$/.test(ut)) {
        a.loadBalancer.cost += cost;
        return;
      }
      // --- managed Kubernetes control plane
      if (product === 'AmazonEKS' && /AmazonEKS-Hours:perCluster/.test(ut)) {
        a.kubernetes.hours += amount;
        a.kubernetes.cost += cost;
        return;
      }
      // --- managed databases
      if (product === 'AmazonRDS') {
        const engine = dbEngine(engineRaw, ut);
        if (!engine) {
          addNotCompared(a, productName, cost, engineRaw ? 'licensed database engine (Oracle, SQL Server, Db2)' : 'database engine not in the export');
          return;
        }
        const m = /(InstanceUsage|Multi-AZUsage|Multi-AZClusterUsage):(db\.[a-z0-9.-]+)/.exec(ut);
        if (m) {
          const cls = g(r, 'product/instanceType') || m[2];
          const ha = m[1] !== 'InstanceUsage';
          const e = dbEntry(a, engine, cls, ha);
          e.instanceHours += amount;
          e.cost += cost;
          return;
        }
        if (/(GP2|GP3|PIOPS|Aurora:Storage|StorageUsage|Storage)$/.test(ut) && !/Backup|Snapshot/i.test(ut)) {
          dbCostOnly(a, engine, cost, /StorageUsage$|Storage$/.test(ut) ? amount : 0);
          return;
        }
        if (/PIOPS|IOUsage|StorageIOUsage|Aurora:StorageIOUsage/.test(ut)) {
          dbCostOnly(a, engine, cost);
          return;
        }
        addNotCompared(a, productName, cost, /Serverless/i.test(ut) ? 'serverless capacity' : 'backups and other database charges');
        return;
      }
      addNotCompared(a, productName, cost, reasonFor(ut) ?? NO_EQUIVALENT);
    },
  };
}
