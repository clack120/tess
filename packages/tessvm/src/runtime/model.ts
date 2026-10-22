import { clamp, isNumber, mod, num, parseNumber } from './cast.ts';

// Entry draws 480 by 270 stage units onto a 640 by 360 canvas.
export const DEFAULT_STAGE_WIDTH = 480;
export const DEFAULT_STAGE_HEIGHT = 270;
// Keep Entry's 640/480 ratio so collision coordinates remain consistent at every stage size.
export const WORLD_SCALE = 4 / 3;

export interface StageMetrics {
  width: number;
  height: number;
  halfWidth: number;
  halfHeight: number;
  scale: number;
  worldWidth: number;
  worldHeight: number;
}

function metrics(width: number, height: number): StageMetrics {
  return {
    width,
    height,
    halfWidth: width / 2,
    halfHeight: height / 2,
    scale: WORLD_SCALE,
    worldWidth: width * WORLD_SCALE,
    worldHeight: height * WORLD_SCALE,
  };
}

export const stage: StageMetrics = metrics(DEFAULT_STAGE_WIDTH, DEFAULT_STAGE_HEIGHT);

// Keep one stage size for collision, walls, dialogs, monitors, and rendering.
export function setStageSize(width: number, height: number): StageMetrics {
  Object.assign(stage, metrics(Math.max(1, Math.round(width)), Math.max(1, Math.round(height))));
  return stage;
}

export const COLLISION = { NONE: 0, UP: 1, RIGHT: 2, LEFT: 3, DOWN: 4 } as const;

export interface Picture {
  id: string;
  name: string;
  fileurl: string;
  // Prefer the vector only when it preserves the saved raster's framing and settings permit it.
  pngurl?: string;
  dimension: { width: number; height: number };
  imageType?: string;
}

export interface Sound {
  id: string;
  name: string;
  fileurl: string;
  duration: number;
}

export interface Effects {
  blur: number;
  hue: number;
  hsv: number;
  brightness: number;
  contrast: number;
  saturation: number;
  alpha: number;
}

export function initialEffects(): Effects {
  return { blur: 0, hue: 0, hsv: 0, brightness: 0, contrast: 0, saturation: 0, alpha: 1 };
}

export interface BrushState {
  color: string;
  thickness: number;
  opacity: number;
  stop: boolean;
  // Order pens by first use because Entry inserts later pens in front.
  started: number;
  path: number[];
  strokes: Stroke[];
  fill: boolean;
}

export interface Stroke {
  color: string;
  thickness: number;
  opacity: number;
  points: number[];
  fill: boolean;
}

let penOrder = 0;

// Preserve pen creation order for layering.
export function newBrush(): BrushState {
  return {
    color: '#ff0000', thickness: 1, opacity: 0, stop: false,
    started: ++penOrder, path: [], strokes: [], fill: false,
  };
}

const CANVAS_DEFAULT_FONT = { size: 10, family: 'sans-serif' };

// Preserve fractional font sizes and use the canvas fallback when the saved size is invalid.
export function parseFont(font: string): {
  size: number;
  family: string;
  bold: boolean;
  italic: boolean;
} {
  const parts = String(font ?? '').trim().split(/\s+/).filter(Boolean);
  let bold = false;
  let italic = false;
  while (parts.length && (parts[0] === 'bold' || parts[0] === 'italic')) {
    if (parts[0] === 'bold') {
      bold = true;
    } else {
      italic = true;
    }
    parts.shift();
  }
  const token = parts.shift();
  const size = parseFloat(token ?? '');
  if (token !== undefined && Number.isNaN(size)) {
    return { ...CANVAS_DEFAULT_FONT, bold: false, italic: false };
  }
  const family = parts.join(' ').trim() || 'Nanum Gothic';
  return { size: size || 20, family, bold, italic };
}

export interface VoiceProps {
  speaker: string;
  speed: number;
  pitch: number;
  volume: number;
}

