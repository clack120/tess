// Compile blocks once into generators; yield only where Entry gives up the frame.
import { SAVE_FUNCTIONS, functionLabel } from '../runtime/save.ts';
import { isBlock, parseScript, findFunctionDefine, functionBody, collectParams, type RawBlock, type FunctionEntry } from './blocks.ts';
import { blockCounts } from './block-count.ts';
import { isNumber } from '../runtime/cast.ts';
export type { RawBlock, FunctionEntry } from './blocks.ts';
import type { GeneratedTrace } from '../runtime/diagnostics.ts';
import { expansionBlock } from '@entropy/core';

let nextSourceId = 0;

export interface CompileInput {
  liveEditing?: boolean;
  objects: Array<{ id: string; scene?: string; script: string | RawBlock[][] }>;
  // sharedList marks lists no object owns; generated code then reads them without an entity lookup.
  variables: Array<{ id: string; variableType?: string; sharedList?: boolean }>;
  functions: FunctionEntry[];
  scenes: Array<{ id: string }>;
  messages: Array<{ id: string }>;
  tables: Array<{ id: string }>;
}

export interface ScriptPlan {
  targetIndex: number;
  event: string;
  filter: string | null;
  blockId: string;
  index: number;
}

export interface CompiledProgram {
  source: string;
  plans: ScriptPlan[];
  unknown: Map<string, number>;
  // Null means the project may read any key.
  keys: Set<number> | null;
  trace: GeneratedTrace;
}

const HATS: Record<string, string> = {
  when_run_button_click: 'start',
  when_some_key_pressed: 'keyPress',
  mouse_clicked: 'mouse_clicked',
  mouse_click_cancled: 'mouse_click_cancled',
  when_object_click: 'when_object_click',
  when_object_click_canceled: 'when_object_click_canceled',
  when_message_cast: 'when_message_cast',
  when_scene_start: 'when_scene_start',
  when_clone_start: 'when_clone_start',
};

const HAT_FILTER: Record<string, number> = {
  when_some_key_pressed: 1,
  when_message_cast: 1,
};

const RESERVED_PARAM = /^(string|boolean)Param_/;

// Entry has no spin limit; this guard yields only as a last resort to keep the runner stoppable.
const SPIN_LIMIT = 10_000_000;

// Use a fixed depth limit because VM calls use frame stacks rather than Entry's JS stack.
const CALL_DEPTH_LIMIT = 1000000;

type Kind = 'num' | 'str' | 'bool' | 'any';

interface Value {
  code: string;
  kind: Kind;
  constant?: string | number | boolean;
}

const NULL_VALUE: Value = { code: 'undefined', kind: 'any' };

function literal(value: unknown): string {
  // Escape work text so it cannot impersonate generated block markers, and escape line separators,
  // which engines disagree on counting as lines when they report error positions.
  return JSON.stringify(value === undefined ? null : value).replaceAll('/*@entropy:', '/\\u002a@entropy:')
    .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

// Treat values that cannot convert to strings as empty so malformed data cannot abort compilation.
function text(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return String(value);
  } catch {
    return '';
  }
}

// Numeric conversion can throw on the same malformed values as text conversion.
function number(value: unknown): number {
  try {
    return Number(value);
  } catch {
    return NaN;
  }
}

// Ignore inherited table keys so project text cannot inject prototype values into generated code.
function pick<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

// Sanitize block types before generated comments so project data cannot inject JavaScript.
function comment(type: string): string {
  return `/* ${String(type).replace(/[^\w.-]+/g, ' ').slice(0, 60)} */`;
}

// Entry executes flow blocks in inputs before reaching the parent block.
const LOOP_TRICKS: Record<string, 'continue' | 'break'> = {
  continue_repeat: 'continue',
  stop_repeat: 'break',
};

function slotTrick(param: unknown): 'continue' | 'break' | null {
  if (!isBlock(param) || param.type !== 'boolean_not') return null;
  const inner = param.params?.[1];
  return isBlock(inner) ? pick(LOOP_TRICKS, inner.type) ?? null : null;
}

// Keep carriers with other effects because Entry evaluates all input slots.
function inertValue(param: unknown): boolean {
  if (!isBlock(param)) return true;
  if ((param.statements?.length ?? 0) > 0) return false;
  if (param.type.startsWith('func_') || param.type === 'calc_rand') return false;
  if (param.type === 'function_field_string' || param.type === 'function_field_boolean') {
    return false;
  }
  return (param.params ?? []).every(inertValue);
}

// Execute an input's flow control without running or reporting the unreachable carrier block.
function carriedTrick(block: RawBlock): 'continue' | 'break' | null {
  if ((block.statements?.length ?? 0) > 0) return null;
  let carried: 'continue' | 'break' | null = null;
  for (const param of block.params ?? []) {
    const trick = isBlock(param) ? pick(LOOP_TRICKS, param.type) : undefined;
    if (trick) {
      carried = trick;
      continue;
    }
    if (!inertValue(param)) return null;
  }
  return carried;
}

export class Codegen {
  readonly trace: GeneratedTrace = { sourceId: `entropy-generated-${++nextSourceId}.js`, sites: [] };
  private readonly traceBlocks: RawBlock[] = [];
  private readonly input: CompileInput;
  private readonly varIndex = new Map<string, number>();
  private readonly targetIndex = new Map<string, number>();
  private readonly funcIndex = new Map<string, number>();
  private readonly tableIndex = new Map<string, number>();
  private readonly localVarIds = new Set<string>();
  private readonly plans: ScriptPlan[] = [];
  private readonly bodies: string[] = [];
  private readonly functionSources: string[] = [];
  private readonly liveBlocks = new Map<string, string>();
  private readonly liveSequences = new Map<string, string[]>();
  private readonly liveChecks = new Map<string, string>();
  private readonly liveTypes = new Map<string, string>();
  readonly unknown = new Map<string, number>();
  private needsBlockCounts = false;
  private compiledBlocks = 0;
  private keys: Set<number> | null = new Set();

  private paramSlots: Map<string, number> | null = null;
  private loopDepth = 0;
  // Loops that can skip yielding need a spin guard.
  private readonly spinning: boolean[] = [];
  // Ending a function executor jumps to this label.
  private funcLabel: string | null = null;

  constructor(input: CompileInput) {
    this.input = input;
    input.variables.forEach((variable, index) => {
      this.varIndex.set(variable.id, index);
    });
    input.objects.forEach((object, index) => {
      this.targetIndex.set(object.id, index);
    });
    (input.tables ?? []).forEach((table, index) => {
      this.tableIndex.set(table.id, index);
    });
    input.functions.forEach((fn, index) => {
      this.funcIndex.set(fn.id, index);
      for (const local of fn.localVariables ?? []) {
        this.localVarIds.add(local.id);
      }
    });
  }

