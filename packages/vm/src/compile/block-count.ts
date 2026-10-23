import { blockShape, type BlockShape } from './block-shapes.ts';
import { collectParams, findFunctionDefine, isBlock, parseScript, type RawBlock } from './blocks.ts';
import type { CompileInput } from './codegen.ts';

const emptyShape: BlockShape = { event: false, primitive: false, slots: [], statements: 0, defaults: new Map() };

export function blockCounts(input: CompileInput): Record<string, number> {
  const dynamic = new Map<string, BlockShape>();
  // Entry's schema registry also resolves Object.prototype names.
  const shapeOf = (type: string) => dynamic.get(type) ?? blockShape(type) ??
    (Object.hasOwn(Object.prototype, type) ? emptyShape : undefined);

  function children(block: RawBlock, shape: BlockShape): RawBlock[] {
    const result: RawBlock[] = [];
    for (const index of shape.slots) {
      const value = block.params?.[index];
      if (isBlock(value)) result.push(value);
      else if (value == null && shape.defaults.has(index)) {
        result.push({ id: '', type: shape.defaults.get(index)!, params: [] });
      }
    }
    for (let index = 0; index < shape.statements; index++) {
      for (const value of block.statements?.[index] ?? []) {
        if (isBlock(value)) result.push(value);
      }
    }
    return result;
  }

  function register(block: RawBlock): void {
    const shape = shapeOf(block.type);
    // Entry registers parameter types found in function code, including undeclared ones.
    if (block.type.includes('stringParam') || block.type.includes('booleanParam')) {
      dynamic.set(block.type, emptyShape);
    }
    if (shape) for (const child of children(block, shape)) register(child);
  }

  for (const fn of input.functions) {
    const content = parseScript(fn.content);
    for (const stack of content) for (const block of stack) if (isBlock(block)) register(block);
    const define = findFunctionDefine(content)?.[0];
    const slots = collectParams(define?.params?.[0]).map((_, index) => index);
    dynamic.set(`func_${fn.id}`, { ...emptyShape, slots });
  }

  function count(block: RawBlock): number {
    const shape = shapeOf(block.type);
    if (!shape || shape.primitive) return 0;
    return 1 + children(block, shape).reduce((total, child) => total + count(child), 0);
  }

  const counts: Record<string, number> = Object.create(null);
  counts.all = 0;
  for (const object of input.objects) {
    let total = 0;
    for (const stack of parseScript(object.script)) {
      if (stack[0] && shapeOf(stack[0].type)?.event) {
        for (const block of stack) if (isBlock(block)) total += count(block);
      }
    }
    counts[`object-${object.id}`] = total;
    const scene = `scene-${object.scene ?? input.scenes[0]?.id ?? ''}`;
    counts[scene] = (counts[scene] ?? 0) + total;
    counts.all += total;
  }
  return counts;
}
