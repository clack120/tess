import { Container, Graphics, Text } from 'pixi.js';
import { entityBounds, type Rect } from '../collision/detect.ts';
import { stage, type Entity, type Variable } from '../runtime/model.ts';

const DIALOG_PADDING = 10;
const DIALOG_FONT = 15;
const DIALOG_BORDER = '#4f80ff';
const DIALOG_BG = '#ffffff';
const MONITOR_VARIABLE = '#4f80ff';
const MONITOR_ANSWER = '#F57DF1';
const MONITOR_TIMER = '#f4af18';
const MONITOR_FAMILY = 'Nanum Gothic, sans-serif';
const MONITOR_BORDER = '#aac5d5';
const MONITOR_BG = '#ffffff';
// Entry uses 10pt labels and 9pt values; one point is 4/3 pixels.
const MONITOR_FONT = 40 / 3;
const MONITOR_VALUE_FONT = 12;
const MONITOR_INSET = 6;
const MONITOR_RADIUS = 7;
// Text anchors use box centers rather than Entry's stored top edges.
const LABEL_Y = -2;
const VALUE_Y = -2;
const LIST_ROW_HEIGHT = 20;
const LIST_TITLE_HEIGHT = 23;
const STRIP_TOP = 4;
const STRIP_HEIGHT = 17;
// Match Entry's 14 by 14 resize handle drawn at 0.7 scale.
const LIST_HANDLE_SIZE = 14 * 0.7;
const LIST_HANDLE_X = 10;
const LIST_HANDLE_Y = 6;
const LIST_HANDLE_COLOR = '#4f80ff';
// Match Entry's minimum list box dimensions.
export const LIST_MIN_SIZE = 100;

const LIST_BAR_TOP = LIST_TITLE_HEIGHT + 4;
const LIST_BAR_HEIGHT = 20;
// Match Entry's 42-unit slider box and its scaled 9 by 20 knob.
const SLIDE_HEIGHT = 42;
const SLIDE_BAR_X = 6;
const SLIDE_BAR_Y = 16;
const SLIDE_BAR_HEIGHT = 5;
const SLIDE_BAR_RADIUS = 2;
const SLIDE_BAR_COLOR = '#d8d8d8';
const SLIDE_KNOB_WIDTH = 9 * 0.8;
const SLIDE_KNOB_HEIGHT = 20 * 0.8;
const SLIDE_KNOB_RADIUS = 1 * 0.8;
const SLIDE_KNOB_COLOR = '#4f80ff';
// Keep the two dark grip lines from Entry's slider image.
const SLIDE_GRIP_COLOR = '#3759b2';
const SLIDE_GRIP_X = [2 * 0.8, 5 * 0.8];
const SLIDE_GRIP_WIDTH = 2 * 0.8;
const SLIDE_GRIP_Y = 4 * 0.8;
const SLIDE_GRIP_HEIGHT = 12 * 0.8;
const TABLE_MARGIN = 24;
const TABLE_TITLE_HEIGHT = 22;
const TABLE_HEAD_HEIGHT = 18;
const TABLE_ROW_HEIGHT = 16;
const TABLE_INDEX_WIDTH = 26;
const TABLE_BG = '#ffffff';
const TABLE_BORDER = '#c0c5cc';
const TABLE_TITLE_BG = '#4f80ff';
const TABLE_TITLE_COLOR = '#ffffff';
const TABLE_HEAD_BG = '#eef1f5';
const TABLE_LINE = '#dfe3e8';
const TABLE_TEXT = '#16161a';
const TABLE_FONT = 11;
const TABLE_CLOSE = 14;

// Entry clamps slider monitor widths to at least 90.
const MONITOR_MIN_WIDTH = 90;
// Use Entry's built-in monitor positions when the project omits them.
const ANSWER_HOME = { x: 150, y: -100 };
const TIMER_HOME = { x: 134, y: -70 };

interface DialogView {
  root: Container;
  frame: Graphics;
  notch: Graphics;
  text: Text;
  message: string;
  mode: string;
}

interface RowView {
  root: Container;
  index: Text;
  strip: Graphics;
  value: Text;
  // Cache displayed values so unchanged rows need no redraw.
  shown: string;
  stripWidth: number;
}

export interface TableLike {
  name: string;
  fields: unknown[];
  rows: unknown[][];
  charts?: ChartLike[];
  // Increment after table changes so open views can refresh.
  revision?: number;
}

// Saved chart column numbers are zero-based.
export interface ChartLike {
  type: string;
  title: string;
  xIndex: number;
  yIndex: number;
  categoryIndexes: number[];
}

interface TableView {
  root: Container;
  frame: Graphics;
  title: Text;
  cells: Text[];
}

