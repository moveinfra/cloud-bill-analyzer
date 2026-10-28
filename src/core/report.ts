// Report output: Markdown, a plain-text table for terminals, and JSON with whole-euro amounts.
import type { Cell, Result } from './estimate';

export function eur(n: number): string {
  const r = Math.round(n);
  return (r < 0 ? '-€' : '€') + Math.abs(r).toLocaleString('en-US');
}

/** "€120" or "€120–150" (whole euros; a range only when the ends differ after rounding). */
export function eurRange(low: number, high: number, approx = false): string {
  const a = Math.round(low);
  const b = Math.round(high);
  const pre = approx ? '~' : '';
  if (a === b) return pre + eur(a);
  return `${pre}${eur(a)}–${Math.abs(b).toLocaleString('en-US')}`;
}

export function cellText(c: Cell | undefined, rough = false): string {
  if (!c) return '–';
  return eurRange(c.low, c.high, rough);
}

export function pct(f: number): string {
  return `${Math.round(f * 100)}%`;
}

export function savingsText(low: number, high: number): string {
  const a = Math.round(low * 100);
  const b = Math.round(high * 100);
  const word = (n: number) => (n >= 0 ? `${n}% less` : `${-n}% more`);
  if (a === b) return word(a);
  if (a >= 0 && b >= 0) return `${a}–${b}% less`;
  if (a < 0 && b < 0) return `${-b}–${-a}% more`;
  return `${word(a)} to ${word(b)}`;
}

/** "3.5 servers", "1 server", "22,306 GB". */
export function qtyText(q: number, unit: string): string {
  const v = q >= 100 ? Math.round(q) : Math.round(q * 10) / 10;
  const u = v === 1 && /s$/.test(unit) && unit !== 'GB' ? unit.slice(0, -1) : unit;
  return `${v.toLocaleString('en-US')} ${u}`;
}

export function headline(r: Result): string {
  const parts = [...r.providers]
    .sort((a, b) => a.low - b.low)
    .map((p) => `on ${p.name} ${eurRange(p.low, p.high, true)}`);
  return `Your bill: ${eur(r.current.total)}/month. The ${pct(r.comparedShare)} we could compare (${eur(r.current.compared)}) would cost ${parts.join(', ')}.`;
}

export function toMarkdown(r: Result): string {
  const ps = r.providers;
  const L: string[] = [];
  L.push(`# Cloud bill comparison`);
  L.push('');
  L.push(`${r.format.label}, ${r.rows.toLocaleString('en-US')} rows${r.period.start ? `, ${r.period.start} to ${r.period.end}` : ''}. Monthly amounts in EUR, excluding VAT.`);
  L.push('');
  if (r.currency.warning) L.push(`> **Currency:** ${r.currency.warning}`, '');
  L.push(headline(r));
  L.push('');
  L.push(`**${pct(r.comparedShare)} of your spend could be compared.**`);
  L.push('');
  L.push(`| | Today | ${ps.map((p) => p.name).join(' | ')} |`);
  L.push(`|---|--:|${ps.map(() => '--:').join('|')}|`);
  for (const c of r.categories) {
    L.push(`| **${c.label}**${c.rough ? ' (rough)' : ''} | ${eur(c.current)} | ${ps.map((p) => cellText(c.estimates[p.id], c.rough)).join(' | ')} |`);
    if (c.items.length > 1 || c.id === 'compute' || c.id === 'database') {
      for (const it of c.items) {
        L.push(
          `| ${it.label}: ${qtyText(it.quantity, it.unit)} | ${eur(it.current)} | ${ps
            .map((p) => {
              const e = it.estimates[p.id];
              return e ? `${cellText(e, it.rough)}${e.detail ? ` ${e.detail}` : ''}` : '–';
            })
            .join(' | ')} |`,
        );
      }
    } else if (c.quantity != null) {
      L.push(`| ${qtyText(c.quantity, c.unit || '')} | | ${ps.map((p) => c.estimates[p.id]?.detail ?? '').join(' | ')} |`);
    }
  }
  L.push(`| **Compared total** | **${eur(r.current.compared)}** | ${ps.map((p) => `**${eurRange(p.low, p.high)}**`).join(' | ')} |`);
  L.push(`| Difference | | ${ps.map((p) => savingsText(p.savingsLow, p.savingsHigh)).join(' | ')} |`);
  L.push('');
  if (r.notCompared.length) {
    L.push(`## Not compared (${eur(r.current.notCompared)})`);
    L.push('');
    L.push('| Service | Today | Why |');
    L.push('|---|--:|---|');
    for (const n of r.notCompared) L.push(`| ${n.service} | ${eur(n.cost)} | ${n.reason} |`);
    L.push('');
  }
  if (r.excluded.length) {
    L.push('## Left out of the comparison');
    L.push('');
    for (const x of r.excluded) L.push(`- ${x.label}: ${eur(x.cost)}`);
    L.push('');
  }
  L.push('## Assumptions');
  L.push('');
  for (const a of r.assumptions) L.push(`- ${a}`);
  L.push('');
  L.push(
    `Prices: [EU Cloud Price Index](${r.prices.source}), ${r.prices.generated}. Made with [cloud-bill-analyzer](${r.tool.url}) ${r.tool.version}. Estimates, not quotes.`,
  );
  L.push('');
  return L.join('\n');
}

