// Match save requests and replies by ID across the page, content script, and worker.
import type { SaveHost, StoredValue } from "../../../vm/src/runtime/save.ts";

const TIMEOUT = 5000;

interface Answer {
  values?: Record<string, StoredValue>;
  error?: boolean;
}

const waiting = new Map<number, (answer: Answer) => void>();
let nextId = 1;
let listening = false;

function listen(): void {
  if (listening) {
    return;
  }
  listening = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data as { __entropy?: string; id?: number; answer?: Answer } | null;
    if (!data || data.__entropy !== "store-answer") {
      return;
    }
    const done = waiting.get(Number(data.id));
    if (done) {
      waiting.delete(Number(data.id));
      done(data.answer ?? {});
    }
  });
}

function ask(message: Record<string, unknown>): Promise<Answer> {
  listen();
  const id = nextId++;
  return new Promise<Answer>((done) => {
    // Time out unanswered saves so disabling the extension cannot leave the work waiting forever.
    const timer = window.setTimeout(() => {
      waiting.delete(id);
      done({ error: true });
    }, TIMEOUT);
    waiting.set(id, (answer) => {
      window.clearTimeout(timer);
      done(answer);
    });
    window.postMessage({ ...message, id }, location.origin);
  });
}

export function bridgeSaveStore(work: string, title: string): SaveHost {
  return {
    async read() {
      const answer = await ask({ __entropy: "store-read", work });
      return answer.values ?? {};
    },
    async write(values) {
      await ask({ __entropy: "store-write", work, title, values });
    },
  };
}
