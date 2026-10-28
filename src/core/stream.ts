// Reads File/Blob objects with web streams (browser and worker). Decompresses gzip with DecompressionStream.
// Nothing here touches the network: the File comes from the user's disk.
import type { Aggregate } from './aggregate';
import { BillError, createAnalyzer } from './analyze';

export interface Progress {
  bytes: number;
  total: number;
  file: number;
  files: number;
}

async function isGzip(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  return head[0] === 0x1f && head[1] === 0x8b;
}

export async function analyzeBlobs(blobs: Blob[], onProgress?: (p: Progress) => void): Promise<Aggregate> {
  const analyzer = createAnalyzer();
  const total = blobs.reduce((s, b) => s + b.size, 0);
  let done = 0;
  let last = 0;
  for (let i = 0; i < blobs.length; i++) {
    const blob = blobs[i];
    const name = (blob as File).name || '';
    if (/\.parquet$/i.test(name)) {
      throw new BillError('Parquet is not supported in this version. Set your export to CSV (gzip is fine); see "How to export your bill".');
    }
    if (i > 0) analyzer.nextFile();
    let read = 0;
    let stream: ReadableStream<Uint8Array> = blob.stream().pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          read += chunk.byteLength;
          const now = Date.now();
          if (onProgress && now - last > 80) {
            last = now;
            onProgress({ bytes: done + read, total, file: i + 1, files: blobs.length });
          }
          ctl.enqueue(chunk);
        },
      }),
    );
    if (await isGzip(blob)) {
      if (typeof DecompressionStream === 'undefined') {
        throw new BillError('This browser cannot decompress .gz files. Decompress the file first, or use a current browser.');
      }
      stream = stream.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
    }
    const reader = stream.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader();
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        analyzer.push(value);
      }
    } catch (e) {
      if (e instanceof BillError) throw e;
      throw new BillError(`Could not read ${name || 'the file'}: ${(e as Error).message || e}. If it is a .gz file, it may be damaged.`);
    }
    done += blob.size;
  }
  onProgress?.({ bytes: total, total, file: blobs.length, files: blobs.length });
  return analyzer.end();
}
