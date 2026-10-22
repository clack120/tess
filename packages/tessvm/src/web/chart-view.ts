// Use HTML for charts and textContent for project text so labels cannot inject markup.
import type { ChartLike, TableLike } from '../render/overlay.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

const COLORS = [
  '#4f80ff', '#f16670', '#6e5ae6', '#00b6b1', '#9fbaff', '#fcad93',
  '#c5b4ff', '#b3c3cd', '#2d51ac', '#a23941', '#423496', '#2a7d7f',
];
const GRID = '#e4e6eb';
const ZERO_LINE = '#c8ccd4';
// Choose tick intervals in multiples of 1, 2, or 5.
const TICKS = 4;
const LABEL_ROOM = 3.4;
// Skip line-point markers above this row count.
const DOT_LIMIT = 40;
const SLICE_LABEL = 0.35;

const FALLBACK_WIDTH = 30;
const FALLBACK_HEIGHT = 13;

const CLOSE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>';

export const CHART_WINDOW_STYLE = `
.tessvm-chart {
  --chart-unit: calc(var(--tessvm-stage-width, 640px) / 640);
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: calc(var(--chart-unit) * 16);
  background: #14161a52;
  color-scheme: light;
  color: #16151a;
  font-family: 'Nanum Gothic', sans-serif;
  font-size: calc(var(--chart-unit) * 14);
  line-height: 1.4;
  text-align: left;
}

.tessvm-chart[hidden] { display: none !important; }
.tessvm-chart * { box-sizing: border-box; }

.tessvm-chart .tessvm-chart-card {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: #fff;
  border-radius: calc(var(--chart-unit) * 12);
  box-shadow: 0 calc(var(--chart-unit) * 10) calc(var(--chart-unit) * 34) #00000038;
}

.tessvm-chart .tessvm-chart-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.5em;
  padding: 0.5em 0.5em 0.5em 1em;
  border-bottom: 1px solid #e6e8ec;
}

.tessvm-chart .tessvm-chart-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 1.05em;
  font-weight: 700;
}

.tessvm-chart .tessvm-chart-pick {
  flex: none;
  max-width: 45%;
  margin: 0;
  padding: 0.3em 1.9em 0.3em 0.7em;
  font: inherit;
  font-size: 0.9em;
  color: inherit;
  background-color: #fff;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23767b85' stroke-width='1.4' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.7em center;
  background-size: 0.7em;
  border: 1px solid #d9dce2;
  border-radius: 0.45em;
  appearance: none;
  cursor: pointer;
}

.tessvm-chart .tessvm-chart-pick:hover { border-color: #b9bec7; }
.tessvm-chart .tessvm-chart-pick[hidden] { display: none !important; }

.tessvm-chart .tessvm-chart-close {
  flex: none;
  display: grid;
  place-items: center;
  width: 1.9em;
  height: 1.9em;
  padding: 0;
  color: #767b85;
  background: none;
  border: 0;
  border-radius: 0.45em;
  cursor: pointer;
  line-height: 0;
}

.tessvm-chart .tessvm-chart-close:hover { color: #16151a; background: #f2f4f7; }
.tessvm-chart .tessvm-chart-close svg { width: 1em; height: 1em; }

.tessvm-chart .tessvm-chart-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 0.7em 1em 0.9em;
}

.tessvm-chart .tessvm-chart-title {
  flex: none;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: 700;
}

.tessvm-chart .tessvm-chart-axis {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 0 1.2em;
  margin-top: 0.1em;
  font-size: 0.85em;
  color: #8b909a;
}

.tessvm-chart .tessvm-chart-legend {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 0.2em 0.9em;
  margin: 0.5em 0 0.2em;
  padding: 0;
  list-style: none;
  font-size: 0.85em;
}

.tessvm-chart .tessvm-chart-legend li { display: flex; align-items: center; gap: 0.4em; }

.tessvm-chart .tessvm-chart-legend i {
  width: 0.75em;
  height: 0.75em;
  border-radius: 0.2em;
}

.tessvm-chart .tessvm-chart-plot {
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  display: block;
  overflow: visible;
}

.tessvm-chart .tessvm-chart-plot text { fill: #8b909a; font-size: 0.8em; }
.tessvm-chart .tessvm-chart-plot text.tessvm-chart-slice { fill: #fff; font-size: 0.82em; font-weight: 700; }
.tessvm-chart .tessvm-chart-plot[hidden] { display: none !important; }

.tessvm-chart .tessvm-chart-empty {
  flex: 1 1 auto;
  display: grid;
  place-items: center;
  color: #8b909a;
}

.tessvm-chart .tessvm-chart-empty[hidden] { display: none !important; }
`;

