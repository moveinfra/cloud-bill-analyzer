/** Lower-case and strip everything but letters and digits: "lineItem/UsageType" and "line_item_usage_type" both become "lineitemusagetype". */
export function normKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function num(s: string | undefined): number {
  if (s == null) return 0;
  const t = s.trim();
  if (t === '') return 0;
  let v = Number(t);
  if (Number.isNaN(v)) {
    // "1,234.50", "€12.30", "(12.30)"
    const neg = /^\(.*\)$/.test(t) || /^-/.test(t);
    v = Number(t.replace(/[^0-9.eE+-]/g, '').replace(/^-/, ''));
    if (Number.isNaN(v)) return 0;
    if (neg) v = -Math.abs(v);
  }
  return v;
}

/**
 * Parses the date formats found in bill exports, as UTC milliseconds.
 * ISO ("2026-10-01", "2026-10-01T00:00:00Z", "2026-10-01 00:00:00 UTC") and US ("10/01/2026", "10/01/2026 13:00").
 */
export function parseDate(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?/.exec(t);
  if (m) {
    let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
    const tz = m[7];
    if (tz && tz !== 'Z' && tz !== 'UTC') {
      const sign = tz[0] === '-' ? -1 : 1;
      const hh = +tz.slice(1, 3);
      const mm = +tz.slice(-2);
      ms -= sign * (hh * 60 + mm) * 60000;
    }
    return ms;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(t);
  if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2], +(m[4] ?? 0), +(m[5] ?? 0));
  return undefined;
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export const HOURS_PER_MONTH = 730;
export const GIB_PER_GB = 1 / 1.073741824;
export const GB_PER_GIB = 1.073741824;

/** Why a line that looks like infrastructure is still not compared, from its usage type / meter / SKU text. */
export function reasonFor(text: string): string | null {
  if (/snapshot/i.test(text)) return 'snapshots';
  if (/NatGateway|NAT Gateway|Cloud NAT/i.test(text)) return 'NAT gateway';
  if (/Regional-Bytes|Inter ?Zone|Inter-?Region|InterZone|-AWS-(Out|In)-Bytes|Intra Continent|Inter Continent/i.test(text))
    return 'traffic between zones or regions, not internet egress';
  if (/Glacier|SIA|ZIA|INT-|IntelligentTiering|Nearline|Coldline|Archive|Cool /i.test(text)) return 'archive or infrequent-access storage class';
  if (/Requests?-Tier|Requests|Operations|Class [AB]/i.test(text)) return 'requests and operations';
  if (/Backup/i.test(text)) return 'backups';
  if (/ElasticIP|IdleAddress|PublicIPv4|IP Address|External IP/i.test(text)) return 'public IP addresses';
  return null;
}

export const NO_EQUIVALENT = 'no EU equivalent in the price index';
