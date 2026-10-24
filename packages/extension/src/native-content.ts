import { api, readSettings, CACHE_KEY, CACHE_CLEAR_KEY, CACHE_SIZE_KEY, ENABLED_KEY, SVG_KEY, ESCAPE_KEY } from './browser.ts';

const editor = /^\/ws(?:\/|$)/.test(location.pathname);
const editorSettings = { enabled: true, svg: true, escape: true };
const editorChanged = new Set<string>();
let editorReady = false;
const sendEditor = () => {
  if (editorReady) window.postMessage({ __entropy: 'editor-settings', ...editorSettings, cache: on }, location.origin);
};
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
  if (editor) {
    for (const [key, field] of [[ENABLED_KEY, 'enabled'], [SVG_KEY, 'svg'], [ESCAPE_KEY, 'escape']] as const) {
      if (key in changes) { editorSettings[field] = changes[key]?.newValue !== false; editorChanged.add(field); }
    }
    if ([ENABLED_KEY, SVG_KEY, ESCAPE_KEY, CACHE_KEY].some(key => key in changes)) sendEditor();
  }
});

window.addEventListener('message', event => {
  if (event.source !== window) return;
  if (editor && event.data?.__entropy !== 'store-answer' && String(event.data?.__entropy).startsWith('store-')) {
    const sent = api.runtime.sendMessage?.(event.data);
    const reply = (answer: unknown) => window.postMessage({ __entropy: 'store-answer', id: event.data.id, answer }, location.origin);
    if (sent) void sent.then(reply, () => reply({ error: true }));
    else reply({ error: true });
    return;
  }
  if (event.data?.__entropy !== 'cache-size') return;
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
  if (editor) {
    for (const field of ['enabled', 'svg', 'escape'] as const) {
      if (!editorChanged.has(field)) editorSettings[field] = settings[field];
    }
    const runner = document.createElement('script');
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = api.runtime.getURL('player.css');
    runner.src = api.runtime.getURL('page/editor.js');
    runner.type = 'module';
    runner.onload = () => { editorReady = true; sendEditor(); };
    (document.head ?? document.documentElement).append(style, runner);
  }
});
