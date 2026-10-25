import {
  Codegen,
  parseScript,
  type CompiledProgram,
  type CompileInput,
  type FunctionEntry,
  type RawBlock,
} from '../compile/codegen.ts';
import { blockCounts } from '../compile/block-count.ts';
import { LiveCode, type LiveProgram } from './live-code.ts';
import { loadYield } from '../web/load-yield.ts';
import { attachJsKernel, CALL_DEPTH_LIMIT, type KernelHandle } from '../kernel/bridge.ts';
import { planKernel, type KernelPlan } from '../kernel/plan.ts';
import { CollisionSystem } from '../collision/detect.ts';
import { MaskStore, type AlphaMask } from '../collision/mask.ts';
import * as cast from './cast.ts';
import {
  Entity,
  Target,
  Thread,
  Variable,
  initialEffects,
  parseFont,
  setStageSize,
  type VariableKind,
  type VoiceProps,
  type CompiledFunction,
  type CompiledScript,
  type Picture,
  type Project,
  type RendererLike,
  type Scene,
  type Sound,
} from './model.ts';
import { Table } from './table.ts';
import { ThreadStop, createOps, type Ops } from './ops.ts';
import { SaveStore, functionName } from './save.ts';
import { Extras } from './extras.ts';
import { blockOfError, snapshotVm, RuntimeBlockError, type GeneratedTrace, type RuntimeValue, type VmSnapshot } from './diagnostics.ts';

// Entry floors the interval in milliseconds, so actual tick cadence can exceed the nominal rate.
export const DEFAULT_FPS = 64;
export const MAX_CLONES = 360;

export interface EntryProjectLike {
  objects: Array<Record<string, unknown>>;
  scenes: Array<{ id: string; name: string }>;
  variables: Array<Record<string, unknown>>;
  messages: Array<{ id: string; name: string }>;
  functions: Array<Record<string, unknown>>;
  tables?: Array<Record<string, unknown>>;
  speed?: number;
  name?: string;
}

export interface SpeechEngine {
  speak(text: string, voice: VoiceProps): Promise<void>;
  stop(): void;
  pause?(): void;
  resume?(): void;
}

// Translation hosts need a deadline so failed API calls cannot hold scripts forever.
export interface Translator {
  translate(text: string, source: string, target: string): Promise<string>;
  detect(text: string): Promise<string>;
}

export interface ExpansionReader {
  read(type: string, params: unknown[]): Promise<unknown>;
}

export interface TextMeasurer {
  measureTextBox(entity: Entity): { width: number; height: number } | null;
}

export interface Renderer extends RendererLike, Partial<TextMeasurer> {
  readonly renderCount?: number;
  attach?(targets: Target[], scenes: Scene[]): void;
  moveEntity?(entity: Entity, location: string): void;
  // Use live draw order for picking because layer changes leave declaration order unchanged.
  drawOrder?(sceneId: string): Entity[];
  syncDialog?(entity: Entity): void;
  showTable?(table: Table | null, chart?: number | null): void;
  stamp?(entity: Entity): void;
  eraseAll?(entity: Entity): void;
  penChanged?(entity: Entity): void;
  showQuestion?(text: string): void;
  hideQuestion?(): void;
  answerSubmitted?(): string | null;
  maskFor?(pictureId: string, width: number, height: number): AlphaMask | null;
  reset?(): void;
  setScene?(sceneId: string): void;
  // Redraw when boost changes the drawing rules.
  setBoost?(on: boolean): void;
}

type ProgramFactory = (runtime: Vm) => LiveProgram & {
  scripts: CompiledScript['body'][];
  functions: CompiledFunction[];
};

interface ParsedSource {
  raw: string;
  parsed: RawBlock[][];
}

function sameItems<T>(left: T[], right: T[], equal: (a: T, b: T) => boolean): boolean {
  return left.length === right.length && left.every((item, index) => equal(item, right[index]!));
}

function sameCompileInput(left: CompileInput, right: CompileInput): boolean {
  return sameItems(left.objects, right.objects,
    (a, b) => a.id === b.id && a.scene === b.scene && a.script === b.script)
    && sameItems(left.variables, right.variables,
      (a, b) => a.id === b.id && a.variableType === b.variableType && a.sharedList === b.sharedList)
    && sameItems(left.functions, right.functions, (a, b) => a.id === b.id && a.type === b.type
      && a.content === b.content && sameItems(a.localVariables, b.localVariables,
        (x, y) => x.id === y.id && x.name === y.name && x.value === y.value))
    && sameItems(left.scenes, right.scenes, (a, b) => a.id === b.id)
    && sameItems(left.messages, right.messages, (a, b) => a.id === b.id)
    && sameItems(left.tables, right.tables, (a, b) => a.id === b.id);
}

export interface AudioEngine {
  play(sound: Sound, entityId: string, startMs?: number, durationMs?: number): (() => void) | void;
  playBgm(sound: Sound): void;
  stopBgm(): void;
  stopAll(): void;
  stopEntity(entityId: string): void;
  stopExcept(entityId: string): void;
  pause?(): void;
  resume?(): void;
  setVolume(volume: number): void;
  getVolume(): number;
  setSpeed(speed: number): void;
  getSpeed(): number;
}

export interface EntryUser {
  id: string;
  nickname: string;
}

// Entry returns a space for both fields when signed out.
export const GUEST = ' ';

const STORE_FLUSH_MS = 1000;

export interface VmOptions {
  liveEditing?: boolean;
  renderer?: Renderer | null;
  audio?: AudioEngine | null;
  speech?: SpeechEngine | null;
  // Without a translation host, return Entry's offline result.
  translator?: Translator | null;
  // Browser hosts provide Entry's weather, festival, and safety data APIs.
  expansion?: ExpansionReader | null;
  // Use the host Entry label when naming new table columns.
  tableColumnName?: string;
  // Leave unset to use the project's speed.
  fps?: number;
  stageWidth?: number;
  stageHeight?: number;
  // Boost defaults on and also selects Entry-compatible fill and text behavior.
  boost?: boolean;
  deviceType?: 'desktop' | 'tablet' | 'mobile';
  touch?: boolean;
  // Without a signed-in viewer, both identity blocks return a space.
  user?: EntryUser | null;
  maxCatchUp?: number;
  store?: VariableStore | null;
  // Disable the kernel to keep all functions on the block execution path.
  kernel?: boolean;
}

// Use the supplied store for persistent shared values; without one they survive only VM restarts.
export interface VariableStore {
  read(key: string): string | number | boolean | Array<{ data: string | number | boolean }> | undefined;
  write(key: string, value: string | number | boolean | Array<{ data: string | number | boolean }>): void;
}