export interface DialogState {
  message: string;
  mode: 'speak' | 'think' | 'ask';
}

// Resolve costumes and sounds by ID, name, then one-based index.
function lookup<T extends { id: string; name: string }>(items: T[], value: unknown): T | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const key = String(value).trim();
  for (const item of items) {
    if (item.id === key) {
      return item;
    }
  }
  for (const item of items) {
    if (item.name === key) {
      return item;
    }
  }
  const index = parseNumber(key);
  if (index !== false && Number(index) > 0 && Number(index) <= items.length) {
    return items[Number(index) - 1] ?? null;
  }
  return null;
}

let entitySeq = 0;

export class Entity {
  readonly target: Target;
  readonly id: string;
  readonly isClone: boolean;
  readonly type: 'sprite' | 'textBox';

  x = 0;
  y = 0;
  regX = 0;
  regY = 0;
  scaleX = 1;
  scaleY = 1;
  rotation = 0;
  direction = 90;
  width = 0;
  height = 0;
  visible = true;
  flip = false;
  scaleOriginX = 1;
  scaleOriginY = 1;
  collision: number = COLLISION.NONE;

  picture: Picture | null = null;
  effect: Effects = initialEffects();

  text = '';
  colour = '#000000';
  bgColor = 'transparent';
  fontSize = 20;
  fontFamily = 'Nanum Gothic';
  fontBold = false;
  fontItalic = false;
  underLine = false;
  strike = false;
  textAlign = 0;
  lineBreak = false;

  voice: VoiceProps = { speaker: 'kyuri', speed: 0, pitch: 0, volume: 1 };

  brush: BrushState | null = null;
  paint: BrushState | null = null;
  stamps: StampState[] = [];
  dialog: DialogState | null = null;
  // Clone local variables use the same indices as the project's variable list.
  localVars: Array<Variable | undefined> | null = null;

  // Bump the pixel revision whenever collision-visible state changes.
  version = 1;
  dirty = true;
  removed = false;

  constructor(target: Target, isClone: boolean) {
    this.target = target;
    this.id = isClone ? `${target.id}#${++entitySeq}` : target.id;
    this.isClone = isClone;
    this.type = target.objectType;
  }

  touch(): void {
    this.version++;
    this.dirty = true;
  }

  setX(x: number): void {
    if (typeof x !== 'number') {
      return;
    }
    this.x = x;
    this.touch();
  }

  setY(y: number): void {
    if (typeof y !== 'number') {
      return;
    }
    this.y = y;
    this.touch();
  }

  getX(): number {
    return this.x;
  }

  getY(): number {
    return this.y;
  }

  getDirection(): number {
    return this.direction;
  }

  // Mirror vertical-rotation sprites when heading crosses the vertical axis.
  setDirection(dir = 0, flippable = false): void {
    const direction = mod(dir, 360);
    if (this.target.rotateMethod === 'vertical' && !flippable) {
      const previousIsRight = this.direction >= 0 && this.direction < 180;
      const afterIsRight = direction >= 0 && direction < 180;
      if (previousIsRight !== afterIsRight) {
        this.setScaleX(-this.getScaleX());
        this.flip = !this.flip;
      }
    }
    this.direction = direction;
    this.touch();
  }

  setRotation(rotation: number): void {
    this.rotation = mod(this.target.rotateMethod === 'free' ? rotation : 0, 360);
    this.touch();
  }

  getRotation(): number {
    return this.rotation;
  }

  setRegX(regX: number): void {
    this.regX = this.type === 'textBox' ? 0 : regX;
    this.touch();
  }

  setRegY(regY: number): void {
    this.regY = this.type === 'textBox' ? 0 : regY;
    this.touch();
  }

  setScaleX(scaleX: number): void {
    this.scaleX = scaleX;
    if (this.target.project.stopped) {
      this.scaleOriginX = scaleX;
    }
    this.touch();
  }

