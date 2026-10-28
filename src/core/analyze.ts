// Turns CSV text, fed in chunks, into an Aggregate. Shared by the browser worker and the CLI.
import type { Aggregate, FormatId } from './aggregate';
import { createAwsClassifier } from './aws';
import { createAzureClassifier } from './azure';
import { CsvParser } from './csv';
import { createGcpClassifier } from './gcp';
import { normKey } from './util';

export const FORMAT_LABELS: Record<FormatId, string> = {
  'aws-cur': 'AWS Cost and Usage Report (legacy CUR)',
  'aws-cur2': 'AWS Data Exports (CUR 2.0)',
  azure: 'Azure cost details export',
  'gcp-bigquery': 'Google Cloud billing export (BigQuery)',
  'gcp-console': 'Google Cloud cost table (console CSV)',
};

export class BillError extends Error {
  override name = 'BillError';
}

export function detectFormat(headers: string[]): FormatId | null {
  const k = new Set(headers.map(normKey));
  if (k.has('lineitemusagetype') && k.has('lineitemproductcode')) {
    return headers.some((h) => h.includes('/')) ? 'aws-cur' : 'aws-cur2';
  }
  if (k.has('metercategory') && (k.has('quantity') || k.has('usagequantity') || k.has('consumedquantity'))) return 'azure';
  if (k.has('skudescription') && k.has('servicedescription')) {
    return k.has('usagestarttime') || headers.some((h) => h.includes('.')) ? 'gcp-bigquery' : 'gcp-console';
  }
  return null;
}

const NOT_CSV: [RegExp, string][] = [
  [/^PAR1/, 'This looks like a Parquet file. Version 0.1 reads CSV only: set your AWS Data Export (or CUR) to "CSV" with GZIP compression, or convert the file, e.g. with DuckDB: COPY (SELECT * FROM \'file.parquet\') TO \'bill.csv\' (HEADER).'],
  [/^PK\u0003\u0004/, 'This is a ZIP archive. Unzip it and drop the CSV inside.'],
  [/^\u001f(\u008b|\uFFFD)/, 'This is gzip data that was not decompressed. Rename the file to end in .gz, or decompress it first.'],
  [/^%PDF/, 'This is a PDF invoice. The analyzer needs the detailed usage export (CSV); see "How to export your bill".'],
  [/^\s*[[{]/, 'This looks like JSON. The analyzer needs the CSV export; see "How to export your bill".'],
];

export function sniffNotCsv(start: string): string | null {
  for (const [re, msg] of NOT_CSV) if (re.test(start)) return msg;
  return null;
}

export interface Analyzer {
  push(text: string): void;
  /** Start the next file of a split export: it must have its own header row, from the same cloud. */
  nextFile(): void;
  end(): Aggregate;
  format(): FormatId | null;
}

export function createAnalyzer(): Analyzer {
  let classify: ((r: string[]) => void) | null = null;
  let agg: Aggregate | null = null;
  let fmt: FormatId | null = null;
  let first = true;
  let err: Error | null = null;

  const onRow = (row: string[]) => {
    if (err) return;
    if (!classify) {
      const f = detectFormat(row);
      if (!f) {
        err = new BillError(
          'This file is not a bill export the analyzer knows. It reads the AWS Cost and Usage Report (legacy or CUR 2.0), the Azure cost details export and the Google Cloud billing export, as CSV. First columns found: ' +
            row.slice(0, 6).join(', '),
        );
        return;
      }
      if (agg && agg.cloud !== cloudOf(f)) {
        err = new BillError('These files come from different clouds. Analyse one cloud at a time.');
        return;
      }
      fmt = f;
      const c =
        f === 'aws-cur' || f === 'aws-cur2'
          ? createAwsClassifier(row, f, agg ?? undefined)
          : f === 'azure'
            ? createAzureClassifier(row, agg ?? undefined)
            : createGcpClassifier(row, f, agg ?? undefined);
      agg = c.aggregate;
      classify = c.row;
      return;
    }
    classify(row);
  };
  let parser = new CsvParser(onRow);

  return {
    push(text: string) {
      if (err) throw err;
      if (first) {
        first = false;
        const msg = sniffNotCsv(text.slice(0, 8));
        if (msg) throw (err = new BillError(msg));
      }
      parser.push(text);
      if (err) throw err;
    },
    nextFile() {
      parser.end();
      if (err) throw err;
      parser = new CsvParser(onRow);
      classify = null;
      first = true;
    },
    end() {
      parser.end();
      if (err) throw err;
      if (!agg) throw new BillError('The file is empty.');
      if (agg.rows === 0) throw new BillError('The file has a header but no rows.');
      return agg;
    },
    format: () => fmt,
  };
}

function cloudOf(f: FormatId): string {
  return f.startsWith('aws') ? 'aws' : f === 'azure' ? 'azure' : 'gcp';
}

/** Convenience for tests and small inputs. */
export function analyzeText(text: string): Aggregate {
  const a = createAnalyzer();
  a.push(text);
  return a.end();
}