export interface VmError {
  message: string;
  blockId: string | null;
  targetId: string | null;
  where?: string;
  name?: string;
  stack?: string;
  blockType?: string;
  inputs?: Record<string, RuntimeValue>;
  // Capture before stopping or resetting the work.
  snapshot?: VmSnapshot;
  context?: {
    frame: number;
    clock: number;
    sceneId: string;
    sceneName: string;
    targetName: string | null;
    entityId: string | null;
    isClone: boolean;
    event: string | null;
    eventFilter: string | null;
    eventBlockId: string | null;
    calls: Array<{ name: string; count: number }>;
  };
}

export class Vm implements Project {
  readonly liveCode: LiveCode | null;
  scenes: Scene[] = [];
  targets: Target[] = [];
  variables: Variable[] = [];
  messages: Array<{ id: string; name: string }> = [];
  tables: Table[] = [];
  readonly tableColumnName: string;
  speech: SpeechEngine | null;
  translator: Translator | null;
  expansion: ExpansionReader | null;
  renderer: Renderer | null;
  audio: AudioEngine | null;
  readonly cast = cast;
  readonly extras = new Extras(this);
  readonly save = new SaveStore(this);
  readonly masks: MaskStore;
  readonly collision: CollisionSystem;
  ops!: Ops;

  // Use project FPS for tick timing and seconds-to-frame conversion.
  frameRate: number;
  private boostOn: boolean;
  deviceType: 'desktop' | 'tablet' | 'mobile';
  touch: boolean;
  user: EntryUser | null;

  state: 'stop' | 'run' | 'pause' = 'stop';
  currentSceneId = '';
  private startSceneId = '';
  clock = 0;
  frame = 0;
  answer: string | number = '';
  answerVisible = true;
  question: string | null = null;
  pendingAnswer: string | null = null;
  pressedKeys = new Set<number>();
  mouseX = 0;
  mouseY = 0;
  // Before the pointer enters, Entry places it at the canvas's top-left corner.
  pointerSeen = false;
  mouseDown = false;
  clickedEntityId: string | null = null;
  private tableCloseAt: number | null = null;
  errors: VmError[] = [];
  // Keep failure state through stop and reset so it can still be inspected.
  lastError: VmError | null = null;
  onError: ((error: VmError) => void) | null = null;

  // The project timer stays stopped until a timer-start block runs.
  private timerInit = false;
  private timerPaused = false;
  private timerStart = 0;
  private timerBase = 0;
  timerVisible = false;

  // Deliver ordinary messages after the current frame.
  private pendingMessages: string[] = [];
  private timeouts: Array<{ at: number; callback: () => void }> = [];

  private scripts: CompiledScript[] = [];
  private readonly traces = new WeakMap<CompiledScript['body'], GeneratedTrace>();
  private kernelOn: boolean;
  kernelPlan: KernelPlan | null = null;
  kernel: KernelHandle | null = null;
  private targetById = new Map<string, Target>();
  private sceneById = new Map<string, Scene>();
  private lastTime: number | null = null;
  private accumulator = 0;
  private readonly maxCatchUp: number;
  private readonly requestedFps: number | undefined;
  private store: VariableStore | null;
  private storedVars: Variable[] = [];
  // Skip unchanged stored values on the next write.
  private readonly written = new Map<string, string>();
  private lastStoreFlush = 0;
  unknownBlocks = new Map<string, number>();
  // A null key set means the work may read any key.
  usedKeys: Set<number> | null = new Set();
  // Untouched generators keep their compiled constants across live edits.
  liveBlockCounts: Record<string, number> | null = null;
  private compileInput: CompileInput | null = null;
  private compiledProgram: CompiledProgram | null = null;
  private compiledFactory: ProgramFactory | null = null;
  private objectScripts = new Map<number, ParsedSource>();
  private functionScripts = new Map<number, ParsedSource>();

  constructor(options: VmOptions = {}) {
    this.liveCode = options.liveEditing ? new LiveCode() : null;
    this.renderer = options.renderer ?? null;
    this.audio = options.audio ?? null;
    this.speech = options.speech ?? null;
    this.translator = options.translator ?? null;
    this.expansion = options.expansion ?? null;
    this.tableColumnName = options.tableColumnName ?? '새로운 열';
    this.requestedFps = options.fps;
    this.frameRate = options.fps ?? DEFAULT_FPS;
    if (options.stageWidth && options.stageHeight) {
      setStageSize(options.stageWidth, options.stageHeight);
    }
    this.boostOn = options.boost ?? true;
    this.deviceType = options.deviceType ?? 'desktop';
    this.touch = options.touch ?? false;
    this.user = options.user ?? null;
    this.maxCatchUp = options.maxCatchUp ?? 4;
    this.store = options.store ?? null;
    this.kernelOn = options.kernel === true;
    this.masks = new MaskStore(
      (key, width, height) => this.renderer?.maskFor?.(key, width, height) ?? null,
    );
    this.collision = new CollisionSystem(this.masks);
    this.ops = createOps(this);
  }

  get stopped(): boolean {
    return this.state === 'stop';
  }

  measureTextBox(entity: Entity): { width: number; height: number } | null {
    return this.renderer?.measureTextBox?.(entity) ?? null;
  }

