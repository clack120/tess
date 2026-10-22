// Match Entry's one-based rows and columns; row one contains field names.
import { isNumber } from './cast.ts';
import { RuntimeBlockError } from './diagnostics.ts';

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

function cellsOf(row: RawRow): unknown[] {
  const cells = Array.isArray(row) ? row : (row as { value?: unknown } | null)?.value;
  return Array.isArray(cells) ? cells : [];
}

// Entry table cells use a parseInt gate before full numeric conversion.
function numericCell(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(numericCell);
  if (!Number.isNaN(parseInt(value as string, 10))) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return value;
}

function sizeRow(row: unknown[], columns: number): unknown[] {
  const length = row.length;
  row.length = columns;
  row.fill(0, length, columns);
  return row;
}

// Null and zero exist in Entry tables; other falsy values do not.
function cellExists(value: unknown): boolean {
  return value === null || value === 0 || Boolean(value);
}

// Keep at least one character before Entry's numeric name suffix.
function nameParts(value: string): { root: string; next: number } {
  let at = value.length;
  while (at > 1) {
    const char = value.charCodeAt(at - 1);
    if (char < 48 || char > 57) break;
    at--;
  }
  return { root: value.slice(0, at), next: at < value.length ? parseInt(value.slice(at), 10) + 1 : 1 };
}

export class Table {
  readonly id: string;
  readonly name: string;
  fields: unknown[];
  // Data excludes the field-name row, which block coordinates address separately.
  rows: unknown[][];
  charts: ChartSpec[] = [];
  // Bump the revision on edits so open views can redraw.
  revision = 0;
  private readonly initialFields: unknown[];
  private readonly initialRows: unknown[][];
  private initialCharts: ChartSpec[] = [];

  static from(raw: RawTable): Table {
    const data = Array.isArray(raw.data) ? (raw.data as RawRow[]) : [];
    const table = new Table(
      String(raw.id ?? ''),
      String(raw.name ?? ''),
      cellsOf(raw.fields as RawRow),
      data,
    );
    table.charts = (Array.isArray(raw.chart) ? raw.chart : []).map((spec) => chartOf(spec));
    table.initialCharts = table.charts.map(chartOf);
    return table;
  }

  constructor(id: string, name: string, fields: unknown[], data: RawRow[]) {
    this.id = id;
    this.name = name;
    this.fields = fields.slice();
    this.rows = data.map((row) => {
      const cells = cellsOf(row).map(numericCell);
      return Array.isArray(row) ? sizeRow(cells, fields.length) : cells;
    });
    this.initialFields = fields.slice();
    this.initialRows = structuredClone(data.map(cellsOf));
  }

  reset(): void {
    this.fields = this.initialFields.slice();
    // Entry reloads saved rows as arrays on stop, including formerly keyed rows.
    this.rows = structuredClone(this.initialRows).map((row) => sizeRow(row.map(numericCell), this.fields.length));
    this.charts = this.initialCharts.map(chartOf);
    this.revision += 1;
  }

  // Row one holds field names, so data rows need an extra index offset.
  private rowAt(row: number): unknown[] | null {
    if (row === 0) {
      return this.fields;
    }
    return this.rows[row - 1] ?? null;
  }

  getValue(row: number, col: number): unknown {
    return this.rowAt(row)?.[col - 1];
  }

  isExist(row: number, col: number): boolean {
    return cellExists(this.getValue(row, col));
  }

  readValue(row: number, col: number): unknown {
    const value = this.getValue(row, col);
    return cellExists(value) ? value : null;
  }

  replaceValue(row: number, col: number, value: unknown): void {
    const target = this.rowAt(row);
    if (target && col >= 1 && col <= target.length) {
      target[col - 1] = numericCell(value);
      this.revision += 1;
    }
  }

  appendRow(): void {
    this.rows.push(new Array<number>(this.fields.length).fill(0));
    this.revision += 1;
  }

  private columnName(base: string): string {
    if (!base) return 'untitled';
    const { root } = nameParts(base);
    let next = 0;
    for (const field of this.fields) {
      if (typeof field !== 'string' || !field) continue;
      const parts = nameParts(field);
      if (parts.root === root) next = Math.max(next, parts.next);
    }
    return next ? `${root}${next}` : base;
  }

  appendCol(name = '새로운 열'): void {
    this.fields.push(this.columnName(name));
    for (const row of this.rows) {
      row.push(0);
    }
    this.revision += 1;
  }