/** The result with every amount rounded to whole euros (quantities to one decimal). */
export function toJson(r: Result): string {
  const round = (k: string, v: unknown) => {
    if (typeof v !== 'number') return v;
    if (/^(savings|comparedShare|factor)/i.test(k)) return Math.round(v * 1000) / 1000;
    if (k === 'rate' || k === 'usdPerEur') return v;
    if (k === 'quantity' || k === 'hours' || k === 'days') return Math.round(v * 10) / 10;
    return Math.round(v);
  };
  return JSON.stringify(r, round, 2) + '\n';
}

/** Plain-text table for terminals. */
export function toTable(r: Result): string {
  const ps = r.providers;
  const rows: string[][] = [['', 'Today', ...ps.map((p) => p.name)]];
  for (const c of r.categories) {
    rows.push([c.label + (c.rough ? ' *' : ''), eur(c.current), ...ps.map((p) => cellText(c.estimates[p.id]))]);
  }
  rows.push(['Compared total', eur(r.current.compared), ...ps.map((p) => eurRange(p.low, p.high))]);
  rows.push(['Difference', '', ...ps.map((p) => savingsText(p.savingsLow, p.savingsHigh))]);
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  const sep = w.map((n) => '-'.repeat(n)).join('  ');
  const out: string[] = [];
  out.push(`${r.format.label}, ${r.rows.toLocaleString('en-US')} rows${r.period.start ? `, ${r.period.start} to ${r.period.end}` : ''}`);
  if (r.currency.warning) out.push(`Warning: ${r.currency.warning}`);
  out.push('');
  out.push(headline(r));
  out.push('');
  out.push(line(rows[0]));
  out.push(sep);
  for (const row of rows.slice(1, -2)) out.push(line(row));
  out.push(sep);
  for (const row of rows.slice(-2)) out.push(line(row));
  out.push('');
  out.push('Monthly, EUR, excl. VAT. * rough estimate.');
  if (r.notCompared.length) {
    out.push('');
    out.push(`Not compared (${eur(r.current.notCompared)}):`);
    const sw = Math.max(...r.notCompared.map((n) => n.service.length));
    for (const n of r.notCompared) out.push(`  ${n.service.padEnd(sw)}  ${eur(n.cost).padStart(8)}  ${n.reason}`);
  }
  if (r.excluded.length) {
    out.push('');
    out.push('Left out:');
    for (const x of r.excluded) out.push(`  ${x.label}: ${eur(x.cost)}`);
  }
  out.push('');
  out.push('Assumptions:');
  for (const a of r.assumptions) out.push(`  - ${a}`);
  out.push('');
  out.push(`Prices: EU Cloud Price Index, ${r.prices.generated} (${r.prices.source})`);
  return out.join('\n') + '\n';
}