  load(project: EntryProjectLike): void {
    this.lastError = null;
    this.masks.clear();
    // Match Entry's project speed fallback and use it for timed blocks.
    this.frameRate = this.requestedFps ?? (Number(project.speed) || DEFAULT_FPS);
    this.scenes = project.scenes.map((scene) => ({ id: scene.id, name: scene.name }));
    this.sceneById = new Map(this.scenes.map((scene) => [scene.id, scene]));
    this.currentSceneId = this.firstSceneId();
    this.messages = project.messages.map((message) => ({ id: message.id, name: message.name }));
    this.tables = (project.tables ?? []).map((raw) => Table.from(raw as never));

    this.answerVisible = false;
    this.timerVisible = false;
    this.variables = project.variables.map((raw) => {
      const type = String(raw.variableType ?? 'variable') as VariableKind;
      const variable = new Variable(
        String(raw.id),
        String(raw.name ?? ''),
        (raw.object as string | null) ?? null,
        type,
      );
      if (type === 'answer') {
        this.answerVisible = Boolean(raw.visible);
      } else if (type === 'timer') {
        this.timerVisible = Boolean(raw.visible);
      }
      variable.isCloud = Boolean(raw.isCloud);
      variable.isRealTime = Boolean(raw.isRealTime);
      variable.value = (raw.value as string | number) ?? 0;
      variable.array = ((raw.array as Array<{ data: string | number }>) ?? []).map((item) => ({
        data: item.data,
      }));
      variable.visible = Boolean(raw.visible);
      variable.x = Number(raw.x ?? 0);
      variable.y = Number(raw.y ?? 0);
      variable.width = Number(raw.width ?? 100);
      variable.height = Number(raw.height ?? 120);
      variable.minValue = Number(raw.minValue ?? 0);
      variable.maxValue = Number(raw.maxValue ?? 100);
      return variable;
    });
    this.storedVars = this.variables.filter((variable) => variable.isStored);
    this.readStore();

    this.targets = [];
    this.targetById.clear();
    project.objects.forEach((raw, index) => {
      const target = new Target(
        this,
        String(raw.id),
        String(raw.name ?? ''),
        (raw.objectType as 'sprite' | 'textBox') ?? 'sprite',
        String(raw.scene ?? this.currentSceneId),
        String(raw.rotateMethod ?? 'free'),
      );
      target.index = index;
      const sprite = (raw.sprite as { pictures?: Picture[]; sounds?: Sound[] }) ?? {};
      target.pictures = (sprite.pictures ?? []).map((picture) => ({
        id: picture.id,
        name: picture.name,
        fileurl: picture.fileurl,
        pngurl: picture.pngurl,
        dimension: picture.dimension ?? { width: 0, height: 0 },
        imageType: picture.imageType,
      }));
      target.sounds = (sprite.sounds ?? []).map((sound) => ({
        id: sound.id,
        name: sound.name,
        fileurl: sound.fileurl,
        duration: Number(sound.duration ?? 0),
      }));
      const selected = raw.selectedPictureId as string | undefined;
      target.defaultPicture =
        (selected ? target.pictures.find((picture) => picture.id === selected) : null) ??
        target.pictures[0] ??
        null;
      target.entity = this.makeEntity(target, raw.entity as Record<string, unknown>, raw);
      this.targets.push(target);
      this.targetById.set(target.id, target);
    });

    this.compile(project);
    this.extras.bind();
    this.save.bind();
    this.snapshot();
    this.renderer?.attach?.(this.targets, this.scenes);
    for (const target of this.targets) {
      // Preserve saved text height; Entry remeasures only width after setText.
      target.entity.measure(false);
      this.renderer?.addEntity(target.entity);
    }
    this.renderer?.setScene?.(this.currentSceneId);
  }

  private makeEntity(
    target: Target,
    model: Record<string, unknown> | undefined,
    raw: Record<string, unknown>,
  ): Entity {
    const entity = new Entity(target, false);
    const m = model ?? {};
    entity.x = Number(m.x ?? 0);
    entity.y = Number(m.y ?? 0);
    entity.regX = Number(m.regX ?? 0);
    entity.regY = Number(m.regY ?? 0);
    entity.scaleX = Number(m.scaleX ?? 1);
    entity.scaleY = Number(m.scaleY ?? 1);
    entity.scaleOriginX = entity.scaleX;
    entity.scaleOriginY = entity.scaleY;
    entity.rotation = Number(m.rotation ?? 0);
    entity.direction = Number(m.direction ?? 90);
    entity.width = Number(m.width ?? 0);
    entity.height = Number(m.height ?? 0);
    entity.visible = m.visible !== false;
    entity.effect = initialEffects();
    if (target.objectType === 'textBox') {
      entity.text = String(raw.text ?? m.text ?? '');
      entity.colour = String(m.colour ?? '#000000');
      entity.bgColor = String(m.bgColor ?? 'transparent');
      entity.textAlign = Number(m.textAlign ?? 0);
      entity.lineBreak = Boolean(m.lineBreak);
      entity.underLine = Boolean(m.underLine);
      entity.strike = Boolean(m.strike);
      const font = parseFont(String(m.font ?? '20px Nanum Gothic'));
      entity.fontSize = font.size;
      entity.fontFamily = font.family;
      entity.fontBold = font.bold;
      entity.fontItalic = font.italic;
    } else {
      entity.picture = target.defaultPicture;
      if (entity.picture && !entity.width) {
        entity.width = entity.picture.dimension.width;
        entity.height = entity.picture.dimension.height;
      }
    }
    return entity;
  }

  private compile(project: EntryProjectLike): void {
    this.liveBlockCounts = null;
    let cacheable = true;
    const nextObjectScripts = new Map<number, ParsedSource>();
    const nextFunctionScripts = new Map<number, ParsedSource>();
    const parsed = (raw: unknown, index: number, previous: Map<number, ParsedSource>,
      next: Map<number, ParsedSource>): RawBlock[][] => {
      if (typeof raw !== 'string') {
        if (raw !== undefined) cacheable = false;
        return parseScript(raw as RawBlock[][] | undefined);
      }
      const old = previous.get(index);
      const value = old?.raw === raw ? old.parsed : parseScript(raw);
      next.set(index, { raw, parsed: value });
      return value;
    };
    const input: CompileInput = {
      liveEditing: this.liveCode !== null,
      objects: project.objects.map((raw, index) => ({
        id: String(raw.id),
        scene: String(raw.scene ?? this.targetOf(String(raw.id))?.sceneId ?? this.currentSceneId),
        script: parsed(raw.script, index, this.objectScripts, nextObjectScripts),
      })),
      variables: this.variables.map((variable) => ({ id: variable.id, sharedList: variable.isList && !variable.objectId })),
      functions: project.functions.map((fn, index) => ({
        id: String(fn.id),
        type: String(fn.type ?? 'normal'),
        localVariables:
          (fn.localVariables as Array<{ id: string; name: string; value: string | number }>) ?? [],
        // Parse once here; codegen, the kernel planner and name lookups all read the same body.
        content: parsed(fn.content, index, this.functionScripts, nextFunctionScripts),
      })),
      scenes: this.scenes,
      messages: this.messages,
      tables: this.tables,
    };
    this.objectScripts = nextObjectScripts;
    this.functionScripts = nextFunctionScripts;
    const reuse = cacheable && this.compileInput !== null && this.compiledProgram !== null
      && this.compiledFactory !== null && sameCompileInput(this.compileInput, input);
    this.compileInput = input;
    const program = reuse ? this.compiledProgram! : new Codegen(input).compile();
    const factory = reuse ? this.compiledFactory!
      : new Function('R', program.source) as ProgramFactory;
    this.compiledProgram = cacheable ? program : null;
    this.compiledFactory = cacheable ? factory : null;
    this.unknownBlocks = new Map(program.unknown);
    this.usedKeys = program.keys ? new Set(program.keys) : null;
    const built = factory(this);
    this.liveCode?.install(built, program.trace);
    built.scripts.forEach(body => this.traces.set(body, program.trace));
    // Identify function frames by their generator prototypes.
    this.functionOf = new WeakMap();
    const note = () => this.rememberFunctions(built.functions, input.functions);
    note();
    this.installKernel(input, built.functions);
    note();
    this.scripts = program.plans.map((plan) => ({
      event: plan.event,
      filter: plan.filter,
      blockId: plan.blockId,
      body: built.scripts[plan.index]!,
    }));
    for (const target of this.targets) {
      target.scripts = [];
    }
    program.plans.forEach((plan, index) => {
      this.targets[plan.targetIndex]?.scripts.push(this.scripts[index]!);
    });
  }

