// Reuse lexer keywords so syntax highlighting stays in sync.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_FUNCTIONS, OPTION_KEYWORDS, STATE_VALUES, OBJECT_PROPERTIES, TEXT_ONLY_PROPERTIES } from '@entropy/core/builtins';
import { NAMED_COLORS } from '@entropy/core';
import { KEYWORDS } from '@entropy/parser';

const here = path.dirname(fileURLToPath(import.meta.url));

const keywords = new Set(KEYWORDS);

// Entropy identifiers include underscores and Unicode letters.
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
  name: 'Entropy',
  scopeName: 'source.etp',
  patterns: [{ include: '#comment' }, { include: '#string' }, { include: '#color' },
    { include: '#number' }, { include: '#declaration' }, { include: '#function-call' },
    { include: '#keyword' }, { include: '#operator' }, { include: '#punctuation' },
    { include: '#identifier' }],
  repository: {
    // A hex color starts with # but is not a comment.
    comment: {
      name: 'comment.line.number-sign.etp',
      match: `#(?!${COLOR_BODY}).*$`,
    },
    string: {
      name: 'string.quoted.double.etp',
      begin: '"',
      end: '"',
      patterns: [{ name: 'constant.character.escape.etp', match: '\\\\(u[0-9a-fA-F]{4}|.)' }],
    },
    color: {
      name: 'constant.other.color.etp',
      match: `#${COLOR_BODY}`,
    },
    number: {
      name: 'constant.numeric.etp',
      match: '(?<![A-Za-z0-9_])[0-9]+(\\.[0-9]+)?',
    },
    declaration: {
      patterns: [
        {
          match: `(${word(['function'])})\\s+([A-Za-z_\\p{L}][A-Za-z0-9_\\p{L}]*)`,
          captures: { 1: { name: 'keyword.declaration.etp' }, 2: { name: 'entity.name.function.etp' } },
        },
        {
          match: `(${word(['table'])})\\s+([A-Za-z_\\p{L}][A-Za-z0-9_\\p{L}]*)`,
          captures: { 1: { name: 'keyword.declaration.etp' }, 2: { name: 'entity.name.type.etp' } },
        },
        {
          match: `(${word(['var', 'list'])})\\s+([A-Za-z_\\p{L}][A-Za-z0-9_\\p{L}]*)`,
          captures: { 1: { name: 'keyword.declaration.etp' }, 2: { name: 'variable.other.etp' } },
        },
        { name: 'keyword.declaration.etp', match: word(DECLARATION) },
      ],
    },
    'function-call': {
      patterns: [
        {
          name: 'support.function.builtin.etp',
          match: `${word(BUILTIN_FUNCTIONS)}(?=\\s*\\()`,
        },
        {
          match: '([A-Za-z_\\p{L}][A-Za-z0-9_\\p{L}]*)(?=\\s*\\()',
          captures: { 1: { name: 'entity.name.function.etp' } },
        },
      ],
    },
    keyword: {
      patterns: [
        { name: 'constant.language.etp', match: word(CONSTANTS) },
        { name: 'variable.language.etp', match: word(STATE_VALUES) },
        { name: 'storage.modifier.etp', match: word([...STORAGE, ...MODIFIER]) },
        { name: 'keyword.control.etp', match: word(CONTROL) },
        { name: 'keyword.control.event.etp', match: word(EVENT) },
        { name: 'support.variable.property.etp', match: word(PROPERTIES) },
        { name: 'keyword.other.command.etp', match: word(COMMANDS) },
      ],
    },
    operator: {
      patterns: [
        { name: 'keyword.operator.assignment.etp', match: '\\*\\*=|[+\\-*/%]=|=(?!=)' },
        { name: 'keyword.operator.comparison.etp', match: '==|!=|>=|<=|>|<' },
        { name: 'keyword.operator.arithmetic.etp', match: '\\*\\*|//|[+\\-*/%]' },
        { name: 'keyword.operator.word.etp', match: word(OPERATOR_WORDS) },
        { name: 'keyword.operator.optional.etp', match: '\\?' },
      ],
    },
    punctuation: {
      patterns: [
        { name: 'punctuation.section.block.begin.etp', match: ':' },
        { name: 'punctuation.separator.comma.etp', match: ',' },
        { name: 'meta.brace.round.etp', match: '[()]' },
        { name: 'meta.brace.square.etp', match: '[\\[\\]]' },
      ],
    },
    identifier: {
      name: 'variable.other.etp',
      match: '[A-Za-z_\\p{L}][A-Za-z0-9_\\p{L}]*',
    },
  },
};

const out = path.join(here, 'syntaxes', 'entropy.tmLanguage.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(grammar, null, 2)}\n`);
console.log(`${path.relative(process.cwd(), out)} 만듦 — 키워드 ${keywords.size}개, 명령 ${COMMANDS.length}개`);
