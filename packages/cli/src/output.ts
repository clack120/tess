import process from 'node:process';
import path from 'node:path';
import type { CompileDiagnostic, PhaseTiming } from '@tess/compiler';

const COLORED = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';
})();

const wrap = (open: number, close: number) => (text: unknown) => (
  COLORED ? `\u001b[${open}m${text}\u001b[${close}m` : String(text)
);

export const dim = wrap(2, 22);
export const bold = wrap(1, 22);
export const red = wrap(31, 39);
export const yellow = wrap(33, 39);
export const green = wrap(32, 39);
export const cyan = wrap(36, 39);
export const grey = wrap(90, 39);
const blue = wrap(34, 39);

const S_BAR = '│';
const S_STEP_SUBMIT = '◇';
const S_ERROR = '■';

const print = (text: string) => process.stdout.write(`${text}\n`);
// Continue multi-line messages under the left guide bar.
const guided = (symbol: string, text: string) =>
  `${grey(S_BAR)}\n${symbol}  ${text.split('\n').join(`\n${grey(S_BAR)}  `)}`;

export const log = {
  message: (text: string, { symbol = grey(S_BAR) }: { symbol?: string } = {}) => print(guided(symbol, text)),
  info: (text: string) => log.message(text, { symbol: blue('●') }),
  success: (text: string) => log.message(text, { symbol: green('◆') }),
  warn: (text: string) => log.message(text, { symbol: yellow('▲') }),
  error: (text: string) => log.message(text, { symbol: red(S_ERROR) }),
};

export function note(text: string, title = '') {
  print(guided(green(S_STEP_SUBMIT), title ? `${title}\n${text}` : text));
}

export function outro(text: string) {
  print(`${grey(S_BAR)}\n${grey('└')}  ${text}\n`);
}

function intro(text: string) {
  print(`${grey('┌')}  ${text}`);
}

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

export function displayWidth(text: unknown): number {
  let width = 0;
  for (const ch of String(text)) width += WIDE.test(ch) ? 2 : 1;
  return width;
}

const padTo = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - displayWidth(text)));

export function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

const STEP_LABEL_WIDTH = 18;

export function begin(command: string, file: string) {
  intro(`${bold(cyan('tess'))} ${command}${file ? ` ${dim(path.basename(file))}` : ''}`);
}

export function step({ label, ms }: PhaseTiming) {
  process.stdout.write(`${stepLine(green(S_STEP_SUBMIT), timed(label, ms))}\n`);
}

const FRAMES = ['◒', '◐', '◓', '◑'];
const ANIMATED = COLORED && Boolean(process.stdout.isTTY);

const stepLine = (symbol: string, text: string) => `${grey(S_BAR)}  ${symbol}  ${text}`;
const timed = (label: string, ms: number) => `${padTo(label, STEP_LABEL_WIDTH)} ${dim(duration(ms).padStart(6))}`;

export function working(title: string) {
  const started = performance.now();
  let frame = 0;
  const paint = () => {
    process.stdout.write(`\r${stepLine(cyan(FRAMES[frame % FRAMES.length]), title)}`);
    frame += 1;
  };
  const spin = ANIMATED ? setInterval(paint, 120) : null;
  if (ANIMATED) paint();

  const finish = (symbol: string, text: string) => {
    if (spin) {
      clearInterval(spin);
      process.stdout.write('\r\u001b[K');
    }
    process.stdout.write(`${stepLine(symbol, text)}\n`);
  };
  return {
    done: (label: string) => finish(green(S_STEP_SUBMIT), timed(label, performance.now() - started)),
    fail: (message: string) => finish(red(S_ERROR), message),
  };
}

function diagnostic(label: string, item: CompileDiagnostic, muted = false): string {
  const file = item.file ?? label;
  const where = path.isAbsolute(file) ? path.relative(process.cwd(), file) : file;
  const paint = muted ? grey : cyan;
  const head = `${paint(`${where}:${item.line}:${item.column}`)}  ${item.code ? `[${item.code}] ` : ''}${muted ? dim(item.message) : item.message}`;
  return [
    head,
    ...(item.detail ? [dim(item.detail)] : []),
    ...(item.related ?? []).map(other => `참고: ${diagnostic(label, other, muted)}`),
    ...(item.help ? [`도움말: ${item.help}`] : []),
  ].join('\n');
}

const REPORT_STYLES = {
  '에러': { paint: red, muted: false, write: (text: string) => log.error(text) },
  '경고': { paint: yellow, muted: false, write: (text: string) => log.warn(text) },
  '주의': {
    paint: grey,
    muted: true,
    write: (text: string) => log.message(text, { symbol: dim('·') }),
  },
} as const;

export type ReportKind = keyof typeof REPORT_STYLES;

export function report(label: string, diagnostics: CompileDiagnostic[], kind: ReportKind) {
  if (diagnostics.length === 0) return;

  const style = REPORT_STYLES[kind];
  const lines = [
    style.paint(`${kind} ${diagnostics.length}개`),
    ...diagnostics.map((item) => diagnostic(label, item, style.muted)),
  ];
  style.write(lines.join('\n'));
}

export function details(rows: Array<[string, string]>): string {
  const width = Math.max(...rows.map(([name]) => displayWidth(name)));
  return rows.map(([name, value]) => `${dim(padTo(name, width))}  ${value}`).join('\n');
}
