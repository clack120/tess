// Both browser APIs support promises; keep only the types used here.

export interface StorageChange {
  newValue?: unknown;
  oldValue?: unknown;
}

export interface ExtensionApi {
  storage: {
    local: {
      get(defaults: Record<string, unknown>): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
    };
    onChanged: {
      addListener(
        listener: (changes: Record<string, StorageChange>, area: string) => void,
      ): void;
    };
  };
  runtime: {
    getURL(path: string): string;
    sendMessage?(message: unknown): Promise<unknown>;
    onMessage?: {
      addListener(
        listener: (
          message: unknown,
          sender: unknown,
          sendResponse: (response: unknown) => void,
        ) => boolean | undefined,
      ): void;
    };
  };
}

const globals = globalThis as unknown as { browser?: ExtensionApi; chrome?: ExtensionApi };

export const api = (globals.browser ?? globals.chrome) as ExtensionApi;

export const ENABLED_KEY = 'enabled';
export const SVG_KEY = 'svg';
export const CACHE_KEY = 'assetCache';
export const NATIVE_CACHE_KEY = 'nativeAssetCache';
export const CACHE_CLEAR_KEY = 'assetCacheClear';
export const CACHE_SIZE_KEY = 'assetCacheSize';
// No popup control yet; set this storage key to false to let Escape reach the browser and page.
export const ESCAPE_KEY = 'grabEscape';

export interface Settings {
  enabled: boolean;
  svg: boolean;
  cache: boolean;
  nativeCache: boolean;
  cacheClear: number;
  escape: boolean;
}

export async function readSettings(): Promise<Settings> {
  const stored = await api.storage.local.get({
    [ENABLED_KEY]: true,
    [SVG_KEY]: true,
    [CACHE_KEY]: false,
    [NATIVE_CACHE_KEY]: false,
    [CACHE_CLEAR_KEY]: 0,
    [ESCAPE_KEY]: true,
  });
  return {
    enabled: stored[ENABLED_KEY] !== false,
    svg: stored[SVG_KEY] !== false,
    cache: stored[CACHE_KEY] === true,
    nativeCache: stored[NATIVE_CACHE_KEY] === true,
    cacheClear: Number(stored[CACHE_CLEAR_KEY]) || 0,
    escape: stored[ESCAPE_KEY] !== false,
  };
}

export async function write(key: string, value: boolean): Promise<void> {
  await api.storage.local.set({ [key]: value });
}