interface MonitorView {
  root: Container;
  frame: Graphics;
  label: Text;
  value: Text;
  items: Container | null;
  rows: RowView[];
  slider: { bar: Graphics; knob: Graphics } | null;
  slideRun: number;
  shown: string;
}

function stageBounds(entity: Entity): Rect {
  const rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  entityBounds(entity, rect);
  return {
    x: (rect.x - stage.worldWidth / 2) / stage.scale,
    y: (rect.y - stage.worldHeight / 2) / stage.scale,
    width: rect.width / stage.scale,
    height: rect.height / stage.scale,
  };
}

export class Overlay {
  private readonly root = new Container();
  private readonly dialogLayer = new Container();
  private readonly monitorLayer = new Container();
  private readonly dialogs = new Map<Entity, DialogView>();
  private readonly monitors = new Map<Variable, MonitorView>();
  private variables: Variable[] = [];
  private readonly scrolled = new Map<Variable, number>();
  private answerMonitor: MonitorView | null = null;
  private timerMonitor: MonitorView | null = null;
  private answerValue: () => string | number = () => '';
  private answerShown: () => boolean = () => false;
  private timerValue: () => number = () => 0;
  private timerShown: () => boolean = () => false;
  private currentScene: () => string = () => '';
  private ownerName: (objectId: string) => string | null = () => null;
  private ownerScene: (objectId: string) => string | null = () => null;
  private readonly tableLayer = new Container();
  private tableView: TableView | null = null;
  private openTable: TableLike | null = null;

  // Bake text at stage scale times canvas resolution so overlays remain sharp.
  static textResolution = 2;

  setTextResolution(resolution: number): void {
    if (Math.abs(resolution - Overlay.textResolution) < 1e-3) return;
    Overlay.textResolution = resolution;
    const visit = (node: Container) => {
      if (node instanceof Text) node.resolution = resolution;
      for (const child of node.children) visit(child as Container);
    };
    visit(this.root);
  }

  constructor(parent: Container) {
    this.root.addChild(this.monitorLayer, this.dialogLayer, this.tableLayer);
    parent.addChild(this.root);
    this.applyStageSize();
  }

  applyStageSize(): void {
    this.root.position.set(stage.worldWidth / 2, stage.worldHeight / 2);
    this.root.scale.set(stage.scale);
  }

  bind(options: {
    variables: Variable[];
    ownerName?: (objectId: string) => string | null;
    // Show local variable monitors only in their owner's scene.
    ownerScene?: (objectId: string) => string | null;
    answer: () => string | number;
    answerVisible: () => boolean;
    timer: () => number;
    timerVisible: () => boolean;
    scene: () => string;
  }): void {
    this.variables = options.variables;
    this.ownerName = options.ownerName ?? (() => null);
    this.ownerScene = options.ownerScene ?? (() => null);
    this.answerValue = options.answer;
    this.answerShown = options.answerVisible;
    this.timerValue = options.timer;
    this.timerShown = options.timerVisible;
    this.currentScene = options.scene;
  }

  // Charts use HTML windows, so draw only ordinary tables on the canvas.
  showTable(table: TableLike | null, chart: number | null = null): void {
    this.openTable = chart === null ? table : null;
  }

  tableAt(x: number, y: number): 'close' | 'window' | null {
    if (!this.openTable) {
      return null;
    }
    const box = Overlay.tableBox();
    if (x < box.left || x > box.left + box.width || y < box.top || y > box.top + box.height) {
      return null;
    }
    const closeLeft = box.left + box.width - TABLE_TITLE_HEIGHT;
    const onClose = x >= closeLeft && y <= box.top + TABLE_TITLE_HEIGHT;
    return onClose ? 'close' : 'window';
  }

  private static tableBox(): { left: number; top: number; width: number; height: number } {
    return {
      left: -stage.width / 2 + TABLE_MARGIN,
      top: -stage.height / 2 + TABLE_MARGIN,
      width: stage.width - TABLE_MARGIN * 2,
      height: stage.height - TABLE_MARGIN * 2,
    };
  }

