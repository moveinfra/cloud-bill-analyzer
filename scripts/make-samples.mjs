#!/usr/bin/env node
// Generates the anonymised sample bills in samples/. Deterministic: run it again and the files do not change.
// Account ids, resource ids and project names are made up. Rates are close to list prices in Frankfurt.
import { writeFile } from 'node:fs/promises';

const out = (name) => new URL(`../samples/${name}`, import.meta.url);

function csv(headers, rows) {
  const q = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => q(r[h])).join(','))].join('\n') + '\n';
}

const r6 = (n) => Math.round(n * 1e6) / 1e6;
const day = (start, i) => new Date(Date.parse(start) + i * 86400000);
const iso = (d) => d.toISOString().replace('.000Z', 'Z');

// ---------------------------------------------------------------- AWS legacy CUR, 7 days, daily, USD
{
  const H = [
    'identity/LineItemId', 'bill/BillingEntity', 'lineItem/UsageAccountId', 'lineItem/LineItemType',
    'lineItem/UsageStartDate', 'lineItem/UsageEndDate', 'lineItem/ProductCode', 'lineItem/UsageType',
    'lineItem/Operation', 'lineItem/AvailabilityZone', 'lineItem/ResourceId', 'lineItem/UsageAmount',
    'lineItem/CurrencyCode', 'lineItem/UnblendedRate', 'lineItem/UnblendedCost', 'lineItem/LineItemDescription',
    'product/ProductName', 'product/instanceType', 'product/operatingSystem', 'product/databaseEngine',
    'product/region', 'pricing/unit', 'reservation/EffectiveCost', 'savingsPlan/SavingsPlanEffectiveCost',
  ];
  const rows = [];
  let id = 1;
  const add = (d, o) => {
    const start = day('2026-10-01T00:00:00Z', d);
    rows.push({
      'identity/LineItemId': `li-${String(id++).padStart(5, '0')}`,
      'bill/BillingEntity': 'AWS',
      'lineItem/UsageAccountId': '123456789012',
      'lineItem/LineItemType': 'Usage',
      'lineItem/UsageStartDate': iso(start),
      'lineItem/UsageEndDate': iso(new Date(+start + 86400000)),
      'lineItem/CurrencyCode': 'USD',
      'product/region': 'eu-central-1',
      ...o,
      'lineItem/UsageAmount': r6(o['lineItem/UsageAmount'] ?? 0),
      'lineItem/UnblendedCost': r6(o['lineItem/UnblendedCost'] ?? 0),
    });
  };
  const usage = (d, product, name, ut, op, amount, rate, unit, extra = {}) =>
    add(d, {
      'lineItem/ProductCode': product,
      'product/ProductName': name,
      'lineItem/UsageType': ut,
      'lineItem/Operation': op,
      'lineItem/UsageAmount': amount,
      'lineItem/UnblendedRate': rate,
      'lineItem/UnblendedCost': amount * rate,
      'pricing/unit': unit,
      ...extra,
    });
  const EC2 = ['AmazonEC2', 'Amazon Elastic Compute Cloud'];
  for (let d = 0; d < 7; d++) {
    for (let i = 1; i <= 3; i++)
      usage(d, ...EC2, 'EUC1-BoxUsage:m6i.xlarge', 'RunInstances', 24, 0.23, 'Hrs', {
        'lineItem/ResourceId': `i-0a1b2c3d4e5f6000${i}`, 'product/instanceType': 'm6i.xlarge', 'product/operatingSystem': 'Linux',
        'lineItem/LineItemDescription': '$0.23 per On Demand Linux m6i.xlarge Instance Hour',
      });
    usage(d, ...EC2, 'EUC1-BoxUsage:t3.medium', 'RunInstances', 24, 0.048, 'Hrs', {
      'lineItem/ResourceId': 'i-0a1b2c3d4e5f60010', 'product/instanceType': 't3.medium', 'product/operatingSystem': 'Linux',
    });
    for (let i = 1; i <= 2; i++)
      add(d, {
        'lineItem/LineItemType': 'DiscountedUsage', 'lineItem/ProductCode': 'AmazonEC2', 'product/ProductName': EC2[1],
        'lineItem/UsageType': 'EUC1-BoxUsage:r6g.large', 'lineItem/Operation': 'RunInstances', 'lineItem/UsageAmount': 24,
        'lineItem/UnblendedCost': 0, 'pricing/unit': 'Hrs', 'product/instanceType': 'r6g.large', 'product/operatingSystem': 'Linux',
        'lineItem/ResourceId': `i-0b1b2c3d4e5f6000${i}`, 'reservation/EffectiveCost': r6(24 * 0.0712),
        'lineItem/LineItemDescription': 'Linux/UNIX (Amazon VPC), r6g.large reserved instance applied',
      });
    for (let i = 1; i <= 2; i++)
      usage(d, ...EC2, 'EUC1-SpotUsage:c6i.2xlarge', 'RunInstances:SV001', 24, 0.1622, 'Hrs', {
        'lineItem/ResourceId': `i-0c1b2c3d4e5f6000${i}`, 'product/instanceType': 'c6i.2xlarge', 'product/operatingSystem': 'Linux',
      });
    usage(d, ...EC2, 'EUC1-BoxUsage:m5.large', 'RunInstances:0002', 24, 0.211, 'Hrs', {
      'lineItem/ResourceId': 'i-0d1b2c3d4e5f60001', 'product/instanceType': 'm5.large', 'product/operatingSystem': 'Windows',
    });
    usage(d, ...EC2, 'EUC1-EBS:VolumeUsage.gp3', 'CreateVolume-Gp3', 2000 / 31, 0.0952, 'GB-Mo');
    usage(d, ...EC2, 'EUC1-EBS:VolumeP-IOPS.gp3', 'CreateVolume-Gp3', 3000 / 31, 0.006, 'IOPS-Mo');
    usage(d, ...EC2, 'EUC1-EBS:SnapshotUsage', 'CreateSnapshot', 800 / 31, 0.054, 'GB-Mo');
    usage(d, ...EC2, 'EUC1-DataTransfer-Out-Bytes', 'RunInstances', 95, 0.09, 'GB');
    usage(d, ...EC2, 'EUC1-DataTransfer-Regional-Bytes', 'InterZone-In', 60, 0.01, 'GB');
    usage(d, ...EC2, 'EUC1-NatGateway-Hours', 'NatGateway', 48, 0.052, 'Hrs');
    usage(d, ...EC2, 'EUC1-NatGateway-Bytes', 'NatGateway', 40, 0.052, 'GB');
    usage(d, 'AWSELB', 'Elastic Load Balancing', 'EUC1-LoadBalancerUsage', 'LoadBalancing:Application', 48, 0.027, 'Hrs');
    usage(d, 'AWSELB', 'Elastic Load Balancing', 'EUC1-LCUUsage', 'LoadBalancing:Application', 30, 0.008, 'LCU-Hrs');
    usage(d, 'AmazonEKS', 'Amazon Elastic Container Service for Kubernetes', 'EUC1-AmazonEKS-Hours:perCluster', 'CreateOperation', 24, 0.1, 'Hours');
    usage(d, 'AmazonRDS', 'Amazon Relational Database Service', 'EUC1-Multi-AZUsage:db.m6g.large', 'CreateDBInstance:0014', 24, 0.316, 'Hrs', {
      'product/instanceType': 'db.m6g.large', 'product/databaseEngine': 'PostgreSQL', 'lineItem/ResourceId': 'arn:aws:rds:eu-central-1:123456789012:db:app-db',
    });
    usage(d, 'AmazonRDS', 'Amazon Relational Database Service', 'EUC1-RDS:Multi-AZ-GP3-Storage', 'CreateDBInstance:0014', 500 / 31, 0.274, 'GB-Mo', {
      'product/databaseEngine': 'PostgreSQL',
    });
    usage(d, 'AmazonRDS', 'Amazon Relational Database Service', 'EUC1-RDS:ChargedBackupUsage', 'CreateDBInstance:0014', 300 / 31, 0.1, 'GB-Mo', {
      'product/databaseEngine': 'PostgreSQL',
    });
    usage(d, 'AmazonS3', 'Amazon Simple Storage Service', 'EUC1-TimedStorage-ByteHrs', 'StandardStorage', 5000 / 31, 0.0245, 'GB-Mo');
    usage(d, 'AmazonS3', 'Amazon Simple Storage Service', 'EUC1-TimedStorage-GlacierByteHrs', 'GlacierStorage', 3000 / 31, 0.0045, 'GB-Mo');
    usage(d, 'AmazonS3', 'Amazon Simple Storage Service', 'EUC1-Requests-Tier1', 'PutObject', 250000, 0.0000054, 'Requests');
    usage(d, 'AmazonS3', 'Amazon Simple Storage Service', 'EUC1-DataTransfer-Out-Bytes', 'GetObject', 20, 0.09, 'GB');
    usage(d, 'AmazonCloudFront', 'Amazon CloudFront', 'EU-DataTransfer-Out-Bytes', 'GET', 150, 0.085, 'GB');
    usage(d, 'AWSLambda', 'AWS Lambda', 'EUC1-Lambda-GB-Second', 'Invoke', 150000, 0.0000166667, 'Lambda-GB-Second');
    usage(d, 'AmazonCloudWatch', 'AmazonCloudWatch', 'EUC1-DataProcessing-Bytes', 'PutLogEvents', 8, 0.63, 'GB');
    usage(d, 'AmazonRoute53', 'Amazon Route 53', 'DNS-Queries', 'Query', 1500000, 0.0000004, 'Queries');
    usage(d, 'awskms', 'AWS Key Management Service', 'EUC1-KMS-Keys', 'CreateKey', 5 / 31, 1, 'Keys');
  }
  for (let i = 1; i <= 2; i++)
    add(0, {
      'lineItem/LineItemType': 'RIFee', 'lineItem/ProductCode': 'AmazonEC2', 'product/ProductName': EC2[1],
      'lineItem/UsageType': 'EUC1-HeavyUsage:r6g.large', 'lineItem/UsageAmount': 744, 'lineItem/UnblendedCost': 744 * 0.0712,
      'lineItem/LineItemDescription': 'USD 0.0712 hourly fee per Linux/UNIX (Amazon VPC), r6g.large instance',
    });
  add(0, {
    'lineItem/LineItemType': 'Usage', 'lineItem/ProductCode': 'AWSSupportBusiness', 'product/ProductName': 'AWS Support (Business)',
    'lineItem/UsageType': 'Dollar', 'lineItem/UsageAmount': 1, 'lineItem/UnblendedCost': 100,
  });
  add(0, {
    'lineItem/LineItemType': 'Credit', 'lineItem/ProductCode': 'AmazonEC2', 'product/ProductName': EC2[1],
    'lineItem/UnblendedCost': -50, 'lineItem/LineItemDescription': 'AWS Activate credits',
  });
  add(0, {
    'lineItem/LineItemType': 'Tax', 'lineItem/ProductCode': 'AmazonEC2', 'product/ProductName': EC2[1],
    'lineItem/UnblendedCost': 0, 'lineItem/LineItemDescription': 'Tax for product code AmazonEC2',
  });
  await writeFile(out('aws-cur-legacy.csv'), csv(H, rows));
}

