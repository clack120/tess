const CONTEXT = 2;
const MAX_LINE = 180;
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/u;
const padding = (text: string) => text.replace(/[^\t]/gu, ch => WIDE.test(ch) ? '  ' : ' ');

export function codeFrame(source: string, line: number, column: number, message: string, endColumn = column + 1): string {
  return createCodeFrame(source)(line, column, message, endColumn);
}

// Split each file once when rendering several diagnostics.
export function createCodeFrame(source: string) {
  const lines = source.split('\n');
  return (line: number, column: number, message = '', endColumn = column + 1): string => {
    const first = Math.max(1, line - CONTEXT);
    const last = Math.min(lines.length, line + CONTEXT);
    const gutter = String(last).length;
    const out: string[] = [];
    for (let at = first; at <= last; at += 1) {
      const number = String(at).padStart(gutter, ' ');
      const original = (lines[at - 1] ?? '').replace(/\r$/, '');
      const cursor = Math.min(original.length, Math.max(0, column - 1));
      let start = at === line && original.length > MAX_LINE ? Math.max(0, cursor - 60) : 0;
      if (start > 0 && /[\uDC00-\uDFFF]/.test(original[start]!)) start--;
      const text = original.slice(start, start + MAX_LINE);
      const prefix = start ? '… ' : '';
      const suffix = start + text.length < original.length ? ' …' : '';
      out.push(`${at === line ? '>' : ' '} ${number} | ${prefix}${text}${suffix}`);
      if (at !== line) continue;
      // Keep tab columns and wide characters aligned with terminal output.
      const before = ' '.repeat(prefix.length) + padding(text.slice(0, cursor - start));
      const marked = padding(text.slice(cursor - start, Math.max(column, endColumn) - 1 - start));
      const caret = before + '^'.repeat(Math.max(1, marked.length));
      out.push(`  ${' '.repeat(gutter)} | ${caret}${message ? ` ${message}` : ''}`);
    }
    return out.join('\n');
  };
}