  private drawTable(): void {
    const table = this.openTable;
    if (!table) {
      if (this.tableView) {
        this.tableView.root.destroy({ children: true });
        this.tableView = null;
      }
      return;
    }
    if (!this.tableView) {
      const root = new Container();
      const frame = new Graphics();
      const title = new Text({
        text: '',
        style: { fontFamily: MONITOR_FAMILY, fontSize: TABLE_FONT + 1, fill: TABLE_TITLE_COLOR },
        resolution: Overlay.textResolution,
      });
      root.addChild(frame, title);
      this.tableLayer.addChild(root);
      this.tableView = { root, frame, title, cells: [] };
    }
    const view = this.tableView;
    const box = Overlay.tableBox();
    view.root.position.set(box.left, box.top);
    view.title.text = table.name;
    view.title.position.set(8, (TABLE_TITLE_HEIGHT - view.title.height) / 2);

    const columns = Math.max(table.fields.length, 1);
    const cellWidth = (box.width - TABLE_INDEX_WIDTH) / columns;
    const room = box.height - TABLE_TITLE_HEIGHT - TABLE_HEAD_HEIGHT;
    const shown = Math.max(0, Math.min(table.rows.length, Math.floor(room / TABLE_ROW_HEIGHT)));

    view.frame.clear();
    this.drawWindowFrame(view, box);
    view.frame
      .rect(0, TABLE_TITLE_HEIGHT, box.width, TABLE_HEAD_HEIGHT)
      .fill({ color: TABLE_HEAD_BG });
    const gridTop = TABLE_TITLE_HEIGHT;
    for (let column = 0; column <= columns; column += 1) {
      const x = TABLE_INDEX_WIDTH + column * cellWidth;
      view.frame.moveTo(x, gridTop).lineTo(x, gridTop + TABLE_HEAD_HEIGHT + shown * TABLE_ROW_HEIGHT);
    }
    view.frame.moveTo(TABLE_INDEX_WIDTH - TABLE_INDEX_WIDTH, gridTop + TABLE_HEAD_HEIGHT)
      .lineTo(box.width, gridTop + TABLE_HEAD_HEIGHT);
    for (let row = 1; row <= shown; row += 1) {
      const y = gridTop + TABLE_HEAD_HEIGHT + row * TABLE_ROW_HEIGHT;
      view.frame.moveTo(0, y).lineTo(box.width, y);
    }
    view.frame.stroke({ width: 1, color: TABLE_LINE });

    const texts: Array<{ text: string; x: number; y: number; head: boolean }> = [];
    table.fields.forEach((field, column) => {
      texts.push({
        text: String(field ?? ''),
        x: TABLE_INDEX_WIDTH + column * cellWidth + 4,
        y: gridTop + (TABLE_HEAD_HEIGHT - TABLE_FONT) / 2,
        head: true,
      });
    });
    for (let row = 0; row < shown; row += 1) {
      const top = gridTop + TABLE_HEAD_HEIGHT + row * TABLE_ROW_HEIGHT + (TABLE_ROW_HEIGHT - TABLE_FONT) / 2;
      texts.push({ text: String(row + 1), x: 6, y: top, head: true });
      for (let column = 0; column < columns; column += 1) {
        texts.push({
          text: String(table.rows[row]?.[column] ?? ''),
          x: TABLE_INDEX_WIDTH + column * cellWidth + 4,
          y: top,
          head: false,
        });
      }
    }
    Overlay.placeCells(view, texts);
  }

  private drawWindowFrame(
    view: TableView,
    box: { width: number; height: number },
  ): void {
    view.frame
      .roundRect(0, 0, box.width, box.height, 6)
      .fill({ color: TABLE_BG })
      .stroke({ width: 1, color: TABLE_BORDER })
      .roundRect(0, 0, box.width, TABLE_TITLE_HEIGHT, 6)
      .fill({ color: TABLE_TITLE_BG })
      .rect(0, TABLE_TITLE_HEIGHT - 6, box.width, 6)
      .fill({ color: TABLE_TITLE_BG });
    const closeX = box.width - TABLE_TITLE_HEIGHT / 2;
    const closeY = TABLE_TITLE_HEIGHT / 2;
    const arm = TABLE_CLOSE / 4;
    view.frame
      .moveTo(closeX - arm, closeY - arm).lineTo(closeX + arm, closeY + arm)
      .moveTo(closeX + arm, closeY - arm).lineTo(closeX - arm, closeY + arm)
      .stroke({ width: 1.5, color: TABLE_TITLE_COLOR });
  }

  // Reuse table text each frame to avoid repeated measurement and texture creation.
  private static placeCells(
    view: TableView,
    texts: Array<{ text: string; x: number; y: number; color?: string }>,
  ): void {
    while (view.cells.length < texts.length) {
      const cell = new Text({
        text: '',
        style: { fontFamily: MONITOR_FAMILY, fontSize: TABLE_FONT, fill: TABLE_TEXT },
        resolution: Overlay.textResolution,
      });
      view.root.addChild(cell);
      view.cells.push(cell);
    }
    view.cells.forEach((cell, index) => {
      const wanted = texts[index];
      cell.visible = Boolean(wanted);
      if (!wanted) {
        return;
      }
      if (cell.text !== wanted.text) {
        cell.text = wanted.text;
      }
      const color = wanted.color ?? TABLE_TEXT;
      if (cell.style.fill !== color) {
        cell.style.fill = color;
      }
      cell.position.set(wanted.x, wanted.y);
    });
  }

