import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const entry = path.join(root, 'node_modules/@entrylabs/entry');
const blocksDir = path.join(entry, 'src/playground/blocks');
const outputDir = path.join(root, 'packages/core/src');
const languageSource = fs.readFileSync(path.join(entry, 'extern/lang/ko.js'), 'utf-8');
const labels = Function(`${languageSource}; return Lang.Blocks`)() as Record<string, string>;

function categoryMap(name: string): Record<string, any> {
  const source = fs.readFileSync(path.join(blocksDir, name), 'utf-8');
  const fn = source.indexOf('function getInitialCategoryMap()');
  const returned = source.indexOf('return', fn);
  const start = source.indexOf('{', returned);
  let depth = 0;
  let end = -1;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) {
      end = index + 1;
      break;
    }
  }
  assert.ok(start > 0 && end > start, `${name}: getInitialCategoryMap을 찾지 못했습니다.`);
  const object = source.slice(start, end).replace(
    /Lang\.Blocks\.([A-Za-z0-9_]+)/g,
    (_, key: string) => JSON.stringify(key),
  );
  return Function(`return (${object})`)();
}

function weatherLocations(): Record<string, any> {
  const source = fs.readFileSync(path.join(blocksDir, 'block_expansion_weather.js'), 'utf-8');
  const start = source.indexOf('    locationMap: {') + '    locationMap: '.length;
  const end = source.indexOf('\n    propertyMap:', start);
  assert.ok(start > 0 && end > start, 'weather locationMap을 찾지 못했습니다.');
  return Function(`return (${source.slice(start, end).trim().replace(/,$/, '')})`)();
}

const parentLabels: Record<string, [string, string]> = {
  Seoul: ['seoul', '서울'], Busan: ['busan', '부산'], Daegu: ['daegu', '대구'],
  Incheon: ['incheon', '인천'], Gwangju: ['gwangju', '광주'], Daejeon: ['daejeon', '대전'],
  Ulsan: ['ulsan', '울산'], Sejong: ['sejong', '세종'],
  'Gyeonggi-do': ['gyeonggi', '경기'], Gangwon: ['gangwon', '강원'],
  'Chungcheongbuk-do': ['chungcheongbuk', '충북'],
  'Chungcheongnam-do': ['chungcheongnam', '충남'],
  'Jeollabuk-do': ['jeollabuk', '전북'], 'Jeollanam-do': ['jeollanam', '전남'],
  'Gyeongsangbuk-do': ['gyeongsangbuk', '경북'],
  'Gyeongsangnam-do': ['gyeongsangnam', '경남'], Jeju: ['jeju', '제주'],
};

function weatherSource(): string {
  const lines = [
    '// Generated from installed @entrylabs/entry. After upgrading it, run:',
    '// bun packages/core/tools/update-entry-expansion-data.ts',
    'export const ENTRY_WEATHER_LOCATIONS = {',
  ];
  for (const [parent, item] of Object.entries(weatherLocations())) {
    const [langKey, label] = parentLabels[parent]!;
    lines.push(`  ${JSON.stringify(parent)}: { label: ${JSON.stringify(label)}, code: ${JSON.stringify(item.code)}, sub: {`);
    for (const [slug, code] of Object.entries(item.sub as Record<string, string>)) {
      let key = `location_${langKey}_${slug}`;
      if (parent === 'Daejeon' && slug === 'western') key = 'location_daejeon_seo_gu';
      if (parent === 'Gangwon' && slug === 'sokcho city') key = 'location_gangwon_sokcho';
      lines.push(`    ${JSON.stringify(slug)}: { label: ${JSON.stringify(labels[key] ?? slug)}, code: ${JSON.stringify(code)} },`);
    }
    lines.push('  } },');
  }
  lines.push(
    '} as const;', '',
    'export type EntryWeatherArea = keyof typeof ENTRY_WEATHER_LOCATIONS;', '',
    'const AREA_ALIASES: Record<string, EntryWeatherArea> = Object.fromEntries(',
    '  Object.entries(ENTRY_WEATHER_LOCATIONS).flatMap(([value, item]) => [',
    '    [value, value], [item.label, value],',
    '  ]),',
    ') as Record<string, EntryWeatherArea>;', '',
    'export function entryWeatherAreaValue(value: string): string {',
    '  return AREA_ALIASES[value] ?? value;',
    '}', '',
    'export function entryWeatherSubareaValue(parent: string, value: string): string {',
    '  const area = ENTRY_WEATHER_LOCATIONS[entryWeatherAreaValue(parent) as EntryWeatherArea];',
    '  if (!area) return value;',
    "  const english = value.toLowerCase().replaceAll('-', '_');",
    '  for (const [slug, item] of Object.entries(area.sub)) {',
    '    if (value === slug || english === slug || value === item.label) return slug;',
    '  }',
    '  return value;',
    '}', '',
    'export function entryWeatherAreaCode(parent: string, sub?: string): string {',
    '  const area = ENTRY_WEATHER_LOCATIONS[entryWeatherAreaValue(parent) as EntryWeatherArea];',
    '  if (!area) return ENTRY_WEATHER_LOCATIONS.Seoul.code;',
    '  if (!sub) return area.code;',
    '  const slug = entryWeatherSubareaValue(parent, sub);',
    '  const child = (area.sub as Record<string, { code: string }>)[slug];',
    '  return child?.code ?? area.code;',
    '}', '',
  );
  return lines.join('\n');
}

