# Contributing

Thanks for helping. Bug reports, mapping fixes, new export formats and docs fixes are all welcome.

## Before you start

- **Small fix** (typo, docs, a clear mapping bug): open a pull request directly.
- **Anything bigger** (a new export format, a new category, a change to how estimates are made): open an issue first
  so we can agree on the approach.
- **Security issue**: do not open a public issue; see [SECURITY.md](SECURITY.md).
- **Wrong price**: prices come from the [EU Cloud Price Index](https://github.com/moveinfra/eu-cloud-prices); report
  it there.

## Never share real bills

Not in issues, pull requests, tests or samples. A bill contains account ids, resource names, tags and spend. To show a
problem, copy the header and a few rows and replace ids, names and tags with placeholders. The usage type, meter or
SKU text and the amounts are what matters.

## Setup

```sh
git clone https://github.com/moveinfra/cloud-bill-analyzer
cd cloud-bill-analyzer
npm ci
npm test
npm run build && npm run serve   # http://localhost:4173/
```

Node.js 20 or later. No runtime dependencies; dev dependencies are TypeScript, Vite, Vitest and esbuild.

## Where things are

| Path | What |
|---|---|
| `src/core/csv.ts` | Streaming CSV parser |
| `src/core/analyze.ts` | Format detection, feeding rows to a classifier |
| `src/core/aws.ts`, `azure.ts`, `gcp.ts` | Line classification per cloud |
| `src/core/estimate.ts` | Currency, period, matching and pricing |
| `src/core/report.ts` | Markdown, JSON and terminal output |
| `src/ui/` | The embeddable page (`mount`) and the parsing worker |
| `src/cli/` | The command line |
| `data/prices.json` | Copy of the price index, made by `npm run update-prices` |
| `samples/` | Anonymised sample bills, made by `node scripts/make-samples.mjs` |
| `docs/how-it-works.md` | Every mapping rule |

## Pull requests

- One topic per pull request, with a short description of what changes for users.
- `npm run typecheck`, `npm test` and `npm run build` pass. CI checks this, and the build fails if the browser bundle
  gains any network API.
- A new mapping rule gets a test (add rows to `scripts/make-samples.mjs` or build a small CSV in the test) and a line
  in `docs/how-it-works.md`.
- When unsure whether a line is comparable, leave it under "Not compared". A smaller honest comparison beats a bigger
  wrong one.
- `data/prices.json` changes only through `npm run update-prices`.
- No runtime dependencies without discussing it first, and nothing that loads code or data from the network.

## Commit messages

Short imperative subject (`Map Azure Ultra Disk capacity`), a body when the reason is not obvious.

## License

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).
