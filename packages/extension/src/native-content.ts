import { api, readSettings, CACHE_KEY, CACHE_CLEAR_KEY, CACHE_SIZE_KEY } from './browser.ts';

let on = false;
let clear = 0;
let ready = false;
let changed = false;
let clearChanged = false;
const send = (live = false) => {
  if (ready) window.postMessage({ __entropy: 'native-cache', on, clear, live }, location.origin);
};

api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (CACHE_KEY in changes) { on = changes[CACHE_KEY]?.newValue === true; changed = true; }
  if (CACHE_CLEAR_KEY in changes) { clear = Number(changes[CACHE_CLEAR_KEY]?.newValue) || 0; clearChanged = true; }
  if (CACHE_KEY in changes || CACHE_CLEAR_KEY in changes) send(CACHE_CLEAR_KEY in changes);
});

window.addEventListener('message', event => {
  if (event.source !== window || event.data?.__entropy !== 'cache-size') return;
  const size = { count: Number(event.data.count) || 0, bytes: Number(event.data.bytes) || 0 };
  void api.storage.local.set({ [CACHE_SIZE_KEY]: size }).catch(error => console.warn('[entropy] 캐시 용량을 기록하지 못했습니다', error));
});

void readSettings().then(settings => {
  if (!changed) on = settings.cache;
  if (!clearChanged) clear = settings.cacheClear;
  const script = document.createElement('script');
  script.src = api.runtime.getURL('page/native-cache.js');
  script.type = 'module';
  script.dataset.entropyNativeCache = on ? '1' : '0';
  script.dataset.entropyClear = String(clear);
  script.onload = () => { ready = true; send(); };
  (document.head ?? document.documentElement).append(script);
});