// ---------------------------------------------------------------- AWS CUR 2.0, one month, monthly granularity, USD
{
  const H = [
    'identity_line_item_id', 'bill_billing_entity', 'line_item_usage_account_id', 'line_item_line_item_type',
    'line_item_usage_start_date', 'line_item_usage_end_date', 'line_item_product_code', 'line_item_usage_type',
    'line_item_operation', 'line_item_resource_id', 'line_item_usage_amount', 'line_item_currency_code',
    'line_item_unblended_rate', 'line_item_unblended_cost', 'line_item_line_item_description', 'product',
    'product_instance_type', 'product_region_code', 'pricing_unit', 'reservation_effective_cost',
    'savings_plan_savings_plan_effective_cost',
  ];
  const rows = [];
  let id = 1;
  const H730 = 720; // September
  const add = (o) =>
    rows.push({
      identity_line_item_id: `li2-${String(id++).padStart(5, '0')}`,
      bill_billing_entity: 'AWS',
      line_item_usage_account_id: '210987654321',
      line_item_line_item_type: 'Usage',
      line_item_usage_start_date: '2026-09-01T00:00:00.000Z',
      line_item_usage_end_date: '2026-10-01T00:00:00.000Z',
      line_item_currency_code: 'USD',
      product_region_code: 'eu-central-1',
      ...o,
      line_item_usage_amount: r6(o.line_item_usage_amount ?? 0),
      line_item_unblended_cost: r6(o.line_item_unblended_cost ?? 0),
    });
  const prod = (name, extra = {}) => JSON.stringify({ product_name: name, ...extra });
  const u = (code, name, ut, op, amount, rate, unit, extra = {}) =>
    add({
      line_item_product_code: code, line_item_usage_type: ut, line_item_operation: op, line_item_usage_amount: amount,
      line_item_unblended_rate: rate, line_item_unblended_cost: amount * rate, pricing_unit: unit, product: prod(name), ...extra,
    });
  // 6 x m7g.xlarge covered by a compute savings plan
  for (let i = 1; i <= 6; i++) {
    add({
      line_item_line_item_type: 'SavingsPlanCoveredUsage', line_item_product_code: 'AmazonEC2',
      line_item_usage_type: 'EUC1-BoxUsage:m7g.xlarge', line_item_operation: 'RunInstances',
      line_item_resource_id: `i-0e1b2c3d4e5f6000${i}`, line_item_usage_amount: H730, line_item_unblended_rate: 0.1958,
      line_item_unblended_cost: H730 * 0.1958, product: prod('Amazon Elastic Compute Cloud', { operating_system: 'Linux' }),
      product_instance_type: 'm7g.xlarge', pricing_unit: 'Hrs', savings_plan_savings_plan_effective_cost: r6(H730 * 0.1404),
    });
    add({
      line_item_line_item_type: 'SavingsPlanNegation', line_item_product_code: 'AmazonEC2',
      line_item_usage_type: 'EUC1-BoxUsage:m7g.xlarge', line_item_operation: 'RunInstances', line_item_usage_amount: 0,
      line_item_unblended_cost: -H730 * 0.1958, product: prod('Amazon Elastic Compute Cloud'),
    });
  }
  add({
    line_item_line_item_type: 'SavingsPlanRecurringFee', line_item_product_code: 'ComputeSavingsPlans',
    line_item_usage_type: 'ComputeSP:1yrNoUpfront', line_item_usage_amount: H730, line_item_unblended_cost: H730 * 0.85,
    product: prod('Savings Plans for AWS Compute usage'),
  });
  for (let i = 1; i <= 4; i++)
    u('AmazonEC2', 'Amazon Elastic Compute Cloud', 'EUC1-BoxUsage:c7i.2xlarge', 'RunInstances', H730 * (i === 4 ? 0.5 : 1), 0.4116, 'Hrs', {
      product_instance_type: 'c7i.2xlarge', line_item_resource_id: `i-0f1b2c3d4e5f6000${i}`,
    });
  u('AmazonEC2', 'Amazon Elastic Compute Cloud', 'EUC1-BoxUsage:x2iedn.xlarge', 'RunInstances', H730, 1.0, 'Hrs', {
    product_instance_type: 'x2iedn.xlarge',
  });
  u('AmazonEC2', 'Amazon Elastic Compute Cloud', 'EUC1-EBS:VolumeUsage.gp3', 'CreateVolume-Gp3', 3500, 0.0952, 'GB-Mo');
  u('AmazonEC2', 'Amazon Elastic Compute Cloud', 'EUC1-EBS:VolumeUsage.gp2', 'CreateVolume-Gp2', 400, 0.119, 'GB-Mo');
  u('AmazonEC2', 'Amazon Elastic Compute Cloud', 'EUC1-DataTransfer-Out-Bytes', 'RunInstances', 12500, 0.09, 'GB');
  u('AWSDataTransfer', 'AWS Data Transfer', 'EUC1-USE1-AWS-Out-Bytes', 'RunInstances', 900, 0.02, 'GB');
  u('AWSELB', 'Elastic Load Balancing', 'EUC1-LoadBalancerUsage', 'LoadBalancing:Network', H730 * 2, 0.027, 'Hrs');
  u('AWSELB', 'Elastic Load Balancing', 'EUC1-LCUUsage', 'LoadBalancing:Network', 2000, 0.006, 'LCU-Hrs');
  u('AmazonEKS', 'Amazon Elastic Container Service for Kubernetes', 'EUC1-AmazonEKS-Hours:perCluster', 'CreateOperation', H730 * 2, 0.1, 'Hours');
  u('AmazonRDS', 'Amazon Relational Database Service', 'EUC1-InstanceUsage:db.r6g.xlarge', 'CreateDBInstance:0002', H730, 0.552, 'Hrs', {
    product_instance_type: 'db.r6g.xlarge', product: prod('Amazon Relational Database Service', { database_engine: 'MySQL' }),
  });
  u('AmazonRDS', 'Amazon Relational Database Service', 'EUC1-RDS:GP3-Storage', 'CreateDBInstance:0002', 800, 0.137, 'GB-Mo', {
    product: prod('Amazon Relational Database Service', { database_engine: 'MySQL' }),
  });
  u('AmazonRDS', 'Amazon Relational Database Service', 'EUC1-InstanceUsage:db.r5.large', 'CreateDBInstance:0004', H730, 0.67, 'Hrs', {
    product_instance_type: 'db.r5.large', product: prod('Amazon Relational Database Service', { database_engine: 'Oracle' }),
  });
  u('AmazonS3', 'Amazon Simple Storage Service', 'EUC1-TimedStorage-ByteHrs', 'StandardStorage', 22000, 0.0245, 'GB-Mo');
  u('AmazonS3', 'Amazon Simple Storage Service', 'EUC1-TimedStorage-SIA-ByteHrs', 'StandardIAStorage', 8000, 0.0135, 'GB-Mo');
  u('AmazonDynamoDB', 'Amazon DynamoDB', 'EUC1-TimedStorage-ByteHrs', 'StandardStorage', 50, 0.306, 'GB-Mo');
  u('AmazonDynamoDB', 'Amazon DynamoDB', 'EUC1-ReadRequestUnits', 'PayPerRequestThroughput', 200e6, 0.000000305, 'ReadRequestUnits');
  u('AmazonCloudWatch', 'AmazonCloudWatch', 'EUC1-DataProcessing-Bytes', 'PutLogEvents', 300, 0.63, 'GB');
  u('AmazonSQS', 'Amazon Simple Queue Service', 'EUC1-Requests-Tier1', 'SendMessage', 40e6, 0.0000004, 'Requests');
  u('AmazonECR', 'Amazon EC2 Container Registry (ECR)', 'EUC1-TimedStorage-ByteHrs', 'StandardStorage', 120, 0.1, 'GB-Mo');
  add({ line_item_line_item_type: 'Tax', line_item_product_code: 'AmazonEC2', line_item_unblended_cost: 0, product: prod('Amazon Elastic Compute Cloud') });
  add({
    line_item_line_item_type: 'EdpDiscount', line_item_product_code: 'AmazonEC2', line_item_unblended_cost: -180,
    line_item_line_item_description: 'Enterprise Discount Program', product: prod('Amazon Elastic Compute Cloud'),
  });
  await writeFile(out('aws-cur2.csv'), csv(H, rows));
}