  clear(): void {
    this.showTable(null);
    this.drawTable();
    this.scrolled.clear();
    for (const view of this.dialogs.values()) {
      view.root.destroy({ children: true });
    }
    this.dialogs.clear();
    for (const view of this.monitors.values()) {
      view.root.destroy({ children: true });
    }
    this.monitors.clear();
    this.answerMonitor?.root.destroy({ children: true });
    this.answerMonitor = null;
    this.timerMonitor?.root.destroy({ children: true });
    this.timerMonitor = null;
  }

  // Remove orphaned clone bubbles so they cannot survive stop and restart.
  forget(entity: Entity): void {
    const view = this.dialogs.get(entity);
    if (!view) {
      return;
    }
    view.root.destroy({ children: true });
    this.dialogs.delete(entity);
  }

  setDialog(entity: Entity): void {
    const state = entity.dialog;
    const existing = this.dialogs.get(entity);
    if (!state) {
      if (existing) {
        existing.root.destroy({ children: true });
        this.dialogs.delete(entity);
      }
      return;
    }
    if (existing) {
      if (existing.message !== state.message || existing.mode !== state.mode) {
        existing.message = state.message;
        existing.mode = state.mode;
        existing.text.text = state.message;
        this.drawDialog(existing);
      }
      // Any new speech, including repeated words, moves its bubble in front in Entry.
      this.raise(existing.root);
      return;
    }
    const root = new Container();
    const frame = new Graphics();
    const notch = new Graphics();
    const text = new Text({
      text: state.message,
      style: { fontFamily: MONITOR_FAMILY, fontSize: DIALOG_FONT, fill: '#000000' },
      resolution: Overlay.textResolution,
    });
    root.addChild(frame, notch, text);
    this.dialogLayer.addChild(root);
    const view: DialogView = { root, frame, notch, text, message: state.message, mode: state.mode };
    this.dialogs.set(entity, view);
    this.drawDialog(view);
  }

  private raise(root: Container): void {
    const last = this.dialogLayer.children.length - 1;
    if (last > 0 && this.dialogLayer.getChildIndex(root) !== last) {
      this.dialogLayer.setChildIndex(root, last);
    }
  }

  private drawDialog(view: DialogView): void {
    const width = Math.max(view.text.width, 17);
    const height = view.text.height;
    view.frame
      .clear()
      .roundRect(
        -DIALOG_PADDING,
        -DIALOG_PADDING,
        width + DIALOG_PADDING * 2,
        height + DIALOG_PADDING * 2,
        DIALOG_PADDING,
      )
      .fill({ color: DIALOG_BG })
      .stroke({ width: 2, color: DIALOG_BORDER });
    view.root.pivot.set(width / 2, height / 2);
  }

  private placeDialog(entity: Entity, view: DialogView): void {
    const bound = stageBounds(entity);
    const width = Math.max(view.text.width, 17);
    const height = view.text.height;
    const north = bound.y - 20 - 2 > -stage.halfHeight;
    const east = bound.x + bound.width / 2 < 0;
    view.root.y = north
      ? Math.max(bound.y - height / 2 - 20 - DIALOG_PADDING, -stage.halfHeight + height / 2 + DIALOG_PADDING)
      : Math.min(
          bound.y + bound.height + height / 2 + 20 + DIALOG_PADDING,
          stage.halfHeight - height / 2 - DIALOG_PADDING,
        );
    view.root.x = east
      ? Math.min(bound.x + bound.width + width / 2, stage.halfWidth - width / 2 - DIALOG_PADDING)
      : Math.max(bound.x - width / 2, -stage.halfWidth + width / 2 + DIALOG_PADDING);
    // Hide bubbles with their object's scene.
    view.root.visible = entity.visible && entity.target.sceneId === this.currentScene();
    this.drawNotch(view, north ? 'n' : 's', east ? 'e' : 'w', width, height);
  }

  private drawNotch(
    view: DialogView,
    vertical: 'n' | 's',
    horizontal: 'e' | 'w',
    width: number,
    height: number,
  ): void {
    const notch = view.notch;
    notch.clear();
    const baseY = vertical === 'n' ? height + DIALOG_PADDING : -DIALOG_PADDING;
    const tipY = vertical === 'n' ? baseY + 9 : baseY - 9;
    const anchorX = horizontal === 'e' ? 2 : width - 2;
    const innerX = horizontal === 'e' ? 12 : width - 12;
    if (view.mode === 'think') {
      notch
        .circle(anchorX + (horizontal === 'e' ? 2 : -2), baseY + (vertical === 'n' ? 5 : -5), 4)
        .fill({ color: DIALOG_BG })
        .stroke({ width: 2, color: DIALOG_BORDER });
      notch
        .circle(anchorX + (horizontal === 'e' ? 8 : -8), baseY + (vertical === 'n' ? 12 : -12), 2.5)
        .fill({ color: DIALOG_BG })
        .stroke({ width: 2, color: DIALOG_BORDER });
      return;
    }
    notch
      .moveTo(anchorX, baseY)
      .lineTo(anchorX, tipY)
      .lineTo(innerX, baseY)
      .fill({ color: DIALOG_BG })
      .stroke({ width: 2, color: DIALOG_BORDER });
  }

