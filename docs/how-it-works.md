# How it works

The analyzer runs in three steps. All of them run in your browser (or in Node.js for the CLI).

1. **Read.** The file is streamed in chunks with the File API, decompressed with `DecompressionStream` if it is gzip,
   and parsed by a small CSV parser (`src/core/csv.ts`) in a Web Worker. The format is detected from the header row
   (`src/core/analyze.ts`).
2. **Classify.** Each line is put into one category with a quantity and its cost (`src/core/aws.ts`, `azure.ts`,
   `gcp.ts`). The result is an *aggregate*: totals per category, in the bill's currency and period.
3. **Estimate.** The aggregate is converted to euros and to one month, then priced on each EU provider with the
   [EU Cloud Price Index](https://github.com/moveinfra/eu-cloud-prices) (`src/core/estimate.ts`).

Column names are matched case-insensitively and ignoring punctuation, so `lineItem/UsageType`, `line_item_usage_type`,
`MeterCategory`, `meterCategory`, `service.description` and `Service description` all work.

The rule throughout: **when unsure, put the line under "Not compared"** with its cost, rather than guess.

## Categories

| Category | Quantity | EU estimate |
|---|---|---|
| Servers | instance hours per instance type | cheapest matching server × average running count |
| Managed databases | instance hours per class, or vCPU-hours and GiB-hours; storage GB-months | managed PostgreSQL scaled, or a server (rough) |
| Block storage | GB-months | GB × block storage price |
| Object storage | GB-months | GB × object storage price |
| Internet egress | GB | tiers above the free allowance |
| Load balancers | load balancer hours | count × load balancer price |
| Kubernetes control plane | cluster hours | count × control plane price |
| Not compared | cost | none |
| Left out | cost | none; credits, refunds, tax, support, discounts |

## AWS (legacy CUR and CUR 2.0)

Detected by the columns `lineItem/ProductCode` and `lineItem/UsageType` (or `line_item_product_code`,
`line_item_usage_type`). Headers with a `/` are the legacy CUR; without, CUR 2.0. In CUR 2.0, the database engine and
operating system are read from the `product` map column when there are no separate columns.

**Cost of a line.** `lineItem/UnblendedCost`, except:

| `lineItem/LineItemType` | Treatment |
|---|---|
| `DiscountedUsage` (reserved instance) | cost = `reservation/EffectiveCost` |
| `SavingsPlanCoveredUsage` | cost = `savingsPlan/SavingsPlanEffectiveCost` |
| `SavingsPlanNegation`, `SavingsPlanRecurringFee`, `SavingsPlanUpfrontFee`, `RIFee`, upfront `Fee` | skipped: the covered usage already carries the amortised cost |
| `Tax` | left out: tax |
| `Credit` | left out: credits |
| `Refund` | left out: refunds |
| `EdpDiscount`, `BundledDiscount`, `PrivateRateDiscount`, `Discount`, `DistributorDiscount` | left out: contract discounts |

Product codes starting with `AWSSupport` (and `OCBPremiumSupport`) are left out as support. Lines billed by
`AWS Marketplace` are not compared.

**Mapping** (`lineItem/UsageType`, matched on its end so region prefixes like `EUC1-` do not matter):

| Rule | Category |
|---|---|
| `AmazonEC2` and `BoxUsage`, `SpotUsage`, `DedicatedUsage`, `UnusedBox`, `UnusedDed` | Servers. Type from `product/instanceType`, else the part after `:`. Spot is noted. |
| …with `lineItem/Operation` `RunInstances:0xxx` (other than `0000`) or a non-Linux `product/operatingSystem` | Not compared: licensed OS (Windows, RHEL, SUSE) |
| `AmazonEC2` and `EBS:VolumeUsage*` | Block storage, GB-months |
| `AmazonEC2` and other `EBS:Volume*` (provisioned IOPS, throughput) | Block storage cost, no quantity |
| `EBS:SnapshotUsage` | Not compared: snapshots |
| `*DataTransfer-Out-Bytes` from any product except CloudFront | Internet egress, GB |
| CloudFront `DataTransfer-Out-Bytes` | Not compared: CDN traffic |
| `DataTransfer-Regional-Bytes`, `*-AWS-Out-Bytes`, `*-AWS-In-Bytes` | Not compared: traffic between zones or regions |
| `AmazonS3` and `TimedStorage-ByteHrs` (S3 Standard) | Object storage, GB-months |
| Other S3 storage classes (`SIA`, `ZIA`, `INT`, `Glacier`…) | Not compared: archive or infrequent-access class |
| S3 requests | Not compared: requests |
| `AWSELB`/`AmazonEC2` and `LoadBalancerUsage` | Load balancers, hours |
| `LCUUsage`, `DataProcessing-Bytes` under ELB | Load balancer cost, no quantity |
| `AmazonEKS` and `AmazonEKS-Hours:perCluster` | Kubernetes control plane, hours |
| `AmazonRDS` `InstanceUsage:db.*` | Managed database, engine from `product/databaseEngine`, class from `product/instanceType` |
| `AmazonRDS` `Multi-AZUsage:db.*`, `Multi-AZClusterUsage:db.*` | Same, with a standby (counts twice) |
| RDS / Aurora storage (`*Storage`, `StorageUsage`) | Database storage, GB-months |
| RDS IOPS and I/O | Database cost without a size: not compared |
| RDS backups, Aurora Serverless | Not compared |
| RDS with Oracle, SQL Server or Db2, or no engine | Not compared: licensed engine |
| `NatGateway-*` | Not compared: NAT gateway |
| Everything else | Not compared, grouped by `product/ProductName` |

## Azure cost details

Detected by `MeterCategory` plus `Quantity` (or `UsageQuantity`, `ConsumedQuantity`). Columns used: `MeterCategory`,
`MeterSubCategory`, `MeterName`, `Quantity`, `UnitOfMeasure`, cost from `CostInBillingCurrency`, `PreTaxCost` or
`Cost`, currency from `BillingCurrency`, `BillingCurrencyCode` or `Currency`, date from `Date` or `UsageDateTime`
(ISO or `MM/DD/YYYY`), plus `ChargeType`, `PricingModel`, `PublisherType` and `AdditionalInfo` when present.

The quantity is multiplied by the number in `UnitOfMeasure` (`100 Hours` → ×100, `10K` → ×10,000). Each day is
counted as a full day for the period.

| Rule | Category |
|---|---|
| `ChargeType` `Purchase` | Left out: reservation and savings plan purchases |
| `ChargeType` `Refund` / `Tax` | Left out |
| `ChargeType` `UnusedReservation`, `UnusedSavingsPlan` | Not compared |
| `PublisherType` `Marketplace` | Not compared |
| `Virtual Machines`, hourly unit | Servers. Size from `AdditionalInfo.ServiceType` or `VMSize`, else from the meter name (`D4s v5` → `Standard_D4s_v5`). Spot and Low Priority are noted. |
| `Virtual Machines` with `Windows` in the sub-category or meter, or `UsageType` ending `_SW`; `Virtual Machines Licenses` | Not compared: licensed OS |
| `Storage`, meter `P30 LRS Disk`, `E10 …`, `S4 …` (monthly unit) | Block storage, GB from the disk tier (P10 = 128 GiB … P80 = 32 TiB) |
| `Storage`, Premium SSD v2 or Ultra `Provisioned Capacity` | Block storage, GiB-hours / 730 |
| Other managed disk meters (operations, IOPS, throughput, bursting) | Block storage cost, no quantity |
| `Storage`, snapshots | Not compared |
| `Storage`, blob `Hot LRS Data Stored` or `Hot ZRS Data Stored` | Object storage, GB-months |
| Other `Data Stored` meters (Cool, Cold, Archive, GRS) | Not compared |
| Blob operations, other storage | Not compared |
| `Bandwidth`, meter `… Data Transfer Out` without inter/intra/region/continent/zone/peering | Internet egress, GB |
| Other `Bandwidth` | Not compared: between regions and zones |
| `Load Balancer` / `Application Gateway`, hourly `Included LB Rules`, `Fixed Cost`, `Basic`, `Standard` meters | Load balancers, hours |
| Other load balancer meters (data processed, rules, capacity units) | Load balancer cost, no quantity |
| `Azure Kubernetes Service`, `Uptime SLA` or `Standard`, hourly | Kubernetes control plane, hours (free-tier clusters have no line) |
| `Azure Database for PostgreSQL / MySQL / MariaDB`, meter `vCore` | Managed database, vCPU-hours; memory 4 GiB per vCore for General Purpose, 8 for Memory Optimized |
| …meter named like a VM size (`B2ms`, `D2ds v5`) | Managed database, instance class |
| …storage meters | Database storage, GB-months |
| …backup meters | Not compared |
| `Support` | Left out: support |
| Everything else | Not compared, grouped by `MeterCategory` |

Reservations in the *actual cost* export appear as usage with zero cost; the page then asks for the *amortized*
export.

## Google Cloud

Detected by `service.description` and `sku.description` (or `Service description`, `SKU description`). With a
`usage_start_time` column or dotted headers it is the BigQuery export, otherwise the console cost table.

Units are converted from either the raw unit (`seconds`, `byte-seconds`, `bytes`) or the pricing unit (`hour`,
`gibibyte hour`, `gibibyte month`, `gibibyte`). GiB are converted to GB (×1.0737) where EU prices are per GB.

**Cost of a line.** `cost` (or `Unrounded cost`, `Cost (€)`, `Cost ($)`). Credits:

| Credit | Treatment |
|---|---|
| In a `credits` JSON column: `COMMITTED_USAGE_DISCOUNT*`, `SUSTAINED_USAGE_DISCOUNT`, `DISCOUNT`, `SUBSCRIPTION_BENEFIT`, `RESELLER_MARGIN` | Added to the line's cost (what you actually paid) |
| In a `credits` JSON column: `FREE_TIER`, `PROMOTION` and others | Left out: credits |
| Console rows with a `Credit type` of committed or sustained use | Left out: contract discounts |
| Console rows with another `Credit type` | Left out: credits |
| `cost_type` `tax` | Left out: tax |
| `cost_type` `adjustment`, `rounding_error` | Left out: refunds and adjustments |

The console's `Usage end date` is inclusive; one day is added.

| Rule | Category |
|---|---|
| `Compute Engine`, SKU `… Core running in …` / `… Ram running in …` (incl. Spot and Preemptible, not GPU, licence, sole tenancy, local SSD) | Servers. With a `machine_spec` column: per machine type. Without: vCPU-hours and GiB-hours per family (N2, E2, N2D AMD, T2A…), priced as a pool. T2A, C4A and Axion are Arm. |
| `Compute Engine`, SKU starting `Commitment` | Not compared: committed use fees |
| `Compute Engine`, `PD Capacity` or `Hyperdisk … Capacity` (not snapshots) | Block storage, GB-months |
| `Hyperdisk … IOPS/Throughput` | Block storage cost, no quantity |
| Any service, SKU with `Internet … Egress` or `Internet … Data Transfer Out`, or `Download Worldwide/APAC/China/Australia` | Internet egress, GB |
| SKU with `Forwarding Rule Minimum` | Load balancers, hours |
| Other load balancing SKUs | Load balancer cost, no quantity |
| `Cloud Storage`, `Standard Storage …`, `Regional Storage …`, `Multi-Regional Storage …` | Object storage, GB-months |
| `Kubernetes Engine`, `… Kubernetes Clusters` (not Autopilot pod resources) | Kubernetes control plane, hours |
| `Cloud SQL for PostgreSQL / MySQL`, `vCPU` / `RAM` / `storage` SKUs | Managed database. `Regional` means a standby (counts twice). |
| `Cloud SQL for SQL Server`, Cloud SQL backups | Not compared |
| `Support` | Left out: support |
| Everything else | Not compared, grouped by service; snapshots, inter-zone/region traffic, archive classes and operations get their own reason |

## Normalising

**Currency.** The bill currency is the one with most spend in the currency column, or the one in the cost header
(`Cost (€)`). EUR is used as is. USD is divided by `fx.usdPerEur` from the price index (ECB rate). Any other currency
needs a rate from you (`--rate`, or the field on the page); without one, amounts are shown unconverted with a warning.

**Period.** From the earliest usage start to the latest usage end. Without end dates: the latest start plus one day
(if all starts are at midnight) or one hour. Every cost and quantity is multiplied by 730 / hours in the period. A
period within 3% of 730 hours is shown as "a 730-hour month"; otherwise the page says it was scaled. Without any dates
the file is assumed to cover one month.

**Average running count** = instance hours / hours in the period. Three servers running half the month count as 1.5.

## Estimating

**Servers.** vCPU and memory of the instance type come from the hyperscaler server table in the price index (AWS
`m6i.xlarge`, Azure `Standard_D4s_v5`, Google `n2-standard-4`; Azure memory is derived from the size name). Unknown
types, or types with unknown memory, are not compared. The EU match is the cheapest server with at least that vCPU and
memory, from general-purpose, compute- or memory-optimised ranges, x86, or Arm too when the source was Arm.
Shared-core EU servers are allowed only when the source was shared-core or burstable (`t3`, `B`-series, `e2-micro`),
to compare like with like. When no single server is large enough, the size is split over 2 to 8 equal servers.

**Google Cloud pools.** Average vCPU V and memory M per family. For each EU server s: low = max(V / s.vcpu,
M / s.memory) × s.price (capacity divides evenly), high = the same rounded up to whole servers. The cheapest of each
over all servers is shown as the range.

**Managed databases (rough).** Per instance: vCPU V and memory M from the class (or from vCPU-hours / hours).
Count = average running × 2 with a standby.

- Provider with managed PostgreSQL: low = price(2 vCPU, 8 GB) × max(V / 2, 0.5) × count;
  high = the same with max(M / 8, 0.5) when that is higher.
- Provider without (Hetzner): cheapest server with V and M (M = 4 × V when unknown), × count, managed by you.
- Plus storage GB × the provider's block storage price.
- MySQL, MariaDB and Aurora are priced like PostgreSQL; the index has no MySQL prices.

**Block and object storage, load balancers.** Quantity × the provider's unit price. Lines with cost but no quantity
(for example IOPS) count towards today's cost of the category and are assumed included on the EU side.

**Kubernetes control plane.** Clusters × the provider's control plane price. Hetzner has no managed Kubernetes: three
of its smallest servers with 2 vCPU and 4 GB per cluster, run by you.

**Internet egress.** As in the price index: allowance = `freeGB` × number of servers if `perServer`, else `freeGB`;
the tiers apply to the GB above the allowance. The number of servers is the EU estimate's server count (compute,
self-managed databases and control planes), at least one. Providers with no tiers include traffic.

**Totals.** Per provider, the sum over compared categories (low and high). Savings = 1 − EU total / today's compared
cost. Share compared = today's compared cost / (compared + not compared). Credits, refunds, tax, support and contract
discounts are not part of either.

**Rounding.** Amounts are shown in whole euros. Rough categories are marked and shown as ranges.