// ---------------------------------------------------------------- Azure MCA cost details, 7 days, daily, EUR
{
  const H = [
    'date', 'billingAccountId', 'subscriptionName', 'resourceGroupName', 'resourceId', 'resourceLocation', 'serviceFamily',
    'meterCategory', 'meterSubCategory', 'meterName', 'productName', 'quantity', 'unitOfMeasure', 'effectivePrice',
    'costInBillingCurrency', 'billingCurrency', 'chargeType', 'pricingModel', 'publisherType', 'additionalInfo',
  ];
  const rows = [];
  const sub = '/subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups';
  const add = (d, o) => {
    const dt = day('2026-10-01T00:00:00Z', d);
    rows.push({
      date: `${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${String(dt.getUTCDate()).padStart(2, '0')}/${dt.getUTCFullYear()}`,
      billingAccountId: 'anon-billing-account',
      subscriptionName: 'production',
      resourceLocation: 'germanywestcentral',
      billingCurrency: 'EUR',
      chargeType: 'Usage',
      pricingModel: 'OnDemand',
      publisherType: 'Azure',
      ...o,
      quantity: r6(o.quantity ?? 0),
      costInBillingCurrency: r6(o.costInBillingCurrency ?? 0),
    });
  };
  const m = (d, family, cat, subc, meter, qty, price, unit, extra = {}) =>
    add(d, {
      serviceFamily: family, meterCategory: cat, meterSubCategory: subc, meterName: meter, quantity: qty, effectivePrice: price,
      costInBillingCurrency: qty * price, unitOfMeasure: unit, productName: `${cat} ${subc} - ${meter}`, ...extra,
    });
  const vm = (name, rg) => `${sub}/${rg}/providers/Microsoft.Compute/virtualMachines/${name}`;
  for (let d = 0; d < 7; d++) {
    for (let i = 1; i <= 3; i++)
      m(d, 'Compute', 'Virtual Machines', 'Dsv5 Series', 'D4s v5', 24, 0.2024, '1 Hour', {
        resourceId: vm(`web-${i}`, 'app'), resourceGroupName: 'app',
        additionalInfo: JSON.stringify({ ServiceType: 'Standard_D4s_v5', VMName: `web-${i}`, UsageType: 'ComputeHR', ImageType: 'Canonical' }),
      });
    for (let i = 1; i <= 2; i++)
      m(d, 'Compute', 'Virtual Machines', 'Esv5 Series', 'E8s v5', 24, 0.3216, '1 Hour', {
        resourceId: vm(`cache-${i}`, 'app'), resourceGroupName: 'app', pricingModel: 'Reservation',
        additionalInfo: JSON.stringify({ ServiceType: 'Standard_E8s_v5', UsageType: 'ComputeHR' }),
      });
    m(d, 'Compute', 'Virtual Machines', 'BS Series', 'B2ms', 24, 0.0952, '1 Hour', {
      resourceId: vm('jump', 'ops'), resourceGroupName: 'ops',
      additionalInfo: JSON.stringify({ ServiceType: 'Standard_B2ms', UsageType: 'ComputeHR' }),
    });
    m(d, 'Compute', 'Virtual Machines', 'Dsv5 Series Windows', 'D2s v5', 24, 0.1932, '1 Hour', {
      resourceId: vm('reporting', 'ops'), resourceGroupName: 'ops',
      additionalInfo: JSON.stringify({ ServiceType: 'Standard_D2s_v5', UsageType: 'ComputeHR' }),
    });
    for (let i = 1; i <= 5; i++)
      m(d, 'Storage', 'Storage', 'Premium SSD Managed Disks', 'P30 LRS Disk', 1 / 31, 135.17, '1/Month', {
        resourceId: `${sub}/app/providers/Microsoft.Compute/disks/disk-${i}`, resourceGroupName: 'app',
      });
    m(d, 'Storage', 'Storage', 'Premium SSD Managed Disks', 'Premium LRS Disk Operations', 150, 0.0005, '10K', {});
    m(d, 'Storage', 'Storage', 'Standard SSD Managed Disks', 'E10 LRS Disk', 2 / 31, 9.6, '1/Month', {});
    m(d, 'Storage', 'Storage', 'Standard HDD Managed Disks', 'Snapshots LRS Snapshots', 400 / 31, 0.05, '1 GB/Month', {});
    m(d, 'Storage', 'Storage', 'General Block Blob v2', 'Hot LRS Data Stored', 6000 / 31, 0.0176, '1 GB/Month', {});
    m(d, 'Storage', 'Storage', 'General Block Blob v2', 'Archive LRS Data Stored', 20000 / 31, 0.0018, '1 GB/Month', {});
    m(d, 'Storage', 'Storage', 'General Block Blob v2', 'Hot LRS Write Operations', 30, 0.0598, '10K', {});
    m(d, 'Networking', 'Bandwidth', 'Rtn Preference: MGN', 'Standard Data Transfer Out', 110, 0.0781, '1 GB', {});
    m(d, 'Networking', 'Bandwidth', 'Inter-Region', 'Intra Continent Data Transfer Out', 40, 0.02, '1 GB', {});
    m(d, 'Networking', 'Load Balancer', 'Standard', 'Standard Included LB Rules and Outbound Rules', 24, 0.0225, '1 Hour', {});
    m(d, 'Networking', 'Load Balancer', 'Standard', 'Standard Data Processed', 90, 0.005, '1 GB', {});
    m(d, 'Compute', 'Azure Kubernetes Service', 'Standard', 'Standard Uptime SLA', 24, 0.0898, '1 Hour', {});
    m(d, 'Databases', 'Azure Database for PostgreSQL', 'Flexible Server General Purpose Ddsv5 Series Compute', 'vCore', 96, 0.0952, '1 Hour', {
      resourceId: `${sub}/data/providers/Microsoft.DBforPostgreSQL/flexibleServers/app-pg`, resourceGroupName: 'data',
    });
    m(d, 'Databases', 'Azure Database for PostgreSQL', 'Flexible Server Storage', 'Storage Data Stored', 512 / 31, 0.1372, '1 GB/Month', {});
    m(d, 'Databases', 'Azure Database for PostgreSQL', 'Flexible Server Backup Storage', 'Backup Storage LRS Data Stored', 200 / 31, 0.095, '1 GB/Month', {});
    m(d, 'Management and Governance', 'Log Analytics', 'Analytics Logs', 'Pay-as-you-go Data Ingestion', 6, 2.76, '1 GB', {});
    m(d, 'Compute', 'Functions', 'Premium Plan', 'vCPU Duration', 24, 0.181, '1 Hour', {});
    m(d, 'Security', 'Key Vault', 'Standard', 'Operations', 50, 0.0291, '10K', {});
    m(d, 'Networking', 'Azure DNS', 'Public', 'Public Queries', 0.3, 0.3655, '1M', {});
    m(d, 'Containers', 'Container Registry', 'Standard', 'Standard Registry Unit', 1, 0.6074, '1/Day', {});
  }
  add(0, {
    serviceFamily: 'Compute', meterCategory: 'Virtual Machines', meterSubCategory: 'Reservation-Base VM', meterName: 'Reservation',
    quantity: 1, costInBillingCurrency: 0, unitOfMeasure: '1 Hour', chargeType: 'Purchase', pricingModel: 'Reservation',
  });
  await writeFile(out('azure-cost-details.csv'), csv(H, rows));
}