  private static text(size: number, fill: string): Text {
    const text = new Text({
      text: '',
      style: { fontFamily: MONITOR_FAMILY, fontSize: size, fill },
      resolution: Overlay.textResolution,
    });
    // Center text by its anchor so font ascent and descent cannot push it downward.
    text.anchor.set(0, 0.5);
    return text;
  }

  private makeMonitor(): MonitorView {
    const root = new Container();
    const frame = new Graphics();
    const label = Overlay.text(MONITOR_FONT, '#000000');
    const value = Overlay.text(MONITOR_VALUE_FONT, '#ffffff');
    root.addChild(frame, label, value);
    this.monitorLayer.addChild(root);
    return { root, frame, label, value, items: null, rows: [], slider: null, slideRun: 0, shown: '' };
  }

  // Prefix local monitor names with the owning object to distinguish duplicate variable names.
  private monitorName(variable: Variable): string {
    if (!variable.objectId) {
      return variable.name;
    }
    const owner = this.ownerName(variable.objectId);
    return owner ? `${owner}:${variable.name}` : variable.name;
  }

  private drawValueMonitor(
    view: MonitorView,
    name: string,
    text: string,
    x: number,
    y: number,
    color: string,
  ): void {
    view.root.position.set(x, y);
    // Rebuild monitor geometry only when changed to avoid measuring text every frame.
    const shown = `${name}\u0000${text}\u0000${color}`;
    if (view.shown === shown) {
      return;
    }
    view.shown = shown;
    view.label.text = name;
    view.value.text = text;
    const nameWidth = view.label.width;
    const valueWidth = view.value.width;
    // Ordinary variable boxes fit their content; only slider boxes have a minimum width of 90.
    view.frame
      .clear()
      .roundRect(0, -14, nameWidth + valueWidth + 35, 24, 4)
      .fill({ color: MONITOR_BG })
      .stroke({ width: 1, color: MONITOR_BORDER })
      .roundRect(nameWidth + 14, -10, valueWidth + 15, 16, MONITOR_RADIUS)
      .fill({ color })
      .stroke({ width: 1, color });
    view.label.position.set(4, LABEL_Y);
    view.value.position.set(nameWidth + 21, VALUE_Y);
  }

  private drawSlideMonitor(
    view: MonitorView,
    variable: Variable,
    at: { x: number; y: number },
  ): void {
    view.root.position.set(at.x, at.y);
    const text = Overlay.formatValue(variable.value);
    const shown = `slide\u0000${variable.name}\u0000${text}\u0000${variable.minValue}\u0000${variable.maxValue}`;
    if (!view.slider) {
      const bar = new Graphics();
      const knob = new Graphics();
      view.root.addChild(bar, knob);
      view.slider = { bar, knob };
    }
    // Update the slider knob even when the rest of the box is unchanged.
    view.slideRun = Overlay.slideRun(view);
    view.slider.knob.position.set(Overlay.slideKnobX(variable, view.slideRun), 9);
    if (view.shown === shown) {
      return;
    }
    view.shown = shown;
    view.label.text = this.monitorName(variable);
    view.value.text = text;
    const nameWidth = view.label.width;
    const valueWidth = view.value.width;
    view.frame
      .clear()
      .roundRect(0, -14, Math.max(nameWidth + valueWidth + 35, MONITOR_MIN_WIDTH), SLIDE_HEIGHT, 4)
      .fill({ color: MONITOR_BG })
      .stroke({ width: 1, color: MONITOR_BORDER })
      .roundRect(nameWidth + 14, -10, valueWidth + 15, 16, MONITOR_RADIUS)
      .fill({ color: MONITOR_VARIABLE })
      .stroke({ width: 1, color: MONITOR_VARIABLE });
    view.label.position.set(4, LABEL_Y);
    view.value.position.set(nameWidth + 21, VALUE_Y);
    const run = Overlay.slideRun(view);
    view.slideRun = run;
    view.slider.bar
      .clear()
      .roundRect(SLIDE_BAR_X, SLIDE_BAR_Y, run + 4, SLIDE_BAR_HEIGHT, SLIDE_BAR_RADIUS)
      .fill({ color: SLIDE_BAR_COLOR });
    // Draw Entry's knob and grip lines directly to avoid another image asset.
    const knobLeft = -SLIDE_KNOB_WIDTH / 2;
    view.slider.knob
      .clear()
      .roundRect(knobLeft, 0, SLIDE_KNOB_WIDTH, SLIDE_KNOB_HEIGHT, SLIDE_KNOB_RADIUS)
      .fill({ color: SLIDE_KNOB_COLOR });
    for (const gripX of SLIDE_GRIP_X) {
      view.slider.knob.rect(knobLeft + gripX, SLIDE_GRIP_Y, SLIDE_GRIP_WIDTH, SLIDE_GRIP_HEIGHT);
    }
    view.slider.knob.fill({ color: SLIDE_GRIP_COLOR });
    view.slider.knob.position.set(Overlay.slideKnobX(variable, run), 9);
  }

