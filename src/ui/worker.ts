// Parses the bill off the main thread so big files do not freeze the page.
import { analyzeBlobs } from '../core/stream';

self.onmessage = async (ev: MessageEvent<{ files: File[] }>) => {
  try {
    const aggregate = await analyzeBlobs(ev.data.files, (p) => self.postMessage({ type: 'progress', ...p }));
    self.postMessage({ type: 'done', aggregate });
  } catch (e) {
    self.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e), bill: e instanceof Error && e.name === 'BillError' });
  }
};
