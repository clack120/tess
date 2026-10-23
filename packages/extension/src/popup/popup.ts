import { api, readSettings, write, ENABLED_KEY, SVG_KEY, CACHE_KEY, CACHE_SIZE_KEY } from '../browser.ts';
import {
  clearWorks, exportAll, exportName, importAll, listWorks, removeWork, type SavedSummary,
} from '../store-db.ts';

const power = document.getElementById('enabled') as HTMLButtonElement;
const svg = document.getElementById('svg') as HTMLInputElement;
const cache = document.getElementById('cache') as HTMLInputElement;
const cacheSize = document.getElementById('cache-size') as HTMLElement;
const chip = document.getElementById('chip') as HTMLElement;
const saves = document.getElementById('saves') as HTMLElement;
const savesEmpty = document.getElementById('saves-empty') as HTMLElement;
const clearAll = document.getElementById('clear') as HTMLButtonElement;
const exportButton = document.getElementById('export') as HTMLButtonElement;
const importButton = document.getElementById('import') as HTMLButtonElement;
const file = document.getElementById('file') as HTMLInputElement;
const savesNote = document.getElementById('saves-note') as HTMLElement;
const state = document.getElementById('state') as HTMLElement;
const note = document.getElementById('note') as HTMLElement;

const TEXT = {
  on: {
    chip: '켜짐',
    state: 'entropy로 실행 중',
    note: ['작품 페이지의 실행 화면을 Entropy가 대신합니다.', '눌러서 끌 수 있습니다.'],
  },
  off: {
    chip: '꺼짐',
    state: '엔트리 기본 실행기',
    note: ['작품 페이지를 원래대로 둡니다.', '눌러서 Entropy 실행기를 켭니다.'],
  },
};

function lines(text: string[]): Node[] {
  return text.flatMap((line, index) =>
    index === 0
      ? [document.createTextNode(line)]
      : [document.createElement('br'), document.createTextNode(line)],
  );
}

function paint(on: boolean): void {
  const text = on ? TEXT.on : TEXT.off;
  power.setAttribute('aria-checked', String(on));
  document.body.classList.toggle('is-off', !on);
  chip.textContent = text.chip;
  state.textContent = text.state;
  note.replaceChildren(...lines(text.note));
}

power.addEventListener('click', () => {
  const on = power.getAttribute('aria-checked') !== 'true';
  paint(on);
  void write(ENABLED_KEY, on);
});

svg.addEventListener('change', () => {
  void write(SVG_KEY, svg.checked);
});

cache.addEventListener('change', () => {
  void write(CACHE_KEY, cache.checked);
});

// Pages report the size after loading a work, so this shows the last known value.
function paintCacheSize(value: unknown): void {
  const size = value as { count?: number; bytes?: number } | null;
  cacheSize.hidden = !size?.count;
  if (size?.count) cacheSize.textContent = `저장한 파일 ${size.count.toLocaleString('ko-KR')}개 · ${byteText(size.bytes ?? 0)}`;
}

function byteText(bytes: number): string {
  if (bytes < 1024 * 1024) return sizeText(bytes);
  const mb = bytes / 1024 / 1024;
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(2)} GB`;
}

void api.storage.local.get({ [CACHE_SIZE_KEY]: null }).then((stored) => paintCacheSize(stored[CACHE_SIZE_KEY]));
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && CACHE_SIZE_KEY in changes) paintCacheSize(changes[CACHE_SIZE_KEY]?.newValue);
});

void readSettings().then((settings) => {
  svg.checked = settings.svg;
  cache.checked = settings.cache;
  paint(settings.enabled);
});

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

const when = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' });

// Confirm deletion in place because opening a dialog can close the popup.
function confirmingButton(label: string, sure: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  let asked = false;
  const reset = () => {
    asked = false;
    button.textContent = label;
    button.classList.remove('is-sure');
  };
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (asked) {
      reset();
      run();
      return;
    }
    asked = true;
    button.textContent = sure;
    button.classList.add('is-sure');
  });
  button.addEventListener('blur', reset);
  return button;
}

function saveRow(saved: SavedSummary, again: () => void): HTMLLIElement {
  const row = document.createElement('li');
  row.className = 'save';
  const text = document.createElement('span');
  text.className = 'save-text';
  const title = document.createElement('span');
  title.className = 'save-title';
  title.textContent = saved.title;
  title.title = saved.work;
  const meta = document.createElement('span');
  meta.className = 'save-meta';
  meta.textContent = `${saved.names}개 · ${sizeText(saved.bytes)}`
    + (saved.updated ? ` · ${when.format(saved.updated)}` : '');
  text.append(title, meta);

  const drop = confirmingButton('삭제', '정말 삭제', () => {
    void removeWork(saved.work).then(again);
  });
  drop.className = 'save-drop';
  row.append(text, drop);
  return row;
}

const clearButton = confirmingButton('전체 삭제', '정말 전체 삭제', () => {
  void clearWorks().then(() => paintSaves());
});
clearButton.id = 'clear';
clearButton.className = 'link';
clearButton.hidden = true;
clearAll.replaceWith(clearButton);

async function paintSaves(): Promise<void> {
  const rows = await listWorks().catch((error) => {
    console.warn('[entropy] 저장된 작품 목록을 읽지 못했습니다', error);
    return [];
  });
  saves.replaceChildren(...rows.map((row) => saveRow(row, () => void paintSaves())));
  savesEmpty.hidden = rows.length > 0;
  clearButton.hidden = rows.length === 0;
}

void paintSaves();

function say(text: string, bad = false): void {
  savesNote.textContent = text;
  savesNote.classList.toggle('is-bad', bad);
  savesNote.hidden = text === '';
}

exportButton.addEventListener('click', () => {
  say('');
  void exportAll().then(
    (blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exportName();
      link.click();
      // Release the blob URL after the browser reads the download.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      say(`${exportName()} 으로 내보냈습니다.`);
    },
    () => say('내보내지 못했습니다.', true),
  );
});

importButton.addEventListener('click', () => {
  say('');
  file.click();
});

file.addEventListener('change', () => {
  const picked = file.files?.[0];
  // Clear the input so selecting the same file again still triggers a change.
  file.value = '';
  if (!picked) {
    return;
  }
  importButton.disabled = true;
  void importAll(picked)
    .then(
      (works) => {
        say(`작품 ${works}개를 가져왔습니다.`);
        return paintSaves();
      },
      (error: Error) => say(error?.message || '가져오지 못했습니다.', true),
    )
    .finally(() => {
      importButton.disabled = false;
    });
});
