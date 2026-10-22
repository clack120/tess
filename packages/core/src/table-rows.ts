// Entry resets tables to origin on stop; rows may be arrays or keyed records.

type RawRow = unknown[] | { value?: unknown } | null | undefined;

interface RawTable {
  data?: unknown;
  origin?: unknown;
}

export function tableRowCells(row: RawRow): unknown[] {
  if (Array.isArray(row)) {
    return row;
  }
  const value = (row as { value?: unknown } | null)?.value;
  return Array.isArray(value) ? value : [];
}

// Prefer origin because Entry restores it before each run.
export function tableRows(table: RawTable | null | undefined): unknown[][] {
  const origin = Array.isArray(table?.origin) ? (table.origin as RawRow[]) : [];
  const data = Array.isArray(table?.data) ? (table.data as RawRow[]) : [];
  const rows = origin.length ? origin : data;
  return rows.map((row) => tableRowCells(row));
}
