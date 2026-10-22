// Reuse lexer keywords so syntax highlighting stays in sync.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_FUNCTIONS, OPTION_KEYWORDS, STATE_VALUES, OBJECT_PROPERTIES, TEXT_ONLY_PROPERTIES } from '@tess/core/builtins';
import { NAMED_COLORS } from '@tess/core';
import { KEYWORDS } from '@tess/parser';

const here = path.dirname(fileURLToPath(import.meta.url));

const keywords = new Set(KEYWORDS);

// Tess identifiers include underscores and Unicode letters.
const word = (list: Iterable<string>) => `(?<![A-Za-z0-9_])(?:${[...list].sort((a, b) => b.length - a.length).join('|')})(?![A-Za-z0-9_])`;

const DECLARATION = ['project', 'scene', 'object', 'text', 'table', 'function', 'use', 'useobject', 'usetext', 'var', 'list'];
const STORAGE = ['shared', 'realtime'];
const MODIFIER = ['as', 'force', 'id', 'default'];
const CONTROL = ['if', 'else', 'switch', 'case', 'default', 'end', 'then', 'do', 'repeat', 'for', 'while', 'until', 'forever',
  'wait', 'break', 'continue', 'skip', 'restart', 'stop', 'return'];
const EVENT = ['when', 'cloned', 'signal', 'click', 'stage', 'key', 'start'];
const OPERATOR_WORDS = ['and', 'or', 'not', 'in', 'at', 'to', 'from', 'for', 'up'];
const CONSTANTS = ['true', 'false', 'transparent', 'next', 'prev', 'back', 'front', 'first', 'last',
  'all', 'this', 'me', 'them', 'other', 'free', 'vertical', 'none', ...OPTION_KEYWORDS];

const PROPERTIES = [...new Set([...OBJECT_PROPERTIES, ...TEXT_ONLY_PROPERTIES])];

// Match the lexer: a color must end at a word boundary.
const COLOR_NAMES = Object.keys(NAMED_COLORS).sort((a, b) => b.length - a.length).join('|');
const COLOR_BODY = `(?:[0-9a-fA-F]+|(?i:${COLOR_NAMES}))(?![\\p{L}0-9_])`;

// Property keywords take precedence over command keywords.
const claimed = new Set([...DECLARATION, ...STORAGE, ...MODIFIER, ...CONTROL, ...EVENT,
  ...OPERATOR_WORDS, ...CONSTANTS, ...PROPERTIES]);
const COMMANDS = [...keywords].filter((keyword) => !claimed.has(keyword));

const grammar = {
  $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
  name: 'Tess',
  scopeName: 'source.tess',
  patterns: [{ include: '#comment' }, { include: '#string' }, { include: '#color' },
    { include: '#number' }, { include: '#declaration' }, { include: '#function-call' },
    { include: '#keyword' }, { include: '#operator' }, { include: '#punctuation' },
    { include: '#identifier' }],
  repository: {
    // A hex color starts with # but is not a comment.
    comment: {
      name: 'comment.line.number-sign.tess',
      match: `#(?!${COLOR_BODY}).*$`,
    },
    string: {
      name: 'string.quoted.double.tess',
      begin: '"',
      end: '"',
      patterns: [{ name: 'constant.character.escape.tess', match: '\\\\(u[0-9a-fA-F]{4}|.)' }],
    },
    color: {
      name: 'constant.other.color.tess',
      match: `#${COLOR_BODY}`,
    },
    number: {
      name: 'constant.numeric.tess',
      match: '(?<![A-Za-z0-9_])[0-9]+(\\.[0-9]+)?',
    },
    declaration: {
      patterns: [
        {
          match: `(${word(['function'])})\\s+([A-Za-z_\\p{L}][A-Za-z0-9_\\p{L}]*)`,
          captures: { 1: { name: 'keyword.declaration.tess' }, 2: { name: 'entity.name.function.tess' } },
        },
        {
          match: `(${word(['table'])})\\s+([A-Za-z_\\p{L}][A-Za-z0-9_\\p{L}]*)`,
          captures: { 1: { name: 'keyword.declaration.tess' }, 2: { name: 'entity.name.type.tess' } },
        },
        {
          match: `(${word(['var', 'list'])})\\s+([A-Za-z_\\p{L}][A-Za-z0-9_\\p{L}]*)`,
          captures: { 1: { name: 'keyword.declaration.tess' }, 2: { name: 'variable.other.tess' } },
        },
        { name: 'keyword.declaration.tess', match: word(DECLARATION) },
      ],
    },
    'function-call': {
      patterns: [
        {
          name: 'support.function.builtin.tess',
          match: `${word(BUILTIN_FUNCTIONS)}(?=\\s*\\()`,
        },
        {
          match: '([A-Za-z_\\p{L}][A-Za-z0-9_\\p{L}]*)(?=\\s*\\()',
          captures: { 1: { name: 'entity.name.function.tess' } },
        },
      ],
    },
    keyword: {
      patterns: [
        { name: 'constant.language.tess', match: word(CONSTANTS) },
        { name: 'variable.language.tess', match: word(STATE_VALUES) },
        { name: 'storage.modifier.tess', match: word([...STORAGE, ...MODIFIER]) },
        { name: 'keyword.control.tess', match: word(CONTROL) },
        { name: 'keyword.control.event.tess', match: word(EVENT) },
        { name: 'support.variable.property.tess', match: word(PROPERTIES) },
        { name: 'keyword.other.command.tess', match: word(COMMANDS) },
      ],
    },
    operator: {
      patterns: [
        { name: 'keyword.operator.assignment.tess', match: '\\*\\*=|[+\\-*/%]=|=(?!=)' },
        { name: 'keyword.operator.comparison.tess', match: '==|!=|>=|<=|>|<' },
        { name: 'keyword.operator.arithmetic.tess', match: '\\*\\*|//|[+\\-*/%]' },
        { name: 'keyword.operator.word.tess', match: word(OPERATOR_WORDS) },
        { name: 'keyword.operator.optional.tess', match: '\\?' },
      ],
    },
    punctuation: {
      patterns: [
        { name: 'punctuation.section.block.begin.tess', match: ':' },
        { name: 'punctuation.separator.comma.tess', match: ',' },
        { name: 'meta.brace.round.tess', match: '[()]' },
        { name: 'meta.brace.square.tess', match: '[\\[\\]]' },
      ],
    },
    identifier: {
      name: 'variable.other.tess',
      match: '[A-Za-z_\\p{L}][A-Za-z0-9_\\p{L}]*',
    },
  },
};

const out = path.join(here, 'syntaxes', 'tess.tmLanguage.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(grammar, null, 2)}\n`);
console.log(`${path.relative(process.cwd(), out)} 만듦 — 키워드 ${keywords.size}개, 명령 ${COMMANDS.length}개`);
