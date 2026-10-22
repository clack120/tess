// Count swapped adjacent letters as one edit to catch common typos.
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const grid = Array.from({ length: rows }, (unused: unknown, i: number) => {
    const row = new Array(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j += 1) grid[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      grid[i][j] = Math.min(
        grid[i - 1][j] + 1,
        grid[i][j - 1] + 1,
        grid[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        grid[i][j] = Math.min(grid[i][j], grid[i - 2][j - 2] + 1);
      }
    }
  }
  return grid[a.length][b.length];
}

function tolerance(length: number): number {
  if (length <= 3) return 1;
  return length <= 8 ? 2 : 3;
}

export function nearestName(name: string, candidates: Iterable<string>): string | null {
  if (!name) return null;
  const target = String(name).toLowerCase();
  const limit = tolerance(target.length);

  let best = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const text = String(candidate);
    if (text === name) continue; 
    const score = editDistance(target, text.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = text;
    }
  }
  return bestScore <= limit ? best : null;
}

export function didYouMean(name: string, candidates: Iterable<string>): string {
  const found = nearestName(name, candidates);
  return found ? ` 혹시 '${found}' 인가요?` : '';
}

export function orHint(name: string, candidates: Iterable<string>, hint: string): string {
  const found = nearestName(name, candidates);
  return found ? ` 혹시 '${found}' 인가요?` : ` ${hint}`;
}
