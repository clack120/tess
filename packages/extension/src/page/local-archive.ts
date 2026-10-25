import { fetchAsset, beginAssetBulk, endAssetBulk } from '../../../vm/src/web/fetch-retry.ts';
import { withAssetUrls, type EntryWork } from './entry-project.ts';
import { localArchiveWorker } from './local-archive-worker.ts';

export interface LocalAsset { name: string; url: string; label: string; }

export function localArchiveProject(work: EntryWork): { project: EntryWork; assets: LocalAsset[] } {
  const normalized = withAssetUrls(work);
  const assets = new Map<string, LocalAsset>();
  const add = (name: string, url: string, label: string) => {
    const absolute = new URL(url, location.href);
    if (absolute.origin !== location.origin || !absolute.pathname.startsWith('/uploads/')) {
      throw new Error(`저장할 미디어 주소를 확인해주세요: ${url}`);
    }
    const old = assets.get(name);
    if (old && old.url !== absolute.href) throw new Error(`서로 다른 미디어의 파일명이 같습니다: ${name}`);
    assets.set(name, { name, url: absolute.href, label }); return name;
  };
  const filename = (value: unknown, description: string) => {
    if (typeof value !== 'string' || !/^[a-z0-9]{4,100}$/i.test(value)) {
      throw new Error(`${description}: 원본 미디어 파일명이 없거나 올바르지 않습니다.`);
    }
    return value;
  };
  const path = (hash: string, kind: string, ext: string) => `temp/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${kind}/${hash}.${ext}`;
  const objects = normalized.objects.map((object, index) => {
    const sprite = object.sprite as { pictures?: Record<string, any>[]; sounds?: Record<string, any>[] } | undefined;
    if (!sprite) return object;
    const pictures = sprite.pictures?.map(picture => {
      const label = `오브젝트 '${object.name ?? object.id}'의 모양 '${picture.name ?? picture.id}'`;
      const hash = filename(picture.filename, label);
      const ext = picture.imageType === 'svg' ? 'svg' : 'png';
      const fileurl = add(path(hash, 'image', ext), picture.fileurl, label);
      const pngurl = ext === 'svg' ? add(path(hash, 'image', 'png'), picture.pngurl, `${label} (그림 사본)`) : undefined;
      return { ...picture, fileurl, ...(pngurl ? { pngurl } : {}) };
    });
    const originalSounds = (work.objects[index]?.sprite as { sounds?: Record<string, any>[] } | undefined)?.sounds;
    const sounds = sprite.sounds?.map((sound, soundIndex) => {
      const original = originalSounds?.[soundIndex];
      // Entry keeps empty, zero-duration sound slots in exported projects and
      // does not load them. Preserve that metadata without inventing a file URL.
      if (original && !original.filename && !original.duration && !original.fileurl && !original.path) return { ...original };
      const label = `오브젝트 '${object.name ?? object.id}'의 소리 '${sound.name ?? sound.id}'`;
      const hash = filename(sound.filename, label);
      const ext = String(sound.ext ?? new URL(sound.fileurl, location.href).pathname.split('.').pop() ?? 'mp3').replace(/^\./, '');
      if (!/^[a-z0-9]{1,8}$/i.test(ext)) throw new Error(`소리 확장자를 확인해주세요: ${ext}`);
      return { ...sound, fileurl: add(path(hash, 'sound', ext), sound.fileurl, label) };
    });
    return { ...object, sprite: { ...sprite, ...(pictures ? { pictures } : {}), ...(sounds ? { sounds } : {}) } };
  });
  return { project: { ...normalized, objects }, assets: [...assets.values()] };
}

export function createLocalArchive(work: EntryWork, signal: AbortSignal,
  progress: (done: number, total: number) => void = () => {}): Promise<Blob> {
  signal.throwIfAborted();
  const { project, assets } = localArchiveProject(work);
  const url = URL.createObjectURL(new Blob([`(${localArchiveWorker.toString()})()`], { type: 'text/javascript' }));
  let worker: Worker;
  try { worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const chunks: ArrayBuffer[] = [];
    let finished = false;
    beginAssetBulk();
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true; controller.abort(); signal.removeEventListener('abort', abort);
      worker.terminate(); endAssetBulk();
      if (error !== undefined) reject(error); else resolve(new Blob(chunks, { type: 'application/octet-stream' }));
    };
    const abort = () => finish(signal.reason ?? new DOMException('취소했습니다', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = event => { event.preventDefault(); finish(new Error(event.message || '파일 압축기를 실행하지 못했습니다.')); };
    worker.onmessage = event => {
      if (finished) return;
      const data = event.data;
      if (data.type === 'chunk') chunks.push(data.bytes);
      else if (data.type === 'done') finish();
      else if (data.type === 'error') finish(new Error(data.message));
      else if (data.type === 'progress') progress(data.done, data.total);
      else if (data.type === 'asset') {
        const asset = assets[data.id];
        if (!asset) { finish(new Error('저장할 파일을 찾지 못했습니다.')); return; }
        void fetchAsset(asset.url, controller.signal).then(response => response.blob()).then(blob => {
          if (!finished) worker.postMessage({ type: 'asset', id: data.id, blob });
        }).catch(error => {
          if (!finished) {
            const message = error instanceof Error ? error.message : String(error);
            const status = /\bHTTP (\d{3})\b/.exec(message)?.[1];
            const reason = status ? `파일을 받지 못했습니다 (HTTP ${status}).` : `파일을 받지 못했습니다: ${message}`;
            finish(new Error(`${asset.label}\n파일: ${asset.name.split('/').at(-1)}\n${reason}`));
          }
        });
      }
    };
    try { signal.throwIfAborted(); worker.postMessage({ type: 'start', project, names: assets.map(asset => asset.name) }); }
    catch (error) { finish(error); }
  });
}
