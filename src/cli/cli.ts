// cloud-bill-analyzer CLI: the same core as the web page, for people who prefer the terminal.
import { BillError } from '../core/analyze';
import { readBill } from './read';
import { VERSION, estimate } from '../core/estimate';
import { toJson, toMarkdown, toTable } from '../core/report';

const HELP = `cloud-bill-analyzer ${VERSION}
See what your AWS, Azure or Google Cloud bill would cost on EU-owned clouds.

Usage:
  cloud-bill-analyzer <bill.csv[.gz]> [more files of the same export...] [options]
  cat bill.csv | cloud-bill-analyzer - [options]

Options:
  --format table|markdown|json   Output format (default: table)
  --provider <ids>               Only these providers, comma-separated: upcloud,hetzner,scaleway,ovhcloud
  --rate <n>                     Exchange rate for bills not in EUR or USD, as bill currency per EUR (e.g. 11.5 for SEK)
  -h, --help                     Show this help
  -v, --version                  Show the version

Reads AWS Cost and Usage Reports (legacy CUR and CUR 2.0), Azure cost details exports and Google Cloud billing
exports as CSV, optionally gzip-compressed. Works offline: prices are built in.
https://github.com/moveinfra/cloud-bill-analyzer
`;

function fail(msg: string): never {
  process.stderr.write(`cloud-bill-analyzer: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const o: { files: string[]; format: string; providers?: string[]; rate?: number } = { files: [], format: 'table' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const eq = a.indexOf('=');
      if (eq > 0) return a.slice(eq + 1);
      const v = argv[++i];
      if (v == null) fail(`${a} needs a value`);
      return v;
    };
    if (a === '-h' || a === '--help') {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (a === '-v' || a === '--version') {
      process.stdout.write(VERSION + '\n');
      process.exit(0);
    } else if (a.startsWith('--format')) o.format = val();
    else if (a.startsWith('--provider')) o.providers = val().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if (a.startsWith('--rate')) o.rate = Number(val());
    else if (a.startsWith('--') ) fail(`unknown option ${a}`);
    else o.files.push(a);
  }
  if (!['table', 'markdown', 'md', 'json'].includes(o.format)) fail(`--format must be table, markdown or json`);
  if (o.rate != null && !(o.rate > 0)) fail('--rate must be a positive number');
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.files.length) {
    process.stdout.write(HELP);
    process.exit(process.argv.length <= 2 ? 0 : 2);
  }
  const agg = await readBill(...o.files);
  const result = estimate(agg, { rate: o.rate, providers: o.providers });
  const out = o.format === 'json' ? toJson(result) : o.format === 'table' ? toTable(result) : toMarkdown(result);
  process.stdout.write(out);
}

main().catch((e: unknown) => {
  if (e instanceof BillError) fail(e.message);
  if (e instanceof Error && /unexpected end of file|incorrect header check/i.test(e.message)) fail(`the gzip file is damaged: ${e.message}`);
  fail(e instanceof Error ? e.message : String(e));
});