  compile(): CompiledProgram {
    return this.finish(this.compileSteps());
  }

  private finish<T>(steps: Generator<void, T, unknown>): T {
    let result = steps.next();
    while (!result.done) result = steps.next();
    return result.value;
  }

  async compileAsync(pause: () => Promise<void> | undefined, signal?: AbortSignal): Promise<CompiledProgram> {
    const steps = this.compileSteps();
    for (;;) {
      signal?.throwIfAborted();
      const result = steps.next();
      if (result.done) return result.value;
      const pending = pause();
      if (pending) await pending;
    }
  }

  *compileSteps(): Generator<void, CompiledProgram, unknown> {
    for (const fn of this.input.functions) {
      this.functionSources.push(yield* this.compileFunction(fn));
      yield;
    }
    for (const [targetIndex, object] of this.input.objects.entries()) {
      const script = parseScript(object.script);
      for (const stack of script) {
        const hat = stack[0];
        if (!hat) {
          continue;
        }
        const event = pick(HATS, hat.type);
        if (!event) {
          // Entry ignores detached stacks and comment-only blocks too.
          continue;
        }
        const filterIndex = pick(HAT_FILTER, hat.type);
        const filter =
          filterIndex === undefined ? null : text(hat.params[filterIndex]);
        if (event === 'keyPress') this.keys?.add(Number(filter));
        const body = yield* this.compileStack(stack.slice(1), '  ', `object:${object.id}:${hat.id}`);
        this.plans.push({
          targetIndex,
          event,
          filter,
          blockId: hat.id,
          index: this.bodies.length,
        });
        this.bodies.push(this.input.liveEditing
          ? `function* (e, th) { const ctx = { entity: e }; try {\n${body}} catch (x) { if (x !== R.liveCode.exit) throw x; } }`
          : `function* (e, th) {\n${body}}`);
        yield;
      }
    }
    return { source: yield* this.emitModule(), plans: this.plans, unknown: this.unknown, keys: this.keys, trace: this.trace };
  }

  // Store a clicked reporter's value in th.state.result for inspection.
  compileProbe(block: RawBlock): string {
    for (const fn of this.input.functions) {
      this.functionSources.push(this.finish(this.compileFunction(fn)));
    }
    const result = this.value(block);
    this.bodies.push(`function* (e, th) {\n  th.state.result = ${result.code};\n}`);
    return this.finish(this.emitModule());
  }

  compileStackProbe(stack: RawBlock[]): string {
    for (const fn of this.input.functions) {
      this.functionSources.push(this.finish(this.compileFunction(fn)));
    }
    this.bodies.push(`function* (e, th) {\n${this.finish(this.compileStack(stack))}}`);
    return this.finish(this.emitModule());
  }

  // Keep source pieces small enough to yield during serialization and trace
  // indexing. Markers are removed once, before joining the finished module.
  private *moduleParts(): Generator<string> {
    yield '"use strict";\nconst O = R.ops, V = R.variables, T = R.targets, C = R.cast;\nconst n = C.num, s = C.str, b = C.bool, nf = C.field;';
    if (this.needsBlockCounts) yield `\nconst B = ${literal(blockCounts(this.input))};`;
    yield '\nconst F = [];';
    for (const [index, source] of this.functionSources.entries()) yield `\nF[${index}] = ${source};`;
    yield '\nreturn { scripts: [\n';
    for (const [index, body] of this.bodies.entries()) yield (index ? ',\n' : '') + body;
    yield '\n], functions: F';
    if (this.input.liveEditing) {
      yield ', blocks: {';
      let separator = '';
      for (const [id, source] of this.liveBlocks) {
        yield `${separator}${literal(id)}: ${source}`;
        separator = ',\n';
      }
      yield '}, sequences: ';
      yield* this.recordParts(this.liveSequences);
      yield ', blockTypes: ';
      yield* this.recordParts(this.liveTypes);
      yield ', checks: {';
      separator = '';
      for (const [id, source] of this.liveChecks) {
        yield `${separator}${literal(id)}: ${source}`;
        separator = ',\n';
      }
      yield '}';
    }
    yield ' };';
  }

  private *recordParts(entries: Map<string, string | string[]>): Generator<string> {
    // Retain JSON's property ordering, including numeric block IDs.
    const pairs = Object.entries(Object.fromEntries(entries));
    yield '{';
    for (let index = 0; index < pairs.length; index += 128) {
      yield (index ? ',' : '') + literal(Object.fromEntries(pairs.slice(index, index + 128))).slice(1, -1);
    }
    yield '}';
  }

