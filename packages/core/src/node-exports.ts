import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const exports = new Map<string, string>(Object.entries(manifest.exports as Record<string, string>).map(([name, file]) => [
  name === '.' ? '@entropy/core' : `@entropy/core/${name.slice(2)}`, file.replace(/^\.\//, ''),
]));

// Share package exports between the development server and standalone exports.
export function coreExport(specifier: string): string | null {
  return exports.get(specifier) ?? null;
}