export interface ChartWindow {
  // Chart indices start at zero, matching Entry.
  show(table: TableLike, chart: number): void;
  hide(): void;
  sync(): void;
  dispose(): void;
}

function unitOf(element: HTMLElement): number {
  const size = typeof getComputedStyle === 'function'
    ? parseFloat(getComputedStyle(element).fontSize)
    : Number.NaN;
  return Number.isFinite(size) && size > 0 ? size : 14;
}

function node<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  parent.appendChild(element);
  return element;
}

function shape(tag: string, attributes: Record<string, string | number>): SVGElement {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

// SVG has no hidden property, so toggle an attribute styled by CSS.
function reveal(element: SVGElement, shown: boolean): void {
  if (shown) {
    element.removeAttribute('hidden');
  } else {
    element.setAttribute('hidden', '');
  }
}

// Keep two coordinate decimals to reduce attribute text without changing the visible chart.
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// Choose readable tick intervals from 1, 2, or 5 times a power of ten.
export function tickStep(span: number, count: number): number {
  const rough = Math.abs(span) / Math.max(count, 1);
  if (!Number.isFinite(rough) || rough <= 0) {
    return 1;
  }
  const power = 10 ** Math.floor(Math.log10(rough));
  for (const step of [1, 2, 5]) {
    if (rough <= step * power) {
      return step * power;
    }
  }
  return 10 * power;
}

export function tickLabel(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function seriesOf(chart: ChartLike): number[] {
  if (chart.categoryIndexes.length) {
    return chart.categoryIndexes;
  }
  return chart.yIndex >= 0 ? [chart.yIndex] : [];
}

export function mountChartWindow(parent: HTMLElement, onClose: () => void): ChartWindow {
  const root = document.createElement('div');
  root.className = 'tessvm-chart';
  root.hidden = true;
  const card = node(root, 'div', 'tessvm-chart-card');
  const head = node(card, 'div', 'tessvm-chart-head');
  const name = node(head, 'span', 'tessvm-chart-name');
  const pick = node(head, 'select', 'tessvm-chart-pick');
  pick.title = '차트 고르기';
  pick.setAttribute('aria-label', '차트 고르기');
  const close = node(head, 'button', 'tessvm-chart-close');
  close.type = 'button';
  close.title = '닫기';
  close.setAttribute('aria-label', '닫기');
  close.innerHTML = CLOSE_ICON;
  const body = node(card, 'div', 'tessvm-chart-body');
  const title = node(body, 'div', 'tessvm-chart-title');
  const axis = node(body, 'div', 'tessvm-chart-axis');
  const legend = node(body, 'ul', 'tessvm-chart-legend');
  const plot = document.createElementNS(SVG_NS, 'svg');
  plot.setAttribute('class', 'tessvm-chart-plot');
  body.appendChild(plot);
  const empty = node(body, 'div', 'tessvm-chart-empty');
  empty.hidden = true;
  parent.appendChild(root);

  let table: TableLike | null = null;
  let at = 0;
  let drawn = '';

  close.addEventListener('click', (event) => {
    event.preventDefault();
    onClose();
  });
  pick.addEventListener('change', () => {
    at = Number(pick.value) || 0;
    draw();
  });
  // Chart presses belong to the modal and must not reach the stage behind it.
  const swallow = (event: Event) => event.stopPropagation();
  const SWALLOWED = ['pointerdown', 'pointerup', 'pointermove', 'click', 'wheel'];
  for (const type of SWALLOWED) {
    root.addEventListener(type, swallow);
  }

  const watch = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(() => {
      if (!root.hidden) {
        draw();
      }
    });
  watch?.observe(body);

  const mark = (): string =>
    `${at}/${table?.revision ?? 0}/${table?.rows.length ?? 0}/${table?.fields.length ?? 0}`;

  function fill(list: Array<{ text: string; color: string }>): void {
    legend.replaceChildren();
    for (const item of list) {
      const row = document.createElement('li');
      const chip = document.createElement('i');
      chip.style.background = item.color;
      const text = document.createElement('span');
      text.textContent = item.text;
      row.append(chip, text);
      legend.appendChild(row);
    }
  }

  function measure(): { em: number; width: number; height: number } {
    const em = unitOf(root);
    const box = plot.getBoundingClientRect();
    return {
      em,
      width: Math.round(box.width) || Math.round(em * FALLBACK_WIDTH),
      height: Math.round(box.height) || Math.round(em * FALLBACK_HEIGHT),
    };
  }

  function draw(): void {
    const spec = table?.charts?.[at] ?? null;
    if (!table || !spec) {
      return;
    }
    drawn = mark();
    const field = (index: number) => String(table?.fields[index] ?? '');
    const series = seriesOf(spec);
    name.textContent = table.name || '차트 보기';
    title.textContent = spec.title || field(spec.xIndex);

    const summary = [`가로축 ${field(spec.xIndex)}`];
    if (series.length) {
      const rest = series.length > 1 ? ` 외 ${series.length - 1}건` : '';
      summary.push(`${spec.categoryIndexes.length ? '계열' : '세로축'} ${field(series[0]!)}${rest}`);
    }
    axis.replaceChildren();
    for (const line of summary) {
      const part = document.createElement('span');
      part.textContent = line;
      axis.appendChild(part);
    }

    plot.replaceChildren();
    const drawable = series.length > 0 && table.rows.length > 0;
    reveal(plot, drawable);
    empty.hidden = drawable;
    if (!drawable) {
      fill([]);
      empty.textContent = '차트로 표현할 수 없습니다.';
      return;
    }

    const size = measure();
    plot.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
    if (spec.type === 'pie') {
      drawPie(table, spec, series[0]!, size);
    } else {
      drawAxisChart(table, spec, series, size);
    }
  }

  function drawAxisChart(
    source: TableLike,
    spec: ChartLike,
    series: number[],
    size: { em: number; width: number; height: number },
  ): void {
    fill(series.map((column, index) => ({
      text: String(source.fields[column] ?? ''),
      color: COLORS[index % COLORS.length]!,
    })));

    const numbers = (index: number) =>
      source.rows.map((row) => Number(row[index] ?? 0) || 0);
    const columns = series.map((column) => numbers(column));
    // Loop over values because spreading large tables exceeds the engine's argument limit.
    let most = 0;
    let least = 0;
    for (const column of columns) {
      for (const value of column) {
        if (value > most) most = value;
        if (value < least) least = value;
      }
    }
    const step = tickStep(most - least, TICKS);
    const low = Math.floor(least / step) * step;
    const high = Math.max(Math.ceil(most / step) * step, low + step);

    const marks: number[] = [];
    for (let value = low; value <= high + step / 2; value += step) {
      marks.push(value);
    }
    const widest = marks.reduce((most, value) => Math.max(most, tickLabel(value).length), 1);
    const pad = {
      left: size.em * (0.6 + widest * 0.5),
      right: size.em * 0.9,
      top: size.em * 0.7,
      bottom: size.em * 1.9,
    };
    const plotWidth = Math.max(size.em, size.width - pad.left - pad.right);
    const plotHeight = Math.max(size.em, size.height - pad.top - pad.bottom);
    const atY = (value: number) =>
      pad.top + plotHeight - ((value - low) / (high - low)) * plotHeight;

    for (const value of marks) {
      const y = round(atY(value));
      plot.appendChild(shape('line', {
        x1: round(pad.left), y1: y, x2: round(pad.left + plotWidth), y2: y,
        stroke: value === 0 ? ZERO_LINE : GRID, 'stroke-width': 1,
      }));
      const label = shape('text', {
        x: round(pad.left - size.em * 0.4), y, 'text-anchor': 'end', 'dominant-baseline': 'central',
      });
      label.textContent = tickLabel(value);
      plot.appendChild(label);
    }

    const rows = source.rows.length;
    const scatter = spec.type === 'scatter';
    // Scatter plots use numeric x values rather than row numbers.
    const xs = scatter ? numbers(spec.xIndex) : [];
    const lowX = scatter ? xs.reduce((min, value) => Math.min(min, value), 0) : 0;
    const highX = scatter ? Math.max(xs.reduce((max, value) => Math.max(max, value), -Infinity), lowX + 1) : 1;
    const slot = plotWidth / Math.max(rows, 1);
    const line = (row: number) => (rows > 1 ? pad.left + (plotWidth * row) / (rows - 1) : pad.left + plotWidth / 2);

    if (spec.type === 'bar') {
      const group = slot * 0.72;
      const barWidth = Math.max(1, group / series.length);
      const base = atY(Math.max(low, 0));
      columns.forEach((column, index) => {
        const color = COLORS[index % COLORS.length]!;
        column.forEach((value, row) => {
          const top = atY(value);
          const height = Math.abs(base - top);
          plot.appendChild(shape('rect', {
            x: round(pad.left + slot * row + (slot - group) / 2 + barWidth * index),
            y: round(Math.min(base, top)),
            width: round(barWidth),
            height: round(Math.max(height, value === 0 ? 0 : 1)),
            rx: round(Math.min(size.em * 0.15, barWidth / 3)),
            fill: color,
          }));
        });
      });
    } else if (scatter) {
      columns.forEach((column, index) => {
        const color = COLORS[index % COLORS.length]!;
        column.forEach((value, row) => {
          plot.appendChild(shape('circle', {
            cx: round(pad.left + ((xs[row]! - lowX) / (highX - lowX)) * plotWidth),
            cy: round(atY(value)),
            r: round(size.em * 0.26),
            fill: color,
            'fill-opacity': 0.85,
          }));
        });
      });
    } else {
      columns.forEach((column, index) => {
        const color = COLORS[index % COLORS.length]!;
        const points = column
          .map((value, row) => `${round(line(row))},${round(atY(value))}`)
          .join(' ');
        plot.appendChild(shape('polyline', {
          points, fill: 'none', stroke: color, 'stroke-width': round(size.em * 0.14),
          'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        }));
        if (rows <= DOT_LIMIT) {
          column.forEach((value, row) => {
            plot.appendChild(shape('circle', {
              cx: round(line(row)), cy: round(atY(value)),
              r: round(size.em * 0.19), fill: color,
            }));
          });
        }
      });
    }

    const baseline = pad.top + plotHeight + size.em * 1.1;
    const write = (x: number, anchor: string, text: string) => {
      const label = shape('text', { x: round(x), y: round(baseline), 'text-anchor': anchor });
      label.textContent = text;
      plot.appendChild(label);
    };
    if (scatter) {
      // Numeric scatter axes need ticks instead of category labels.
      const across = tickStep(highX - lowX, TICKS);
      for (let value = Math.ceil(lowX / across) * across; value <= highX + across / 2; value += across) {
        // Keep end ticks inside the chart bounds.
        const first = value - across < lowX;
        const last = value + across > highX;
        write(
          pad.left + ((value - lowX) / (highX - lowX)) * plotWidth,
          first ? 'start' : last ? 'end' : 'middle',
          tickLabel(value),
        );
      }
      return;
    }
    const every = Math.max(1, Math.ceil((rows * size.em * LABEL_ROOM) / plotWidth));
    const bar = spec.type === 'bar';
    source.rows.forEach((row, index) => {
      if (index % every !== 0) {
        return;
      }
      // Keep end labels inside the chart bounds.
      const anchor = bar || (index > 0 && index < rows - 1)
        ? 'middle'
        : index === 0 ? 'start' : 'end';
      write(bar ? pad.left + slot * index + slot / 2 : line(index), anchor, String(row[spec.xIndex] ?? ''));
    });
  }

  function drawPie(
    source: TableLike,
    spec: ChartLike,
    column: number,
    size: { em: number; width: number; height: number },
  ): void {
    const values = source.rows.map((row) => Math.max(0, Number(row[column] ?? 0) || 0));
    const total = values.reduce((sum, value) => sum + value, 0);
    fill(source.rows.map((row, index) => ({
      text: String(row[spec.xIndex] ?? ''),
      color: COLORS[index % COLORS.length]!,
    })));
    if (total <= 0) {
      reveal(plot, false);
      empty.hidden = false;
      empty.textContent = '차트로 표현할 수 없습니다.';
      return;
    }

    const radius = Math.max(size.em, Math.min(size.width, size.height) / 2 - size.em * 0.6);
    const centreX = size.width / 2;
    const centreY = size.height / 2;
    let from = -Math.PI / 2;
    values.forEach((value, row) => {
      const sweep = (value / total) * Math.PI * 2;
      const color = COLORS[row % COLORS.length]!;
      if (sweep >= Math.PI * 2 - 1e-6) {
        plot.appendChild(shape('circle', {
          cx: round(centreX), cy: round(centreY), r: round(radius), fill: color,
        }));
      } else if (sweep > 0) {
        const to = from + sweep;
        plot.appendChild(shape('path', {
          d: `M ${round(centreX)} ${round(centreY)}`
            + ` L ${round(centreX + Math.cos(from) * radius)} ${round(centreY + Math.sin(from) * radius)}`
            + ` A ${round(radius)} ${round(radius)} 0 ${sweep > Math.PI ? 1 : 0} 1`
            + ` ${round(centreX + Math.cos(to) * radius)} ${round(centreY + Math.sin(to) * radius)} Z`,
          fill: color, stroke: '#fff', 'stroke-width': 1.5, 'stroke-linejoin': 'round',
        }));
      }
      // Label only pie slices with enough room for text.
      if (sweep > SLICE_LABEL) {
        const middle = from + sweep / 2;
        const label = shape('text', {
          x: round(centreX + Math.cos(middle) * radius * 0.62),
          y: round(centreY + Math.sin(middle) * radius * 0.62),
          'text-anchor': 'middle', 'dominant-baseline': 'central',
          class: 'tessvm-chart-slice',
        });
        label.textContent = `${Math.round((value / total) * 100)}%`;
        plot.appendChild(label);
      }
      from += sweep;
    });
  }

  return {
    show(next: TableLike, chart: number): void {
      const charts = next.charts ?? [];
      const wanted = Math.max(0, Math.min(charts.length - 1, Math.floor(chart) || 0));
      table = next;
      at = wanted;
      // Show the chart selector only when there is more than one chart.
      pick.hidden = charts.length < 2;
      pick.replaceChildren();
      charts.forEach((spec, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = spec.title || `차트 ${index + 1}`;
        pick.appendChild(option);
      });
      pick.value = String(wanted);
      root.hidden = false;
      draw();
    },
    hide(): void {
      root.hidden = true;
      table = null;
      plot.replaceChildren();
      legend.replaceChildren();
    },
    sync(): void {
      if (!root.hidden && table && mark() !== drawn) {
        draw();
      }
    },
    dispose(): void {
      watch?.disconnect();
      for (const type of SWALLOWED) {
        root.removeEventListener(type, swallow);
      }
      root.remove();
    },
  };
}
