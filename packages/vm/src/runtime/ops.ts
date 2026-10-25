import { BOUNCE_THRESHOLD, TOUCH_THRESHOLD } from '../collision/detect.ts';
import * as cast from './cast.ts';
import {
  COLLISION,
  newBrush,
  stage,
  type BrushState,
  type Entity,
  type Stroke,
  type Target,
  type Variable,
} from './model.ts';
import { cellToRowCol, columnIndex } from './table.ts';
import { GUEST } from './engine.ts';
import type { Vm } from './engine.ts';
import { RuntimeBlockError } from './diagnostics.ts';

type TableRef = number | string;

export type Ops = ReturnType<typeof createOps>;

// Unwind immediately when a block stops the script so no following function statements run.
export class ThreadStop extends Error {
  constructor() {
    super('thread stopped');
    this.name = 'ThreadStop';
  }
}

const SQRT3 = Math.sqrt(3);
const HALF_SQRT2 = Math.SQRT2 / 2;

// Use exact trig values for Entry's common angles.
const TRIG: Record<string, Record<number, number>> = {
  sin: {
    0: 0, 30: 0.5, 45: HALF_SQRT2, 60: SQRT3 / 2, 90: 1, 120: SQRT3 / 2, 135: HALF_SQRT2,
    150: 0.5, 180: 0, 210: -0.5, 225: -HALF_SQRT2, 240: -SQRT3 / 2, 270: -1,
    300: -SQRT3 / 2, 315: -HALF_SQRT2, 330: -0.5, 360: 0,
  },
  cos: {
    0: 1, 30: SQRT3 / 2, 45: HALF_SQRT2, 60: 0.5, 90: 0, 120: -0.5, 135: -HALF_SQRT2,
    150: -SQRT3 / 2, 180: -1, 210: -SQRT3 / 2, 225: -HALF_SQRT2, 240: -0.5, 270: 0,
    300: 0.5, 315: HALF_SQRT2, 330: SQRT3 / 2, 360: 1,
  },
  tan: {
    0: 0, 30: SQRT3 / 3, 45: 1, 60: SQRT3, 90: Infinity, 120: -SQRT3, 135: -1,
    150: -SQRT3 / 3, 180: 0, 210: SQRT3 / 3, 225: 1, 240: SQRT3, 270: -Infinity,
    300: -SQRT3, 315: -1, 330: -SQRT3 / 3, 360: 0,
  },
};

function preciseTrig(degrees: number, operator: 'sin' | 'cos' | 'tan'): number {
  const angle = degrees % 360;
  const table = TRIG[operator]!;
  if (Object.prototype.hasOwnProperty.call(table, angle)) {
    return table[angle]!;
  }
  return Math[operator]((angle * Math.PI) / 180);
}

const TRANSLATE_MAX_CHARS = 3000;
const NO_SENTENCE = '문장이 없습니다';
const SENTENCE_TOO_LONG = '3000자까지만 입력할 수 있습니다.';
const UNKNOWN_SENTENCE = '알 수 없는 문장입니다.';

// Preserve Entry's displayed language names, including its Vietnamese label.
const LANGUAGE_NAMES: Record<string, string> = {
  ko: '한국어', en: '영어', ja: '일본어', 'zh-CN': '중국어간체', 'zh-TW': '중국어번체',
  es: '스페인어', fr: '프랑스어', de: '독일어', ru: '러시아어', pt: '포르투갈어',
  th: '태국어', vi: '베트남', id: '인도네시아어', hi: '힌디어',
};

// Accept readable language names as well as Papago codes from older or hand-written projects.
function languageCode(value: string): string {
  const name = value.replace(/\s+/g, '');
  if (name === '베트남어') return 'vi';
  for (const [code, label] of Object.entries(LANGUAGE_NAMES)) {
    if (label === name) return code;
  }
  return value;
}

// Yield across frames; an optional fallback handles rejected or empty answers.
function* settle<T>(answer: Promise<T>, fallback?: T): Generator<number, T> {
  let value: T | undefined;
  let failure: unknown;
  let failed = false;
  let done = false;
  void answer.then(
    (result) => { value = result; done = true; },
    (error) => { failure = error; failed = true; done = true; },
  );
  while (!done) {
    yield 1;
  }
  if (failed && fallback === undefined) throw failure;
  return fallback === undefined ? value! : value || fallback;
}

function factorial(n: number): number {
  let result = 1;
  for (let i = 2; i <= n; i += 1) {
    result *= i;
  }
  return result;
}

// Round long decimals before displaying speech bubbles, matching Entry.
function roundedDecimals(value: unknown, decimals: number): unknown {
  if (!cast.isNumber(value) || !/\d+\.\d+$/.test(String(value))) {
    return value;
  }
  return Number(`${Math.round(Number(`${value}e${decimals}`))}e-${decimals}`);
}

function ensureBrush(entity: Entity, which: 'brush' | 'paint'): BrushState {
  let state = entity[which];
  if (!state) {
    state = newBrush();
    state.stop = true;
    entity[which] = state;
  }
  return state;
}

