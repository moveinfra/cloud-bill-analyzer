// The privacy promise, as a test: nothing that runs in the browser can make a network request.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|importScripts)\b|\bimport\s*\(/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('offline', () => {
  const root = new URL('../src/', import.meta.url).pathname;
  for (const f of files(root).filter((f) => /\.(ts|css)$/.test(f) && !f.includes('/cli/'))) {
    it(`${f.slice(root.length)} has no network APIs`, () => {
      const code = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(code).not.toMatch(FORBIDDEN);
    });
  }
});
