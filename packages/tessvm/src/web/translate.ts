import type { Translator } from '../runtime/engine.ts';

const API = '/api/expansionBlock/papago/';
const ENGINE = 'n2mt';
const TIMEOUT_MS = 3000;

export class EntryTranslator implements Translator {
  // Use the same-origin translation path; the local server proxies it to Entry.
  private async call(path: string, query: Record<string, string>): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(`${API}${path}?${new URLSearchParams(query)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return response.ok ? ((await response.json()) as Record<string, unknown>) : {};
    } catch (error) {
      // Return the block's default after refusal, network failure, or timeout.
      console.warn('[tessvm] 번역·언어 감지 요청이 실패해 기본값을 씁니다', error);
      return {};
    }
  }

  async translate(text: string, source: string, target: string): Promise<string> {
    const body = await this.call(`translate/${ENGINE}`, { text, source, target });
    return typeof body.translatedText === 'string' ? body.translatedText : '';
  }

  async detect(text: string): Promise<string> {
    const body = await this.call('dect/langs', { query: text });
    return typeof body.langCode === 'string' ? body.langCode : '';
  }
}