export function createOps(vm: Vm) {
  function pen(entity: Entity): void {
    const brush = entity.brush;
    if (brush && !brush.stop) {
      brush.path.push(entity.x, entity.y);
      vm.renderer?.penChanged?.(entity);
    }
    const paint = entity.paint;
    if (paint && !paint.stop) {
      paint.path.push(entity.x, entity.y);
      vm.renderer?.penChanged?.(entity);
    }
  }

  function targetFor(id: string): Target | null {
    return vm.targetOf(id);
  }

  function entityFor(id: string): Entity | null {
    return vm.entityOf(id);
  }

  function variable(entity: Entity, index: number): Variable | null {
    return vm.variableAt(index, entity);
  }

  function listVariable(entity: Entity, index: number, blockType: string): Variable {
    const list = variable(entity, index);
    if (!list?.isList) {
      throw new RuntimeBlockError('리스트를 찾을 수 없습니다', blockType, { list: list?.name ?? index });
    }
    return list;
  }

  function listError(blockType: string, list: Variable, inputs: Record<string, unknown>): never {
    throw new RuntimeBlockError(`리스트 항목 위치가 올바르지 않습니다 (항목 수 ${list.array.length})`,
      blockType, { list: list.name, length: list.array.length, ...inputs });
  }

  function tableAt(index: TableRef) {
    return typeof index === 'number' ? vm.tables[index] : undefined;
  }

  function tableError(index: TableRef, blockType: string, inputs: Record<string, unknown>): never {
    throw new RuntimeBlockError('표를 찾을 수 없습니다', blockType, { table: index, ...inputs });
  }

  function tableColumnPosition(index: TableRef, column: unknown, blockType: string, input = 'column') {
    try {
      return columnIndex(column);
    } catch {
      throw new RuntimeBlockError('표의 열 지정값을 읽을 수 없습니다 (예: A 또는 1)', blockType,
        { table: tableAt(index)?.id ?? index, [input]: column });
    }
  }

  function tableCellPosition(index: TableRef, cell: unknown, blockType: string, value?: unknown) {
    const address = cell || '';
    const upper = (address as string).toUpperCase;
    if (typeof upper !== 'function') {
      throw new RuntimeBlockError('셀 주소를 글자로 읽을 수 없습니다 (예: A2)', blockType,
        { table: tableAt(index)?.id ?? index, cell, ...(blockType === 'set_value_from_cell' ? { value } : {}) });
    }
    return cellToRowCol(upper.call(address));
  }

  // Resolve the three list index keywords before numeric index conversion.
  function listIndex(raw: unknown, list: Variable): number {
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
      if (raw === 'FIRST') {
        return 1;
      }
      if (raw === 'LAST') {
        return list.array.length;
      }
      if (raw === 'RANDOM') {
        return Math.floor(Math.random() * list.array.length) + 1;
      }
    }
    return cast.isNumber(raw) ? Number(raw) : NaN;
  }

  function startStroke(entity: Entity, which: 'brush' | 'paint'): void {
    const state = entity[which];
    if (!state) {
      return;
    }
    if (state.path.length >= 4) {
      state.strokes.push({
        color: state.color,
        thickness: state.thickness,
        opacity: state.opacity,
        points: state.path,
        fill: which === 'paint',
      });
    }
    state.path = [entity.x, entity.y];
    vm.renderer?.penChanged?.(entity);
  }

  const ops = {
    moveDirection(entity: Entity, value: number): void {
      const radians = ((entity.rotation + entity.direction - 90) / 180) * Math.PI;
      entity.setX(entity.x + value * Math.cos(radians));
      entity.setY(entity.y - value * Math.sin(radians));
      pen(entity);
    },

    moveX(entity: Entity, value: number): void {
      entity.setX(entity.x + value);
      pen(entity);
    },

    moveY(entity: Entity, value: number): void {
      entity.setY(entity.y + value);
      pen(entity);
    },

    moveToAngle(entity: Entity, value: number, angle: number): void {
      entity.setX(entity.x + value * Math.cos(((angle - 90) / 180) * Math.PI));
      entity.setY(entity.y - value * Math.sin(((angle - 90) / 180) * Math.PI));
      pen(entity);
    },

    locateX(entity: Entity, value: number): void {
      entity.setX(value);
      pen(entity);
    },

    locateY(entity: Entity, value: number): void {
      entity.setY(value);
      pen(entity);
    },

    locateXY(entity: Entity, x: number, y: number): void {
      entity.setX(x);
      entity.setY(y);
      pen(entity);
    },

    locateTo(entity: Entity, targetId: string): void {
      const point = ops.pointOf(targetId);
      if (!point) {
        return;
      }
      entity.setX(Number(point.x));
      entity.setY(Number(point.y));
      pen(entity);
    },

    pointOf(targetId: string): { x: number; y: number } | null {
      if (targetId === 'mouse') {
        return { x: vm.mouseX, y: vm.mouseY };
      }
      const target = entityFor(targetId);
      return target ? { x: target.x, y: target.y } : null;
    },

    *moveXYTime(entity: Entity, seconds: number, dx: number, dy: number) {
      let frames = Math.max(Math.floor(seconds * vm.frameRate), 1);
      const stepX = dx / frames;
      const stepY = dy / frames;
      const step = () => {
        entity.setX(entity.x + stepX);
        entity.setY(entity.y + stepY);
        frames -= 1;
        pen(entity);
      };
      if (frames === 1) {
        step();
      }
      while (frames !== 0) {
        step();
        yield 0;
      }
    },

    *locateXYTime(entity: Entity, seconds: number, x: number, y: number) {
      let frames = Math.max(Math.floor(seconds * vm.frameRate), 1);
      const step = () => {
        entity.setX(entity.x + (x - entity.x) / frames);
        entity.setY(entity.y + (y - entity.y) / frames);
        frames -= 1;
        pen(entity);
      };
      if (frames === 1) {
        step();
      }
      while (frames !== 0) {
        step();
        yield 0;
      }
    },

    *locateObjectTime(entity: Entity, seconds: number, targetId: string) {
      const frames = Math.floor(seconds * vm.frameRate);
      const point = ops.pointOf(targetId);
      if (!point) {
        return;
      }
      if (frames === 0) {
        entity.setX(Number(point.x));
        entity.setY(Number(point.y));
        pen(entity);
        return;
      }
      const stepX = (point.x - entity.x) / frames;
      const stepY = (point.y - entity.y) / frames;
      let left = frames;
      while (left !== 0) {
        entity.setX(entity.x + stepX);
        entity.setY(entity.y + stepY);
        left -= 1;
        pen(entity);
        yield 0;
      }
    },

    rotateRelative(entity: Entity, value: number): void {
      entity.setRotation(value + entity.rotation);
    },

    directionRelative(entity: Entity, value: number): void {
      entity.setDirection(value + entity.direction);
    },

    rotateAbsolute(entity: Entity, value: number): void {
      entity.setRotation(value);
    },

    directionAbsolute(entity: Entity, value: number): void {
      entity.setDirection(value);
    },

    *rotateByTime(entity: Entity, seconds: number, angle: number) {
      let frames = Math.max(Math.floor(seconds * vm.frameRate), 1);
      const stepAngle = angle / frames;
      const step = () => {
        entity.setRotation(entity.rotation + stepAngle);
        frames -= 1;
      };
      if (frames === 1) {
        step();
      }
      while (frames !== 0) {
        step();
        yield 0;
      }
    },

    *directionByTime(entity: Entity, seconds: number, angle: number) {
      let frames = Math.max(Math.floor(seconds * vm.frameRate), 1);
      const stepAngle = angle / frames;
      const step = () => {
        entity.setDirection(entity.direction + stepAngle);
        frames -= 1;
      };
      if (frames === 1) {
        step();
      }
      while (frames !== 0) {
        step();
        yield 0;
      }
    },

    seeAngleObject(entity: Entity, targetId: string): void {
      if (entity.target.id === targetId) {
        return;
      }
      const point = ops.pointOf(targetId);
      if (!point) {
        return;
      }
      const deltaX = point.x - entity.x;
      const deltaY = point.y - entity.y;
      let value: number;
      if (deltaX === 0 && deltaY === 0) {
        value = entity.direction + entity.rotation;
      } else if (deltaX >= 0) {
        value = (-Math.atan(deltaY / deltaX) / Math.PI) * 180 + 90;
      } else {
        value = (-Math.atan(deltaY / deltaX) / Math.PI) * 180 + 270;
      }
      if (entity.target.rotateMethod === 'free') {
        const native = entity.direction + entity.rotation;
        entity.setRotation(entity.rotation + value - native);
      } else {
        entity.setDirection(value);
      }
    },

    // Bounce once per wall contact, matching Entry's state machine.
    bounceWall(entity: Entity): void {
      const method = entity.target.rotateMethod;
      const angle =
        method === 'free' ? cast.mod(entity.rotation + entity.direction, 360) : entity.direction;
      const flipVertical = () => {
        if (method === 'free') {
          entity.setRotation(-entity.rotation - entity.direction * 2 + 180);
        } else {
          entity.setDirection(-entity.direction + 180);
        }
      };
      const flipHorizontal = () => {
        if (method === 'free') {
          entity.setRotation(-entity.rotation - entity.direction * 2);
        } else {
          entity.setDirection(-entity.direction + 360);
        }
      };
      const hits = (side: string) => vm.collision.touchingWall(entity, side, BOUNCE_THRESHOLD);

      const test = (first: string, second: string, firstFlag: number, secondFlag: number, flip: () => void) => {
        let skip = entity.collision === firstFlag;
        let hit = hits(first);
        if (!hit && skip) {
          entity.collision = COLLISION.NONE;
        }
        if (hit && skip) {
          hit = false;
        }
        if (hit) {
          flip();
          entity.collision = firstFlag;
          return;
        }
        skip = entity.collision === secondFlag;
        let other = hits(second);
        if (!other && skip) {
          entity.collision = COLLISION.NONE;
        }
        if (other && skip) {
          other = false;
        }
        if (other) {
          flip();
          entity.collision = secondFlag;
        }
      };

      if ((angle < 90 && angle >= 0) || (angle < 360 && angle >= 270)) {
        test('wall_up', 'wall_down', COLLISION.UP, COLLISION.DOWN, flipVertical);
      } else if (angle < 270 && angle >= 90) {
        test('wall_down', 'wall_up', COLLISION.DOWN, COLLISION.UP, flipVertical);
      }
      if (angle < 360 && angle >= 180) {
        test('wall_left', 'wall_right', COLLISION.LEFT, COLLISION.RIGHT, flipHorizontal);
      } else if (angle < 180 && angle >= 0) {
        test('wall_right', 'wall_left', COLLISION.RIGHT, COLLISION.LEFT, flipHorizontal);
      }
    },

    dialog(entity: Entity, message: unknown, mode: string): void {
      entity.dialog = { message: dialogText(message), mode: mode as 'speak' | 'think' };
      entity.dirty = true;
      vm.renderer?.syncDialog?.(entity);
    },

    *dialogTime(entity: Entity, message: unknown, seconds: number, mode: string) {
      ops.dialog(entity, message, mode);
      const until = vm.clock + seconds * 1000;
      while (vm.clock < until && entity.dialog) {
        yield 0;
      }
      ops.removeDialog(entity);
    },

    removeDialog(entity: Entity): void {
      entity.dialog = null;
      entity.dirty = true;
      vm.renderer?.syncDialog?.(entity);
    },

    setPicture(entity: Entity, id: string): void {
      entity.setImage(entity.target.getPicture(id));
    },

    nextPicture(entity: Entity, direction: string): void {
      const current = entity.picture?.id ?? '';
      const picture =
        direction === 'prev'
          ? entity.target.getPrevPicture(current)
          : entity.target.getNextPicture(current);
      entity.setImage(picture);
    },

    addEffect(entity: Entity, effect: string, value: number): void {
      if (effect === 'color') {
        entity.effect.hsv += value;
      } else if (effect === 'brightness') {
        entity.effect.brightness += value;
      } else if (effect === 'transparency') {
        entity.effect.alpha -= value / 100;
      }
      entity.applyEffects();
    },

    setEffect(entity: Entity, effect: string, value: number): void {
      if (effect === 'color') {
        entity.effect.hsv = value;
      } else if (effect === 'brightness') {
        entity.effect.brightness = value;
      } else if (effect === 'transparency') {
        entity.effect.alpha = 1 - value / 100;
      }
      entity.applyEffects();
    },

    // Legacy size setters use the saved scale, so 100 always means the original size.
    setScalePercent(entity: Entity, percent: number): void {
      const scale = percent / 100;
      entity.setScaleX(scale * entity.scaleOriginX);
      entity.setScaleY(scale * entity.scaleOriginY);
    },

    // Legacy size changes multiply both axes by (N + 100) percent.
    changeScalePercent(entity: Entity, percent: number): void {
      const scale = (percent + 100) / 100;
      entity.setScaleX(entity.getScaleX() * scale);
      entity.setScaleY(entity.getScaleY() * scale);
    },

    stretchSize(entity: Entity, dimension: unknown, value: number): void {
      if (dimension === 'WIDTH') {
        entity.setXSize(entity.getSize() + value);
      } else {
        entity.setYSize(entity.getSize() + value);
      }
    },

    changeObjectIndex(entity: Entity, location: string): void {
      vm.renderer?.moveEntity?.(entity, location);
    },

    *waitSecond(seconds: number) {
      const until = vm.clock + (60 / vm.frameRate) * seconds * 1000;
      yield 0;
      while (vm.clock < until) {
        yield 0;
      }
    },

    // Wait for save completion here; asynchronous saves continue immediately.
    *saveStoreWait() {
      let done = false;
      void vm.save.write().then(() => {
        done = true;
      });
      while (!done) {
        yield 1;
      }
    },

    saveStore(): void {
      void vm.save.write();
    },

    // Unwind the running script immediately so no following statements execute.
    die(): never {
      throw new ThreadStop();
    },

    stopAll(): void {
      for (const target of vm.targets) {
        for (const thread of target.threads) {
          thread.stop();
        }
        target.threads = [];
      }
    },

    stopEntity(entity: Entity): void {
      vm.stopThreadsOf(entity);
    },

    stopTarget(entity: Entity): void {
      const target = entity.target;
      for (const thread of target.threads) {
        thread.stop();
      }
      target.threads = [];
    },

    // Mark threads stopped without splicing the active iteration.
    stopOtherThreads(entity: Entity, current: unknown): void {
      for (const thread of entity.target.threads) {
        if (thread !== current && thread.entity === entity) {
          thread.stop();
        }
      }
    },

    stopOtherTargets(entity: Entity): void {
      for (const target of vm.targets) {
        if (target === entity.target) {
          continue;
        }
        for (const thread of target.threads) {
          thread.stop();
        }
        target.threads = [];
      }
    },

    restart(): void {
      vm.stop();
      vm.start();
    },

    // Stop-project also resets the player, unlike stop-all-scripts.
    stopRun(): void {
      vm.stop();
      vm.reset();
    },

    createClone(entity: Entity, targetId: string): void {
      if (targetId === 'self') {
        vm.addClone(entity.target, entity);
        return;
      }
      const target = targetFor(targetId);
      if (target) {
        vm.addClone(target, target.entity);
      }
    },

    removeAllClones(entity: Entity): void {
      for (const clone of entity.target.getClonedEntities()) {
        clone.removeClone();
      }
    },

    castMessage(id: string): void {
      vm.queueMessage(id);
    },

    *castMessageWait(id: string) {
      const started = vm.fireEvent('when_message_cast', id);
      while (started.some((thread) => !thread.done)) {
        yield 0;
      }
    },

    startScene(id: string): void {
      vm.selectScene(id);
      vm.fireEvent('when_scene_start');
    },

    startNeighborScene(operator: string): void {
      const index = vm.scenes.findIndex((scene) => scene.id === vm.currentSceneId);
      const next = operator === 'next' ? index + 1 : index - 1;
      const scene = vm.scenes[next];
      if (scene) {
        vm.selectScene(scene.id);
        vm.fireEvent('when_scene_start');
      }
    },

    entityOf(id: string): Entity | null {
      return entityFor(id);
    },

    getVariable(entity: Entity, index: number): string | number | boolean {
      return variable(entity, index)?.getValue() ?? 0;
    },

    setVariable(entity: Entity, index: number, value: unknown): void {
      variable(entity, index)?.setValue(value as string | number);
    },

    // Add numeric values and concatenate other values, matching Entry.
    changeVariable(entity: Entity, index: number, value: unknown): void {
      if (value === false) {
        throw new RuntimeBlockError('변수 증가량으로 판단값 false를 사용할 수 없습니다 (숫자 0은 허용됩니다)',
          'change_variable', { variable: variable(entity, index)?.name ?? index, increment: value });
      }
      const target = variable(entity, index);
      if (!target) {
        return;
      }
      const current = target.getValue();
      if (cast.isNumber(value) && target.isNumber()) {
        // Keep toFixed results as text because their decimal formatting affects later changes.
        const increment = cast.parseNumber(value) as string | number;
        const places = maxFloatPoint([increment, current as string | number]);
        target.setValue(cast.addNum(Number(increment), Number(current)).toFixed(places));
        return;
      }
      target.setValue(`${current}${value}`);
    },

    showVariable(entity: Entity, index: number, visible: boolean): void {
      const target = variable(entity, index);
      if (target) {
        target.visible = visible;
      }
    },

    listValue(entity: Entity, index: number, raw: unknown): string | number | boolean {
      return ops.listItem(listVariable(entity, index, 'value_of_index_from_list'), raw);
    },

    listItem(list: Variable, raw: unknown): string | number | boolean {
      const at = listIndex(raw, list);
      if (!Number.isInteger(at) || at < 1 || at > list.array.length || !list.array[at - 1]) {
        listError('value_of_index_from_list', list, { index: raw, resolvedIndex: at });
      }
      return list.array[at - 1]!.data;
    },

    listLength(entity: Entity, index: number): number {
      return listVariable(entity, index, 'length_of_list').array.length;
    },

    listIncludes(entity: Entity, index: number, data: string): boolean {
      const list = variable(entity, index);
      if (!list) {
        return false;
      }
      for (const item of list.array) {
        if (String(item.data) === data) {
          return true;
        }
      }
      return false;
    },

    listAppend(entity: Entity, index: number, value: unknown): void {
      const list = listVariable(entity, index, 'add_value_to_list');
      list.array.push({ data: value as string | number });
      list.touch();
    },

    listRemove(entity: Entity, index: number, raw: unknown): void {
      const list = listVariable(entity, index, 'remove_value_from_list');
      if (!cast.isNumber(raw) || Number(raw) > list.array.length) {
        listError('remove_value_from_list', list, { index: raw });
      }
      // Entry passes zero, negative, and fractional indices through to Array.splice.
      list.array.splice(Number(raw) - 1, 1);
      list.touch();
    },

    listInsert(entity: Entity, index: number, raw: unknown, value: unknown): void {
      const list = listVariable(entity, index, 'insert_value_to_list');
      if (!cast.isNumber(raw) || Number(raw) === 0 || Number(raw) > list.array.length + 1) {
        listError('insert_value_to_list', list, { index: raw, value });
      }
      list.array.splice(Number(raw) - 1, 0, { data: value as string | number });
      list.touch();
    },

    listReplace(entity: Entity, index: number, raw: unknown, value: unknown): void {
      ops.listSet(listVariable(entity, index, 'change_value_list_index'), raw, value);
    },

    listSet(list: Variable, raw: unknown, value: unknown): void {
      const at = cast.isNumber(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(at) || at < 1 || at > list.array.length || !list.array[at - 1]) {
        listError('change_value_list_index', list, { index: raw, value });
      }
      list.array[at - 1]!.data = value as string | number;
      list.touchItem(at - 1);
    },

    *askAndWait(entity: Entity, message: unknown) {
      ops.dialog(entity, message, 'ask');
      vm.question = String(message);
      vm.pendingAnswer = null;
      vm.renderer?.showQuestion?.(String(message));
      while (vm.pendingAnswer === null) {
        yield 0;
      }
      vm.answer = vm.pendingAnswer;
      vm.pendingAnswer = null;
      vm.question = null;
      vm.renderer?.hideQuestion?.();
      ops.removeDialog(entity);
    },

    answer(): string | number {
      return vm.answer;
    },

    showAnswer(visible: boolean): void {
      vm.answerVisible = visible;
    },

    readText(entity: Entity, targetId: string): string {
      const source = targetId === 'self' ? entity : entityFor(targetId);
      return (source?.text ?? '').replace(/\n/gim, ' ');
    },

    textEffect(entity: Entity, effect: string, mode: string): void {
      const on = mode === 'on';
      if (effect === 'fontBold') {
        entity.fontBold = on;
      } else if (effect === 'fontItalic') {
        entity.fontItalic = on;
      } else if (effect === 'underLine') {
        entity.underLine = on;
      } else if (effect === 'strike') {
        entity.strike = on;
      }
      entity.measure();
      entity.touch();
    },

    textFont(entity: Entity, font: string): void {
      entity.fontFamily = font;
      entity.measure();
      entity.touch();
    },

    textColor(entity: Entity, colour: string): void {
      entity.colour = colour.startsWith('#') ? colour : `#${colour}`;
      entity.touch();
    },

    textBgColor(entity: Entity, colour: string): void {
      entity.bgColor = colour.startsWith('#') ? colour : `#${colour}`;
      entity.touch();
    },

    playSound(entity: Entity, id: string, startSeconds = 0, durationSeconds?: number): void {
      const sound = entity.target.getSound(id);
      if (sound) {
        vm.audio?.play(
          sound,
          entity.id,
          startSeconds * 1000,
          durationSeconds === undefined ? undefined : durationSeconds * 1000,
        );
      }
    },

    playSoundRange(entity: Entity, id: string, start: number, end: number): void {
      const sound = entity.target.getSound(id);
      if (!sound) {
        return;
      }
      const from = Math.min(start, end) * 1000;
      const to = Math.max(start, end) * 1000;
      vm.audio?.play(sound, entity.id, from, to - from);
    },

    *playSoundWait(entity: Entity, id: string, startSeconds = 0, durationSeconds?: number) {
      const sound = entity.target.getSound(id);
      if (!sound) {
        yield 0;
        return;
      }
      const stop = vm.audio?.play(sound, entity.id, startSeconds * 1000);
      const speed = vm.audio?.getSpeed() ?? 1;
      const ms = durationSeconds !== undefined
        ? durationSeconds * 1000
        : Math.floor((sound.duration * 1000) / speed);
      let playing = true;
      vm.setTimeout(() => {
        if (durationSeconds !== undefined) stop?.();
        playing = false;
      }, ms);
      yield 0;
      while (playing) {
        yield 0;
      }
    },

    *playSoundRangeWait(entity: Entity, id: string, start: number, end: number) {
      const sound = entity.target.getSound(id);
      if (!sound) {
        yield 0;
        return;
      }
      ops.playSoundRange(entity, id, start, end);
      const ms = Math.abs(end - start) * 1000;
      let playing = true;
      vm.setTimeout(() => { playing = false; }, ms);
      yield 0;
      while (playing) {
        yield 0;
      }
    },

    changeVolume(value: number): void {
      vm.audio?.setVolume(cast.clamp((vm.audio?.getVolume() ?? 1) + value / 100, 0, 1));
    },

    setVolume(value: number): void {
      vm.audio?.setVolume(cast.clamp(value / 100, 0, 1));
    },

    volume(): number {
      return (vm.audio?.getVolume() ?? 1) * 100;
    },

    changeSpeed(value: number): void {
      vm.audio?.setSpeed(cast.clamp((vm.audio?.getSpeed() ?? 1) + value, 0.5, 2));
    },

    setSpeed(value: number): void {
      vm.audio?.setSpeed(cast.clamp(value, 0.5, 2));
    },

    speed(): number {
      return vm.audio?.getSpeed() ?? 1;
    },

    stopSounds(entity: Entity, target: string): void {
      if (target === 'thisOnly') {
        vm.audio?.stopEntity(entity.id);
        return;
      }
      if (target === 'other_objects') {
        vm.audio?.stopExcept(entity.id);
      } else {
        vm.audio?.stopAll();
      }
      // TTS is a global sound instance, so every stop target except thisOnly reaches it.
      vm.speech?.stop();
    },

    playBgm(entity: Entity, id: string): void {
      const sound = entity.target.getSound(id);
      if (sound) {
        vm.audio?.playBgm(sound);
      }
    },

    stopBgm(): void {
      vm.audio?.stopBgm();
    },

    soundDuration(entity: Entity, id: string): number | undefined {
      return entity.target.sounds.find(sound => sound.id === id)?.duration;
    },

    startDrawing(entity: Entity): void {
      if (entity.brush) {
        entity.brush.stop = false;
      } else {
        entity.brush = newBrush();
      }
      startStroke(entity, 'brush');
    },

    stopDrawing(entity: Entity): void {
      if (entity.brush) {
        entity.brush.stop = true;
        startStroke(entity, 'brush');
        entity.brush.path = [];
      }
    },

    startFill(entity: Entity): void {
      if (entity.paint) {
        entity.paint.stop = false;
      } else {
        entity.paint = newBrush();
      }
      startStroke(entity, 'paint');
    },

    stopFill(entity: Entity): void {
      if (entity.paint) {
        entity.paint.stop = true;
        startStroke(entity, 'paint');
        entity.paint.path = [];
      }
    },

    setPenColor(entity: Entity, colour: string): void {
      const brush = ensureBrush(entity, 'brush');
      startStroke(entity, 'brush');
      // Store Entry's parsed RGB value rather than the original color text.
      brush.color = cast.hexColor(colour);
    },

    setRandomPenColor(entity: Entity): void {
      const random = () =>
        cast.rgbToHex(
          Math.floor(Math.random() * 256),
          Math.floor(Math.random() * 256),
          Math.floor(Math.random() * 256),
        );
      ops.setPenColor(entity, random());
      ops.setFillColor(entity, random());
    },

    setFillColor(entity: Entity, colour: string): void {
      const paint = ensureBrush(entity, 'paint');
      startStroke(entity, 'paint');
      paint.color = cast.hexColor(colour);
    },

    changeThickness(entity: Entity, value: number): void {
      const brush = ensureBrush(entity, 'brush');
      startStroke(entity, 'brush');
      brush.thickness = Math.max(1, brush.thickness + value);
    },

    setThickness(entity: Entity, value: number): void {
      const brush = ensureBrush(entity, 'brush');
      startStroke(entity, 'brush');
      brush.thickness = Math.max(1, value);
    },

    // Transparency affects both pen and fill; color and thickness affect only their own state.
    changePenOpacity(entity: Entity, value: number): void {
      for (const which of ['brush', 'paint'] as const) {
        const state = ensureBrush(entity, which);
        startStroke(entity, which);
        state.opacity = cast.clamp(state.opacity + value, 0, 100);
      }
    },

    setPenOpacity(entity: Entity, value: number): void {
      for (const which of ['brush', 'paint'] as const) {
        const state = ensureBrush(entity, which);
        startStroke(entity, which);
        state.opacity = cast.clamp(value, 0, 100);
      }
    },

    eraseAll(entity: Entity): void {
      if (entity.brush) {
        entity.brush.strokes = [];
        entity.brush.path = entity.brush.stop ? [] : [entity.x, entity.y];
      }
      if (entity.paint) {
        entity.paint.strokes = [];
        entity.paint.path = entity.paint.stop ? [] : [entity.x, entity.y];
      }
      entity.stamps = [];
      vm.renderer?.eraseAll?.(entity);
    },

    stamp(entity: Entity): void {
      entity.stamps.push({
        picture: entity.picture,
        x: entity.x,
        y: entity.y,
        regX: entity.regX,
        regY: entity.regY,
        scaleX: entity.scaleX,
        scaleY: entity.scaleY,
        rotation: entity.rotation,
        alpha: entity.effect.alpha,
      });
      vm.renderer?.stamp?.(entity);
    },

    *tableAppend(index: TableRef, property: string): Generator<number, void> {
      yield* settle((async () => {
        const target = tableAt(index) ?? tableError(index, 'append_row_to_table', { property });
        if (property === 'ROW') await target.appendRow();
        else await target.appendCol(vm.tableColumnName);
      })());
    },

    *tableInsert(index: TableRef, at: number, property: string): Generator<number, void> {
      yield* settle((async () => {
        const target = tableAt(index) ?? tableError(index, 'insert_row_to_table', { position: at, property });
        if (property === 'ROW') await target.insertRow(at - 1);
        else await target.insertCol(at, vm.tableColumnName);
      })());
    },

    tableDelete(index: TableRef, at: number, property: string): void {
      const target = tableAt(index) ?? tableError(index, 'delete_row_from_table', { position: at, property });
      if (property === 'ROW') target.deleteRow(at - 1);
      else target.deleteCol(at);
    },

    tableSet(index: TableRef, row: number, col: unknown, value: unknown): void {
      const column = tableColumnPosition(index, col, 'set_value_from_table');
      const target = tableAt(index) ?? tableError(index, 'set_value_from_table', { row, column: col, value });
      if (target.isExist(row - 1, column)) {
        target.replaceValue(row - 1, column, value);
      }
    },

    tableSetCell(index: TableRef, cell: unknown, value: unknown): void {
      const { row, col } = tableCellPosition(index, cell, 'set_value_from_cell', value);
      const target = tableAt(index) ?? tableError(index, 'set_value_from_cell', { cell, value });
      if (target.isExist(row, col)) target.replaceValue(row, col, value);
    },

    tableCount(index: TableRef, property: string): number {
      const target = tableAt(index) ?? tableError(index, 'get_table_count', { property });
      if (property === 'ROW') return target.rows.length + 1;
      if (property === 'COL') return target.fields.length;
      return 0;
    },

    tableValue(index: TableRef, row: number, col: unknown): unknown {
      const column = tableColumnPosition(index, col, 'get_value_from_table');
      return (tableAt(index) ?? tableError(index, 'get_value_from_table', { row, column: col })).readValue(row - 1, column);
    },

    tableLastValue(index: TableRef, col: unknown): unknown {
      const column = tableColumnPosition(index, col, 'get_value_from_last_row');
      const target = tableAt(index) ?? tableError(index, 'get_value_from_last_row', { column: col });
      return target.readValue(target.rows.length, column);
    },

    tableCellValue(index: TableRef, cell: unknown): unknown {
      const { row, col } = tableCellPosition(index, cell, 'get_value_from_cell');
      return (tableAt(index) ?? tableError(index, 'get_value_from_cell', { cell })).readValue(row, col);
    },

    // Opening a table window does not hold the running script.
    showTable(index: TableRef, seconds?: number): void {
      vm.openTable(tableAt(index) ?? null, seconds);
    },

    // Entry chart indices start at zero.
    showChart(index: TableRef, chart: unknown): void {
      vm.openTable(tableAt(index) ?? null, undefined, Math.max(0, Math.floor(Number(chart) || 0)));
    },

    closeTable(): void {
      vm.openTable(null);
    },

    tableCalc(index: TableRef, col: unknown, calc: string): number {
      const column = tableColumnPosition(index, col, 'calc_values_from_table');
      const values = (tableAt(index) ?? tableError(index, 'calc_values_from_table', { column: col, calculation: calc })).column(column);
      const total = values.length;
      if (!total) {
        return 0;
      }
      const sum = values.reduce((a, b) => a + b);
      switch (calc) {
        case 'SUM':
          return sum;
        case 'MAX':
          return values.reduce((a, b) => Math.max(a, b));
        case 'MIN':
          return values.reduce((a, b) => Math.min(a, b));
        case 'AVG':
          return sum / total;
        case 'STDEV': {
          const mean = sum / total;
          const variance = values.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (total - 1);
          return Math.sqrt(variance);
        }
        case 'MEDIAN': {
          values.sort((left, right) => left - right);
          return (values[Math.floor(total / 2)]! + values[total - 1 - Math.floor(total / 2)]!) / 2;
        }
        default:
          return 0;
      }
    },

    tableCoefficient(index: TableRef, x: unknown, y: unknown): string | number {
      const left = tableColumnPosition(index, x, 'get_coefficient', 'x') - 1;
      const right = tableColumnPosition(index, y, 'get_coefficient', 'y') - 1;
      return (tableAt(index) ?? tableError(index, 'get_coefficient', { x, y })).coefficient(left, right);
    },

    tableLookup(index: TableRef, field: unknown, value: unknown, returnField: unknown): unknown {
      const col = tableColumnPosition(index, field, 'get_value_v_lookup');
      const returnCol = tableColumnPosition(index, returnField, 'get_value_v_lookup', 'returnColumn');
      const target = tableAt(index) ?? tableError(index, 'get_value_v_lookup', { column: field, value, returnColumn: returnField });
      for (let row = 0; row <= target.rows.length; row += 1) {
        // eslint-disable-next-line eqeqeq
        if (target.getValue(row, col) == value) {
          return target.readValue(row, returnCol);
        }
      }
      return null;
    },

    speak(entity: Entity, text: string): void {
      vm.speech?.speak(text, entity.voice);
    },

    *speakWait(entity: Entity, text: string) {
      const done = vm.speech?.speak(text, entity.voice);
      if (!done) {
        return;
      }
      let finished = false;
      void done.then(() => {
        finished = true;
      });
      while (!finished) {
        yield 1;
      }
    },

    setVoice(entity: Entity, speaker: string, speed: unknown, pitch: unknown): void {
      entity.voice = { speaker, speed: Number(speed) || 0, pitch: Number(pitch) || 0, volume: 1 };
    },

    *blockCount(entity: Entity, target: unknown, counts: Record<string, number>): Generator<number, number> {
      return yield* settle((async () => {
        if (!target) return 0;
        // Entry reads the dropdown directly without evaluating or coercing it.
        const key = target as string;
        if (key.indexOf('scene-') === 0) return counts[`scene-${key.substr(6)}`] ?? 0;
        if (key === 'all') return counts.all!;
        if (key === 'self') return counts[`object-${entity.target.id}`] ?? counts.all!;
        if (key.indexOf('object-') === 0) return counts[`object-${key.substr(7)}`] ?? counts.all!;
        return 0;
      })());
    },

    *translate(sourceName: string, text: string, targetName: string): Generator<number, string> {
      const source = languageCode(String(sourceName));
      const target = languageCode(String(targetName));
      // Invalid translation text returns Entry's reason rather than an API result.
      if (!text) {
        return NO_SENTENCE;
      }
      if (text.length > TRANSLATE_MAX_CHARS) {
        return SENTENCE_TOO_LONG;
      }
      // Skip the API call when source and target languages match.
      if (String(source) === String(target)) {
        return text;
      }
      const answer = vm.translator?.translate(text, String(source), String(target));
      if (!answer) {
        return UNKNOWN_SENTENCE;
      }
      return yield* settle(answer, UNKNOWN_SENTENCE);
    },

    *detectLanguage(text: string): Generator<number, string> {
      if (!text) {
        return NO_SENTENCE;
      }
      if (text.length > TRANSLATE_MAX_CHARS) {
        return SENTENCE_TOO_LONG;
      }
      const answer = vm.translator?.detect(text);
      if (!answer) {
        return UNKNOWN_SENTENCE;
      }
      const code = yield* settle(answer, '');
      return LANGUAGE_NAMES[code] ?? UNKNOWN_SENTENCE;
    },

    *expansion(type: string, params: unknown[]): Generator<number, unknown> {
      const fallback = type.startsWith('check_') ? false
        : type.startsWith('count_') ? 0 : '데이터 없음';
      const answer = vm.expansion?.read(type, params);
      return answer ? yield* settle(answer, fallback) : fallback;
    },

    timerAction(action: string): void {
      if (action === 'START') {
        vm.startTimer();
      } else if (action === 'STOP') {
        vm.pauseTimer();
      } else {
        vm.resetTimer();
      }
    },

    showTimer(visible: boolean): void {
      vm.timerVisible = visible;
    },

    timerValue(): number {
      return vm.timerValue();
    },

    frame(): number {
      return vm.frame;
    },

    random(left: string, right: string): number | string {
      const low = Math.min(Number(left), Number(right));
      const high = Math.max(Number(left), Number(right));
      const isFloat = /\d+\.\d+$/.test(left) || /\d+\.\d+$/.test(right);
      if (isFloat) {
        return (Math.random() * (high - low) + low).toFixed(2);
      }
      return Math.floor(Math.random() * (high - low + 1) + low);
    },

    mathOp(value: number, rawOperator: string): number {
      let operator = rawOperator;
      if (operator.indexOf('_') > 0) {
        operator = operator.split('_')[0]!;
      }
      switch (operator) {
        case 'square':
          return value * value;
        case 'factorial':
          return factorial(value);
        case 'root':
          return Math.sqrt(value);
        case 'log':
          return Math.log(value) / Math.LN10;
        case 'ln':
          return Math.log(value);
        case 'asin':
        case 'acos':
        case 'atan':
          return ((Math[operator](value) as number) * 180) / Math.PI;
        case 'sin':
        case 'cos':
        case 'tan':
          return preciseTrig(value, operator);
        case 'unnatural': {
          const fraction = cast.subNum(value, Math.floor(value));
          return value < 0 && fraction !== 0 ? 1 - fraction : fraction;
        }
        case 'abs':
          return Math.abs(value);
        case 'floor':
          return Math.floor(value);
        case 'ceil':
          return Math.ceil(value);
        case 'round':
          return Math.round(value);
        default:
          return Math.round(value);
      }
    },

    quotient(left: number, right: number, operator: string): number {
      if (operator === 'QUOTIENT') {
        return Math.floor(left / right);
      }
      return left - right * Math.floor(left / right);
    },

    mouseCoordinate(axis: string): number {
      return axis === 'x' ? vm.mouseX : vm.mouseY;
    },

    objectProperty(entity: Entity, targetId: string, property: string): string | number {
      const target = targetId === 'self' ? entity : entityFor(targetId);
      if (!target) {
        return 0;
      }
      switch (property) {
        case 'x':
          return target.x;
        case 'y':
          return target.y;
        case 'rotation':
          return target.rotation;
        case 'direction':
          return target.direction;
        case 'picture_index':
          return target.target.pictures.indexOf(target.picture!) + 1;
        case 'size':
          return cast.fixed(target.getSize(), 1);
        case 'picture_name':
          return target.picture?.name ?? '';
        default:
          return 0;
      }
    },

    distanceTo(entity: Entity, targetId: string): number {
      const point = ops.pointOf(targetId);
      if (!point) {
        return 0;
      }
      return Math.sqrt((entity.x - point.x) ** 2 + (entity.y - point.y) ** 2);
    },

    dateValue(unit: string): number {
      const now = new Date();
      switch (unit) {
        case 'YEAR':
          return now.getFullYear();
        case 'MONTH':
          return now.getMonth() + 1;
        case 'DAY':
          return now.getDate();
        case 'HOUR':
          return now.getHours();
        case 'MINUTE':
          return now.getMinutes();
        case 'DAY_OF_WEEK':
          return now.getDay();
        default:
          return now.getSeconds();
      }
    },

    // Out-of-range text access throws and stops the whole work, matching Entry.
    charAt(text: string, index: number): string {
      // Keep Entry's comparisons so NaN and fractional indices pass the same checks.
      if (index - 1 < 0 || index - 1 > text.length - 1) {
        throw new RuntimeBlockError(`글자 위치 ${index} 이(가) 범위를 벗어났습니다 (글자 수 ${text.length})`, 'char_at', { text, index });
      }
      return text[index - 1] ?? '';
    },

    substring(text: string, start: number, end: number): string {
      const from = start - 1;
      const to = end - 1;
      const last = text.length - 1;
      if (from < 0 || to < 0 || from > last || to > last) {
        throw new RuntimeBlockError(`글자 범위 ${start}~${end} 이(가) 범위를 벗어났습니다 (글자 수 ${text.length})`, 'substring', { text, start, end });
      }
      return text.substring(Math.min(from, to), Math.max(from, to) + 1);
    },

    changeCase(text: string, mode: string): string {
      if (mode === 'toUpperCase') {
        return text.toUpperCase();
      }
      if (mode === 'toLowerCase') {
        return text.toLowerCase();
      }
      return text;
    },

    rgbToHex(r: number, g: number, b: number): string {
      return cast.rgbToHex(r, g, b);
    },

    hexToRgb(hex: unknown, channel: string): number {
      const rgb = cast.hexToRgb(hex);
      return rgb[channel as 'r' | 'g' | 'b'] ?? 0;
    },

    isClicked(): boolean {
      return vm.mouseDown;
    },

    isObjectClicked(entity: Entity): boolean {
      return vm.clickedEntityId === entity.id;
    },

    isKeyPressed(code: unknown): boolean {
      return vm.pressedKeys.has(Number(code));
    },

    isType(value: string, type: string): boolean {
      if (type === 'number') {
        return cast.isNumber(value);
      }
      if (type === 'en') {
        return /^[a-zA-Z]+$/.test(value);
      }
      if (type === 'ko') {
        return /^[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]+$/.test(value);
      }
      return false;
    },

    touching(entity: Entity, targetId: string): boolean {
      if (!entity.visible) {
        return false;
      }
      if (/wall/.test(targetId)) {
        return vm.collision.touchingWall(entity, targetId, TOUCH_THRESHOLD);
      }
      if (targetId === 'mouse') {
        // Before the pointer enters, use the canvas's top-left corner rather than the stage center.
        if (!vm.pointerSeen) {
          return vm.collision.touchingMouse(entity, 0, 0);
        }
        return vm.collision.touchingMouse(
          entity,
          vm.mouseX * stage.scale + stage.worldWidth / 2,
          -vm.mouseY * stage.scale + stage.worldHeight / 2,
        );
      }
      const target = targetFor(targetId);
      if (!target) {
        return false;
      }
      return vm.collision.touchingTarget(entity, target, TOUCH_THRESHOLD);
    },

    isBoostMode(): boolean {
      return vm.boost;
    },

    isDeviceType(device: string): boolean {
      if (device !== 'desktop') {
        return vm.deviceType === device;
      }
      return vm.deviceType !== 'mobile' && vm.deviceType !== 'tablet';
    },

    isTouchSupported(): boolean {
      return vm.touch;
    },

    // Read the viewer's username and nickname; return a space for each when signed out.
    userId(): string {
      return vm.user ? vm.user.id : GUEST;
    },

    nickname(): string {
      return vm.user?.nickname ?? GUEST;
    },
  };

  return ops;
}

function dialogText(message: unknown): string {
  let text: unknown = message;
  if (text === '') {
    text = '    ';
  } else if (typeof text === 'boolean') {
    text = text ? 'True' : 'False';
  } else {
    text = `${text}`;
  }
  return wrapDialog(String(roundedDecimals(text, 3)));
}

// Split bubbles every 15 characters and discard existing line breaks, matching Entry's regex.
function wrapDialog(text: string): string {
  return text.match(/.{1,15}/g)?.join('\n') ?? text;
}

function maxFloatPoint(numbers: Array<string | number>): number {
  let max = 0;
  for (const value of numbers) {
    const text = String(value);
    const dot = text.indexOf('.');
    if (dot !== -1) {
      max = Math.max(max, text.length - dot - 1);
    }
  }
  return Math.min(max, 20);
}