  // Fall back to the original body on untouched data if kernel execution cannot preserve Entry behavior.
  private installKernel(input: CompileInput, table: CompiledFunction[]): void {
    this.kernelPlan = null;
    this.kernel = null;
    if (!this.kernelOn) {
      return;
    }
    const plan = planKernel(input.objects, input.functions, this.variables);
    this.kernelPlan = plan;
    if (!plan.roots.size) {
      return;
    }
    const handle = attachJsKernel(plan, this.variables);
    if (!handle) {
      return;
    }
    this.kernel = handle;
    for (const [index, root] of handle.roots) {
      const javascript = table[index];
      if (!javascript) {
        continue;
      }
      table[index] = function* (entity, thread, args) {
        // Leave room for the kernel's call chain inside the remaining recursion limit.
        if (thread.depth + handle.depth < CALL_DEPTH_LIMIT) {
          let numeric = true;
          for (let at = 0; at < root.arity; at += 1) {
            const raw = args?.[at];
            const number = typeof raw === 'number' ? raw : cast.isNumber(raw) ? Number(raw) : NaN;
            if (!Number.isFinite(number)) {
              numeric = false;
              break;
            }
          }
          if (numeric) {
            const result = handle.run(index, args ?? []);
            if (result !== null) {
              return result;
            }
          }
        }
        return yield javascript(entity, thread, args);
      };
    }
  }

  // Rebuild executable code without reloading entities, clones, variables or assets.
  // Editor dispatch preserves active blocks; other hosts restart edited stacks
  // because their compiled generators cannot change their instruction pointer.
  patchCode(project: Pick<EntryProjectLike, 'objects' | 'functions'>): number {
    const change = this.prepareCodePatch(project);
    return change ? this.commitCodePatch(change, new Codegen(change.input).compile()) : 0;
  }

  async patchCodeAsync(project: Pick<EntryProjectLike, 'objects' | 'functions'>, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    const change = this.prepareCodePatch(project);
    if (!change) return 0;
    const program = await new Codegen(change.input).compileAsync(loadYield(), signal);
    signal?.throwIfAborted();
    if (this.compileInput !== change.previous || this.state === 'stop') throw new Error('실행이 중단되어 갱신을 취소했습니다.');
    return this.commitCodePatch(change, program);
  }

  private prepareCodePatch(project: Pick<EntryProjectLike, 'objects' | 'functions'>) {
    const previous = this.compileInput;
    if (!previous) return null;
    const key = (value: unknown) => JSON.stringify(value, (_name, item) => {
      if (item && typeof item.id === 'string' && typeof item.type === 'string' &&
        ('params' in item || 'statements' in item)) {
        return { id: item.id, type: item.type, params: item.params ?? [], statements: item.statements ?? [] };
      }
      return item;
    });
    const objects = new Map(project.objects.map(object => [String(object.id), object]));
    const functionScripts = new Map<number, ParsedSource>();
    const input: CompileInput = { ...previous,
      objects: previous.objects.map(object => ({ ...object,
        script: objects.has(object.id) ? parseScript(objects.get(object.id)!.script as string) : object.script,
      })),
      functions: project.functions.map((fn, index) => {
        const raw = fn.content;
        const cached = this.functionScripts.get(index);
        const content = typeof raw === 'string' && cached?.raw === raw ? cached.parsed : parseScript(raw as string);
        if (typeof raw === 'string') functionScripts.set(index, { raw, parsed: content });
        return { id: String(fn.id), type: String(fn.type ?? 'normal'), content,
          localVariables: (fn.localVariables as FunctionEntry['localVariables']) ?? [] };
      }),
    };
    const functionsChanged = previous.functions.length !== input.functions.length || input.functions.some((fn, index) => {
      const old = previous.functions[index]!;
      return old.id !== fn.id || old.type !== fn.type || key(old.localVariables) !== key(fn.localVariables) ||
        (old.content !== fn.content && key(old.content) !== key(fn.content));
    });
    if (!functionsChanged && input.objects.every((object, index) => {
      const old = previous.objects[index]!;
      return old.script === object.script || key(old.script) === key(object.script);
    })) return null;
    return { previous, input, functionsChanged, key, functionScripts };
  }

