const CONTEXT = 2;
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/u;
const padding = (text: string) => text.replace(/[^\t]/gu, ch => WIDE.test(ch) ? '  ' : ' ');

export function codeFrame(source: string, line: number, column: number, message: string, endColumn = column + 1): string {
  const lines = source.split('\n');
  const first = Math.max(1, line - CONTEXT);
  const last = Math.min(lines.length, line + CONTEXT);
  const gutter = String(last).length;
  const out: string[] = [];
  for (let at = first; at <= last; at += 1) {
    const number = String(at).padStart(gutter, ' ');
    const text = (lines[at - 1] ?? '').replace(/\r$/, '');
    out.push(`${at === line ? '>' : ' '} ${number} | ${text}`);
    if (at !== line) continue;
    // Keep tab columns and wide characters aligned with terminal output.
    const before = padding(text.slice(0, Math.max(0, column - 1)));
    const marked = padding(text.slice(Math.max(0, column - 1), Math.max(column, endColumn) - 1));
    const caret = before + '^'.repeat(Math.max(1, marked.length));
    out.push(`  ${' '.repeat(gutter)} | ${caret}${message ? ` ${message}` : ''}`);
  }
  return out.join('\n');
}
