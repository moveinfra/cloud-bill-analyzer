// Fails the build if the browser bundle contains anything that can make a network request.
// Run after `vite build`. This is the check behind the "your file stays in your browser" promise.
import { readFileSync } from 'node:fs';

const FORBIDDEN = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\bsendBeacon\b/,
  /\bRTCPeerConnection\b/,
  /\bimportScripts\b/,
  /\bimport\s*\(/,
  /https?:\/\/[^"'`\s]*\.(js|mjs|css|json)\b/,
];
let bad = 0;
for (const f of ['dist/bill-analyzer.js', 'dist/bill-analyzer.css']) {
  const code = readFileSync(f, 'utf8');
  for (const re of FORBIDDEN) {
    const m = re.exec(code);
    if (m) {
      bad++;
      console.error(`${f}: found ${m[0]} near: ${code.slice(Math.max(0, m.index - 80), m.index + 80)}`);
    }
  }
}
if (bad) process.exit(1);
console.log('check-offline: no network APIs in dist/bill-analyzer.js or dist/bill-analyzer.css');