// ---------------------------------------------------------------- Google Cloud BigQuery export (flattened), 7 days, EUR
{
  const H = [
    'billing_account_id', 'service.id', 'service.description', 'sku.id', 'sku.description', 'usage_start_time',
    'usage_end_time', 'project.id', 'location.region', 'cost', 'currency', 'usage.amount', 'usage.unit',
    'usage.amount_in_pricing_units', 'usage.pricing_unit', 'credits', 'invoice.month', 'cost_type',
  ];
  const rows = [];
  const GIB = 2 ** 30;
  const add = (d, o) => {
    const s = day('2026-10-01T00:00:00Z', d);
    const fmt = (x) => x.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
    rows.push({
      billing_account_id: '000000-AAAAAA-BBBBBB',
      usage_start_time: fmt(s),
      usage_end_time: fmt(new Date(+s + 86400000)),
      'project.id': 'example-prod',
      'location.region': 'europe-west3',
      currency: 'EUR',
      'invoice.month': '202610',
      cost_type: 'regular',
      credits: '[]',
      ...o,
      cost: r6(o.cost ?? 0),
    });
  };
  // kind: hour (seconds), gibHour (byte-seconds), gibMonth (byte-seconds), gib (bytes)
  const sku = (d, service, desc, kind, qty, price, credits) => {
    const usage =
      kind === 'hour' ? [qty * 3600, 'seconds', qty, 'hour']
      : kind === 'gibHour' ? [qty * GIB * 3600, 'byte-seconds', qty, 'gibibyte hour']
      : kind === 'gibMonth' ? [qty * GIB * 86400, 'byte-seconds', r6((qty * 24) / 730), 'gibibyte month']
      : kind === 'gib' ? [qty * GIB, 'bytes', qty, 'gibibyte']
      : [qty, 'requests', qty, 'count'];
    const pricingQty = usage[2];
    add(d, {
      'service.description': service, 'service.id': service.toUpperCase().replace(/\W/g, '').slice(0, 4) + '-0000-0000',
      'sku.description': desc, 'sku.id': 'ANON-SKU-' + desc.length, 'usage.amount': r6(usage[0]), 'usage.unit': usage[1],
      'usage.amount_in_pricing_units': r6(pricingQty), 'usage.pricing_unit': usage[3], cost: pricingQty * price,
      credits: credits ? JSON.stringify(credits.map((c) => ({ ...c, amount: r6(c.amount) }))) : '[]',
    });
  };
  for (let d = 0; d < 7; d++) {
    const coreCost = 12 * 24 * 0.0346;
    sku(d, 'Compute Engine', 'N2 Instance Core running in Frankfurt', 'hour', 12 * 24, 0.0346, [
      { name: 'Sustained usage discount', type: 'SUSTAINED_USAGE_DISCOUNT', amount: -coreCost * 0.2 * (d / 6) },
    ]);
    sku(d, 'Compute Engine', 'N2 Instance Ram running in Frankfurt', 'gibHour', 48 * 24, 0.00464);
    sku(d, 'Compute Engine', 'E2 Instance Core running in Frankfurt', 'hour', 4 * 24, 0.0251);
    sku(d, 'Compute Engine', 'E2 Instance Ram running in Frankfurt', 'gibHour', 16 * 24, 0.00336);
    sku(d, 'Compute Engine', 'Spot Preemptible N2D AMD Instance Core running in Frankfurt', 'hour', 8 * 24, 0.0072);
    sku(d, 'Compute Engine', 'Spot Preemptible N2D AMD Instance Ram running in Frankfurt', 'gibHour', 32 * 24, 0.00097);
    sku(d, 'Compute Engine', 'Balanced PD Capacity in Frankfurt', 'gibMonth', 1500, 0.1078);
    sku(d, 'Compute Engine', 'Storage PD Snapshot in Frankfurt', 'gibMonth', 600, 0.0313);
    sku(d, 'Compute Engine', 'Network Internet Data Transfer Out from Frankfurt to Americas', 'gib', 30, 0.1078);
    sku(d, 'Compute Engine', 'Network Internet Data Transfer Out from Frankfurt to EMEA', 'gib', 70, 0.1078);
    sku(d, 'Compute Engine', 'Network Inter Zone Data Transfer Out', 'gib', 120, 0.009);
    sku(d, 'Networking', 'Cloud Load Balancer Forwarding Rule Minimum Global', 'hour', 24, 0.0225);
    sku(d, 'Networking', 'Networking Cloud Load Balancing Data Processing Charge Inbound', 'gib', 100, 0.0072);
    sku(d, 'Cloud Storage', 'Standard Storage Frankfurt', 'gibMonth', 4096, 0.0207);
    sku(d, 'Cloud Storage', 'Coldline Storage Frankfurt', 'gibMonth', 10000, 0.0054);
    sku(d, 'Cloud Storage', 'Regional Standard Class A Operations', 'count', 200000, 0.0000045);
    sku(d, 'Kubernetes Engine', 'Regional Kubernetes Clusters', 'hour', 24, 0.0898);
    sku(d, 'Cloud SQL', 'Cloud SQL for PostgreSQL: Regional - vCPU in Frankfurt', 'hour', 4 * 24, 0.0905);
    sku(d, 'Cloud SQL', 'Cloud SQL for PostgreSQL: Regional - RAM in Frankfurt', 'gibHour', 16 * 24, 0.0153);
    sku(d, 'Cloud SQL', 'Cloud SQL for PostgreSQL: Regional - Standard storage in Frankfurt', 'gibMonth', 250, 0.2);
    sku(d, 'Cloud Logging', 'Log Volume', 'gib', 15, 0.45, d === 0 ? [{ name: 'Free tier', type: 'FREE_TIER', amount: -2.25 }] : null);
    sku(d, 'Cloud Run', 'CPU Allocation Time (tier 1)', 'hour', 40, 0.0216);
    sku(d, 'BigQuery', 'Analysis (europe-west3)', 'count', 0.4, 6.0);
    sku(d, 'Secret Manager', 'Secret version replica storage', 'count', 30, 0.0019);
  }
  add(6, {
    'service.description': 'Invoice', 'sku.description': 'Tax', cost: 0, cost_type: 'tax', 'usage.amount': 0,
  });
  add(0, {
    'service.description': 'Compute Engine', 'sku.description': 'N2 Instance Core running in Frankfurt', cost: 0,
    'usage.amount': 0, 'usage.unit': 'seconds',
    credits: JSON.stringify([{ name: 'Free trial credit', type: 'PROMOTION', amount: -40 }]),
  });
  await writeFile(out('gcp-bigquery-export.csv'), csv(H, rows));
}