  setScaleY(scaleY: number): void {
    this.scaleY = scaleY;
    if (this.target.project.stopped) {
      this.scaleOriginY = scaleY;
    }
    this.touch();
  }

  getScaleX(): number {
    return this.scaleX;
  }

  getScaleY(): number {
    return this.scaleY;
  }

  // Entry reports size as the mean of the transformed side lengths.
  getSize(): number {
    return (this.width * Math.abs(this.scaleX) + this.height * Math.abs(this.scaleY)) / 2;
  }

  setSize(size: number): void {
    const scale = Math.max(1, size) / this.getSize();
    this.setScaleX(this.scaleX * scale);
    this.setScaleY(this.scaleY * scale);
  }

  setXSize(size: number): void {
    this.setScaleX(this.scaleX * (Math.max(1, size) / this.getSize()));
  }

  setYSize(size: number): void {
    this.setScaleY(this.scaleY * (Math.max(1, size) / this.getSize()));
  }

  resetSize(): void {
    this.setScaleX(this.scaleOriginX);
    this.setScaleY(this.scaleOriginY);
  }

  setWidth(width: number): void {
    this.width = width;
    this.touch();
  }

  setHeight(height: number): void {
    this.height = height;
    this.touch();
  }

  getWidth(): number {
    return this.width;
  }

  getHeight(): number {
    return this.height;
  }

  setVisible(visible: boolean): boolean {
    this.visible = visible;
    this.touch();
    return visible;
  }

  getVisible(): boolean {
    return this.visible;
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
    this.measure(false);
    this.touch();
  }

  // Update width immediately after text changes; only font changes also remeasure saved height.
  measure(withHeight = true): void {
    if (this.type !== 'textBox' || this.lineBreak) {
      return;
    }
    const size = this.target.project.measureTextBox?.(this);
    if (size) {
      this.width = size.width;
      if (withHeight) {
        this.height = size.height;
      }
    }
  }

  // Keep the registration point's offset from the costume center when changing images.
  setImage(picture: Picture | null | undefined): void {
    if (!picture) {
      return;
    }
    const absoluteRegX = this.regX - this.width / 2;
    const absoluteRegY = this.regY - this.height / 2;
    this.picture = picture;
    this.width = picture.dimension.width;
    this.height = picture.dimension.height;
    this.setRegX(this.width / 2 + absoluteRegX);
    this.setRegY(this.height / 2 + absoluteRegY);
    this.touch();
  }

  resetFilter(): void {
    if (this.type !== 'sprite') {
      return;
    }
    this.effect = initialEffects();
    this.touch();
  }

  applyEffects(): void {
    this.effect.alpha = clamp(this.effect.alpha, 0, 1);
    this.touch();
  }

  worldMatrix(out: Float64Array): Float64Array {
    const rad = (this.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const sx = this.scaleX * stage.scale;
    const sy = this.scaleY * stage.scale;
    const a = cos * sx;
    const b = sin * sx;
    const c = -sin * sy;
    const d = cos * sy;
    out[0] = a;
    out[1] = b;
    out[2] = c;
    out[3] = d;
    out[4] = this.x * stage.scale + stage.worldWidth / 2 - (a * this.regX + c * this.regY);
    out[5] = -this.y * stage.scale + stage.worldHeight / 2 - (b * this.regX + d * this.regY);
    return out;
  }

  removeClone(): void {
    if (!this.isClone || this.removed) {
      return;
    }
    this.removed = true;
    this.target.removeClone(this);
  }
}

export interface StampState {
  picture: Picture | null;
  x: number;
  y: number;
  regX: number;
  regY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  alpha: number;
}

export class Target {
  readonly project: Project;
  readonly id: string;
  readonly name: string;
  readonly objectType: 'sprite' | 'textBox';
  readonly sceneId: string;
  rotateMethod: string;
  pictures: Picture[] = [];
  sounds: Sound[] = [];
  defaultPicture: Picture | null = null;
  entity!: Entity;
  clones: Entity[] = [];
  scripts: CompiledScript[] = [];
  threads: Thread[] = [];
  index = 0;

