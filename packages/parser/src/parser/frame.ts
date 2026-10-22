/**
 * @fileoverview The code frame an error is shown with.
 *
 * A few lines of the source around the failure, numbered, with a caret under
 * the column and the message beside it — the shape `@babel/code-frame` prints,
 * written here so the parser carries no dependency into a browser build.
 */

/** Lines shown above and below the one that failed. */
const CONTEXT = 2;
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/u;
const padding = (text: string) => text.replace(/[^\t]/gu, ch => WIDE.test(ch) ? '  ' : ' ');

/**
 * @param source 원본 소스 코드
 * @param line   1부터 세는 줄 번호
 * @param column 1부터 세는 칸 번호
 * @param message 캐럿 옆에 적을 말
 */
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
    // Keep tabs at the same terminal columns, and count Korean characters as two cells.
    const before = padding(text.slice(0, Math.max(0, column - 1)));
    const marked = padding(text.slice(Math.max(0, column - 1), Math.max(column, endColumn) - 1));
    const caret = before + '^'.repeat(Math.max(1, marked.length));
    out.push(`  ${' '.repeat(gutter)} | ${caret}${message ? ` ${message}` : ''}`);
  }
  return out.join('\n');
}