  private static slideRun(view: MonitorView): number {
    return Math.max(view.label.width + view.value.width + 26, MONITOR_MIN_WIDTH) - 16;
  }

  private static slideKnobX(variable: Variable, run: number): number {
    const span = Math.abs(variable.maxValue - variable.minValue);
    const ratio = span === 0 ? 0 : Math.abs(Number(variable.value) - variable.minValue) / span;
    return run * ratio + SLIDE_BAR_X;
  }

  // Saved list dimensions describe row space; the full frame adds 7 in width and 22 in height.
  private drawListMonitor(
    view: MonitorView,
    variable: Variable,
    at: { x: number; y: number },
  ): void {
    const width = variable.width || 100;
    const height = variable.height || 120;
    const rows = variable.array;
    view.root.position.set(at.x, at.y);

    const visible = Math.floor((height - 15) / LIST_ROW_HEIGHT);
    const overflow = visible < rows.length;
    const first = Math.max(0, Math.min(this.scrollOf(variable), rows.length - visible));
    const stripWidth = width - 2 * MONITOR_INSET - (overflow ? 30 : 20) - 6 + 14;
    const run = this.barRun(variable);

    const shown = `${variable.name}\u0000${width}\u0000${height}\u0000${first}\u0000${run ? run.room : -1}`;
    if (view.shown !== shown) {
      view.shown = shown;
      view.value.text = '';
      view.frame
        .clear()
        .roundRect(0, 0, width + 7, height + 22, MONITOR_RADIUS)
        .fill({ color: MONITOR_BG })
        .stroke({ width: 1, color: MONITOR_BORDER });
      if (run) {
        view.frame
          .roundRect(width - 9, run.top + (run.span * first) / run.room, 6, LIST_BAR_HEIGHT, 3)
          .fill({ color: MONITOR_BORDER });
      }
      const handleX = width - LIST_HANDLE_X;
      const handleY = height + LIST_HANDLE_Y;
      view.frame
        .moveTo(handleX + LIST_HANDLE_SIZE, handleY)
        .lineTo(handleX + LIST_HANDLE_SIZE, handleY + LIST_HANDLE_SIZE)
        .lineTo(handleX, handleY + LIST_HANDLE_SIZE)
        .closePath()
        .fill({ color: LIST_HANDLE_COLOR });
      view.label.style.fill = '#000000';
      view.label.text = this.monitorName(variable);
      view.label.position.set((width - view.label.width) / 2 + 3, LIST_TITLE_HEIGHT / 2);
    }

    if (!view.items) {
      view.items = new Container();
      view.root.addChild(view.items);
    }
    const seats = Math.max(0, Math.min(visible, rows.length - first));
    for (let seat = 0; seat < seats; seat += 1) {
      this.drawRow(view, seat, first + seat, String(rows[first + seat]!.data ?? ''), stripWidth);
    }
    // Hide unused rows instead of deleting them so growing lists can reuse them.
    for (let seat = seats; seat < view.rows.length; seat += 1) {
      view.rows[seat]!.root.visible = false;
    }
  }