  constructor(project: Project, id: string, name: string, objectType: 'sprite' | 'textBox', sceneId: string, rotateMethod: string) {
    this.project = project;
    this.id = id;
    this.name = name;
    this.objectType = objectType;
    this.sceneId = sceneId;
    this.rotateMethod = rotateMethod;
  }

  // Return null on missing costumes; falling back to the first silently shows the wrong image.
  getPicture(value: unknown): Picture | null {
    return lookup(this.pictures, value) ?? (value ? null : this.defaultPicture ?? this.pictures[0] ?? null);
  }

  private pictureIndex(value: unknown): number {
    const picture = lookup(this.pictures, value);
    return picture ? this.pictures.indexOf(picture) : -1;
  }

  getNextPicture(value: unknown): Picture | null {
    const length = this.pictures.length;
    const index = this.pictureIndex(value);
    return this.pictures[index === length - 1 ? 0 : index + 1] ?? null;
  }

  getPrevPicture(value: unknown): Picture | null {
    const index = this.pictureIndex(value);
    return this.pictures[index === 0 ? this.pictures.length - 1 : index - 1] ?? null;
  }

  getSound(value: unknown): Sound | null {
    return lookup(this.sounds, value) ?? (value ? null : this.sounds[0] ?? null);
  }

  addClone(source: Entity): Entity {
    const clone = new Entity(this, true);
    clone.x = source.x;
    clone.y = source.y;
    clone.regX = source.regX;
    clone.regY = source.regY;
    clone.scaleX = source.scaleX;
    clone.scaleY = source.scaleY;
    clone.scaleOriginX = source.scaleOriginX;
    clone.scaleOriginY = source.scaleOriginY;
    clone.rotation = source.rotation;
    clone.direction = source.direction;
    clone.width = source.width;
    clone.height = source.height;
    clone.visible = source.visible;
    clone.picture = source.picture;
    clone.effect = { ...source.effect };
    clone.text = source.text;
    clone.colour = source.colour;
    clone.bgColor = source.bgColor;
    clone.fontSize = source.fontSize;
    clone.fontFamily = source.fontFamily;
    clone.fontBold = source.fontBold;
    clone.fontItalic = source.fontItalic;
    clone.underLine = source.underLine;
    clone.strike = source.strike;
    clone.textAlign = source.textAlign;
    clone.lineBreak = source.lineBreak;
    if (source.brush) {
      clone.brush = {
        ...newBrush(),
        color: source.brush.color,
        thickness: source.brush.thickness,
        opacity: source.brush.opacity,
        stop: source.brush.stop,
        path: [clone.x, clone.y],
      };
    }
    this.clones.push(clone);
    // Keep the clone's source entity so the renderer can insert it directly underneath.
    this.project.renderer?.addEntity(clone, source);
    return clone;
  }

  removeClone(clone: Entity): void {
    const index = this.clones.indexOf(clone);
    if (index >= 0) {
      this.clones.splice(index, 1);
    }
    this.project.stopThreadsOf(clone);
    this.project.renderer?.removeEntity(clone);
  }

  getClonedEntities(): Entity[] {
    return this.clones.slice();
  }

