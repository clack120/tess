// Match Entry's one-based rows and columns; row one contains field names.
import { isNumber, num } from './cast.ts';

type RawRow = unknown[] | { value?: unknown } | null | undefined;

interface RawTable {
  id?: unknown;
  name?: unknown;
  fields?: unknown;
  data?: unknown;
  origin?: unknown;
  chart?: unknown;
}

// Chart columns start at zero; unused column slots hold -1.
export interface ChartSpec {
  type: string;
  title: string;
  xIndex: number;
  yIndex: number;
  categoryIndexes: number[];
}

function chartOf(raw: unknown): ChartSpec {
  const spec = (raw ?? {}) as Record<string, unknown>;
  const indexes = Array.isArray(spec.categoryIndexes) ? spec.categoryIndexes : [];
  return {
    type: String(spec.type ?? 'bar'),
    title: String(spec.title ?? ''),
    xIndex: Number(spec.xIndex ?? -1),
    yIndex: Number(spec.yIndex ?? -1),
    categoryIndexes: indexes.map((index) => Number(index)).filter((index) => index >= 0),
  };
}

function cellsOf(row: RawRow): Array<string | number> {
  const cells = Array.isArray(row) ? row : (row as { value?: unknown } | null)?.value;
  return Array.isArray(cells) ? (cells as Array<string | number>) : [];
}

export class Table {
  readonly id: string;
  readonly name: string;
  fields: string[];
  // Data excludes the field-name row, which block coordinates address separately.
  rows: Array<Array<string | number>>;
  charts: ChartSpec[] = [];
  // Bump the revision on edits so open views can redraw.
  revision = 0;
  private readonly initialFields: string[];
  private readonly initialRows: Array<Array<string | number>>;

  // Restore origin on each run, falling back to data only when origin is absent.
  static from(raw: RawTable): Table {
    const origin = Array.isArray(raw.origin) ? (raw.origin as RawRow[]) : [];
    const data = Array.isArray(raw.data) ? (raw.data as RawRow[]) : [];
    const table = new Table(
      String(raw.id ?? ''),
      String(raw.name ?? ''),
      cellsOf(raw.fields as RawRow).map((field) => String(field ?? '')),
      (origin.length ? origin : data).map((row) => cellsOf(row)),
    );
    table.charts = (Array.isArray(raw.chart) ? raw.chart : []).map((spec) => chartOf(spec));
    return table;
  }

  constructor(id: string, name: string, fields: string[], data: Array<Array<string | number>>) {
    this.id = id;
    this.name = name;
    this.fields = fields.slice();
    this.rows = data.map((row) => row.slice());
    this.initialFields = fields.slice();
    this.initialRows = data.map((row) => row.slice());
  }

  reset(): void {
    this.fields = this.initialFields.slice();
    this.rows = this.initialRows.map((row) => row.slice());
    this.revision += 1;
  }

  // Row one holds field names, so data rows need an extra index offset.
  private rowAt(row: number): Array<string | number> | null {
    if (row === 0) {
      return this.fields;
    }
    return this.rows[row - 1] ?? null;
  }

  getValue(row: number, col: number): string | number | null {
    const target = this.rowAt(row);
    if (!target) {
      return null;
    }
    const value = target[col - 1];
    return value === undefined ? null : value;
  }

  isExist(row: number, col: number): boolean {
    return this.getValue(row, col) !== null;
  }

  replaceValue(row: number, col: number, value: string | number): void {
    const target = this.rowAt(row);
    if (target && col >= 1 && col <= target.length) {
      target[col - 1] = value;
      this.revision += 1;
    }
  }

  appendRow(): void {
    this.rows.push(new Array<string>(this.fields.length).fill(''));
    this.revision += 1;
  }

  appendCol(): void {
    this.fields.push('');
    for (const row of this.rows) {
      row.push('');
    }
    this.revision += 1;
  }

  insertRow(index: number): void {
    const at = Math.max(0, Math.min(this.rows.length, index));
    this.rows.splice(at, 0, new Array<string>(this.fields.length).fill(''));
    this.revision += 1;
  }

  insertCol(index: number): void {
    const at = Math.max(0, Math.min(this.fields.length, index - 1));
    this.fields.splice(at, 0, '');
    for (const row of this.rows) {
      row.splice(at, 0, '');
    }
    this.revision += 1;
  }

  deleteRow(index: number): void {
    if (index >= 0 && index < this.rows.length) {
      this.rows.splice(index, 1);
      this.revision += 1;
    }
  }

  deleteCol(index: number): void {
    const at = index - 1;
    if (at >= 0 && at < this.fields.length) {
      this.fields.splice(at, 1);
      for (const row of this.rows) {
        row.splice(at, 1);
      }
      this.revision += 1;
    }
  }

  // Count unparseable column values as zero.
  column(col: number): number[] {
    return this.rows.map((row) => {
      const value = row[col - 1];
      return isNumber(value) ? num(value) : 0;
    });
  }

  coefficient(x: number, y: number): number {
    const left = this.column(x + 1);
    const right = this.column(y + 1);
    const total = Math.min(left.length, right.length);
    if (!total) {
      return 0;
    }
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < total; i += 1) {
      sumX += left[i]!;
      sumY += right[i]!;
    }
    const meanX = sumX / total;
    const meanY = sumY / total;
    let covariance = 0;
    let varianceX = 0;
    let varianceY = 0;
    for (let i = 0; i < total; i += 1) {
      const dx = left[i]! - meanX;
      const dy = right[i]! - meanY;
      covariance += dx * dy;
      varianceX += dx * dx;
      varianceY += dy * dy;
    }
    const denominator = Math.sqrt(varianceX * varianceY);
    return denominator === 0 ? 0 : covariance / denominator;
  }
}

// Keep numeric column indices; convert letter names using base 26.
export function columnIndex(value: unknown): number {
  if (isNumber(value)) {
    return parseFloat(String(value));
  }
  const text = String(value ?? '');
  if (!text || /[^A-Za-z]|\s/.test(text)) {
    return 0;
  }
  let total = 0;
  for (let i = 0; i < text.length; i += 1) {
    total += (text.toUpperCase().charCodeAt(i) - 64) * Math.pow(26, text.length - i - 1);
  }
  return total;
}

export function cellToRowCol(cell: string): { row: number; col: number } {
  const match = /^([A-Za-z]+)(\d+)$/.exec(cell.trim());
  if (!match) {
    return { row: 0, col: 0 };
  }
  return { col: columnIndex(match[1]!), row: Number(match[2]) };
}
