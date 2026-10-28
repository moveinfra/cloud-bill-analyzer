import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { Aggregate } from '../core/aggregate';
import { type Analyzer, BillError, createAnalyzer } from '../core/analyze';

async function isGzip(file: string): Promise<boolean> {
  if (file.endsWith('.gz')) return true;
  const fh = await open(file, 'r');
  try {
    const b = Buffer.alloc(2);
    await fh.read(b, 0, 2, 0);
    return b[0] === 0x1f && b[1] === 0x8b;
  } finally {
    await fh.close();
  }
}

/** Streams bill export files (CSV, optionally gzip), or stdin for "-", into one Aggregate. */
export async function readBill(...files: string[]): Promise<Aggregate> {
  const analyzer = createAnalyzer();
  for (let i = 0; i < files.length; i++) {
    if (i > 0) analyzer.nextFile();
    await readOne(files[i], analyzer);
  }
  return analyzer.end();
}

async function readOne(file: string, analyzer: Analyzer): Promise<void> {
  if (/\.parquet$/i.test(file)) {
    throw new BillError('Parquet is not supported in this version. Set your export to CSV (gzip is fine); see the README.');
  }
  let input: Readable;
  if (file === '-') input = process.stdin;
  else {
    let gz: boolean;
    try {
      gz = await isGzip(file);
    } catch (e) {
      throw new BillError(`cannot read ${file}: ${(e as Error).message}`);
    }
    input = createReadStream(file);
    if (gz) input = input.pipe(createGunzip());
  }
  const dec = new TextDecoder('utf-8');
  for await (const chunk of input) analyzer.push(dec.decode(chunk as Buffer, { stream: true }));
  analyzer.push(dec.decode());
}