  // Scan the object's own entity before its clones, matching Entry.
  forEachEntity(visit: (entity: Entity) => void): void {
    visit(this.entity);
    const clones = this.clones;
    for (let i = 0; i < clones.length; i += 1) {
      visit(clones[i]!);
    }
  }
}

export type VariableKind = 'variable' | 'list' | 'slide' | 'timer' | 'answer';

// Preserve stored booleans as booleans, including inside lists.
export type VariableValue = string | number | boolean;

export class Variable {
  readonly id: string;
  readonly name: string;
  readonly objectId: string | null;
  readonly kind: VariableKind;
  readonly isList: boolean;
  readonly isSlide: boolean;
  // Shared and real-time values survive restarts instead of reverting to the project snapshot.
  isCloud = false;
  isRealTime = false;
  value: VariableValue = 0;
  array: Array<{ data: VariableValue }> = [];
  // Count every write so kernel caches notice changes, including direct list writes through touch.
  revision = 0;
  // Track in-place item writes separately; structural changes invalidate the whole list.
  private spanFrom = Infinity;
  private spanTo = -1;
  private spanAll = true;
  private syncedAt = -1;
  visible = false;
  x = 0;
  y = 0;
  width = 100;
  height = 120;
  minValue = 0;
  maxValue = 100;
  // Notify extras on every write so repeating the same clipboard text still requests another copy.
  onWrite: (() => void) | null = null;
  private snapshotValue: VariableValue = 0;
  private snapshotArray: Array<{ data: VariableValue }> = [];
  private snapshotVisible = false;

  constructor(id: string, name: string, objectId: string | null, kind: VariableKind) {
    this.id = id;
    this.name = name;
    this.objectId = objectId;
    this.kind = kind;
    this.isList = kind === 'list';
    this.isSlide = kind === 'slide';
  }

  getValue(): VariableValue {
    return this.value;
  }

  setValue(value: VariableValue): void {
    this.touch();
    if (this.isSlide) {
      const n = num(value);
      this.value = clamp(n, this.minValue, this.maxValue);
      this.onWrite?.();
      return;
    }
    this.value = value;
    this.onWrite?.();
  }

  touch(): void {
    this.revision += 1;
    this.spanAll = true;
  }

  touchItem(at: number): void {
    this.revision += 1;
    if (at < this.spanFrom) this.spanFrom = at;
    if (at > this.spanTo) this.spanTo = at;
  }

  synced(): void {
    this.syncedAt = this.revision;
    this.spanAll = false;
    this.spanFrom = Infinity;
    this.spanTo = -1;
  }

  // Return changed indices only when the kernel's revision matches; otherwise copy the whole list.
  changedSince(revision: number): [number, number] | null {
    return this.syncedAt === revision && !this.spanAll ? [this.spanFrom, this.spanTo] : null;
  }

  // Match Entry's numeric test to decide whether variable changes add or concatenate.
  isNumber(): boolean {
    return isNumber(this.value);
  }

  getArray(): Array<{ data: VariableValue }> {
    return this.array;
  }

  get isStored(): boolean {
    return this.isCloud || this.isRealTime;
  }

  takeSnapshot(): void {
    this.snapshotValue = this.value;
    this.snapshotArray = this.array.map((item) => ({ data: item.data }));
    this.snapshotVisible = this.visible;
  }

  loadSnapshot(): void {
    // Preserve stored values while restoring their monitor positions.
    if (!this.isStored) {
      this.value = this.snapshotValue;
      this.array = this.snapshotArray.map((item) => ({ data: item.data }));
      this.touch();
    }
    this.visible = this.snapshotVisible;
  }
}

export interface CompiledScript {
  /** Event that starts it: `start`, `when_message_cast`, … */
  event: string;
  /** Message id, key code, or whatever the hat block filters on. */
  filter: string | null;
  /** Generator body produced by the compiler. */
  body: ScriptBody;
  /** Block id of the hat, for error reporting. */
  blockId: string;
}

// A number yields the frame, 1 marks a promise wait, and a generator starts a nested call.
export type Yielded = number | CallFrame;

export type CallFrame = Generator<Yielded, unknown, unknown> & { finishes?: boolean };

// Throw into a value call to finish through its return expression.
const FINISH = Symbol('finish');

export type ScriptBody = (entity: Entity, thread: Thread) => Generator<Yielded, void, unknown>;

export type CompiledFunction = (entity: Entity, thread: Thread, args: unknown[]) => CallFrame;

export class Thread {
  readonly target: Target;
  readonly entity: Entity;
  readonly script: CompiledScript;
  iterator: Generator<Yielded, void, unknown>;
  // Keep nested call frames off the JavaScript stack.
  private frames: CallFrame[];
  private waitingAsync = false;
  get finish(): symbol {
    return FINISH;
  }
  done = false;
  // Preserve the call stack before unwinding an error.
  failedFrames: CallFrame[] | null = null;
  running = false;
  state: Record<string, unknown> = {};
  depth = 0;

