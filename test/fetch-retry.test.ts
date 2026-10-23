import test from 'node:test';
import assert from 'node:assert/strict';
import { stub } from './stub.ts';
import { fetchRetry } from '../packages/vm/src/web/fetch-retry.ts';

function serve(t: any, statuses: number[]) {
  const seen: number[] = [];
  stub(t, globalThis, 'fetch', async () => {
    const status = statuses[seen.length] ?? 200;
    seen.push(status);
    return new Response(status === 200 ? 'ok' : 'no', { status, headers: { 'retry-after': '0.01' } });
  });
  return seen;
}

test('rate limits and server errors are retried until the asset arrives', async t => {
  const seen = serve(t, [429, 503, 200]);
  assert.equal(await (await fetchRetry('/a.png')).text(), 'ok');
  assert.deepEqual(seen, [429, 503, 200]);
});

test('missing assets fail without waiting for retries', async t => {
  const seen = serve(t, [404, 200]);
  await assert.rejects(fetchRetry('/a.png'), /HTTP 404/);
  assert.deepEqual(seen, [404]);
});

test('persistent rate limits give up after the retry budget', async t => {
  const seen = serve(t, Array(10).fill(429));
  await assert.rejects(fetchRetry('/a.png'), /HTTP 429/);
  assert.equal(seen.length, 5);
});

test('aborting stops a pending retry', async t => {
  serve(t, Array(10).fill(503));
  const controller = new AbortController();
  const pending = fetchRetry('/a.png', controller.signal);
  controller.abort();
  await assert.rejects(pending);
});

test('the asset cache answers repeat requests without the network and is dropped when turned off', async t => {
  const { fetchAsset, setAssetCache, assetCacheSize, onAssetCacheChange } = await import('../packages/vm/src/web/fetch-retry.ts');
  const stores = new Map<string, Map<string, Response>>();
  let finishWrite!: () => void;
  const writing = new Promise<void>(resolve => { finishWrite = resolve; });
  let reads = 0;
  stub(t, globalThis, 'caches', {
    open: async (name: string) => {
      const entries = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, entries);
      return {
        match: async (key: string | Request) => { reads++; return entries.get(typeof key === 'string' ? key : key.url)?.clone(); },
        put: async (url: string, response: Response) => { await writing; entries.set(url, response); },
        keys: async () => [...entries.keys()].map(url => new Request(url)),
      };
    },
    delete: async (name: string) => stores.delete(name),
  });
  const seen = serve(t, []);
  setAssetCache(true);
  t.after(() => setAssetCache(false));
  const reported: Array<Promise<{ count: number; bytes: number }>> = [];
  const unsubscribe = onAssetCacheChange(() => { reported.push(assetCacheSize()); });
  t.after(unsubscribe);
  assert.equal(await (await fetchAsset('https://playentry.org/uploads/a.png')).text(), 'ok');
  assert.equal(reported.length, 0, 'incomplete writes do not update the popup');
  finishWrite();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(await Promise.all(reported), [{ count: 1, bytes: 2 }]);
  assert.equal(await (await fetchAsset('https://playentry.org/uploads/a.png')).text(), 'ok');
  assert.equal(seen.length, 1);
  const readsBeforeSize = reads;
  assert.deepEqual(await assetCacheSize(), { count: 1, bytes: 2 });
  assert.equal(reads, readsBeforeSize, 'unchanged file sizes do not read cached bodies again');
  await fetchAsset('data:text/plain,x');
  assert.equal(seen.length, 2, 'non-http URLs bypass the cache');
  setAssetCache(false);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(stores.size, 0);
  assert.deepEqual(await assetCacheSize(), { count: 0, bytes: 0 });
  assert.deepEqual(await reported.at(-1), { count: 0, bytes: 0 });
});

test('turning the cache off during a download prevents stale writes and a quick re-enable waits for deletion', async t => {
  const { fetchAsset, setAssetCache } = await import('../packages/vm/src/web/fetch-retry.ts');
  let finishDownload!: (value: Response) => void;
  let finishDelete!: () => void;
  const deleting = new Promise<void>(resolve => { finishDelete = resolve; });
  let downloading!: () => void;
  const beganDownload = new Promise<void>(resolve => { downloading = resolve; });
  const writes: string[] = [];
  let opens = 0;
  stub(t, globalThis, 'caches', {
    open: async () => {
      opens++;
      return { match: async () => undefined, put: async (url: string) => { writes.push(url); } };
    },
    delete: async () => { await deleting; return true; },
  });
  stub(t, globalThis, 'fetch', () => {
    downloading();
    return new Promise<Response>(resolve => { finishDownload = resolve; });
  });
  setAssetCache(true);
  t.after(() => setAssetCache(false));
  const stale = fetchAsset('https://playentry.org/old.png');
  await beganDownload;
  setAssetCache(false);
  setAssetCache(true);
  const fresh = fetchAsset('https://playentry.org/new.png');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(opens, 1, 'new requests wait until deletion finishes');
  finishDownload(new Response('old'));
  assert.equal(await (await stale).text(), 'old', 'the active load is allowed to finish');
  assert.deepEqual(writes, []);
  stub(t, globalThis, 'fetch', async () => new Response('new'));
  finishDelete();
  assert.equal(await (await fresh).text(), 'new');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(writes, ['https://playentry.org/new.png']);
});