  private commitCodePatch(change: NonNullable<ReturnType<Vm['prepareCodePatch']>>, factoryProgram: CompiledProgram): number {
    const { previous, input, functionsChanged, key, functionScripts } = change;
    const unsupported = [...factoryProgram.unknown].filter(([type, count]) => count > (this.unknownBlocks.get(type) ?? 0));
    if (unsupported.length) {
      throw new Error(`현재 실행기에 없는 블록 또는 변수가 있습니다: ${unsupported.slice(0, 6).map(([type]) => type).join(', ')}`);
    }
    const factory = new Function('R', factoryProgram.source) as ProgramFactory;
    const built = factory(this); // Compile completely before replacing any running code.
    const counts = blockCounts(input);
    this.liveCode?.install(built, factoryProgram.trace);
    built.scripts.forEach(body => this.traces.set(body, factoryProgram.trace));
    this.rememberFunctions(built.functions, input.functions);
    this.installKernel(input, built.functions);
    this.rememberFunctions(built.functions, input.functions);
    const signatures = (script: RawBlock[][]) => new Map(script.map(stack => [stack[0]?.id, key(stack)]));
    let restarted = 0;
    for (let index = 0; index < this.targets.length; index++) {
      const target = this.targets[index]!;
      const before = this.liveCode ? null : signatures(previous.objects[index]!.script as RawBlock[][]);
      const after = this.liveCode ? null : signatures(input.objects[index]!.script as RawBlock[][]);
      const old = new Map(target.scripts.map(script => [script.blockId, script]));
      const changed = new Set<string>();
      const scripts = factoryProgram.plans.filter(plan => plan.targetIndex === index).map(plan => {
        const kept = old.get(plan.blockId);
        if (kept && (this.liveCode ? kept.event === plan.event && kept.filter === plan.filter
          : !functionsChanged && before!.get(plan.blockId) === after!.get(plan.blockId))) return kept;
        changed.add(plan.blockId);
        return { event: plan.event, filter: plan.filter, blockId: plan.blockId, body: built.scripts[plan.index]! };
      });
      const next = new Map(scripts.map(script => [script.blockId, script]));
      const restartedEntities = new Map<CompiledScript, Set<Entity>>();
      for (const thread of target.threads) {
        if (this.liveCode) {
          if (thread.script.event === 'probe') continue;
          const replacement = next.get(thread.script.blockId);
          if (!replacement) thread.stop();
          else {
            thread.script = replacement;
            thread.pruneLiveFrames(frame => this.liveCode!.contains(frame));
          }
          continue;
        }
        if (thread.script.event === 'probe' && !functionsChanged) continue;
        const replacement = next.get(thread.script.blockId);
        if (!replacement || changed.has(thread.script.blockId)) {
          if (!thread.done && replacement && replacement.event === thread.script.event && replacement.filter === thread.script.filter &&
            this.state !== 'stop' && target.sceneId === this.currentSceneId && !thread.entity.removed) {
            thread.restart(replacement);
            const entities = restartedEntities.get(replacement) ?? new Set<Entity>();
            entities.add(thread.entity); restartedEntities.set(replacement, entities);
            restarted++;
          } else thread.stop();
        }
      }
      target.threads = target.threads.filter(thread => !thread.done);
      target.scripts = scripts;
      if (!this.liveCode && target.sceneId === this.currentSceneId && this.state !== 'stop') {
        for (const script of scripts) {
          if (script.event === 'start' && changed.has(script.blockId)) {
            const entities = restartedEntities.get(script);
            target.forEachEntity(entity => {
              if (!entity.removed && !entities?.has(entity)) {
                target.threads.push(new Thread(target, entity, script)); restarted++;
              }
            });
          }
        }
      }
    }
    this.scripts = this.targets.flatMap(target => target.scripts);
    this.compileInput = input;
    this.liveBlockCounts = counts;
    this.compiledProgram = factoryProgram;
    this.compiledFactory = factory;
    this.objectScripts.clear(); this.functionScripts = functionScripts;
    this.unknownBlocks = new Map(factoryProgram.unknown);
    this.usedKeys = factoryProgram.keys ? new Set(factoryProgram.keys) : null;
    return restarted;
  }

