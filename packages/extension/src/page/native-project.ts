import type { EntryWork } from './entry-project.ts';
import { loadYield } from '../../../vm/src/web/load-yield.ts';

// Use Entry's own serializers, but let input/paint/cancellation run between
// objects and functions. Temporary replacements exist only during the final
// synchronous header export; no native methods stay patched across an await.
export async function exportNativeProject(entry: any, original: () => EntryWork | false,
  signal: AbortSignal, progress: (done: number, total: number) => void = () => {}): Promise<EntryWork | false> {
  signal.throwIfAborted();
  entry.getMainWS()?.syncCode?.();
  const container = entry.container, variables = entry.variableContainer;
  const objectsJSON = container?.toJSON, functionsJSON = variables?.getFunctionJSON;
  if (!Array.isArray(container?.objects_) || typeof objectsJSON !== 'function' ||
    !variables?.functions_ || typeof functionsJSON !== 'function') return original.call(entry);
  const objects = container.objects_.slice();
  const functions = Object.entries(variables.functions_);
  const objectValues: unknown[] = [], functionValues: unknown[] = [];
  const pause = loadYield();
  const total = objects.length + functions.length;
  let done = 0;
  for (const object of objects) {
    signal.throwIfAborted();
    const receiver = Object.create(container); receiver.objects_ = [object];
    const result = objectsJSON.call(receiver);
    if (!Array.isArray(result) || result.length !== 1) throw new Error('오브젝트 내보내기 형식이 변경되었습니다.');
    objectValues.push(result[0]); progress(++done, total);
    const pending = pause(); if (pending) await pending;
  }
  for (const [id, fn] of functions) {
    signal.throwIfAborted();
    const receiver = Object.create(variables); receiver.functions_ = Object.fromEntries([[id, fn]]);
    const result = functionsJSON.call(receiver);
    if (!Array.isArray(result) || result.length !== 1) throw new Error('함수 내보내기 형식이 변경되었습니다.');
    functionValues.push(result[0]); progress(++done, total);
    const pending = pause(); if (pending) await pending;
  }
  signal.throwIfAborted();
  if (container.toJSON !== objectsJSON || variables.getFunctionJSON !== functionsJSON) throw new Error('내보내기 도중 에디터 연결이 변경되었습니다.');
  const readObjects = () => objectValues, readFunctions = () => functionValues;
  try {
    if (!Reflect.set(container, 'toJSON', readObjects) || container.toJSON !== readObjects ||
      !Reflect.set(variables, 'getFunctionJSON', readFunctions) || variables.getFunctionJSON !== readFunctions) {
      throw new Error('이 에디터에서는 작업을 나눠 내보낼 수 없습니다.');
    }
    return original.call(entry);
  } finally {
    if (container.toJSON === readObjects) container.toJSON = objectsJSON;
    if (variables.getFunctionJSON === readFunctions) variables.getFunctionJSON = functionsJSON;
  }
}