// ---------------------------------------------------------------- Google Cloud console cost table, one month, USD
{
  const H = [
    'Billing account name', 'Billing account ID', 'Project name', 'Project ID', 'Service description', 'Service ID',
    'SKU description', 'SKU ID', 'Credit type', 'Cost type', 'Usage start date', 'Usage end date', 'Usage amount',
    'Usage unit', 'Unrounded Cost ($)', 'Cost ($)',
  ];
  const rows = [];
  const add = (service, sku, amount, unit, cost, extra = {}) =>
    rows.push({
      'Billing account name': 'Example billing', 'Billing account ID': '000000-AAAAAA-BBBBBB', 'Project name': 'shop',
      'Project ID': 'shop-prod', 'Service description': service, 'Service ID': 'ANON', 'SKU description': sku,
      'SKU ID': 'ANON-' + sku.length, 'Credit type': '', 'Cost type': 'Usage', 'Usage start date': '2026-09-01',
      'Usage end date': '2026-09-30', 'Usage amount': amount, 'Usage unit': unit,
      'Unrounded Cost ($)': r6(cost), 'Cost ($)': Math.round(cost * 100) / 100, ...extra,
    });
  const h = 720;
  add('Compute Engine', 'E2 Instance Core running in Frankfurt', 16 * h, 'hour', 16 * h * 0.0275);
  add('Compute Engine', 'E2 Instance Ram running in Frankfurt', 64 * h, 'gibibyte hour', 64 * h * 0.00369);
  add('Compute Engine', 'T2A Instance Core running in Frankfurt', 8 * h, 'hour', 8 * h * 0.0337);
  add('Compute Engine', 'T2A Instance Ram running in Frankfurt', 32 * h, 'gibibyte hour', 32 * h * 0.00451);
  add('Compute Engine', 'SSD backed PD Capacity in Frankfurt', 800, 'gibibyte month', 800 * 0.221);
  add('Compute Engine', 'Network Internet Data Transfer Out from Frankfurt to EMEA', 2500, 'gibibyte', 2500 * 0.12);
  add('Networking', 'Network Load Balancing: Forwarding Rule Minimum Service Charge in Frankfurt', h, 'hour', h * 0.025);
  add('Cloud Storage', 'Standard Storage Frankfurt', 1200, 'gibibyte month', 1200 * 0.023);
  add('Kubernetes Engine', 'Zonal Kubernetes Clusters', h, 'hour', h * 0.1);
  add('Cloud SQL', 'Cloud SQL for MySQL: Zonal - vCPU in Frankfurt', 2 * h, 'hour', 2 * h * 0.0496);
  add('Cloud SQL', 'Cloud SQL for MySQL: Zonal - RAM in Frankfurt', 7.5 * h, 'gibibyte hour', 7.5 * h * 0.0084);
  add('Cloud SQL', 'Cloud SQL for MySQL: Zonal - Standard storage in Frankfurt', 100, 'gibibyte month', 100 * 0.204);
  add('Cloud Monitoring', 'Monitoring data', 40, 'mebibyte', 10.2);
  add('Cloud Pub/Sub', 'Message Delivery Basic', 0.2, 'tebibyte', 8.0);
  add('Compute Engine', 'E2 Instance Core running in Frankfurt', 0, 'hour', -16 * h * 0.0275 * 0.1, { 'Credit type': 'Committed use discount' });
  add('Kubernetes Engine', 'Zonal Kubernetes Clusters', 0, 'hour', -h * 0.1, { 'Credit type': 'Free tier' });
  await writeFile(out('gcp-console-cost-table.csv'), csv(H, rows));
}

console.log('samples written');
