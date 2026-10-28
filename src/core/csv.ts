// A small streaming CSV parser (RFC 4180: quotes, escaped quotes, CRLF, newlines inside quotes).
// Feed it text in chunks of any size; it calls onRow for every complete row.

export class CsvParser {
  private field = '';
  private row: string[] = [];
  private inQuotes = false;
  private quotePending = false; // saw a quote inside a quoted field; next char decides
  private started = false;
  private lastWasCR = false;

  constructor(private readonly onRow: (row: string[]) => void, private readonly delimiter = ',') {}

  push(chunk: string): void {
    let i = 0;
    if (!this.started) {
      this.started = true;
      if (chunk.charCodeAt(0) === 0xfeff) i = 1; // BOM
    }
    const d = this.delimiter;
    const n = chunk.length;
    while (i < n) {
      const c = chunk[i];
      if (this.inQuotes) {
        if (this.quotePending) {
          this.quotePending = false;
          if (c === '"') {
            this.field += '"';
            i++;
            continue;
          }
          this.inQuotes = false; // closing quote; fall through to handle c unquoted
        } else {
          // fast path: copy up to the next quote
          const q = chunk.indexOf('"', i);
          if (q === -1) {
            this.field += chunk.slice(i);
            return;
          }
          this.field += chunk.slice(i, q);
          this.quotePending = true;
          i = q + 1;
          continue;
        }
      }
      if (c === '"' && this.field === '') {
        this.inQuotes = true;
        this.lastWasCR = false;
        i++;
        continue;
      }
      if (c === d) {
        this.row.push(this.field);
        this.field = '';
        this.lastWasCR = false;
      } else if (c === '\n') {
        if (!this.lastWasCR) this.endRow();
        this.lastWasCR = false;
      } else if (c === '\r') {
        this.endRow();
        this.lastWasCR = true;
      } else {
        // fast path: copy plain characters up to the next special one
        let j = i + 1;
        while (j < n) {
          const cj = chunk[j];
          if (cj === d || cj === '\n' || cj === '\r' || cj === '"') break;
          j++;
        }
        this.field += chunk.slice(i, j);
        this.lastWasCR = false;
        i = j;
        continue;
      }
      i++;
    }
  }

  end(): void {
    if (this.quotePending) {
      this.quotePending = false;
      this.inQuotes = false;
    }
    if (this.field !== '' || this.row.length > 0) this.endRow();
  }

  private endRow(): void {
    this.row.push(this.field);
    this.field = '';
    const row = this.row;
    this.row = [];
    if (row.length === 1 && row[0] === '') return; // blank line
    this.onRow(row);
  }
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const p = new CsvParser((r) => rows.push(r));
  p.push(text);
  p.end();
  return rows;
}
