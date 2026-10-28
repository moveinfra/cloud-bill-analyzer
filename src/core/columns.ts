import { normKey } from './util';

export type Getter = (row: string[], ...keys: string[]) => string;

/** Column lookup by normalised header name; the first key that exists wins. */
export function columns(headers: string[]): { has: (...keys: string[]) => boolean; get: Getter; index: Map<string, number> } {
  const index = new Map<string, number>();
  headers.forEach((h, i) => {
    const k = normKey(h);
    if (!index.has(k)) index.set(k, i);
  });
  const cache = new Map<string, number>();
  const resolve = (keys: string[]): number => {
    const ck = keys.join('|');
    const c = cache.get(ck);
    if (c !== undefined) return c;
    let idx = -1;
    for (const k of keys) {
      const i = index.get(normKey(k));
      if (i !== undefined) {
        idx = i;
        break;
      }
    }
    cache.set(ck, idx);
    return idx;
  };
  return {
    index,
    has: (...keys) => resolve(keys) >= 0,
    get: (row, ...keys) => {
      const i = resolve(keys);
      return i >= 0 ? (row[i] ?? '') : '';
    },
  };
}