  constructor(target: Target, entity: Entity, script: CompiledScript) {
    this.target = target;
    this.entity = entity;
    this.script = script;
    this.iterator = script.body(entity, this);
    this.frames = [this.iterator as CallFrame];
  }

  step(): void {
    if (this.done || this.running) {
      return;
    }
    this.running = true;
    try {
      this.resume();
    } finally {
      this.running = false;
    }
  }

  // On pause, finish frame-waiting value calls but keep promise waits pending.
  finishValueCalls(): void {
    if (this.done || this.running || this.waitingAsync || !this.frames.some((frame) => frame.finishes)) return;
    this.running = true;
    try {
      this.resume(true);
    } finally {
      this.running = false;
    }
  }

  private resume(finishingValues = false): void {
    const frames = this.frames;
    let input: unknown;
    let thrown = false;
    let error: unknown;
    // Do not finish unstarted calls or interrupt a return expression already being evaluated.
    let fresh = false;
    const told = finishingValues ? new Set<CallFrame>() : null;
    for (;;) {
      if (told && !thrown) {
        const at = frames.findLastIndex((frame) => frame.finishes && !told.has(frame));
        if (at !== -1 && !(fresh && at === frames.length - 1)) {
          while (frames.length > at + 1) frames.pop()!.return(undefined);
          told.add(frames[at]!);
          thrown = true;
          error = FINISH;
        }
      }
      const frame = frames[frames.length - 1]!;
      let result: IteratorResult<Yielded, unknown>;
      try {
        result = thrown ? frame.throw(error) : frame.next(input);
        thrown = false;
        fresh = false;
      } catch (caught) {
        fresh = false;
        // Capture the stack at the first failing frame before callers unwind.
        if (!thrown) this.failedFrames = frames.slice();
        frames.pop();
        if (!frames.length) {
          this.done = true;
          throw caught;
        }
        thrown = true;
        error = caught;
        continue;
      }
      if (result.done) {
        frames.pop();
        if (!frames.length) {
          this.done = true;
          return;
        }
        input = result.value;
        continue;
      }
      const value = result.value;
      if (typeof value === 'number') {
        this.waitingAsync = value === 1;
        if (told && !this.waitingAsync && frames.some((frame) => frame.finishes && !told.has(frame))) continue;
        return;
      }
      frames.push(value);
      fresh = true;
      input = undefined;
    }
  }

  // Mark running generators done because they cannot be closed from inside their own execution.
  stop(): void {
    this.done = true;
    if (!this.running) {
      for (let at = this.frames.length - 1; at >= 0; at -= 1) {
        this.frames[at]!.return(undefined);
      }
      this.frames.length = 0;
    }
  }
}

export interface RendererLike {
  addEntity(entity: Entity, source?: Entity): void;
  removeEntity(entity: Entity): void;
  flush(): void;
}

export interface Scene {
  id: string;
  name: string;
}

export interface Project {
  scenes: Scene[];
  targets: Target[];
  renderer: RendererLike | null;
  stopped: boolean;
  stopThreadsOf(entity: Entity): void;
  /** Measured size of a text box's current text, when a measurer is attached. */
  measureTextBox?(entity: Entity): { width: number; height: number } | null;
}