  // Step waiting reporter blocks across frames until completion or the evaluation timeout.
  async evaluate(block: RawBlock, targetId: string, timeoutMs = 5000): Promise<unknown> {
    const target = this.targetOf(targetId);
    if (!target || !this.compileInput) {
      return undefined;
    }
    const codegen = new Codegen({ ...this.compileInput, liveEditing: false });
    const source = codegen.compileProbe(block);
    const built = (new Function('R', source) as (runtime: Vm) => { scripts: CompiledScript['body'][]; functions: CompiledFunction[] })(this);
    built.scripts.forEach(body => this.traces.set(body, codegen.trace));
    this.rememberFunctions(built.functions, this.compileInput.functions);
    const thread = new Thread(target, target.entity, {
      event: 'probe',
      filter: null,
      blockId: String(block.id ?? ''),
      body: built.scripts[0]!,
    });
    const until = Date.now() + timeoutMs;
    try {
      thread.step();
      while (!thread.done && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 16));
        thread.step();
      }
    } catch (error) {
      if (!(error instanceof ThreadStop)) {
        const record = this.errorRecord(error, thread);
        this.errors.push(record);
        this.lastError = record;
        this.onError?.(record);
      }
      throw error;
    }
    return thread.done ? thread.state.result : undefined;
  }

  runStack(stack: RawBlock[], targetId: string, extraFunctions: FunctionEntry[] = []): boolean {
    const body = this.compileStack(stack, extraFunctions);
    return body ? this.startStack(body, targetId, String(stack[0]?.id ?? '')) : false;
  }

  // Compile added helper functions alongside editor-started stacks when the loaded work lacks them.
  compileStack(stack: RawBlock[], extraFunctions: FunctionEntry[] = []): CompiledScript['body'] | null {
    if (!this.compileInput) {
      return null;
    }
    const input = extraFunctions.length
      ? { ...this.compileInput, functions: [...this.compileInput.functions, ...extraFunctions] }
      : this.compileInput;
    const codegen = new Codegen({ ...input, liveEditing: false });
    const source = codegen.compileStackProbe(stack);
    const built = (new Function('R', source) as (runtime: Vm) => { scripts: CompiledScript['body'][]; functions: CompiledFunction[] })(this);
    built.scripts.forEach(body => this.traces.set(body, codegen.trace));
    this.rememberFunctions(built.functions, input.functions);
    return built.scripts[0] ?? null;
  }

  // Run a newly started stack immediately, then continue with other scripts each frame.
  startStack(body: CompiledScript['body'], targetId: string, blockId = ''): boolean {
    const target = this.targetOf(targetId);
    if (!target) {
      return false;
    }
    const thread = new Thread(target, target.entity, { event: 'probe', filter: null, blockId, body });
    this.runThread(thread);
    if (!thread.done) {
      target.threads.push(thread);
    }
    return true;
  }

  compiledSource(project: EntryProjectLike): string {
    const input: CompileInput = {
      objects: project.objects.map((raw) => ({
        id: String(raw.id),
        scene: String(raw.scene ?? this.targetOf(String(raw.id))?.sceneId ?? this.currentSceneId),
        script: parseScript(raw.script as string | RawBlock[][]),
      })),
      variables: this.variables.map((variable) => ({ id: variable.id, sharedList: variable.isList && !variable.objectId })),
      functions: project.functions.map((fn) => ({
        id: String(fn.id),
        type: String(fn.type ?? 'normal'),
        localVariables:
          (fn.localVariables as Array<{ id: string; name: string; value: string | number }>) ?? [],
        // Parse once here; codegen, the kernel planner and name lookups all read the same body.
        content: parseScript(fn.content as string | RawBlock[][]),
      })),
      scenes: this.scenes,
      messages: this.messages,
      tables: this.tables,
    };
    return new Codegen(input).compile().source;
  }

  targetOf(id: string): Target | null {
    return this.targetById.get(id) ?? null;
  }

  entityOf(id: string): Entity | null {
    return this.targetById.get(id)?.entity ?? null;
  }

  // Pick by the renderer's live display order; declared order is only a headless fallback.
  entityAtPoint(worldX: number, worldY: number): Entity | null {
    const scene = this.currentSceneId;
    const drawn = this.renderer?.drawOrder?.(scene);
    const order = drawn?.length
      ? drawn
      : this.targets
          .filter((target) => target.sceneId === scene)
          .flatMap((target) => [target.entity, ...target.clones]);
    for (const entity of order) {
      if (this.collision.touchingMouse(entity, worldX, worldY)) {
        return entity;
      }
    }
    return null;
  }

  private static readonly CLICK_EVENTS = ['when_object_click', 'when_object_click_canceled'];

  clickableAt(worldX: number, worldY: number): boolean {
    if (this.state !== 'run') {
      return false;
    }
    const entity = this.entityAtPoint(worldX, worldY);
    return Boolean(
      entity?.target.scripts.some((script) => Vm.CLICK_EVENTS.includes(script.event)),
    );
  }

  variableAt(index: number, entity: Entity): Variable | null {
    const shared = this.variables[index];
    if (!shared) {
      return null;
    }
    if (shared.objectId && entity.isClone) {
      return entity.localVars?.[index] ?? shared;
    }
    return shared;
  }

  sceneOf(id: string): Scene | null {
    return this.sceneById.get(id) ?? null;
  }

  currentTargets(): Target[] {
    const scene = this.currentSceneId;
    return this.targets.filter((target) => target.sceneId === scene);
  }

  readStore(): void {
    this.written.clear();
    if (!this.store) {
      return;
    }
    for (const variable of this.storedVars) {
      const saved = this.store.read(variable.id);
      if (saved === undefined) {
        continue;
      }
      if (variable.isList && Array.isArray(saved)) {
        variable.array = saved.map((item) => ({ data: item.data }));
        variable.touch();
      } else if (!variable.isList && !Array.isArray(saved)) {
        variable.value = saved;
      }
      this.written.set(variable.id, JSON.stringify(saved));
    }
  }

  // Save changed shared values periodically and once more when stopping.
  flushStore(): void {
    if (!this.store) {
      return;
    }
    for (const variable of this.storedVars) {
      const value = variable.isList
        ? variable.array.map((item) => ({ data: item.data }))
        : variable.value;
      const text = JSON.stringify(value);
      if (this.written.get(variable.id) === text) {
        continue;
      }
      this.written.set(variable.id, text);
      this.store.write(variable.id, value);
    }
  }

  private snapshot(): void {
    for (const variable of this.variables) {
      variable.takeSnapshot();
    }
    for (const target of this.targets) {
      takeEntitySnapshot(target.entity);
    }
  }

  start(): void {
    if (this.state === 'run') {
      return;
    }
    if (this.state === 'pause') {
      this.state = 'run';
      this.lastTime = null;
      this.audio?.resume?.();
      this.speech?.resume?.();
      return;
    }
    this.resetExecution();
    this.state = 'run';
    this.clock = 0;
    this.lastStoreFlush = 0;
    this.frame = 0;
    this.lastTime = null;
    this.accumulator = 0;
    this.clearTimer();
    this.extras.started();
    // Restore stored values before the first block on every run.
    this.save.started();
    this.fireEvent('start');
    // Starting on a later scene also fires that scene's start event.
    if (this.currentSceneId !== (this.scenes[0]?.id ?? '')) this.fireEvent('when_scene_start');
  }

  stop(): void {
    this.state = 'stop';
    this.pendingMessages = [];
    this.timeouts = [];
    this.flushStore();
    for (const target of this.targets) {
      for (const thread of target.threads) {
        thread.stop();
      }
      target.threads = [];
    }
    this.audio?.stopAll();
    this.audio?.stopBgm();
    this.speech?.stop();
    // Clear audio pause state on stop or the next run can stay silent.
    this.audio?.resume?.();
    this.speech?.resume?.();
    this.clearQuestion();
    for (const table of this.tables) {
      table.reset();
    }
    this.extras.stopped();
  }

  pause(finishValues = true): void {
    if (this.state === 'run') {
      // Stop the project timer with the engine clock.
      this.state = 'pause';
      // Pause sounds in place rather than ending them.
      this.audio?.pause?.();
      this.speech?.pause?.();
      for (const target of this.targets) {
        if (finishValues) for (const thread of target.threads.slice()) this.runThread(thread, true);
      }
    }
  }

  reset(): void {
    for (const table of this.tables) {
      table.reset();
    }
    this.resetExecution();
  }

  private resetExecution(): void {
    this.timeouts = [];
    for (const target of this.targets) {
      for (const clone of target.clones.slice()) {
        this.renderer?.removeEntity(clone);
      }
      target.clones = [];
      target.threads = [];
      this.resetEntity(target.entity);
    }
    for (const variable of this.variables) {
      variable.loadSnapshot();
    }
    this.answer = '';
    this.errors = [];
    this.pendingMessages = [];
    this.openTable(null);
    this.currentSceneId = this.firstSceneId();
    this.audio?.setVolume(1);
    this.audio?.setSpeed(1);
    this.clearTimer();
    this.renderer?.setScene?.(this.currentSceneId);
    this.clearQuestion();
  }

  advance(timestamp: number): void {
    if (this.state !== 'run') {
      this.lastTime = timestamp;
      return;
    }
    const step = 1000 / this.frameRate;
    const elapsed = this.lastTime === null ? step : timestamp - this.lastTime;
    // Limit catch-up work without discarding elapsed time from timers and deadlines.
    this.clock += elapsed;
    this.accumulator += Math.min(elapsed, step * this.maxCatchUp);
    this.lastTime = timestamp;
    let ticks = 0;
    // Catch frame failures so the driver cannot repeat the same throw over a frozen canvas.
    try {
      while (this.accumulator >= step && ticks < this.maxCatchUp) {
        this.accumulator -= step;
        this.tick(0);
        ticks += 1;
        if (this.state !== 'run') {
          break;
        }
      }
      this.renderer?.flush();
    } catch (error) {
      this.fail(error);
    }
  }

  // Frame-level failures stop the work and use the same reporting path as script errors.
  fail(error: unknown, blockId: string | null = null, targetId: string | null = null): void {
    const record = this.errorRecord(error, null, blockId, targetId);
    this.errors.push(record);
    this.lastError = record;
    this.stop();
    // Keep the full stack in the console because the host may display only the message.
    console.error('[entropy] 프레임을 끝내지 못했습니다', error);
    this.onError?.(record);
  }

  tick(deltaMs = 1000 / this.frameRate): void {
    this.clock += deltaMs;
    this.frame += 1;
    // Auto-close table windows using engine time so pauses stop their countdown.
    if (this.tableCloseAt !== null && this.clock >= this.tableCloseAt) {
      this.openTable(null);
    }
    if (this.clock - this.lastStoreFlush >= STORE_FLUSH_MS) {
      this.lastStoreFlush = this.clock;
      this.flushStore();
    }
    this.collision.beginFrame();
    const scene = this.currentSceneId;
    const targets = this.targets;
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i]!;
      if (target.sceneId !== scene) {
        continue;
      }
      const threads = target.threads;
      for (let j = 0; j < threads.length; j += 1) {
        const thread = threads[j]!;
        if (thread.done) {
          threads.splice(j, 1);
          j -= 1;
          continue;
        }
        this.runThread(thread);
      }
    }
    this.extras.frame();
    this.flushMessages();
    // Entry runs engine timeouts after scripts, including timers from cancelled scripts.
    let remaining = 0;
    for (const timeout of this.timeouts) {
      if (timeout.at <= this.clock) timeout.callback();
      else this.timeouts[remaining++] = timeout;
    }
    this.timeouts.length = remaining;
  }

  setTimeout(callback: () => void, delay: number): void {
    this.timeouts.push({ at: this.clock + Math.max(Number(delay) || 0, 0), callback });
  }

  private runThread(thread: Thread, finishingValues = false): void {
    try {
      if (finishingValues) thread.finishValueCalls();
      else thread.step();
    } catch (error) {
      thread.done = true;
      if (error instanceof ThreadStop) {
        // A script ending itself is normal control flow, not an error.
        return;
      }
      const record = this.errorRecord(error, thread);
      this.errors.push(record);
      this.lastError = record;
      this.onError?.(record);
    }
  }

  private functionOf = new WeakMap<object, string>();

  // Reading a name parses the whole function body, so keep it per entry across compiles and probes.
  private readonly functionNames = new WeakMap<FunctionEntry, string>();

  private rememberFunctions(functions: CompiledFunction[], entries: FunctionEntry[]): void {
    functions.forEach((fn, index) => {
      if (!fn?.prototype) return;
      const entry = entries[index]!;
      let name = this.functionNames.get(entry);
      if (name === undefined) this.functionNames.set(entry, name = functionName(entry.content) || entry.id);
      this.functionOf.set(fn.prototype as object, name);
    });
  }

  private errorRecord(error: unknown, thread: Thread | null, blockId: string | null = null, targetId: string | null = null): VmError {
    const stack = error instanceof Error ? error.stack : undefined;
    const site = thread?.failedFrames?.slice().reverse().map(frame => blockOfError(stack, frame.liveTrace)).find(Boolean)
      ?? blockOfError(stack, thread ? this.traces.get(thread.script.body) : undefined);
    const target = thread?.target ?? (targetId ? this.targetOf(targetId) : null);
    const sceneId = target?.sceneId ?? this.currentSceneId;
    const calls = thread ? this.callsOf(thread) : [];
    return {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : typeof error,
      stack,
      blockId: site?.blockId ?? blockId ?? thread?.script.blockId ?? null,
      blockType: site?.blockType ?? (error instanceof RuntimeBlockError ? error.blockType : undefined),
      targetId: target?.id ?? targetId,
      ...(thread ? { where: this.whereOf(thread, calls) } : {}),
      ...(error instanceof RuntimeBlockError ? { inputs: error.inputs } : {}),
      snapshot: snapshotVm(this),
      context: {
        frame: this.frame, clock: this.clock, sceneId,
        sceneName: this.sceneOf(sceneId)?.name ?? sceneId,
        targetName: target?.name ?? null,
        entityId: thread?.entity.id ?? null,
        isClone: thread?.entity.isClone ?? false,
        event: thread?.script.event ?? null,
        eventFilter: thread?.script.filter ?? null,
        eventBlockId: thread?.script.blockId ?? null,
        calls,
      },
    };
  }

  private callsOf(thread: Thread): Array<{ name: string; count: number }> {
    const steps: Array<{ name: string; count: number }> = [];
    for (const frame of thread.failedFrames ?? []) {
      const name = this.functionOf.get(Object.getPrototypeOf(frame) as object);
      if (name === undefined) continue;
      const last = steps[steps.length - 1];
      if (last?.name === name) last.count += 1;
      else steps.push({ name, count: 1 });
    }
    return steps;
  }

  private whereOf(thread: Thread, steps: Array<{ name: string; count: number }>): string {
    const target = thread.target;
    const scene = this.scenes.find((item) => item.id === target.sceneId);
    const parts = [
      `장면 '${scene?.name ?? target.sceneId}'`,
      `오브젝트 '${target.name}'${thread.entity.isClone ? ' (복제본)' : ''}`,
    ];
    // Collapse repeated calls and retain both ends of long stacks.
    const shown = steps.map((step) => (step.count > 1 ? `${step.name} ×${step.count}` : step.name));
    const calls = shown.length > 8 ? [...shown.slice(0, 3), '…', ...shown.slice(-3)] : shown;
    if (calls.length) parts.push(`함수 ${calls.join(' → ')}`);
    return parts.join(' · ');
  }

  // Notify the renderer when boost changes because it affects fill and text layout rules.
  get boost(): boolean {
    return this.boostOn;
  }

  set boost(on: boolean) {
    if (this.boostOn === on) {
      return;
    }
    this.boostOn = on;
    this.renderer?.setBoost?.(on);
  }

  fireEvent(event: string, filter?: string): Thread[] {
    if (this.state !== 'run' && event !== 'start') {
      return [];
    }
    const started: Thread[] = [];
    for (const target of this.targets) {
      if (target.sceneId !== this.currentSceneId) {
        continue;
      }
      target.forEachEntity((entity) => {
        started.push(...this.startScripts(target, entity, event, filter));
      });
    }
    return started;
  }

  // Queue ordinary messages until after the sending frame; send-and-wait starts receivers immediately.
  queueMessage(id: string): void {
    this.pendingMessages.push(id);
  }

  // Deliver queued messages in the scene active at the end of the frame.
  private flushMessages(): void {
    if (!this.pendingMessages.length) {
      return;
    }
    const queued = this.pendingMessages;
    this.pendingMessages = [];
    for (const id of queued) {
      this.fireEvent('when_message_cast', id);
    }
  }

  fireEventOn(event: string, entity: Entity, filter?: string): Thread[] {
    if (this.state !== 'run') {
      return [];
    }
    return this.startScripts(entity.target, entity, event, filter);
  }

  private startScripts(target: Target, entity: Entity, event: string, filter?: string): Thread[] {
    const started: Thread[] = [];
    for (const script of target.scripts) {
      if (script.event !== event) {
        continue;
      }
      if (filter !== undefined && script.filter !== null && script.filter !== filter) {
        continue;
      }
      const thread = new Thread(target, entity, script);
      target.threads.push(thread);
      started.push(thread);
    }
    return started;
  }

  // Mark stopped threads instead of splicing them, or later threads can miss the current frame.
  stopThreadsOf(entity: Entity): void {
    for (const thread of entity.target.threads) {
      if (thread.entity === entity) {
        thread.stop();
      }
    }
  }

  setStartScene(scene: string | null | undefined): void {
    const wanted = String(scene ?? '');
    const found = this.sceneById.has(wanted)
      ? wanted
      : this.scenes.find((candidate) => candidate.name === wanted)?.id ?? '';
    this.startSceneId = found;
    if (this.state === 'stop') {
      this.currentSceneId = this.firstSceneId();
      this.renderer?.setScene?.(this.currentSceneId);
    }
  }

  private firstSceneId(): string {
    return this.sceneById.has(this.startSceneId) ? this.startSceneId : this.scenes[0]?.id ?? '';
  }

  onSceneChange: ((id: string) => void) | null = null;

  selectScene(id: string): void {
    const scene = this.sceneById.get(id);
    if (!scene || scene.id === this.currentSceneId) {
      if (scene) {
        this.resetSceneDuringRun(scene.id);
      }
      return;
    }
    this.resetSceneDuringRun(this.currentSceneId);
    this.currentSceneId = scene.id;
    // Stop scene sounds on exit, but let background music continue.
    if (this.state === 'run') {
      this.audio?.stopAll();
      this.speech?.stop();
    }
    this.renderer?.setScene?.(scene.id);
    this.onSceneChange?.(scene.id);
  }

  // Restore objects and clear clones, effects, pens, and scripts when leaving a scene.
  private resetSceneDuringRun(sceneId: string): void {
    for (const target of this.targets) {
      if (target.sceneId !== sceneId) {
        continue;
      }
      for (const thread of target.threads) {
        thread.stop();
      }
      target.threads = [];
      for (const clone of target.clones.slice()) {
        clone.removeClone();
      }
      this.resetEntity(target.entity);
    }
    // Hide the answer field because its waiting script leaves with the scene.
    this.clearQuestion();
  }

  // Table windows do not hold scripts; timed windows close using engine time.
  openTable(table: Table | null, seconds?: number, chart: number | null = null): void {
    this.tableCloseAt = table && seconds ? this.clock + seconds * 1000 : null;
    this.renderer?.showTable?.(table, table ? chart : null);
  }

  private clearQuestion(): void {
    this.question = null;
    this.pendingAnswer = null;
    this.renderer?.hideQuestion?.();
  }

  private resetEntity(entity: Entity): void {
    loadEntitySnapshot(entity);
    entity.effect = initialEffects();
    entity.dialog = null;
    entity.brush = null;
    entity.paint = null;
    entity.stamps = [];
    this.renderer?.syncDialog?.(entity);
    this.renderer?.eraseAll?.(entity);
    entity.touch();
  }

  addClone(target: Target, source: Entity): Entity | null {
    if (target.clones.length > MAX_CLONES) {
      return null;
    }
    const clone = target.addClone(source);
    if (source.localVars) {
      clone.localVars = source.localVars.map((variable) =>
        variable ? cloneVariable(variable) : undefined,
      );
    } else {
      clone.localVars = this.variables.map((variable) =>
        variable.objectId === target.id ? cloneVariable(variable) : undefined,
      );
    }
    this.startScripts(target, clone, 'when_clone_start');
    return clone;
  }

  clearTimer(): void {
    this.timerInit = false;
    this.timerPaused = false;
    this.timerBase = 0;
    this.timerStart = 0;
  }

  startTimer(): void {
    if (!this.timerInit) {
      this.timerInit = true;
      this.timerPaused = false;
      this.timerBase = 0;
      this.timerStart = this.clock;
      return;
    }
    if (this.timerPaused) {
      this.timerStart = this.clock - this.timerBase;
      this.timerPaused = false;
    }
  }

  pauseTimer(): void {
    if (this.timerInit && !this.timerPaused) {
      this.timerBase = this.clock - this.timerStart;
      this.timerPaused = true;
    }
  }

  // Reset does nothing before the timer starts; resetting a stopped timer returns it to never-started.
  resetTimer(): void {
    if (!this.timerInit) {
      return;
    }
    const wasPaused = this.timerPaused;
    this.timerBase = 0;
    this.timerStart = this.clock;
    if (wasPaused) {
      this.timerInit = false;
    }
  }

  timerValue(): number {
    if (!this.timerInit) {
      return 0;
    }
    const elapsed = this.timerPaused ? this.timerBase : this.clock - this.timerStart;
    return Math.max(elapsed / 1000, 0);
  }
}