  insertRow(index: number): void {
    let row: unknown[] = new Array<number>(this.fields.length).fill(0);
    if (index === 0) {
      const previous = this.fields;
      this.fields = row;
      row = previous.slice();
      index = 1;
    }
    this.rows.splice(index - 1, 0, row);
    this.revision += 1;
  }

  insertCol(index: number, name = '새로운 열'): void {
    if (index < 1 || index > this.fields.length + 1) {
      throw new RuntimeBlockError(`열 삽입 위치가 범위를 벗어났습니다 (위치 ${index}, 허용 범위 1–${this.fields.length + 1})`,
        'insert_row_to_table', { table: this.id, tableName: this.name, position: index, columns: this.fields.length, property: 'COL' });
    }
    this.fields.splice(index - 1, 0, this.columnName(name));
    for (const row of this.rows) {
      row.splice(index - 1, 0, 0);
    }
    // Entry adjusts chart indices with the block's one-based column number.
    for (const chart of this.charts) {
      if (chart.xIndex >= index) chart.xIndex++;
      if (chart.yIndex >= index) chart.yIndex++;
      for (let i = 0; i < chart.categoryIndexes.length; i++) {
        if (chart.categoryIndexes[i] >= index) chart.categoryIndexes[i]++;
      }
    }
    this.revision += 1;
  }

  deleteRow(index: number): void {
    if (index === 0 && this.rows[0]) {
      this.fields = this.rows[0].slice();
      index = 1;
    }
    if (Number.isInteger(index) && index >= 1 && index <= this.rows.length) {
      this.rows.splice(index - 1, 1);
      this.revision += 1;
    }
  }

  deleteCol(index: number): void {
    if (!index) return;
    this.fields.splice(index - 1, 1);
    for (const row of this.rows) row.splice(index - 1, 1);
    for (const chart of this.charts) {
      if (chart.xIndex === index) {
        chart.xIndex = chart.yIndex = -1;
        chart.categoryIndexes = [];
      } else if (chart.xIndex > index) chart.xIndex--;
      if (chart.yIndex === index) {
        chart.yIndex = -1;
        chart.categoryIndexes = [];
      } else if (chart.yIndex > index) chart.yIndex--;
      for (let i = 0; i < chart.categoryIndexes.length; i++) {
        if (chart.categoryIndexes[i] === index) chart.categoryIndexes.splice(i--, 1);
        else if (chart.categoryIndexes[i] > index) chart.categoryIndexes[i]--;
      }
    }
    this.revision += 1;
  }

  // Statistics retain numeric NaN and count other nonnumeric cells as zero.
  column(col: number): number[] {
    return this.rows.map((row) => {
      const value = numericCell(row[col - 1]);
      return typeof value === 'number' ? value : 0;
    });
  }

  coefficient(x: number, y: number): string | number {
    const total = this.rows.length;
    if (!total) {
      return 0;
    }
    let sumX = 0;
    let sumY = 0;
    let squareX = 0;
    let squareY = 0;
    let product = 0;
    // Correlation uses Number on raw cells and retains Entry's cancellation and rounding.
    for (const row of this.rows) {
      const left = Number(row[x]);
      const right = Number(row[y]);
      sumX += left;
      sumY += right;
      squareX += left ** 2;
      squareY += right ** 2;
      product += left * right;
    }
    const denominator = Math.sqrt((squareX - sumX ** 2 / total) * (squareY - sumY ** 2 / total));
    return denominator === 0 ? 0 : ((product - sumX * sumY / total) / denominator).toFixed(2);
  }
}

// Keep numeric column indices; convert letter names using base 26.
export function columnIndex(value: unknown): number {
  if (isNumber(value)) {
    return parseFloat(String(value));
  }
  if (/[^A-Za-z]|\s/.test(value as string)) {
    return 0;
  }
  const column = value as ArrayLike<string> | null | undefined;
  const length = column?.length ?? 0;
  let total = 0;
  for (let i = 0; i < length; i += 1) {
    total += (column![i]!.toUpperCase().charCodeAt(0) - 64) * Math.pow(26, length - i - 1);
  }
  return total;
}

export function cellToRowCol(cell: string): { row: number; col: number } {
  let col = 0;
  let at = 0;
  while (at < cell.length && Number.isNaN(Number(cell[at]))) {
    col = col * 26 + (cell.charCodeAt(at) - 64);
    at++;
  }
  return { col, row: parseInt(cell.slice(at), 10) - 1 };
}
