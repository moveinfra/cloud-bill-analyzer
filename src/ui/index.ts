// Embeddable bill analyzer: mount(element, options). Framework-free; CSS is scoped under .mi-bill.
// The file is read with the File API and parsed in a Web Worker (or on the main thread if workers are blocked).
// No network requests are made: prices and samples are bundled.
import './styles.css';
import type { Aggregate } from '../core/aggregate';
import { type Result, VERSION, estimate } from '../core/estimate';
import { prices } from '../core/prices';
import { cellText, eur, eurRange, pct, qtyText, savingsText, toJson, toMarkdown } from '../core/report';
import { type Progress, analyzeBlobs } from '../core/stream';
import { HOWTO } from './howto';
import { SAMPLES } from './samples';
import BillWorker from './worker?worker&inline';

export { VERSION, estimate, analyzeBlobs, toMarkdown, toJson };
export type { Result, Aggregate };

export interface MountOptions {
  /** Only compare these providers (upcloud, hetzner, scaleway, ovhcloud). Default: all four. */
  providers?: string[];
  /** The call-to-action line under the result. false hides it. */
  cta?: { text?: string; linkText?: string; url?: string } | false;
  /** Link to the source code shown next to the privacy line. */
  sourceUrl?: string;
  /** 'auto' follows prefers-color-scheme. */
  theme?: 'auto' | 'light' | 'dark';
  /** Show the "How to export your bill" section. Default true. */
  howTo?: boolean;
  /** Show the "Try a sample bill" buttons. Default true. */
  samples?: boolean;
  /** Parse on the main thread instead of a worker (for pages whose CSP blocks blob: workers). */
  noWorker?: boolean;
}

export interface Instance {
  analyze(files: File[]): Promise<void>;
  destroy(): void;
}

const CLOUD_NAMES: Record<string, string> = { aws: 'AWS', azure: 'Azure', gcp: 'Google Cloud' };

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmtBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

const fmtDate = (iso?: string) =>
  iso ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';

function parseInWorker(files: File[], onProgress: (p: Progress) => void): Promise<Aggregate> {
  return new Promise((resolve, reject) => {
    let w: Worker;
    try {
      w = new BillWorker();
    } catch (e) {
      reject(Object.assign(new Error('worker unavailable'), { fallback: true }));
      return;
    }
    w.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      if (m.type === 'progress') onProgress(m);
      else {
        w.terminate();
        if (m.type === 'done') resolve(m.aggregate as Aggregate);
        else reject(Object.assign(new Error(m.message), { bill: m.bill }));
      }
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      w.terminate();
      reject(Object.assign(new Error('worker failed'), { fallback: true }));
    };
    w.postMessage({ files });
  });
}

