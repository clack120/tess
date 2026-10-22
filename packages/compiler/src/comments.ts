import { colorLiteralLength } from '@tess/core';
import type { Node } from '@tess/parser';
import type { EntryComment } from './types.ts';

interface ScannedComment {
  start: number;
  end: number;
  text: string;
}

type AnyNode = Record<string, unknown> & { type?: string; loc?: { file?: string; start: number } };

const ATTACHABLE = new Set([
  'Event',
  'If', 'Switch', 'Repeat', 'For', 'While', 'Until', 'Forever', 'Wait', 'Break', 'Continue', 'Skip', 'Restart', 'Return',
  'Stop', 'StopSound', 'StopBgm', 'StopDraw', 'StopFill', 'StopTimer',
  'StartDraw', 'StartFill', 'StartTimer', 'ResetSize', 'ResetTimer', 'Clear',
  'Send', 'Clone', 'DeleteClone', 'DeleteClones', 'Jump',
  'Forward', 'Bounce', 'Move', 'Go', 'Turn', 'Steer', 'Look',
  'Show', 'Hide', 'CostumeStep', 'Say', 'Think', 'Flip', 'Order',
  'TextWrite', 'Stamp', 'PlaySound', 'PlayBgm',
  'ListAdd', 'ListInsert', 'ListRemove', 'Ask',
  'VarDecl', 'ListDecl', 'Assign', 'ExpressionStatement',
]);

export function makeComment(value: string): EntryComment {
  return {
    x: 240,
    y: -10,
    width: 160,
    height: 100,
    value,
    readOnly: false,
    visible: true,
    display: true,
    movable: true,
    isOpened: true,
    deletable: 1,
    type: 'comment',
  };
}

export function scanComments(source: string): ScannedComment[] {
  const comments: ScannedComment[] = [];

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (ch === '"') {
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }

    if (ch !== '#') continue;

    // Use the lexer's color rules so hex colors are not treated as comments.
    const color = colorLiteralLength(source, i);
    if (color) {
      i += color - 1;
      continue;
    }

    let end = i;
    while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end += 1;
    comments.push({ start: i, end, text: source.slice(i + 1, end).trim() });
    i = end;
  }
  return comments;
}

export function buildCommentMap(ast: Node, sources: Map<string, string>): Map<string, string> {
  const nodesByFile = new Map<string, AnyNode[]>();
  collectNodes(ast, nodesByFile);

  const map = new Map<string, string>();
  for (const [file, nodes] of nodesByFile) {
    const source = sources.get(file);
    if (!source) continue;
    attachInFile(source, file, nodes, map);
  }
  return map;
}

export function commentKey(node: Node | AnyNode | null | undefined): string {
  const loc = (node as AnyNode | null | undefined)?.loc;
  return `${loc?.file ?? ''} ${loc?.start ?? -1}`;
}

function collectNodes(node: unknown, out: Map<string, AnyNode[]>) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child) => collectNodes(child, out));
    return;
  }
  const item = node as AnyNode;
  const file = item.loc?.file;
  if (item.type !== undefined && ATTACHABLE.has(item.type) && file) {
    if (!out.has(file)) out.set(file, []);
    out.get(file)!.push(item);
  }
  for (const [key, value] of Object.entries(item)) {
    if (key !== 'loc') collectNodes(value, out);
  }
}

function attachInFile(source: string, file: string, nodes: AnyNode[], map: Map<string, string>) {
  const comments = scanComments(source);
  if (comments.length === 0) return;

  const lineOf = makeLineFinder(source);
  const sorted = [...nodes].sort((a, b) => a.loc!.start - b.loc!.start);
  const remaining: ScannedComment[] = [];

  // Attach a trailing comment to the last statement on its line.
  for (const comment of comments) {
    const before = sorted[firstAfter(sorted, comment.start - 1) - 1];
    const owner = before && lineOf(before.loc!.start) === lineOf(comment.start) ? before : null;
    if (owner) append(map, commentKey(owner), comment.text);
    else remaining.push(comment);
  }

  // Attach a comment group to the statement directly below it.
  for (let i = 0; i < remaining.length; i += 1) {
    const group = [remaining[i]!];
    while (
      i + 1 < remaining.length
      && onlySpaceBetween(source, group[group.length - 1]!.end, remaining[i + 1]!.start)
    ) {
      group.push(remaining[i + 1]!);
      i += 1;
    }
    const last = group[group.length - 1]!;
    const owner = sorted[firstAfter(sorted, last.end)];
    if (owner && onlySpaceBetween(source, last.end, owner.loc!.start)) {
      append(map, commentKey(owner), group.map((comment) => comment.text).join('\n'));
    }
  }
}

function append(map: Map<string, string>, key: string, text: string) {
  map.set(key, map.has(key) ? `${map.get(key)}\n${text}` : text);
}

function firstAfter(list: AnyNode[], offset: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid]!.loc!.start > offset) high = mid;
    else low = mid + 1;
  }
  return low;
}

function onlySpaceBetween(source: string, from: number, to: number) {
  return to >= from && /^\s*$/.test(source.slice(from, to));
}

function makeLineFinder(source: string) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1);
  return (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}