function emitOptions(
  lines: string[], name: string, families: Record<string, any>, prefix: string,
): void {
  lines.push(`export const ${name} = {`);
  for (const [family, categories] of Object.entries(families)) {
    lines.push(`  ${JSON.stringify(family)}: {`);
    for (const [code, item] of Object.entries(categories as Record<string, any>)) {
      lines.push(`    ${JSON.stringify(code)}: { label: ${JSON.stringify(labels[`${prefix}${code}`] ?? code)}, sub: {`);
      for (const sub of item.sub) {
        lines.push(`      ${JSON.stringify(sub)}: ${JSON.stringify(labels[`${prefix}${sub}`] ?? sub)},`);
      }
      lines.push('    } },');
    }
    lines.push('  },');
  }
  lines.push('} as const;', '');
}

function disasterSource(): string {
  const lines = [
    '// Generated from installed @entrylabs/entry. After upgrading it, run:',
    '// bun packages/core/tools/update-entry-expansion-data.ts',
  ];
  emitOptions(lines, 'ENTRY_GUIDELINE_OPTIONS', categoryMap(
    'block_expansion_emergencyActionGuidelines.js',
  ), 'emergencyActionGuidelines');
  emitOptions(lines, 'ENTRY_BEHAVIOR_OPTIONS', {
    '01': categoryMap('block_expansion_behaviorconduct_disaster.js'),
    '03': categoryMap('block_expansion_behaviorconduct_lifesafety.js'),
  }, 'behaviorConduct');
  lines.push(
    'type OptionFamily = Record<string, Record<string, { label: string; sub: Record<string, string> }>>;', '',
    'function categoryValue(table: OptionFamily, family: string, value: string): string {',
    '  const categories = table[family];',
    '  if (!categories) return value;',
    "  const compact = value.replaceAll(' ', '');",
    '  for (const [code, item] of Object.entries(categories)) {',
    "    if (value === code || value === item.label || compact === item.label.replaceAll(' ', '')) return code;",
    '  }',
    '  return value;',
    '}', '',
    'function subcategoryValue(',
    '  table: OptionFamily, family: string, category: string, value: string,',
    '): string {',
    '  const categories = table[family];',
    '  if (!categories) return value;',
    '  const parent = categories[categoryValue(table, family, category)];',
    '  if (!parent) return value;',
    "  const compact = value.replaceAll(' ', '');",
    '  for (const [code, label] of Object.entries(parent.sub)) {',
    "    if (value === code || value === label || compact === label.replaceAll(' ', '')) return code;",
    '  }',
    '  return value;',
    '}', '',
    'export function entryGuidelineCategoryValue(family: string, value: string): string {',
    '  return categoryValue(ENTRY_GUIDELINE_OPTIONS as OptionFamily, family, value);',
    '}', '',
    'export function entryGuidelineSubcategoryValue(',
    '  family: string, category: string, value: string,',
    '): string {',
    '  return subcategoryValue(ENTRY_GUIDELINE_OPTIONS as OptionFamily, family, category, value);',
    '}', '',
    'export function entryBehaviorCategoryValue(family: string, value: string): string {',
    '  return categoryValue(ENTRY_BEHAVIOR_OPTIONS as OptionFamily, family, value);',
    '}', '',
    'export function entryBehaviorSubcategoryValue(',
    '  family: string, category: string, value: string,',
    '): string {',
    '  return subcategoryValue(ENTRY_BEHAVIOR_OPTIONS as OptionFamily, family, category, value);',
    '}', '',
  );
  return lines.join('\n');
}

const outputs = new Map([
  [path.join(outputDir, 'entry-weather-locations.ts'), weatherSource()],
  [path.join(outputDir, 'entry-disaster-options.ts'), disasterSource()],
]);

if (process.argv.includes('--check')) {
  const stale = [...outputs].filter(([file, expected]) => (
    !fs.existsSync(file) || fs.readFileSync(file, 'utf-8') !== expected
  ));
  if (stale.length > 0) {
    console.error('설치된 @entrylabs/entry와 확장 선택지 데이터가 다릅니다. 다음 명령으로 갱신하세요:');
    console.error('bun packages/core/tools/update-entry-expansion-data.ts');
    process.exitCode = 1;
  } else {
    console.log('Entry 확장 선택지 데이터가 현재 설치된 @entrylabs/entry와 일치합니다.');
  }
} else {
  for (const [file, source] of outputs) fs.writeFileSync(file, source);
  console.log('Entry 확장 선택지 데이터를 현재 설치된 @entrylabs/entry에 맞춰 갱신했습니다.');
}
