#!/usr/bin/env node
// Copies the EU Cloud Price Index into data/prices.json, keeping only what the analyzer uses.
//
//   node scripts/update-prices.mjs                      # from GitHub (raw URL)
//   node scripts/update-prices.mjs ../eu-cloud-prices/data/eu-cloud-prices.json
//
// This is the only script that touches the network, and it runs at build time, never in the browser.
import { readFile, writeFile } from 'node:fs/promises';

const RAW = 'https://raw.githubusercontent.com/moveinfra/eu-cloud-prices/main/data/eu-cloud-prices.json';
const OUT = new URL('../data/prices.json', import.meta.url);
const HYPERSCALERS = new Set(['aws', 'azure', 'gcp']);

const src = process.argv[2] || RAW;
const text = /^https?:/.test(src) ? await (await fetch(src)).text() : await readFile(src, 'utf8');
const idx = JSON.parse(text);

const r = (n, d = 4) => (n == null ? n : Math.round(n * 10 ** d) / 10 ** d);

const out = {
  source: 'https://github.com/moveinfra/eu-cloud-prices',
  license: idx.license,
  generated: idx.generated,
  fx: { usdPerEur: idx.fx.usdPerEur, date: idx.fx.date },
  providers: idx.providers.map((p) => ({ id: p.id, name: p.name, euOwned: p.euOwned, region: p.region, location: p.location })),
  // Each server is [name, vcpu, memoryGiB, monthlyEUR, category, arch, estimated?].
  // Hyperscalers: only the spec is needed (monthly is 0), storage-optimised types are kept so bills can be matched.
  // EU providers: general, compute, memory and shared ranges.
  // Per-price source links are left out to keep the bundle small; they are in the index itself.
  serverFields: ['name', 'vcpu', 'memoryGiB', 'monthly', 'category', 'arch', 'estimated'],
  servers: {},
  services: {},
};

for (const p of idx.providers) {
  const hyper = HYPERSCALERS.has(p.id);
  out.servers[p.id] = (idx.servers[p.id] || [])
    .filter((s) => s.category !== 'other' && (hyper || s.category !== 'storage'))
    .filter((s) => s.vcpu > 0)
    .map((s) => {
      const row = [s.name, s.vcpu, r(s.memoryGiB, 2), hyper ? 0 : r(s.monthly, 2), s.category, s.arch];
      if (s.estimated) row.push(1);
      return row;
    });
  const sv = idx.services[p.id] || {};
  const unit = (u) => (u ? { price: r(u.price), product: u.product } : null);
  out.services[p.id] = {
    blockStorageGBMonth: unit(sv.blockStorageGBMonth),
    objectStorageGBMonth: unit(sv.objectStorageGBMonth),
    loadBalancerMonthly: unit(sv.loadBalancerMonthly),
    kubernetesMonthly: unit(sv.kubernetesMonthly),
    postgres2vCPU8GBMonthly: unit(sv.postgres2vCPU8GBMonthly),
    egress: sv.egress
      ? {
          freeGB: sv.egress.freeGB,
          perServer: sv.egress.perServer,
          tiers: sv.egress.tiers ? sv.egress.tiers.map((t) => ({ fromGB: t.fromGB, toGB: t.toGB ?? null, perGB: r(t.perGB) })) : null,
        }
      : null,
  };
}

await writeFile(OUT, JSON.stringify(out) + '\n');
const n = Object.values(out.servers).reduce((a, s) => a + s.length, 0);
console.log(`data/prices.json: index of ${out.generated}, ${n} server types, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