  private *emitModule(): Generator<void, string, unknown> {
    let line = 3, column = 1; // new Function adds two header lines.
    const clean: string[] = [];
    let emitted = 0;
    this.trace.sites = [];
    const advance = (part: string) => {
      clean.push(part);
      emitted += part.length;
      let end = -1;
      for (const match of part.matchAll(/[\n\u2028\u2029]/g)) { line++; end = match.index; }
      column = end < 0 ? column + part.length : part.length - end;
    };
    for (const part of this.moduleParts()) {
      let previous = 0;
      for (const match of part.matchAll(/\/\*@entropy:(\d+)\*\//g)) {
        advance(part.slice(previous, match.index));
        previous = match.index + match[0].length;
        const block = this.traceBlocks[Number(match[1])]!;
        this.trace.sites.push({ line, column, blockId: block.id, blockType: block.type });
        if (emitted >= 16_384) { emitted = 0; yield; }
      }
      advance(part.slice(previous));
      if (emitted >= 16_384) { emitted = 0; yield; }
    }
    return `${clean.join('')}\n//# sourceURL=${this.trace.sourceId}`;
  }

  private marker(block: RawBlock): string {
    return `/*@entropy:${this.traceBlocks.push(block) - 1}*/`;
  }

  private *compileFunction(fn: FunctionEntry): Generator<void, string, unknown> {
    // Intercept the save manager's empty functions here instead of through an extension.
    const saving = pick(SAVE_FUNCTIONS, functionLabel(fn.content));
    if (saving) {
      return saving === 'wait'
        ? 'function* (e, th, P) { yield* O.saveStoreWait(); }'
        : 'function* (e, th, P) { O.saveStore(); }';
    }
    const content = parseScript(fn.content);
    const stack = findFunctionDefine(content);
    const define = stack?.[0];
    if (!define) {
      return 'function* () {}';
    }
    const params = collectParams(define.params[0]);
    this.paramSlots = new Map(params.map((name, index) => [name, index]));
    const previousLoopDepth = this.loopDepth;
    this.loopDepth = 0;

    const locals = (fn.localVariables ?? [])
      .map((local) => `${literal(text(local.id))}: ${literal(local.value ?? 0)}`)
      .join(', ');
    const previousLabel = this.funcLabel;
    this.funcLabel = 'fn';
    const body = yield* this.compileStack(functionBody(stack!), '    ', `function:${fn.id}`);
    this.funcLabel = previousLabel;

    // Beyond the depth limit, a call runs no body and produces no value.
    const returnsValue = define.type === 'function_create_value';
    const result = returnsValue ? this.liveCheck(`return:${fn.id}`, this.value(define.params[3]).code) : '';
    // On pause, finish skips the value function body and evaluates its return expression.
    let source =
      `function* (e, th, P) {\n` +
      `  if (th.depth >= ${CALL_DEPTH_LIMIT}) throw new RangeError('함수 호출이 너무 깊습니다 (끝나지 않는 재귀)');\n` +
      `  th.depth += 1;\n` +
      `  try {\n` +
      `  const L = {${locals}};\n` +
      (this.input.liveEditing ? '  const ctx = { entity: e, params: P, locals: L };\n' : '');
    const liveExit = this.input.liveEditing ? ' && x !== R.liveCode.exit' : '';
    const syncEntity = this.input.liveEditing ? '  e = ctx.entity;\n' : '';
    source += returnsValue
      ? `  try {\n  fn: {\n${body}  }\n  } catch (x) { if (x !== th.finish${liveExit}) throw x; }\n${syncEntity}  return ${result};\n`
      : this.input.liveEditing
        ? `  try {\n${body}  } catch (x) { if (x !== R.liveCode.exit) throw x; }\n`
        : `  fn: {\n${body}  }\n`;
    source += '  } finally { th.depth -= 1; }\n}';

    this.paramSlots = null;
    this.loopDepth = previousLoopDepth;
    // Mark the prototype once to avoid extra work on each call.
    return this.marker(define) + (returnsValue
      ? `((g) => { g.prototype.finishes = true; return g; })(${source})`
      : source);
  }

  // Ending a function executor leaves its caller alive and still evaluates its return expression.
  private endExecutor(): string {
    if (this.input.liveEditing) return 'throw R.liveCode.exit;';
    return this.funcLabel ? `break ${this.funcLabel};` : 'return;';
  }

  private *compileStack(blocks: RawBlock[], indent = '  ', sequenceId = 'probe'): Generator<void, string, unknown> {
    if (this.input.liveEditing) {
      const ids: string[] = [];
      this.liveSequences.set(sequenceId, ids);
      for (const [index, block] of blocks.entries()) {
        const id = block.id ?? `${sequenceId}:${index}`;
        ids.push(id);
        this.liveTypes.set(id, block.type);
        const current = { ...block, id };
        const marker = this.marker(current);
        const body = marker + (yield* this.statementCode(current, '  '));
        this.liveBlocks.set(id, `function* (ctx, th) { let e = ctx.entity; const P = ctx.params, L = ctx.locals;\n${body}}`);
        if (++this.compiledBlocks % 32 === 0) yield;
      }
      return `${indent}yield R.liveCode.sequence(${literal(sequenceId)}, ctx, th);\n`;
    }
    const out: string[] = [];
    for (const block of blocks) {
      const marker = this.marker(block);
      out.push(marker + (yield* this.statementCode(block, indent)));
      if (++this.compiledBlocks % 32 === 0) yield;
    }
    return out.join('');
  }

  private *statementCode(block: RawBlock, ind: string): Generator<void, string, unknown> {
    const p = block.params;
    const line = (code: string) => `${ind}${code}\n`;

    // Check flow carriers first because input control can prevent the parent block from running.
    const carried = carriedTrick(block);
    if (carried) {
      return line(this.trickCode(carried));
    }

    switch (block.type) {
      case 'move_direction':
        return line(`O.moveDirection(e, ${this.num(p[0])});`);
      case 'bounce_wall':
        return line('O.bounceWall(e);');
      case 'move_x':
        return line(`O.moveX(e, ${this.num(p[0])});`);
      case 'move_y':
        return line(`O.moveY(e, ${this.num(p[0])});`);
      case 'move_to_angle':
        // Entry evaluates ANGLE then VALUE before converting either to a number.
        return line(`{ const angle = ${this.raw(p[0])}; const distance = ${this.raw(p[1])}; ${this.marker(block)}O.moveToAngle(e, Number(distance), Number(angle)); }`);
      case 'locate_x':
        return line(`O.locateX(e, ${this.num(p[0])});`);
      case 'locate_y':
        return line(`O.locateY(e, ${this.num(p[0])});`);
      case 'locate_xy':
        return line(`O.locateXY(e, ${this.numOf(p[0])}, ${this.numOf(p[1])});`);
      case 'locate':
        return line(`O.locateTo(e, ${this.field(p[0])});`);
      case 'move_xy_time':
        return line(
          `yield* O.moveXYTime(e, ${this.numOf(p[0])}, ${this.numOf(p[1])}, ${this.numOf(p[2])});`,
        );
      case 'locate_xy_time':
        return line(
          `yield* O.locateXYTime(e, ${this.numOf(p[0])}, ${this.numOf(p[1])}, ${this.numOf(p[2])});`,
        );
      case 'locate_object_time':
        return line(`yield* O.locateObjectTime(e, ${this.num(p[0])}, ${this.field(p[1])});`);
      case 'rotate_relative':
        return line(`O.rotateRelative(e, ${this.num(p[0])});`);
      case 'direction_relative':
        return line(`O.directionRelative(e, ${this.num(p[0])});`);
      case 'rotate_absolute':
        return line(`O.rotateAbsolute(e, ${this.num(p[0])});`);
      case 'direction_absolute':
        return line(`O.directionAbsolute(e, ${this.num(p[0])});`);
      case 'rotate_by_time':
        return line(`yield* O.rotateByTime(e, ${this.numOf(p[0])}, ${this.numOf(p[1])});`);
      case 'direction_relative_duration':
        return line(`yield* O.directionByTime(e, ${this.numOf(p[0])}, ${this.numOf(p[1])});`);
      case 'see_angle_object':
        return line(`O.seeAngleObject(e, ${this.field(p[0])});`);

      case 'show':
        return line('e.setVisible(true);');
      case 'hide':
        return line('e.setVisible(false);');
      case 'dialog':
        return line(`O.dialog(e, ${this.raw(p[0])}, ${this.field(p[1])});`);
      case 'dialog_time':
        return line(`yield* O.dialogTime(e, ${this.raw(p[0])}, ${this.numOf(p[1])}, ${this.field(p[2])});`);
      case 'remove_dialog':
        return line('O.removeDialog(e);');
      case 'change_to_some_shape':
        return line(`O.setPicture(e, ${this.str(p[0])});`);
      case 'change_to_next_shape':
        return line(`O.nextPicture(e, ${this.field(p[0])});`);
      case 'add_effect_amount':
        return line(`O.addEffect(e, ${this.field(p[0])}, ${this.num(p[1])});`);
      case 'change_effect_amount':
        return line(`O.setEffect(e, ${this.field(p[0])}, ${this.num(p[1])});`);
      case 'erase_all_effects':
        return line('e.resetFilter();');
      case 'change_scale_size':
        return line(`{ const amount = ${this.num(p[0])}; ${this.marker(block)}e.setSize(e.getSize() + amount); }`);
      case 'set_scale_size':
        return line(`e.setSize(${this.num(p[0])});`);
      case 'stretch_scale_size':
        return line(`O.stretchSize(e, ${this.raw(p[0])}, ${this.num(p[1])});`);
      case 'reset_scale_size':
        return line('e.resetSize();');

      case 'set_scale_percent':
        return line(`O.setScalePercent(e, ${this.num(p[0])});`);
      case 'change_scale_percent':
        return line(`O.changeScalePercent(e, ${this.num(p[0])});`);
      // Legacy opacity runs in the opposite direction from transparency.
      case 'set_effect':
      case 'set_entity_effect':
        return line(
          text(p[0]) === 'opacity'
            ? `O.setEffect(e, 'transparency', 100 - ${this.num(p[1])});`
            : `O.setEffect(e, ${this.field(p[0])}, ${this.num(p[1])});`,
        );
      case 'set_effect_amount':
        return line(`O.addEffect(e, ${this.field(p[0])}, ${this.num(p[1])});`);
      case 'reset_project_timer':
        return line("O.timerAction('RESET');");
      case 'flip_x':
        return line('e.setScaleY(-e.getScaleY());');
      case 'flip_y':
        return line('e.setScaleX(-e.getScaleX());');
      case 'change_object_index':
        return line(`O.changeObjectIndex(e, ${this.field(p[0])});`);

      case 'wait_second':
        return line(`yield* O.waitSecond(${this.num(p[0])});`);
      case 'repeat_basic':
        return yield* this.repeatBasic(block, ind);
      case 'repeat_inf':
        return yield* this.loop(`while (${this.liveCheck(block.id, 'true')}) {`, block.statements?.[0] ?? [], ind, false, block.id);
      // Maze loops cost no frame; guard nonempty bodies and skip empty ones, matching Entry.
      case 'ai_repeat_until_reach':
        return block.statements?.[0]?.length
          ? yield* this.loop(`while (true) {`, block.statements[0], ind, true, block.id)
          : '';
      case 'repeat_while_true':
        return yield* this.repeatWhile(block, ind);
      case '_if':
        return (
          line(`if (${this.bool(p[0])}) {`) +
          (yield* this.compileStack(block.statements?.[0] ?? [], `${ind}  `, `${block.id}:0`)) +
          line('}')
        );
      case 'if_else':
        return (
          line(`if (${this.bool(p[0])}) {`) +
          (yield* this.compileStack(block.statements?.[0] ?? [], `${ind}  `, `${block.id}:0`)) +
          line('} else {') +
          (yield* this.compileStack(block.statements?.[1] ?? [], `${ind}  `, `${block.id}:1`)) +
          line('}')
        );
      case 'wait_until_true': {
        // Input flow control unwinds to the loop without spending a frame.
        const trick = slotTrick(p[0]);
        if (trick) {
          return line(this.trickCode(trick));
        }
        return line(`while (!(${this.liveCheck(block.id, this.bool(p[0]))})) { yield 0; }`);
      }
      case 'stop_repeat':
        return line(this.trickCode('break'));
      case 'continue_repeat':
        return this.loopDepth > 0 ? line(`{ yield 0; ${this.trickCode('continue')} }`) : line('yield 0;');
      case 'stop_object':
        return this.stopObject(text(p[0]), ind);
      case 'restart_project':
        return line('O.restart(); O.die();');
      case 'stop_run':
        return line('O.stopRun(); O.die();');
      case 'create_clone':
        return line(`O.createClone(e, ${this.field(p[0])});`);
      // Removing a clone ends all its scripts, including this one.
      case 'delete_clone':
        return line('if (e.isClone) { e.removeClone(); O.die(); }');
      case 'remove_all_clones':
        return line('O.removeAllClones(e);');

      case 'message_cast':
        return line(`O.castMessage(${this.field(p[0])});`);
      case 'message_cast_wait':
        return line(`yield* O.castMessageWait(${this.field(p[0])});`);
      case 'start_scene':
        return line(`O.startScene(${this.field(p[0])}); O.die();`);
      case 'start_neighbor_scene':
        return line(`O.startNeighborScene(${this.field(p[0])}); O.die();`);
      case 'switch_scope':
        return line(`${this.input.liveEditing ? 'ctx.entity = ' : ''}e = O.entityOf(${this.field(p[0])}) || e;`);

      case 'set_variable':
        return line(`O.setVariable(e, ${this.varRef(p[0])}, ${this.raw(p[1])});`);
      case 'change_variable':
        return line(`O.changeVariable(e, ${this.varRef(p[0])}, ${this.raw(p[1])});`);
      case 'show_variable':
        return line(`O.showVariable(e, ${this.varRef(p[0])}, true);`);
      case 'hide_variable':
        return line(`O.showVariable(e, ${this.varRef(p[0])}, false);`);
      case 'add_value_to_list':
        return line(`O.listAppend(e, ${this.varRef(p[1])}, ${this.raw(p[0])});`);
      case 'remove_value_from_list':
        return line(`O.listRemove(e, ${this.varRef(p[1])}, ${this.numeral(p[0])});`);
      case 'insert_value_to_list':
        // Entry evaluates DATA before INDEX, including calls that yield or fail.
        return line(`{ const data = ${this.raw(p[0])}; const index = ${this.numeral(p[2])}; ${this.marker(block)}O.listInsert(e, ${this.varRef(p[1])}, index, data); }`);
      case 'change_value_list_index': {
        const list = this.sharedList(p[0]);
        return line(list ? `O.listSet(${list}, ${this.numeral(p[1])}, ${this.raw(p[2])});`
          : `O.listReplace(e, ${this.varRef(p[0])}, ${this.numeral(p[1])}, ${this.raw(p[2])});`);
      }
      case 'show_list':
        return line(`O.showVariable(e, ${this.varRef(p[0])}, true);`);
      case 'hide_list':
        return line(`O.showVariable(e, ${this.varRef(p[0])}, false);`);
      case 'ask_and_wait':
        return line(`yield* O.askAndWait(e, ${this.raw(p[0])});`);
      case 'set_visible_answer':
        return line(`O.showAnswer(${this.field(p[0])} !== 'HIDE');`);
      case 'set_func_variable':
        return line(`L[${this.funcVarKey(p[0])}] = ${this.raw(p[1])};`);

      case 'text_write':
        return line(`e.setText(${this.str(p[0])});`);
      case 'text_append':
        return line(`{ const value = ${this.str(p[0])}; ${this.marker(block)}e.setText(e.getText() + value); }`);
      case 'text_prepend':
        return line(`e.setText(${this.str(p[0])} + e.getText());`);
      case 'text_flush':
        return line("e.setText('');");
      case 'text_change_effect':
        return line(`O.textEffect(e, ${this.field(p[0])}, ${this.field(p[1])});`);
      case 'text_change_font':
        return line(`O.textFont(e, ${this.field(p[0])});`);
      case 'text_change_font_color':
        return line(`O.textColor(e, ${this.str(p[0])});`);
      case 'text_change_bg_color':
        return line(`O.textBgColor(e, ${this.str(p[0])});`);

      case 'sound_something_with_block':
        return line(`O.playSound(e, ${this.str(p[0])});`);
      case 'sound_something_second_with_block':
        return line(`O.playSound(e, ${this.strOf(p[0])}, 0, ${this.numOf(p[1])});`);
      case 'sound_from_to':
        return line(`O.playSoundRange(e, ${this.strOf(p[0])}, ${this.numOf(p[1])}, ${this.numOf(p[2])});`);
      case 'sound_something_wait_with_block':
        return line(`yield* O.playSoundWait(e, ${this.str(p[0])});`);
      case 'sound_something_second_wait_with_block':
        return line(`yield* O.playSoundWait(e, ${this.str(p[0])}, 0, ${this.num(p[1])});`);
      case 'sound_from_to_and_wait':
        return line(
          `yield* O.playSoundRangeWait(e, ${this.strOf(p[0])}, ${this.numOf(p[1])}, ${this.numOf(p[2])});`,
        );
      case 'sound_volume_change':
        return line(`O.changeVolume(${this.num(p[0])});`);
      case 'sound_volume_set':
        return line(`O.setVolume(${this.num(p[0])});`);
      case 'sound_speed_change':
        return line(`O.changeSpeed(${this.num(p[0])});`);
      case 'sound_speed_set':
        return line(`O.setSpeed(${this.num(p[0])});`);
      case 'sound_silent_all':
        return line(`O.stopSounds(e, ${this.field(p[0])});`);
      case 'play_bgm':
        return line(`O.playBgm(e, ${this.str(p[0])});`);
      case 'stop_bgm':
        return line('O.stopBgm();');

      case 'brush_stamp':
        return line('O.stamp(e);');
      case 'start_drawing':
        return line('O.startDrawing(e);');
      case 'stop_drawing':
        return line('O.stopDrawing(e);');
      case 'start_fill':
        return line('O.startFill(e);');
      case 'stop_fill':
        return line('O.stopFill(e);');
      case 'set_color':
        return line(`O.setPenColor(e, ${this.str(p[0])});`);
      case 'set_random_color':
        return line('O.setRandomPenColor(e);');
      case 'set_fill_color':
        return line(`O.setFillColor(e, ${this.str(p[0])});`);
      case 'change_thickness':
        return line(`O.changeThickness(e, ${this.num(p[0])});`);
      case 'set_thickness':
        return line(`O.setThickness(e, ${this.num(p[0])});`);
      case 'change_brush_transparency':
        return line(`O.changePenOpacity(e, ${this.num(p[0])});`);
      case 'set_brush_tranparency':
        return line(`O.setPenOpacity(e, ${this.num(p[0])});`);
      case 'brush_erase_all':
        return line('O.eraseAll(e);');

      case 'append_row_to_table':
        return line(`yield* O.tableAppend(${this.tableRef(p[0])}, ${this.str(p[1])});`);
      case 'insert_row_to_table':
        return line(`yield* O.tableInsert(${this.tableRef(p[0])}, ${this.num(p[1])}, ${this.str(p[2])});`);
      case 'delete_row_from_table':
        return line(`O.tableDelete(${this.tableRef(p[0])}, ${this.num(p[1])}, ${this.str(p[2])});`);
      case 'set_value_from_table':
        return line(
          `O.tableSet(${this.tableRef(p[0])}, ${this.num(p[1])}, ${this.raw(p[2])}, ${this.raw(p[3])});`,
        );
      case 'set_value_from_cell':
        return line(`O.tableSetCell(${this.tableRef(p[0])}, ${this.raw(p[1])}, ${this.raw(p[2])});`);
      case 'open_table':
        return line(`O.showTable(${this.tableRef(p[0])});`);
      // Closing the table later must not hold the script; Entry runs following blocks immediately.
      case 'open_table_wait':
        return line(`O.showTable(${this.tableRef(p[0])}, ${this.num(p[1])});`);
      case 'close_table_chart':
        return line('O.closeTable();');
      case 'open_table_chart':
        return line(`O.showChart(${this.tableRef(p[0])}, ${this.num(p[1])});`);
      case 'save_current_table':
        // The save dialog belongs to the editor and has no effect in the running work.
        return line(comment(block.type));

      case 'read_text':
        return line(`O.speak(e, ${this.str(p[0])});`);
      case 'read_text_wait_with_block':
        return line(`yield* O.speakWait(e, ${this.str(p[0])});`);
      case 'set_tts_property':
        return line(
          `O.setVoice(e, ${this.field(p[0])}, ${this.field(p[1])}, ${this.field(p[2])});`,
        );

      case 'choose_project_timer_action':
        return line(`O.timerAction(${this.field(p[1])});`);
      case 'set_visible_project_timer':
        return line(`O.showTimer(${this.field(p[1])} === 'SHOW');`);

      default:
        if (block.type.startsWith('func_')) {
          return this.callFunction(block, ind, false).code;
        }
        this.note(block.type);
        return line(comment(block.type));
    }
  }

  // Outside loops, input flow control unwinds calls and yields or ends the script.
  private trickCode(trick: 'continue' | 'break'): string {
    if (this.loopDepth > 0) {
      if (trick === 'continue' && this.spinning.length) {
        // This iteration skips yielding, so the enclosing loop needs a guard.
        this.spinning[this.spinning.length - 1] = true;
      }
      if (this.input.liveEditing) return `throw R.liveCode.${trick};`;
      return trick === 'break' ? 'break;' : 'continue;';
    }
    return trick === 'break' ? this.endExecutor() : 'yield 0;';
  }

  // Put the spin guard before the body so continue cannot bypass it.
  private spinGuard(depth: number, ind: string): string {
    const spins = `s${depth}`;
    const mark = `m${depth}`;
    return (
      `${ind}  if (${mark} !== O.frame()) { ${mark} = O.frame(); ${spins} = 0; }\n` +
      `${ind}  else if ((${spins} += 1) >= ${SPIN_LIMIT}) { ${spins} = 0; yield 0; ${mark} = O.frame(); }\n`
    );
  }

  private *repeatBasic(block: RawBlock, ind: string): Generator<void, string, unknown> {
    const count = this.num(block.params[0]);
    const depth = this.loopDepth;
    const varName = `i${depth}`;
    this.loopDepth += 1;
    this.spinning.push(false);
    const inner = this.loopBody((yield* this.compileStack(block.statements?.[0] ?? [], `${ind}  `, `${block.id}:0`)), ind);
    const spins = this.spinning.pop() ?? false;
    this.loopDepth -= 1;
    const head = spins ? `, s${depth} = 0, m${depth} = O.frame()` : '';
    return (
      `${ind}{ let ${varName} = Math.floor(${count})${head};\n` +
      `${ind}while (${varName} !== 0 && !(${varName} < 0)) { ${varName}--;\n` +
      (spins ? this.spinGuard(depth, ind) : '') +
      inner +
      `${ind}  yield 0;\n${ind}} }\n`
    );
  }

  private *repeatWhile(block: RawBlock, ind: string): Generator<void, string, unknown> {
    const until = text(block.params[1] ?? 'until') === 'until';
    const condition = until ? `!(${this.bool(block.params[0])})` : this.bool(block.params[0]);
    return yield* this.loop(`while (${this.liveCheck(block.id, condition)}) {`, block.statements?.[0] ?? [], ind, false, block.id);
  }

  private liveCheck(id: string, expression: string): string {
    if (!this.input.liveEditing) return expression;
    this.liveChecks.set(id, `function* (ctx, th) { const e = ctx.entity, P = ctx.params, L = ctx.locals; return ${expression}; }`);
    return `(yield R.liveCode.check(${literal(id)}, ctx, th))`;
  }

  private loopBody(body: string, ind: string): string {
    return this.input.liveEditing
      ? `${ind}  try {\n${body}${ind}  } catch (x) { if (x === R.liveCode.break) break; if (x === R.liveCode.continue) continue; throw x; }\n${ind}  e = ctx.entity;\n`
      : body;
  }

  // Loop iterations cost a frame unless the body skips yielding.
  // Frameless loops still need the spin guard to yield when stuck.
  private *loop(header: string, body: RawBlock[], ind: string, frameless = false, id = ''): Generator<void, string, unknown> {
    const depth = this.loopDepth;
    this.loopDepth += 1;
    this.spinning.push(false);
    const inner = this.loopBody(yield* this.compileStack(body, `${ind}  `, `${id}:0`), ind);
    const spins = (this.spinning.pop() ?? false) || frameless;
    this.loopDepth -= 1;
    const tail = frameless ? '' : `${ind}  yield 0;\n`;
    if (!spins) {
      return `${ind}${header}\n${inner}${tail}${ind}}\n`;
    }
    return (
      `${ind}{ let s${depth} = 0, m${depth} = O.frame();\n` +
      `${ind}${header}\n${this.spinGuard(depth, ind)}${inner}${tail}${ind}} }\n`
    );
  }

  private stopObject(target: string, ind: string): string {
    const line = (code: string) => `${ind}${code}\n`;
    switch (target) {
      case 'all':
        return line('O.stopAll(); O.die();');
      case 'thisOnly':
        return line('O.stopEntity(e); O.die();');
      case 'thisObject':
        return line('O.stopTarget(e); O.die();');
      // Stopping a function's executor leaves its caller running, matching Entry.
      case 'thisThread':
        return line(this.endExecutor());
      case 'otherThread':
        return line('O.stopOtherThreads(e, th);');
      case 'other_objects':
        return line('O.stopOtherTargets(e);');
      default:
        return line(this.endExecutor());
    }
  }

  // Keep the numeric fallback because Entry converts NaN and negative zero to zero at each number slot.
  private num(param: unknown): string {
    const value = this.value(param);
    if (value.constant !== undefined) {
      const folded = parseFloat(text(value.constant)) || 0;
      return String(folded);
    }
    return value.kind === 'num' ? `(${value.code} || 0)` : `n(${value.code})`;
  }

  // Timed blocks use Number rather than parseFloat with a zero fallback.
  private numOf(param: unknown): string {
    const value = this.value(param);
    if (value.constant !== undefined) {
      return String(number(value.constant));
    }
    return value.kind === 'num' ? value.code : `Number(${value.code})`;
  }

  private str(param: unknown): string {
    const value = this.value(param);
    if (value.constant !== undefined) {
      return literal(text(value.constant));
    }
    return value.kind === 'str' ? value.code : `s(${value.code})`;
  }

  private strOf(param: unknown): string {
    return this.str(param);
  }

  private bool(param: unknown): string {
    const value = this.value(param);
    if (value.constant !== undefined) {
      return String(Boolean(value.constant));
    }
    return value.kind === 'bool' ? value.code : `b(${value.code})`;
  }

  private raw(param: unknown): string {
    const value = this.value(param);
    return value.code;
  }

  // Typed numbers arrive as text; parse the ones that read back unchanged once, where only their number matters.
  private numeral(param: unknown): string {
    const value = this.value(param);
    const constant = value.constant;
    return typeof constant === 'string' && isNumber(constant) && String(Number(constant)) === constant ? constant : value.code;
  }

  private field(param: unknown): string {
    if (isBlock(param)) {
      return this.value(param).code;
    }
    return literal(param ?? null);
  }

  private varRef(param: unknown): string {
    const id = text(param);
    const index = this.varIndex.get(id);
    if (index === undefined) {
      this.note(`variable:${id}`);
      return 'null';
    }
    return `${index}`;
  }

  private sharedList(param: unknown): string | null {
    const index = this.varIndex.get(text(param));
    return index !== undefined && this.input.variables[index]!.sharedList ? `V[${index}]` : null;
  }

  private tableRef(param: unknown): string {
    const id = text(param);
    const index = this.tableIndex.get(id);
    if (index === undefined) {
      this.note(`table:${id}`);
      return literal(id);
    }
    return `${index}`;
  }

  private funcVarKey(param: unknown): string {
    return literal(text(param));
  }

  private value(param: unknown): Value {
    if (!isBlock(param)) {
      if (param === null || param === undefined) {
        return NULL_VALUE;
      }
      return { code: literal(param), kind: typeof param === 'number' ? 'num' : 'any', constant: param as string };
    }
    const value = this.blockValue(param);
    return value.constant !== undefined ? value : { ...value, code: this.marker(param) + value.code };
  }

  private blockValue(block: RawBlock): Value {
    const p = block.params;

    switch (block.type) {
      case 'number':
      case 'text':
        return { code: literal(p[0] ?? ''), kind: 'any', constant: (p[0] ?? '') as string };
      case 'angle':
        return { code: String(number(p[0] ?? 0) || 0), kind: 'num', constant: number(p[0] ?? 0) || 0 };
      case 'True':
        return { code: 'true', kind: 'bool', constant: true };
      case 'False':
        return { code: 'false', kind: 'bool', constant: false };
      case 'get_pictures':
      case 'get_sounds':
        return { code: literal(text(p[0])), kind: 'str', constant: text(p[0]) };
      // Entry table dropdowns store one-based column numbers as text.
      case 'get_table_fields':
        return { code: literal(text(p[0])), kind: 'str', constant: text(p[0]) };
      // Both primitive color pickers hold their color in the first parameter.
      case 'color':
      case 'text_color':
        return { code: literal(text(p[0])), kind: 'str', constant: text(p[0]) };

      case 'calc_basic':
        return this.calcBasic(block);
      case 'calc_rand':
        return { code: `O.random(${this.str(p[1])}, ${this.str(p[3])})`, kind: 'any' };
      case 'calc_operation':
        return { code: `O.mathOp(${this.num(p[1])}, ${this.field(p[3])})`, kind: 'num' };
      case 'quotient_and_mod':
        return {
          code: `O.quotient(${this.num(p[1])}, ${this.num(p[3])}, ${this.field(p[5])})`,
          kind: 'num',
        };
      case 'coordinate_mouse':
        return { code: `O.mouseCoordinate(${this.field(p[1])})`, kind: 'num' };
      case 'coordinate_object':
        return { code: `O.objectProperty(e, ${this.field(p[1])}, ${this.field(p[3])})`, kind: 'any' };
      case 'get_x_coordinate':
        return { code: 'e.getX()', kind: 'num' };
      case 'get_y_coordinate':
        return { code: 'e.getY()', kind: 'num' };
      case 'calc_mod':
        return { code: `(${this.num(p[0])} % ${this.num(p[2])})`, kind: 'num' };
      case 'calc_share':
        return { code: `Math.floor(${this.num(p[0])} / ${this.num(p[2])})`, kind: 'num' };
      // Legacy arithmetic stores operands at indices 0 and 2.
      case 'calc_plus':
        return { code: `C.calcPlus(${this.numeral(p[0])}, ${this.numeral(p[2])})`, kind: 'any' };
      case 'calc_minus':
        return { code: `C.subNum(${this.num(p[0])}, ${this.num(p[2])})`, kind: 'num' };
      case 'calc_times':
        return { code: `C.mulNum(${this.num(p[0])}, ${this.num(p[2])})`, kind: 'num' };
      case 'calc_divide':
        return { code: `C.divNum(${this.num(p[0])}, ${this.num(p[2])})`, kind: 'num' };
      // Resolve FIRST, LAST, and RANDOM only at list read slots.
      case 'options_for_list':
        return { code: this.field(p[0]), kind: 'str' };
      case 'distance_something':
        return { code: `O.distanceTo(e, ${this.field(p[1])})`, kind: 'num' };
      case 'get_project_timer_value':
        return { code: 'O.timerValue()', kind: 'num' };
      case 'get_date':
        return { code: `O.dateValue(${this.field(p[1])})`, kind: 'num' };
      case 'get_user_name':
        return { code: 'O.userId()', kind: 'str' };
      case 'get_nickname':
        return { code: 'O.nickname()', kind: 'str' };

      case 'length_of_string':
        return { code: `${this.str(p[1])}.length`, kind: 'num' };
      case 'reverse_of_string':
        return { code: `${this.str(p[1])}.split('').reverse().join('')`, kind: 'str' };
      case 'combine_something':
        return { code: `(${this.str(p[1])} + ${this.str(p[3])})`, kind: 'str' };
      case 'char_at':
        return { code: `O.charAt(${this.str(p[1])}, ${this.num(p[3])})`, kind: 'str' };
      case 'substring':
        return {
          code: `O.substring(${this.str(p[1])}, ${this.num(p[3])}, ${this.num(p[5])})`,
          kind: 'str',
        };
      case 'count_match_string':
        return { code: `(${this.str(p[0])}.split(${this.str(p[2])}).length - 1)`, kind: 'num' };
      case 'index_of_string':
        return { code: `(${this.str(p[1])}.indexOf(${this.str(p[3])}) + 1)`, kind: 'num' };
      case 'replace_string':
        return {
          code: `${this.str(p[1])}.split(${this.str(p[3])}).join(${this.str(p[5])})`,
          kind: 'str',
        };
      case 'change_string_case':
        return { code: `O.changeCase(${this.str(p[1])}, ${this.field(p[3])})`, kind: 'str' };
      case 'change_rgb_to_hex':
        return {
          code: `O.rgbToHex(${this.num(p[0])}, ${this.num(p[1])}, ${this.num(p[2])})`,
          kind: 'str',
        };
      case 'change_hex_to_rgb':
        return { code: `O.hexToRgb(${this.raw(p[0])}, ${this.field(p[1])})`, kind: 'num' };
      case 'get_boolean_value':
        return { code: `(${this.raw(p[0])} ? 'TRUE' : 'FALSE')`, kind: 'str' };
      case 'get_block_count':
        this.needsBlockCounts = true;
        return { code: `(yield* O.blockCount(e, ${literal(p[0])}, B))`, kind: 'num' };

      // Translation waits for Entry's service like a function call.
      case 'get_translated_string':
        return {
          code: `(yield* O.translate(${this.field(p[0])}, ${this.str(p[1])}, ${this.field(p[2])}))`,
          kind: 'str',
        };
      case 'check_language':
        return { code: `(yield* O.detectLanguage(${this.str(p[0])}))`, kind: 'str' };

      case 'is_clicked':
        return { code: 'O.isClicked()', kind: 'bool' };
      case 'is_object_clicked':
        return { code: 'O.isObjectClicked(e)', kind: 'bool' };
      case 'is_press_some_key':
        // A computed key may refer to any key at runtime.
        if (isBlock(p[0])) this.keys = null;
        else this.keys?.add(Number(text(p[0])));
        return { code: `O.isKeyPressed(${this.field(p[0])})`, kind: 'bool' };
      case 'reach_something':
        return { code: `O.touching(e, ${this.field(p[1])})`, kind: 'bool' };
      case 'is_type':
        return { code: `O.isType(${this.str(p[0])}, ${this.field(p[2])})`, kind: 'bool' };
      case 'boolean_basic_operator':
        return this.compare(block);
      case 'boolean_and_or':
        // Entry evaluates both sides before combining them.
        return {
          code:
            text(p[1] ?? 'AND') === 'AND'
              ? `C.andOf(${this.raw(p[0])}, ${this.raw(p[2])})`
              : `C.orOf(${this.raw(p[0])}, ${this.raw(p[2])})`,
          kind: 'bool',
        };
      // Legacy and/or blocks also evaluate both sides.
      case 'boolean_and':
        return { code: `C.andOf(${this.raw(p[0])}, ${this.raw(p[2])})`, kind: 'bool' };
      case 'boolean_or':
        return { code: `C.orOf(${this.raw(p[0])}, ${this.raw(p[2])})`, kind: 'bool' };
      case 'boolean_equal':
        return { code: `C.cmpEqual(${this.numeral(p[0])}, ${this.numeral(p[2])})`, kind: 'bool' };
      case 'boolean_bigger':
        return { code: `C.cmpGreater(${this.numeral(p[0])}, ${this.numeral(p[2])})`, kind: 'bool' };
      case 'boolean_smaller':
        return { code: `C.cmpLess(${this.numeral(p[0])}, ${this.numeral(p[2])})`, kind: 'bool' };
      case 'boolean_not':
        return { code: `(!${this.bool(p[1])})`, kind: 'bool' };
      case 'is_boost_mode':
        return { code: 'O.isBoostMode()', kind: 'bool' };
      case 'is_current_device_type':
        return { code: `O.isDeviceType(${this.field(p[0])})`, kind: 'bool' };
      case 'is_touch_supported':
        return { code: 'O.isTouchSupported()', kind: 'bool' };

      case 'get_variable':
        return { code: `O.getVariable(e, ${this.varRef(p[0])})`, kind: 'any' };
      case 'value_of_index_from_list': {
        const list = this.sharedList(p[1]);
        return { code: list ? `O.listItem(${list}, ${this.numeral(p[3])})` : `O.listValue(e, ${this.varRef(p[1])}, ${this.numeral(p[3])})`, kind: 'any' };
      }
      case 'length_of_list':
        return { code: `O.listLength(e, ${this.varRef(p[1])})`, kind: 'num' };
      case 'is_included_in_list':
        return { code: `O.listIncludes(e, ${this.varRef(p[1])}, ${this.str(p[3])})`, kind: 'bool' };
      case 'get_canvas_input_value':
        return { code: 'O.answer()', kind: 'any' };
      case 'get_func_variable':
        return { code: `L[${this.funcVarKey(p[0])}]`, kind: 'any' };

      case 'text_read':
        return { code: `O.readText(e, ${this.field(p[0])})`, kind: 'str' };

      case 'get_table_count':
        return { code: `O.tableCount(${this.tableRef(p[0])}, ${this.str(p[1])})`, kind: 'num' };
      case 'get_value_from_table':
        return {
          code: `O.tableValue(${this.tableRef(p[0])}, ${this.num(p[1])}, ${this.raw(p[2])})`,
          kind: 'any',
        };
      case 'get_value_from_last_row':
        return { code: `O.tableLastValue(${this.tableRef(p[0])}, ${this.raw(p[1])})`, kind: 'any' };
      case 'get_value_from_cell':
        return { code: `O.tableCellValue(${this.tableRef(p[0])}, ${this.raw(p[1])})`, kind: 'any' };
      case 'calc_values_from_table':
        return {
          code: `O.tableCalc(${this.tableRef(p[0])}, ${this.raw(p[1])}, ${this.field(p[2])})`,
          kind: 'num',
        };
      case 'get_coefficient':
        return {
          code: `O.tableCoefficient(${this.tableRef(p[0])}, ${this.raw(p[1])}, ${this.raw(p[2])})`,
          kind: 'any',
        };
      case 'get_value_v_lookup':
        return {
          code: `O.tableLookup(${this.tableRef(p[0])}, ${this.raw(p[1])}, ${this.raw(p[2])}, ${this.raw(p[3])})`,
          kind: 'any',
        };

      case 'get_sound_volume':
        return { code: 'O.volume()', kind: 'num' };
      case 'get_sound_speed':
        return { code: 'O.speed()', kind: 'num' };
      case 'get_sound_duration':
        return { code: `O.soundDuration(e, ${this.field(p[1])})`, kind: 'num' };

      default: {
        const expansion = expansionBlock(block.type);
        if (expansion) {
          const args = expansion.slots.map((slot, index) => slot === 'value'
            ? this.raw(p[index])
            : this.field(p[index]));
          return {
            code: `(yield* O.expansion(${literal(block.type)}, [${args.join(', ')}]))`,
            kind: expansion.kind === 'boolean' ? 'bool' : 'any',
          };
        }
        if (block.type.startsWith('func_')) {
          return { code: this.callFunction(block, '', true).code, kind: 'any' };
        }
        const slot = this.paramSlots?.get(block.type);
        if (slot !== undefined) {
          return { code: `P[${slot}]`, kind: 'any' };
        }
        if (RESERVED_PARAM.test(block.type)) {
          return NULL_VALUE;
        }
        this.note(block.type);
        return NULL_VALUE;
      }
    }
  }

  private calcBasic(block: RawBlock): Value {
    const operator = text(block.params[1] ?? 'PLUS');
    const left = block.params[0];
    const right = block.params[2];
    if (operator === 'PLUS') {
      return { code: `C.calcPlus(${this.numeral(left)}, ${this.numeral(right)})`, kind: 'any' };
    }
    const l = this.num(left);
    const r = this.num(right);
    switch (operator) {
      case 'MINUS':
        return { code: `C.subNum(${l}, ${r})`, kind: 'num' };
      case 'MULTI':
        return { code: `C.mulNum(${l}, ${r})`, kind: 'num' };
      default:
        return { code: `C.divNum(${l}, ${r})`, kind: 'num' };
    }
  }

  private compare(block: RawBlock): Value {
    const left = this.numeral(block.params[0]);
    const right = this.numeral(block.params[2]);
    const table: Record<string, string> = {
      EQUAL: 'cmpEqual',
      NOT_EQUAL: 'cmpNotEqual',
      GREATER: 'cmpGreater',
      LESS: 'cmpLess',
      GREATER_OR_EQUAL: 'cmpGreaterEqual',
      LESS_OR_EQUAL: 'cmpLessEqual',
    };
    const fn = pick(table, text(block.params[1] ?? 'EQUAL')) ?? 'cmpEqual';
    return { code: `C.${fn}(${left}, ${right})`, kind: 'bool' };
  }

  private callFunction(block: RawBlock, ind: string, asValue: boolean): { code: string } {
    const id = block.type.slice('func_'.length);
    const index = this.funcIndex.get(id);
    if (index === undefined) {
      this.note(block.type);
      return { code: asValue ? 'undefined' : `${ind}${comment(`missing ${block.type}`)}\n` };
    }
    // Preserve empty argument slots so later arguments keep their declaration indices.
    const args = block.params.map((param) => this.raw(param));
    // Yield calls onto the thread's stack so recursion does not grow the JS stack.
    const call = `(yield ${this.input.liveEditing ? 'R.liveCode.functions' : 'F'}[${index}](e, th, [${args.join(', ')}]))`;
    return { code: asValue ? call : `${ind}${call};\n` };
  }

  private note(type: string): void {
    this.unknown.set(type, (this.unknown.get(type) ?? 0) + 1);
  }
}

export { parseScript, findFunctionDefine, functionBody, collectParams } from './blocks.ts';
