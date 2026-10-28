# cloud-bill-analyzer

**What would your AWS, Azure or Google Cloud bill cost on an EU-owned cloud?**
Drop your bill export into a web page and see the same usage priced on [UpCloud](https://upcloud.com),
[Hetzner](https://www.hetzner.com/cloud), [Scaleway](https://www.scaleway.com) and [OVHcloud](https://www.ovhcloud.com).

**Try it:** [moveinfra.github.io/cloud-bill-analyzer](https://moveinfra.github.io/cloud-bill-analyzer/)
(soon also at [moveinfra.eu/bill-analyzer](https://moveinfra.eu/bill-analyzer/)).

- **Your file stays in your browser.** It is read and parsed on your machine. The page makes no network requests
  after it loads: prices and sample bills are bundled, and the page's Content Security Policy sets `connect-src 'none'`.
  [How to check this yourself](SECURITY.md#check-it-yourself).
- **Honest numbers.** Anything it cannot map with confidence is listed under "Not compared" with its cost, and the
  page tells you which share of your bill was compared. Rough estimates are shown as ranges.
- **Also a CLI** for people who prefer the terminal: same code, same results.
- **Open source**, Apache-2.0.

## What it reads

| Cloud | Export | Notes |
|---|---|---|
| AWS | Data Exports (CUR 2.0) and the legacy Cost and Usage Report | CSV or CSV.gz. Parquet is not supported yet: set the export to CSV. Several files of one export can be dropped at once. |
| Azure | Cost details export (Cost Management → Exports, or "Download usage details") | EA, MCA and pay-as-you-go column names. Use the amortized dataset if you have reservations. |
| Google Cloud | Cost table CSV from the console, or the BigQuery billing export saved as CSV | The BigQuery export can add machine types; see below. |

The format is detected from the header row.

## How to export your bill

**AWS (Data Exports, CUR 2.0)**

1. *Billing and Cost Management* → *Data Exports* → *Create*.
2. *Standard data export*, table *CUR 2.0*, default columns.
3. Time granularity *Daily*, file format *CSV* with *GZIP* compression.
4. Choose an S3 bucket and save. The first files arrive within 24 hours.
5. Download one month from `s3://<bucket>/<prefix>/<export>/data/BILLING_PERIOD=YYYY-MM/` and drop all files at once.

A legacy Cost and Usage Report works too. Docs: [standard data export](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-create-standard.html),
[legacy CUR](https://docs.aws.amazon.com/cur/latest/userguide/cur-create.html).

**Azure**

1. Azure portal → *Cost Management* → *Exports* → *Create*.
2. *Cost and usage details (amortized)*, one full month, format *CSV*.
3. *Run now*, then download the file from the storage account.

Small subscriptions can use *Cost analysis* → *Download* → *Usage details*. Docs:
[exports](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-improved-exports),
[download usage details](https://learn.microsoft.com/en-us/azure/cost-management-billing/understand/download-azure-daily-usage).

**Google Cloud**

- Quickest: *Billing* → *Cost table* → pick a month → *Download* → *CSV*.
- More detail: enable the [BigQuery billing export](https://cloud.google.com/billing/docs/how-to/export-data-bigquery)
  (*Standard usage cost*), run this query for one month and save the result as CSV:

```sql
SELECT service.description AS service_description,
  sku.description AS sku_description,
  usage_start_time, usage_end_time,
  usage.amount AS usage_amount, usage.unit AS usage_unit,
  usage.amount_in_pricing_units AS usage_amount_in_pricing_units,
  usage.pricing_unit AS usage_pricing_unit,
  cost, currency, cost_type,
  TO_JSON_STRING(credits) AS credits,
  (SELECT value FROM UNNEST(system_labels)
   WHERE key = 'compute.googleapis.com/machine_spec') AS machine_spec
FROM `PROJECT.DATASET.gcp_billing_export_v1_XXXXXX`
WHERE invoice.month = '202610'
```

Docs: [cost table](https://cloud.google.com/billing/docs/how-to/cost-table).

## What the result shows

- **Headline:** your monthly bill, and what the comparable part would cost on each EU provider.
- **Share compared:** for example "83% of your spend could be compared". The EU figures cover that part only.
- **Category table:** servers, managed databases, block storage, object storage, internet egress, load balancers and
  the Kubernetes control plane, today and on each provider, with the server or product picked.
- **Not compared:** every other service with its current cost and the reason it was left out.
- **Left out:** credits, refunds, tax, support plans and contract discounts, shown on their own.
- **Assumptions**, and downloads of the report as Markdown or JSON.

All amounts are per month, in EUR, excluding VAT, rounded to whole euros. A bill that covers part of a month is
scaled to 730 hours, and the page says so.

## How estimates are made

In short:

- **Servers:** each instance type is looked up in the price index (vCPU and memory), then matched to the cheapest EU
  server with at least that much, from general-purpose, compute- or memory-optimised ranges; x86 unless the source was
  Arm. Count = instance hours / hours in the bill. Google Cloud bills vCPU and memory per machine family, so those are
  priced as a pool, as a range.
- **Managed databases (rough):** the provider's managed PostgreSQL price for 2 vCPU / 8 GB, scaled by vCPU / 2 (low)
  and memory / 8 GB (high). Multi-AZ counts twice. Where there is no managed PostgreSQL (Hetzner), a server you run
  yourself.
- **Storage, egress, load balancers, Kubernetes:** quantities from the bill times the provider's unit prices.
  Egress uses the provider's free allowance (per server where traffic comes with every server) and price tiers.
- **Reservations, savings plans, committed use:** today's cost is what you actually paid (amortised). EU prices are
  on-demand list prices.

Every mapping rule is in [docs/how-it-works.md](docs/how-it-works.md).

Prices come from the [EU Cloud Price Index](https://github.com/moveinfra/eu-cloud-prices) (list prices, Frankfurt
regions for the hyperscalers, refreshed monthly). A [workflow](.github/workflows/prices.yml) copies it into
`data/prices.json` every month.

## Command line

Node.js 20 or later:

```sh
git clone https://github.com/moveinfra/cloud-bill-analyzer && cd cloud-bill-analyzer
npm ci && npm run build
node dist/cli.js bill.csv.gz
node dist/cli.js part-1.csv.gz part-2.csv.gz --format markdown > report.md
node dist/cli.js bill.csv --format json --provider hetzner,scaleway
node dist/cli.js bill.csv --rate 11.5          # SEK bill: 11.5 SEK per EUR
```

| Option | Meaning |
|---|---|
| `--format table\|markdown\|json` | Output format, default `table` |
| `--provider <ids>` | Only these providers: `upcloud`, `hetzner`, `scaleway`, `ovhcloud` |
| `--rate <n>` | Exchange rate for bills not in EUR or USD, as bill currency per EUR |

The package's `bin` is `cloud-bill-analyzer`. The CLI is offline too.

## Embed it in a page

```html
<link rel="stylesheet" href="bill-analyzer.css">
<div id="bill-analyzer"></div>
<script type="module">
  import { mount } from './bill-analyzer.js';
  mount(document.getElementById('bill-analyzer'), { theme: 'auto' });
</script>
```

`mount(element, options)` options: `providers` (array of ids), `theme` (`auto`, `light`, `dark`), `howTo` and
`samples` (booleans), `cta` (`{ text, linkText, url }` or `false`), `sourceUrl`, and `noWorker` (parse on the main
thread if your Content Security Policy does not allow `worker-src blob:`). All CSS is scoped under `.mi-bill`; colours
are `--mi-*` custom properties you can override. Fonts are inherited from your page.

## Limitations

- CSV only. Parquet exports, PDF invoices and the Azure price sheet are not read.
- One cloud per analysis. Multi-cloud bills: run each export separately.
- AWS: Windows, RHEL and SUSE instances, Oracle and SQL Server databases, Aurora Serverless, Fargate, CloudFront and
  NAT gateways are not compared. Only S3 Standard counts as object storage.
- Azure: only VM sizes and disk tiers it knows are compared; Azure SQL Database and Cosmos DB are not. Free-tier AKS
  clusters have no billing line and are not counted.
- Google Cloud: without the `machine_spec` column, VMs are compared as vCPU and memory per family, which is rougher.
- Bills in currencies other than EUR and USD need an exchange rate from you.
- EU prices are list prices. Your current bill includes your discounts; EU providers also give discounts.
- vCPUs are compared one to one. Real performance per vCPU differs; benchmark your workload before you decide.

## Development

```sh
npm ci
npm test            # vitest, uses the files in samples/
npm run typecheck
npm run build       # dist/bill-analyzer.{js,css}, dist/cli.js, and the offline check
npm run serve       # http://localhost:4173/
npm run update-prices [path-to-eu-cloud-prices.json]
node scripts/make-samples.mjs   # regenerate samples/
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE). Price data: [EU Cloud Price Index](https://github.com/moveinfra/eu-cloud-prices) by MoveInfra,
CC BY 4.0.

Maintained by [MoveInfra](https://moveinfra.eu/), which moves companies from US clouds to EU-owned ones. Provider
names are trademarks of their owners; this tool is not affiliated with any of them.
