import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRetry } from '../packages/tessvm/src/web/fetch-retry.ts';

function serve(t: any, statuses: number[]) {
  const seen: number[] = [];
  t.mock.method(globalThis, 'fetch', async () => {
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
  const { fetchAsset, setAssetCache, assetCacheSize } = await import('../packages/tessvm/src/web/fetch-retry.ts');
  const stores = new Map<string, Map<string, Response>>();
  (globalThis as any).caches = {
    open: async (name: string) => {
      const entries = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, entries);
      return {
        match: async (key: string | Request) => entries.get(typeof key === 'string' ? key : key.url)?.clone(),
        put: async (url: string, response: Response) => { entries.set(url, response); },
        keys: async () => [...entries.keys()].map(url => new Request(url)),
      };
    },
    delete: async (name: string) => stores.delete(name),
  };
  t.after(() => { delete (globalThis as any).caches; });
  const seen = serve(t, []);
  setAssetCache(true);
  t.after(() => setAssetCache(false));
  assert.equal(await (await fetchAsset('https://playentry.org/uploads/a.png')).text(), 'ok');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(await (await fetchAsset('https://playentry.org/uploads/a.png')).text(), 'ok');
  assert.equal(seen.length, 1);
  assert.deepEqual(await assetCacheSize(), { count: 1, bytes: 2 });
  await fetchAsset('data:text/plain,x');
  assert.equal(seen.length, 2, 'non-http URLs bypass the cache');
  setAssetCache(false);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(stores.size, 0);
  assert.deepEqual(await assetCacheSize(), { count: 0, bytes: 0 });
});
