// Self-contained so both the extension and the single-file userscript can start
// the same worker from a Blob URL, without cross-origin module-worker imports.
export function localArchiveWorker(): void {
  const scope = globalThis as unknown as {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage(message: unknown, transfer?: Transferable[]): void;
  };
  const files = new Map<number, { resolve(blob: Blob): void; reject(error: Error): void }>();
  const encoder = new TextEncoder();
  const block = 512;
  function header(name: string, size: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(block);
    const write = (value: string, offset: number, length: number) => {
      const encoded = encoder.encode(value);
      if (encoded.length > length) throw new Error(`파일 경로가 너무 깁니다: ${name}`);
      bytes.set(encoded, offset);
    };
    const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, '0') + '\0';
    write(name, 0, 100); write(octal(0o644, 8), 100, 8);
    write(octal(0, 8), 108, 8); write(octal(0, 8), 116, 8);
    write(octal(size, 12), 124, 12); write(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
    write('0', 156, 1); write('ustar\0' + '00', 257, 8);
    bytes.fill(32, 148, 156);
    const checksum = bytes.reduce((sum, value) => sum + value, 0);
    write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    return bytes;
  }
  function read(id: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
      files.set(id, { resolve, reject }); scope.postMessage({ type: 'asset', id });
    });
  }
  async function* contents(name: string, blob: Blob): AsyncGenerator<Uint8Array<ArrayBuffer>> {
    yield header(name, blob.size);
    const reader = blob.stream().getReader();
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; yield value; }
    } finally { reader.releaseLock(); }
    if (blob.size % block) yield new Uint8Array(block - blob.size % block);
  }
  async function build(project: unknown, names: string[]): Promise<void> {
    async function* tar(): AsyncGenerator<Uint8Array<ArrayBuffer>> {
      // Stringify and UTF-8 conversion stay off the editor's main thread.
      yield* contents('temp/project.json', new Blob([JSON.stringify(project)], { type: 'application/json' }));
      const pending = new Map<number, Promise<Blob>>();
      const prefetch = (id: number) => {
        if (id < names.length) {
          const job = read(id); job.catch(() => {}); pending.set(id, job);
        }
      };
      for (let id = 0; id < Math.min(6, names.length); id++) prefetch(id);
      for (let id = 0; id < names.length; id++) {
        const blob = await pending.get(id)!; pending.delete(id);
        yield* contents(names[id]!, blob);
        prefetch(id + 6);
        scope.postMessage({ type: 'progress', done: id + 1, total: names.length });
      }
      yield new Uint8Array(block * 2);
    }
    const iterator = tar();
    const stream = new ReadableStream<BufferSource>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close(); else controller.enqueue(next.value);
        } catch (error) { controller.error(error); }
      },
      async cancel() { await iterator.return(undefined); },
    }).pipeThrough(new CompressionStream('gzip'));
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      const bytes = value.slice(); scope.postMessage({ type: 'chunk', bytes: bytes.buffer }, [bytes.buffer]);
    }
    scope.postMessage({ type: 'done' });
  }
  scope.onmessage = event => {
    const data = event.data;
    if (data.type === 'start') {
      void build(data.project, data.names).catch(error => scope.postMessage({ type: 'error', message: String(error?.message ?? error) }));
    } else if (data.type === 'asset') {
      const waiting = files.get(data.id); files.delete(data.id);
      if (data.error) waiting?.reject(new Error(data.error)); else waiting?.resolve(data.blob);
    }
  };
}