export function mount(el: HTMLElement, options: MountOptions = {}): Instance {
  const P = prices();
  const sourceUrl = options.sourceUrl ?? 'https://github.com/moveinfra/cloud-bill-analyzer';
  const cta = options.cta === false ? null : { text: 'Want this done for you?', linkText: 'moveinfra.eu', url: 'https://moveinfra.eu/', ...(options.cta || {}) };
  let agg: Aggregate | null = null;
  let result: Result | null = null;
  let rate: number | undefined;
  let fileLabel = '';
  let busy = false;
  let destroyed = false;

  const root = document.createElement('div');
  root.className = 'mi-bill';
  if (options.theme && options.theme !== 'auto') root.dataset.theme = options.theme;
  root.innerHTML = `
    <div class="mi-bill__drop" data-drop tabindex="-1">
      <p class="mi-bill__drop-title">Drop your cloud bill here</p>
      <p class="mi-bill__drop-sub">CSV export from AWS, Azure or Google Cloud. <code>.csv</code> or <code>.csv.gz</code>, one or several files.</p>
      <label class="mi-bill__btn mi-bill__btn--primary">
        Choose file
        <input type="file" accept=".csv,.gz,.csv.gz,text/csv,application/gzip" multiple data-input hidden>
      </label>
      ${
        options.samples === false
          ? ''
          : `<p class="mi-bill__samples">Try a sample bill:
              ${SAMPLES.map((s) => `<button type="button" class="mi-bill__link" data-sample="${s.id}">${esc(s.label)}</button>`).join('<span aria-hidden="true"> · </span>')}
            </p>`
      }
      <p class="mi-bill__privacy">
        <svg viewBox="0 0 16 16" aria-hidden="true" width="14" height="14"><path fill="currentColor" d="M8 1 2.5 3.2v4.1c0 3.4 2.3 6.5 5.5 7.7 3.2-1.2 5.5-4.3 5.5-7.7V3.2L8 1Zm-1 9.9L4.6 8.5l1-1L7 8.9l3.4-3.4 1 1L7 10.9Z"/></svg>
        Your file stays in your browser. Nothing is uploaded.
        <a href="${esc(sourceUrl)}" target="_blank" rel="noopener">Check the source code</a>
      </p>
    </div>
    <div class="mi-bill__status" data-status role="status" aria-live="polite" hidden></div>
    <div class="mi-bill__result" data-result hidden></div>
    ${
      options.howTo === false
        ? ''
        : `<details class="mi-bill__howto">
            <summary>How to export your bill</summary>
            <div class="mi-bill__tabs" role="tablist">
              ${HOWTO.map((h, i) => `<button type="button" role="tab" class="mi-bill__tab" aria-selected="${i === 0}" data-tab="${h.id}">${esc(h.name)}</button>`).join('')}
            </div>
            ${HOWTO.map((h, i) => `<div class="mi-bill__tabpanel" role="tabpanel" data-panel="${h.id}" ${i === 0 ? '' : 'hidden'}>${h.html}</div>`).join('')}
          </details>`
    }
    <p class="mi-bill__foot">Prices: <a href="${esc(P.source)}" target="_blank" rel="noopener">EU Cloud Price Index</a>, ${esc(fmtDate(P.generated))}.
      List prices in EUR, excl. VAT. Estimates, not quotes. cloud-bill-analyzer ${VERSION}.</p>
  `;
  el.appendChild(root);

  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const drop = $('[data-drop]');
  const input = $<HTMLInputElement>('[data-input]');
  const status = $('[data-status]');
  const out = $('[data-result]');

  const setStatus = (html: string, kind: 'info' | 'error' = 'info') => {
    status.hidden = !html;
    status.className = `mi-bill__status${kind === 'error' ? ' mi-bill__status--error' : ''}`;
    status.innerHTML = html;
  };

  async function analyze(files: File[]): Promise<void> {
    if (busy || !files.length) return;
    busy = true;
    root.classList.add('is-busy');
    out.hidden = true;
    rate = undefined;
    const total = files.reduce((s, f) => s + f.size, 0);
    fileLabel = files.length === 1 ? files[0].name : `${files.length} files`;
    const progress = (p: Progress) => {
      if (destroyed) return;
      const f = total ? Math.min(1, p.bytes / total) : 0;
      setStatus(`<span>Reading ${esc(fileLabel)}: ${fmtBytes(p.bytes)} of ${fmtBytes(total)}${p.files > 1 ? ` (file ${p.file} of ${p.files})` : ''}</span>
        <span class="mi-bill__progress"><span style="width:${(f * 100).toFixed(1)}%"></span></span>`);
    };
    progress({ bytes: 0, total, file: 1, files: files.length });
    try {
      try {
        agg = options.noWorker ? await analyzeBlobs(files, progress) : await parseInWorker(files, progress);
      } catch (e) {
        if (!(e as { fallback?: boolean }).fallback) throw e;
        agg = await analyzeBlobs(files, progress); // workers blocked: parse here, in chunks
      }
      if (destroyed) return;
      render();
      setStatus('');
    } catch (e) {
      agg = null;
      result = null;
      setStatus(`<strong>Could not read this file.</strong> ${esc((e as Error).message)}`, 'error');
    } finally {
      busy = false;
      root.classList.remove('is-busy');
      input.value = '';
    }
  }

  function render(): void {
    if (!agg) return;
    try {
      result = estimate(agg, { rate, providers: options.providers });
    } catch (e) {
      setStatus(`<strong>Could not compare this bill.</strong> ${esc((e as Error).message)}`, 'error');
      return;
    }
    const r = result;
    const ps = [...r.providers];
    const cheapest = ps.reduce((a, b) => (b.low < a.low ? b : a), ps[0]);
    const max = Math.max(r.current.compared, ...ps.map((p) => p.high), 1);
    const w = (v: number) => `${Math.max(0.5, (v / max) * 100).toFixed(2)}%`;
    const period = r.period.start ? `${fmtDate(r.period.start)} – ${fmtDate(r.period.end)}` : 'no dates in file';

    const bars = [
      `<div class="mi-bill__bar mi-bill__bar--today">
        <span class="mi-bill__bar-label">${esc(CLOUD_NAMES[r.cloud] ?? r.cloud)} today</span>
        <span class="mi-bill__bar-track"><span class="mi-bill__bar-fill" style="width:${w(r.current.compared)}"></span></span>
        <span class="mi-bill__bar-value">${eur(r.current.compared)}</span>
      </div>`,
      ...[...ps]
        .sort((a, b) => a.low - b.low)
        .map(
          (p) => `<div class="mi-bill__bar${p.id === cheapest.id ? ' is-best' : ''}">
          <span class="mi-bill__bar-label">${esc(p.name)}</span>
          <span class="mi-bill__bar-track">
            <span class="mi-bill__bar-fill" style="width:${w(p.low)}"></span>${
              p.high > p.low + 0.5 ? `<span class="mi-bill__bar-range" style="width:${(((p.high - p.low) / max) * 100).toFixed(2)}%"></span>` : ''
            }
          </span>
          <span class="mi-bill__bar-value">${eurRange(p.low, p.high, true)} <small>${esc(savingsText(p.savingsLow, p.savingsHigh))}</small></span>
        </div>`,
        ),
    ].join('');

    const rows = r.categories
      .map((c) => {
        const head = `<tr class="mi-bill__cat">
          <th scope="row">${esc(c.label)}${c.rough ? ' <span class="mi-bill__rough" title="Rough estimate">rough</span>' : ''}${
            c.quantity != null ? `<small>${esc(qtyText(c.quantity, c.unit || ''))}</small>` : ''
          }</th>
          <td>${eur(c.current)}</td>
          ${ps.map((p) => `<td class="${p.id === cheapest.id ? 'is-best' : ''}">${esc(cellText(c.estimates[p.id], c.rough))}${c.items.length === 1 && c.estimates[p.id]?.detail ? `<small>${esc(c.estimates[p.id].detail)}</small>` : ''}</td>`).join('')}
        </tr>`;
        const items =
          c.items.length > 1 || c.id === 'compute' || c.id === 'database'
            ? c.items
                .map(
                  (it) => `<tr class="mi-bill__item">
              <th scope="row">${esc(it.label)}<small>${esc(qtyText(it.quantity, it.unit))}</small></th>
              <td>${eur(it.current)}</td>
              ${ps.map((p) => `<td>${esc(cellText(it.estimates[p.id], it.rough))}${it.estimates[p.id]?.detail ? `<small>${esc(it.estimates[p.id].detail)}</small>` : ''}</td>`).join('')}
            </tr>`,
                )
                .join('')
            : '';
        return head + (c.items.length > 1 || c.id === 'compute' || c.id === 'database' ? items : '');
      })
      .join('');

    const currencyBox = r.currency.warning
      ? `<div class="mi-bill__warn">
          <p>${esc(r.currency.warning)}</p>
          ${
            r.currency.bill !== 'unknown' && r.currency.bill !== 'EUR' && r.currency.bill !== 'USD'
              ? `<form class="mi-bill__rate" data-rate>
                  <label>${esc(r.currency.bill)} per EUR <input type="number" step="any" min="0" inputmode="decimal" required value="${rate ?? ''}"></label>
                  <button type="submit" class="mi-bill__btn">Convert</button>
                </form>`
              : ''
          }
        </div>`
      : '';

    const nc = r.notCompared.length
      ? `<section class="mi-bill__section">
          <h3>Not compared <span>${eur(r.current.notCompared)}/month</span></h3>
          <p class="mi-bill__muted">Services without a clear counterpart in the price index. They are part of your bill but not of the comparison.</p>
          <ul class="mi-bill__list">${r.notCompared
            .map((n) => `<li><span>${esc(n.service)}<small>${esc(n.reason)}</small></span><span>${eur(n.cost)}</span></li>`)
            .join('')}</ul>
        </section>`
      : '';
    const ex = r.excluded.length
      ? `<section class="mi-bill__section">
          <h3>Left out of the comparison</h3>
          <ul class="mi-bill__list">${r.excluded.map((x) => `<li><span>${esc(x.label)}</span><span>${eur(x.cost)}</span></li>`).join('')}</ul>
        </section>`
      : '';

    out.innerHTML = `
      <div class="mi-bill__meta">
        <span class="mi-bill__chip">${esc(r.format.label)}</span>
        <span>${esc(fileLabel)} · ${r.rows.toLocaleString('en-US')} rows · ${esc(period)}</span>
      </div>
      ${currencyBox}
      <h2 class="mi-bill__headline">Your bill: <strong>${eur(r.current.total)}/month</strong>${ps.length ? ' · ' : ''}${[...ps]
        .sort((a, b) => a.low - b.low)
        .map((p) => `on ${esc(p.name)} <strong>${eurRange(p.low, p.high, true)}</strong>`)
        .join(', ')}</h2>
      <p class="mi-bill__share"><strong>${pct(r.comparedShare)} of your spend could be compared</strong> (${eur(r.current.compared)} of ${eur(r.current.total)}). The EU figures are for that part.</p>
      <div class="mi-bill__bars" role="img" aria-label="Monthly cost of the compared part, today and on each EU provider">${bars}</div>
      ${
        r.categories.length
          ? `<div class="mi-bill__tablewrap"><table class="mi-bill__table">
        <thead><tr><th scope="col">Monthly, EUR</th><th scope="col">Today</th>${ps.map((p) => `<th scope="col">${esc(p.name)}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><th scope="row">Compared total</th><td>${eur(r.current.compared)}</td>${ps.map((p) => `<td class="${p.id === cheapest.id ? 'is-best' : ''}">${eurRange(p.low, p.high)}</td>`).join('')}</tr>
          <tr class="mi-bill__diff"><th scope="row">Difference</th><td></td>${ps.map((p) => `<td>${esc(savingsText(p.savingsLow, p.savingsHigh))}</td>`).join('')}</tr>
        </tfoot>
      </table></div>`
          : `<p class="mi-bill__warn">Nothing in this bill could be compared. See the list below for what it contains.</p>`
      }
      ${nc}
      ${ex}
      <section class="mi-bill__section">
        <h3>Assumptions</h3>
        <ul class="mi-bill__assumptions">${r.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
      </section>
      <div class="mi-bill__actions">
        <button type="button" class="mi-bill__btn" data-dl="md">Download report (Markdown)</button>
        <button type="button" class="mi-bill__btn" data-dl="json">Download JSON</button>
        <button type="button" class="mi-bill__btn mi-bill__btn--ghost" data-reset>Analyse another bill</button>
      </div>
      ${cta ? `<p class="mi-bill__cta">${esc(cta.text)} <a href="${esc(cta.url)}" target="_blank" rel="noopener">${esc(cta.linkText)}</a></p>` : ''}
    `;
    out.hidden = false;
  }

  function download(kind: 'md' | 'json'): void {
    if (!result) return;
    const day = new Date().toISOString().slice(0, 10);
    const blob = new Blob([kind === 'md' ? toMarkdown(result) : toJson(result)], {
      type: kind === 'md' ? 'text/markdown;charset=utf-8' : 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cloud-bill-comparison-${day}.${kind}`;
    root.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // --- events
  const onClick = (ev: Event) => {
    const t = (ev.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!t) return;
    if (t.dataset.sample) {
      const s = SAMPLES.find((x) => x.id === t.dataset.sample)!;
      analyze([new File([s.text], s.file, { type: 'text/csv' })]);
    } else if (t.dataset.dl) download(t.dataset.dl as 'md' | 'json');
    else if (t.dataset.reset != null) {
      out.hidden = true;
      agg = result = null;
      drop.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      drop.focus();
    } else if (t.dataset.tab) {
      root.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b === t)));
      root.querySelectorAll<HTMLElement>('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== t.dataset.tab));
    }
  };
  const onSubmit = (ev: Event) => {
    const f = ev.target as HTMLFormElement;
    if (!f.matches('[data-rate]')) return;
    ev.preventDefault();
    const v = Number((f.querySelector('input') as HTMLInputElement).value);
    if (v > 0) {
      rate = v;
      render();
    }
  };
  const onChange = () => analyze([...(input.files || [])]);
  const stop = (ev: DragEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  const onDragOver = (ev: DragEvent) => {
    stop(ev);
    drop.classList.add('is-over');
  };
  const onDragLeave = (ev: DragEvent) => {
    stop(ev);
    drop.classList.remove('is-over');
  };
  const onDrop = (ev: DragEvent) => {
    stop(ev);
    drop.classList.remove('is-over');
    analyze([...(ev.dataTransfer?.files || [])]);
  };
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  input.addEventListener('change', onChange);
  drop.addEventListener('dragover', onDragOver);
  drop.addEventListener('dragenter', onDragOver);
  drop.addEventListener('dragleave', onDragLeave);
  drop.addEventListener('drop', onDrop);

  return {
    analyze,
    destroy() {
      destroyed = true;
      root.removeEventListener('click', onClick);
      root.removeEventListener('submit', onSubmit);
      root.remove();
    },
  };
}