  // Reuse row text to avoid measuring and baking textures on every frame.
  private drawRow(
    view: MonitorView,
    seat: number,
    at: number,
    text: string,
    stripWidth: number,
  ): void {
    let row = view.rows[seat];
    if (!row) {
      const middle = STRIP_TOP + STRIP_HEIGHT / 2;
      const root = new Container();
      const index = Overlay.text(MONITOR_FONT, '#000000');
      index.position.set(0, middle);
      const strip = new Graphics();
      const value = Overlay.text(MONITOR_VALUE_FONT, '#ffffff');
      value.position.set(24, middle);
      root.addChild(index, strip, value);
      view.items!.addChild(root);
      row = { root, index, strip, value, shown: '\u0000', stripWidth: -1 };
      view.rows[seat] = row;
    }
    row.root.visible = true;
    row.root.position.set(MONITOR_INSET, seat * LIST_ROW_HEIGHT + LIST_TITLE_HEIGHT);
    if (row.stripWidth !== stripWidth) {
      row.stripWidth = stripWidth;
      row.strip
        .clear()
        .roundRect(18, STRIP_TOP, stripWidth, STRIP_HEIGHT, 2)
        .fill({ color: MONITOR_VARIABLE });
      row.shown = '\u0000';
    }
    const shown = `${at}\u0000${text}`;
    if (row.shown === shown) {
      return;
    }
    row.shown = shown;
    row.index.text = String(at + 1);
    row.value.text = Overlay.fitText(row.value, text, stripWidth - 12);
  }

  scrollOf(variable: Variable): number {
    return this.scrolled.get(variable) ?? 0;
  }

  scrollTo(variable: Variable, row: number): void {
    const visible = Math.floor(((variable.height || 120) - 15) / LIST_ROW_HEIGHT);
    const last = Math.max(0, variable.array.length - visible);
    this.scrolled.set(variable, Math.max(0, Math.min(last, Math.round(row))));
  }

  listHandleAt(x: number, y: number): Variable | null {
    for (const [variable, view] of this.monitors) {
      if (!variable.isList || !variable.visible || !view.root.visible) {
        continue;
      }
      const left = view.root.x + (variable.width || 100) - LIST_HANDLE_X;
      const top = view.root.y + (variable.height || 120) + LIST_HANDLE_Y;
      if (x >= left && x <= left + LIST_HANDLE_SIZE && y >= top && y <= top + LIST_HANDLE_SIZE) {
        return variable;
      }
    }
    return null;
  }

  // Scroll list rows and the scrollbar, but leave the title strip fixed.
  listAt(x: number, y: number): { variable: Variable; rowsPerPixel: number } | null {
    for (const [variable, view] of this.monitors) {
      if (!variable.isList || !variable.visible || !view.root.visible) {
        continue;
      }
      const boxWidth = (variable.width || 100) + 7;
      const boxHeight = (variable.height || 120) + 22;
      const left = view.root.x;
      const top = view.root.y;
      const inside = x >= left && x <= left + boxWidth && y >= top && y <= top + boxHeight;
      if (!inside || y - top < LIST_TITLE_HEIGHT) {
        continue;
      }
      const run = this.barRun(variable);
      // Scrollbar dragging follows the track; row dragging follows the pointer.
      const onBar = run !== null && x - left >= (variable.width || 100) - 12;
      return {
        variable,
        rowsPerPixel: onBar && run ? run.room / run.span : 1 / LIST_ROW_HEIGHT,
      };
    }
    return null;
  }

  sliderAt(x: number, y: number): Variable | null {
    for (const [variable, view] of this.monitors) {
      if (!variable.isSlide || !variable.visible || !view.root.visible || !view.slider) {
        continue;
      }
      const width = Math.max(view.label.width + view.value.width + 35, MONITOR_MIN_WIDTH);
      const left = view.root.x;
      const top = view.root.y - 14;
      if (x < left || x > left + width || y < top || y > top + SLIDE_HEIGHT) {
        continue;
      }
      // Keep the variable pill above the slider read-only for dragging.
      if (y - view.root.y < SLIDE_BAR_Y - 6) {
        continue;
      }
      return variable;
    }
    return null;
  }

  // Match Entry's slider ratio over the local range from 10 to maxWidth + 10.
  dragSlider(variable: Variable, x: number): void {
    const view = this.monitors.get(variable);
    if (!view || !view.slider) {
      return;
    }
    const run = view.slideRun || Overlay.slideRun(view);
    const command = Math.min(run + 10, Math.max(10, x - view.root.x));
    const ratio = run === 0 ? 0 : Math.min(1, Math.max(0, (command - 10) / run));
    const min = Number(variable.minValue);
    const max = Number(variable.maxValue);
    let value = parseFloat((min + Math.abs(max - min) * ratio).toFixed(2));
    value = Math.min(Math.max(value, min), max);
    // Entry retains decimals only when the slider bounds contain them.
    if (Number.isInteger(min) && Number.isInteger(max)) {
      value = Math.round(value);
    }
    variable.setValue(value);
  }

  // Share scrollbar geometry between drawing and hit tests so the thumb cannot drift.
  private barRun(variable: Variable): { top: number; span: number; room: number } | null {
    const height = variable.height || 120;
    const visible = Math.floor((height - 15) / LIST_ROW_HEIGHT);
    const room = variable.array.length - visible;
    if (room <= 0) {
      return null;
    }
    // Align the scrollbar track with the rows rather than the full box.
    const lastStripBottom =
      (visible - 1) * LIST_ROW_HEIGHT + LIST_TITLE_HEIGHT + STRIP_TOP + STRIP_HEIGHT;
    const bottom = lastStripBottom - LIST_BAR_HEIGHT;
    return { top: LIST_BAR_TOP, span: Math.max(1, bottom - LIST_BAR_TOP), room };
  }