interface EntitySnapshot {
  x: number;
  y: number;
  regX: number;
  regY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  direction: number;
  width: number;
  height: number;
  visible: boolean;
  picture: Picture | null;
  text: string;
  textAlign: number;
  lineBreak: boolean;
  fontSize: number;
  fontBold: boolean;
  fontItalic: boolean;
  underLine: boolean;
  strike: boolean;
}

const snapshots = new WeakMap<Entity, EntitySnapshot>();

function takeEntitySnapshot(entity: Entity): void {
  snapshots.set(entity, {
    x: entity.x,
    y: entity.y,
    regX: entity.regX,
    regY: entity.regY,
    scaleX: entity.scaleX,
    scaleY: entity.scaleY,
    rotation: entity.rotation,
    direction: entity.direction,
    width: entity.width,
    height: entity.height,
    visible: entity.visible,
    picture: entity.picture,
    text: entity.text,
    textAlign: entity.textAlign,
    lineBreak: entity.lineBreak,
    fontSize: entity.fontSize,
    fontBold: entity.fontBold,
    fontItalic: entity.fontItalic,
    underLine: entity.underLine,
    strike: entity.strike,
  });
}

function loadEntitySnapshot(entity: Entity): void {
  const saved = snapshots.get(entity);
  if (!saved) {
    return;
  }
  Object.assign(entity, saved);
  // Remeasure restored text width while preserving its saved height.
  entity.measure(false);
  entity.scaleOriginX = saved.scaleX;
  entity.scaleOriginY = saved.scaleY;
  entity.effect = initialEffects();
  entity.flip = false;
  entity.collision = 0;
}

function cloneVariable(source: Variable): Variable {
  const copy = new Variable(source.id, source.name, source.objectId, source.kind);
  copy.isCloud = source.isCloud;
  copy.isRealTime = source.isRealTime;
  copy.value = source.value;
  copy.array = source.array.map((item) => ({ data: item.data }));
  copy.visible = source.visible;
  copy.x = source.x;
  copy.y = source.y;
  copy.minValue = source.minValue;
  copy.maxValue = source.maxValue;
  return copy;
}
