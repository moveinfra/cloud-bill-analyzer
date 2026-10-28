# Security policy

## Reporting a vulnerability

Please report security issues privately, not in public issues:

- GitHub: **Security → Report a vulnerability** on this repository, or
- email **hello@moveinfra.eu** with "security" in the subject.

Include the version, how to reproduce, and the impact you see. We reply within 3 working days and keep you updated
until a fix is released. We credit reporters in the release notes unless you ask us not to.

Please do not send real bills, even to reproduce a problem. Anonymised rows are enough.

## The privacy promise

**No data leaves your browser.** A cloud bill lists your accounts, resources and spend, so the analyzer is built so
that it cannot send it anywhere:

- The file is read with the browser's File API and parsed in a Web Worker created from code inside the bundle. It is
  never uploaded.
- The bundle contains no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon` or dynamic `import()`.
  Prices and sample bills are compiled in. There is no analytics or telemetry.
- `scripts/check-offline.mjs` fails the build if any of those appear in `dist/`, and `test/offline.test.ts` checks the
  source. Both run in CI.
- The standalone page sets a Content Security Policy with `connect-src 'none'`, so the browser itself blocks any
  request the page might try to make.
- Downloads (Markdown, JSON) are created in the page as `blob:` URLs.
- Results are not stored: reload the page and they are gone.

When the analyzer is embedded on another site, that site's own scripts are outside this promise. On moveinfra.eu the
same bundle is used unchanged.

## Check it yourself

1. Open the page, then your browser's developer tools → **Network**.
2. Drop a bill (or a sample). No request appears after the page has loaded. Blob URLs for the worker and downloads
   are local.
3. Or disconnect from the network after the page has loaded: it keeps working.
4. Read the code: `src/core` (parsing and estimates) and `src/ui` (the page) are small and have no dependencies.
   `grep -nE "fetch|XMLHttpRequest|WebSocket|sendBeacon|import\(" dist/bill-analyzer.js` prints nothing.
5. Build it yourself (`npm ci && npm run build`) and compare `dist/bill-analyzer.js` with the published file.

The CLI reads only the files you name and writes only to standard output. `scripts/update-prices.mjs` is the only
code that uses the network; it runs at build time to fetch the public price index.

## Supported versions

Fixes go into the latest version, which is what the hosted pages serve.
