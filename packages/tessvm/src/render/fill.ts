// Split self-intersecting fills by nonzero winding because PIXI triangulation fills them differently.

// Fall back to PIXI above this point count to limit scanline work.
const MAX_POINTS = 8192;

// Treat subpixel differences below this distance as equal.
const EPSILON = 1e-9;

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  // Count downward edges as +1 and upward edges as -1 for winding.
  dir: number;
}

// Skip horizontal edges in scans, but retain their y coordinates as band boundaries.
function edgesOf(points: number[]): Edge[] {
  const edges: Edge[] = [];
  const count = points.length / 2;
  for (let at = 0; at < count; at += 1) {
    const next = (at + 1) % count;
    const x0 = points[at * 2]!;
    const y0 = points[at * 2 + 1]!;
    const x1 = points[next * 2]!;
    const y1 = points[next * 2 + 1]!;
    if (y0 === y1) continue;
    edges.push({ x0, y0, x1, y1, dir: y1 > y0 ? 1 : -1 });
  }
  return edges;
}

function xAt(edge: Edge, y: number): number {
  return edge.x0 + ((edge.x1 - edge.x0) * (y - edge.y0)) / (edge.y1 - edge.y0);
}

function spans(edge: Edge, top: number, bottom: number): boolean {
  return Math.min(edge.y0, edge.y1) <= top && Math.max(edge.y0, edge.y1) >= bottom;
}

// Skip pairwise intersection tests when edge order stays unchanged across a band.
function keepsOrder(edges: Edge[], top: number, bottom: number): boolean {
  const byTop = edges.map((edge, at) => at).sort((a, b) => xAt(edges[a]!, top) - xAt(edges[b]!, top));
  const byBottom = edges
    .map((edge, at) => at)
    .sort((a, b) => xAt(edges[a]!, bottom) - xAt(edges[b]!, bottom));
  return byTop.every((at, index) => at === byBottom[index]);
}

function crossingsIn(edges: Edge[], top: number, bottom: number): number[] {
  if (keepsOrder(edges, top, bottom)) return [];
  const found: number[] = [];
  for (let a = 0; a < edges.length; a += 1) {
    const first = edges[a]!;
    const ax = first.x1 - first.x0;
    const ay = first.y1 - first.y0;
    for (let b = a + 1; b < edges.length; b += 1) {
      const second = edges[b]!;
      const bx = second.x1 - second.x0;
      const by = second.y1 - second.y0;
      const denominator = ax * by - ay * bx;
      if (Math.abs(denominator) < EPSILON) continue;
      const dx = second.x0 - first.x0;
      const dy = second.y0 - first.y0;
      const t = (dx * by - dy * bx) / denominator;
      const u = (dx * ay - dy * ax) / denominator;
      if (t <= EPSILON || t >= 1 - EPSILON) continue;
      if (u <= EPSILON || u >= 1 - EPSILON) continue;
      const y = first.y0 + ay * t;
      if (y > top + EPSILON && y < bottom - EPSILON) found.push(y);
    }
  }
  return found.sort((a, b) => a - b);
}

function insideSpans(edges: Edge[], y: number): { left: Edge; right: Edge }[] {
  const hits = edges.map((edge) => ({ x: xAt(edge, y), edge }));
  hits.sort((a, b) => a.x - b.x);

  const found: { left: Edge; right: Edge }[] = [];
  let winding = 0;
  for (let at = 0; at < hits.length - 1; at += 1) {
    winding += hits[at]!.edge.dir;
    if (winding !== 0) found.push({ left: hits[at]!.edge, right: hits[at + 1]!.edge });
  }
  return found;
}

// Return null when splitting is unnecessary or impossible so the caller can keep the original path.
export function nonzeroParts(points: number[]): number[][] | null {
  if (points.length < 6 || points.length > MAX_POINTS * 2) return null;
  const edges = edgesOf(points);
  if (edges.length < 2) return null;

  // Split at every vertex y so edges cannot end inside a band.
  const rows: number[] = [];
  for (let at = 1; at < points.length; at += 2) rows.push(points[at]!);
  rows.sort((a, b) => a - b);

  const parts: number[][] = [];
  for (let at = 0; at < rows.length - 1; at += 1) {
    const top = rows[at]!;
    const bottom = rows[at + 1]!;
    if (bottom - top < EPSILON) continue;
    const crossing = edges.filter((edge) => spans(edge, top, bottom));
    if (crossing.length === 0) continue;

    // Split again at edge crossings so each resulting region is a trapezoid.
    const cuts = [top, ...crossingsIn(crossing, top, bottom), bottom];
    for (let cut = 0; cut < cuts.length - 1; cut += 1) {
      const from = cuts[cut]!;
      const to = cuts[cut + 1]!;
      if (to - from < EPSILON) continue;
      for (const span of insideSpans(crossing, (from + to) / 2)) {
        parts.push([
          xAt(span.left, from), from,
          xAt(span.right, from), from,
          xAt(span.right, to), to,
          xAt(span.left, to), to,
        ]);
      }
    }
  }
  return parts.length > 0 ? parts : null;
}

// Boost mode uses PIXI in Entry too, so keep its original self-intersection behavior.
export function fillParts(points: number[], boost: boolean): number[][] | null {
  return boost ? null : nonzeroParts(points);
}
