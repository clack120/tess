// Store data in the extension so the popup can read the same saves as the worker.
import { api } from './browser.ts';
import { readWork, writeWork, type StoredValue } from './store-db.ts';

export interface StoreRequest {
  __entropy: 'store-read' | 'store-write';
  work: string;
  title?: string;
  values?: Record<string, StoredValue>;
}

export function answer(message: StoreRequest): Promise<unknown> | undefined {
  if (message?.__entropy === 'store-read') {
    return readWork(message.work).then((values) => ({ values }));
  }
  if (message?.__entropy === 'store-write') {
    return writeWork(message.work, message.title ?? '', message.values ?? {}).then(() => ({
      ok: true,
    }));
  }
  return undefined;
}

api.runtime.onMessage?.addListener((message, _sender, sendResponse) => {
  const reply = answer(message as StoreRequest);
  if (!reply) {
    return false;
  }
  // Return true to keep the message channel open until the write completes.
  void reply.then(
    (value) => sendResponse(value),
    () => sendResponse({ error: true }),
  );
  return true;
});