  // Match Entry's clipped row text ending with two dots.
  private static fitText(view: Text, text: string, room: number): string {
    view.text = text;
    if (view.width <= room) {
      return text;
    }
    let cut = text;
    while (cut.length > 1 && view.width > room) {
      cut = `${cut.slice(0, -3)}..`;
      view.text = cut;
    }
    return cut;
  }

  // Entry shows integers unchanged and rounds other numbers to two decimals.
  private static formatValue(value: string | number | boolean): string {
    const text = String(value);
    if (text !== '' && !isNaN(Number(text))) {
      if (text[0] !== '0' && Number.isInteger(Number(text))) {
        return text;
      }
      return Number(text).toFixed(2).replace('.00', '');
    }
    return text;
  }

  // Show local monitors only in their owner's scene.
  private inCurrentScene(variable: Variable): boolean {
    if (!variable.objectId) return true;
    const scene = this.ownerScene(variable.objectId);
    return scene === null || scene === this.currentScene();
  }

  flush(): void {
    this.drawTable();
    for (const [entity, view] of this.dialogs) {
      this.placeDialog(entity, view);
    }
    for (const variable of this.variables) {
      if (variable.kind === 'answer' || variable.kind === 'timer') {
        continue;
      }
      let view = this.monitors.get(variable);
      if (!variable.visible || !this.inCurrentScene(variable)) {
        if (view) {
          view.root.visible = false;
        }
        continue;
      }
      if (!view) {
        view = this.makeMonitor();
        this.monitors.set(variable, view);
      }
      view.root.visible = true;
      const at = this.homeOf(variable);
      if (variable.isList) {
        this.drawListMonitor(view, variable, at);
      } else if (variable.isSlide) {
        this.drawSlideMonitor(view, variable, at);
      } else {
        this.drawValueMonitor(
          view,
          this.monitorName(variable),
          Overlay.formatValue(variable.value),
          at.x,
          at.y,
          MONITOR_VARIABLE,
        );
      }
    }
    this.flushBuiltin();
  }

  // Entry treats zero coordinates as missing and lays those monitors out automatically.
  private homeOf(variable: Variable): { x: number; y: number } {
    if (variable.x && variable.y) {
      return { x: variable.x, y: variable.y };
    }
    // Count variables and lists separately so automatic positions stay within their own columns.
    const family = this.variables.filter((item) => item.isList === variable.isList);
    const index = Math.max(0, family.indexOf(variable));
    if (variable.isList) {
      return {
        x: -Math.floor((index % 24) / 6) * 110 + 120,
        y: index * 24 + 20 - 135 - Math.floor(index / 6) * 145,
      };
    }
    const column = Math.floor(index / 11);
    return { x: 10 - 240 + column * 80, y: index * 24 + 20 - 135 - column * 264 };
  }

  // Preserve saved timer and answer positions, with Entry's defaults when absent.
  private flushBuiltin(): void {
    const answer = this.variables.find((variable) => variable.kind === 'answer');
    const timer = this.variables.find((variable) => variable.kind === 'timer');
    if (this.answerShown()) {
      if (!this.answerMonitor) {
        this.answerMonitor = this.makeMonitor();
      }
      this.answerMonitor.root.visible = true;
      const at = Overlay.builtinHome(answer, ANSWER_HOME);
      this.drawValueMonitor(
        this.answerMonitor,
        '대답',
        String(this.answerValue()),
        at.x,
        at.y,
        MONITOR_ANSWER,
      );
    } else if (this.answerMonitor) {
      this.answerMonitor.root.visible = false;
    }
    if (this.timerShown()) {
      if (!this.timerMonitor) {
        this.timerMonitor = this.makeMonitor();
      }
      this.timerMonitor.root.visible = true;
      const at = Overlay.builtinHome(timer, TIMER_HOME);
      this.drawValueMonitor(
        this.timerMonitor,
        timer?.name || '초시계',
        this.timerValue().toFixed(1),
        at.x,
        at.y,
        MONITOR_TIMER,
      );
    } else if (this.timerMonitor) {
      this.timerMonitor.root.visible = false;
    }
  }

  private static builtinHome(
    variable: Variable | undefined,
    home: { x: number; y: number },
  ): { x: number; y: number } {
    return variable?.x && variable.y ? { x: variable.x, y: variable.y } : home;
  }
}
