// Short, step-by-step export instructions per cloud. Static, trusted HTML.

export interface HowTo {
  id: 'aws' | 'azure' | 'gcp';
  name: string;
  html: string;
}

export const HOWTO: HowTo[] = [
  {
    id: 'aws',
    name: 'AWS',
    html: `
<p><strong>Data Exports (CUR 2.0)</strong>, the current format:</p>
<ol>
  <li>Open <em>Billing and Cost Management</em> → <em>Data Exports</em> → <em>Create</em>.</li>
  <li>Choose <em>Standard data export</em> and the table <em>CUR 2.0</em>. Keep the default columns.</li>
  <li>Time granularity <em>Daily</em>. File format <em>CSV</em>, compression <em>GZIP</em>. Do not pick Parquet.</li>
  <li>Pick or create an S3 bucket and save. The first files arrive within 24 hours.</li>
  <li>Download the files for one full month from <code>s3://&lt;bucket&gt;/&lt;prefix&gt;/&lt;export&gt;/data/BILLING_PERIOD=YYYY-MM/</code>. Drop all of them at once if there are several.</li>
</ol>
<p>A legacy <strong>Cost and Usage Report</strong> works too: its <code>.csv.gz</code> files are in the S3 bucket you set up for it.</p>
<p>Official docs: <a href="https://docs.aws.amazon.com/cur/latest/userguide/dataexports-create-standard.html" target="_blank" rel="noopener">Creating a standard data export</a> ·
<a href="https://docs.aws.amazon.com/cur/latest/userguide/cur-create.html" target="_blank" rel="noopener">Legacy CUR</a></p>`,
  },
  {
    id: 'azure',
    name: 'Azure',
    html: `
<p><strong>Cost details export</strong>:</p>
<ol>
  <li>In the Azure portal open <em>Cost Management</em> → <em>Exports</em> (under <em>Reporting + analytics</em>) → <em>Create</em>.</li>
  <li>Choose <em>Cost and usage details (amortized)</em>, so reserved instances and savings plans show their real cost.</li>
  <li>Pick a full month, format <em>CSV</em> (gzip is fine), and a storage account.</li>
  <li>Click <em>Run now</em>, then download the file from the storage container.</li>
</ol>
<p>Small subscriptions can also use <em>Cost analysis</em> → <em>Download</em> → <em>Usage details</em>, or the invoice's <em>Download usage</em>. EA, MCA and pay-as-you-go column names all work.</p>
<p>Official docs: <a href="https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-improved-exports" target="_blank" rel="noopener">Create exports</a> ·
<a href="https://learn.microsoft.com/en-us/azure/cost-management-billing/understand/download-azure-daily-usage" target="_blank" rel="noopener">Download usage details</a></p>`,
  },
  {
    id: 'gcp',
    name: 'Google Cloud',
    html: `
<p><strong>Cost table</strong>, quickest:</p>
<ol>
  <li>Open <em>Billing</em> → <em>Cost table</em> and pick one invoice month.</li>
  <li>Click <em>Download</em> → <em>CSV</em>.</li>
</ol>
<p><strong>BigQuery billing export</strong>, more detail (machine types):</p>
<ol>
  <li><em>Billing</em> → <em>Billing export</em> → enable <em>Standard usage cost</em> to a BigQuery dataset. Data starts from the day you enable it.</li>
  <li>Run this query for one month and use <em>Save results</em> → <em>CSV</em>:</li>
</ol>
<pre><code>SELECT service.description AS service_description,
  sku.description AS sku_description,
  usage_start_time, usage_end_time,
  usage.amount AS usage_amount, usage.unit AS usage_unit,
  usage.amount_in_pricing_units AS usage_amount_in_pricing_units,
  usage.pricing_unit AS usage_pricing_unit,
  cost, currency, cost_type,
  TO_JSON_STRING(credits) AS credits,
  (SELECT value FROM UNNEST(system_labels)
   WHERE key = 'compute.googleapis.com/machine_spec') AS machine_spec
FROM \`PROJECT.DATASET.gcp_billing_export_v1_XXXXXX\`
WHERE invoice.month = '202610'</code></pre>
<p>Official docs: <a href="https://cloud.google.com/billing/docs/how-to/cost-table" target="_blank" rel="noopener">Cost table</a> ·
<a href="https://cloud.google.com/billing/docs/how-to/export-data-bigquery" target="_blank" rel="noopener">Export billing data to BigQuery</a></p>`,
  },
];
