import type { CallNode, FunctionDeclNode, Node } from '@entropy/parser';
import type { Context } from './context.ts';

interface FunctionCalls {
  node: FunctionDeclNode;
  edges: Map<string, CallNode[]>;
}

// Warn about source that is valid Entropy but unsafe or surprising in EntryJS itself.
export function diagnoseEntryRisks(ctx: Context): void {
  diagnoseRecursion(ctx);
  diagnoseInitialSceneEvents(ctx);
}

function diagnoseRecursion(ctx: Context): void {
  const names = new Set(ctx.functions.filter((fn) => !fn.generated).map((fn) => fn.name));
  const graph = new Map<string, FunctionCalls>();
  for (const fn of ctx.functions) {
    if (fn.generated || !fn.node) continue;
    const edges = new Map<string, CallNode[]>();
    visitCalls(fn.node.body, names, (call) => {
      const calls = edges.get(call.callee) ?? [];
      calls.push(call);
      edges.set(call.callee, calls);
    });
    graph.set(fn.name, { node: fn.node, edges });
  }

  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();

  const connect = (name: string): void => {
    indexes.set(name, nextIndex);
    lowLinks.set(name, nextIndex);
    nextIndex += 1;
    stack.push(name);
    active.add(name);

    for (const target of graph.get(name)?.edges.keys() ?? []) {
      if (!graph.has(target)) continue;
      if (!indexes.has(target)) {
        connect(target);
        lowLinks.set(name, Math.min(lowLinks.get(name)!, lowLinks.get(target)!));
      } else if (active.has(target)) {
        lowLinks.set(name, Math.min(lowLinks.get(name)!, indexes.get(target)!));
      }
    }

    if (lowLinks.get(name) !== indexes.get(name)) return;
    const component: string[] = [];
    while (stack.length) {
      const member = stack.pop()!;
      active.delete(member);
      component.push(member);
      if (member === name) break;
    }
    reportRecursiveComponent(component, graph, ctx);
  };

  for (const name of graph.keys()) if (!indexes.has(name)) connect(name);
}

function reportRecursiveComponent(
  component: string[], graph: Map<string, FunctionCalls>, ctx: Context,
): void {
  const members = new Set(component);
  const calls = component.flatMap((from) => [...(graph.get(from)?.edges ?? [])]
    .filter(([to]) => members.has(to))
    .flatMap(([to, nodes]) => nodes.map((node) => ({ from, to, node }))));
  const recursive = component.length > 1 || calls.some((call) => call.from === call.to);
  if (!recursive) return;

  const first = calls[0]?.node ?? graph.get(component[0]!)!.node;
  const names = component.length === 1
    ? `'${component[0]}' 함수`
    : `함수 순환(${component.slice().reverse().join(' → ')})`;
  ctx.warn(
    first,
    `${names}이(가) 재귀 호출됩니다. 깊이가 입력에 따라 커지면 Entry 원 실행기에서 작품 전체가 멈출 수 있습니다.`,
    {
      code: 'W0004',
      help: 'EntryJS 호출 오버헤드가 포함된 JavaScript 스택이라 약 1,500단계부터 실패 가능성이 매우 높습니다. 실제 한계는 브라우저·기기·환경마다 다릅니다. 선형 재귀는 반복문·작업 분할로 바꾸고, 같은 틱 처리가 꼭 필요하면 입력을 고정한 뒤 균형 재귀로 깊이를 줄이세요.',
      related: calls.slice(1, 8).map(({ from, to, node }) => (
        ctx.diagnostic(node, `'${from}' 에서 '${to}' 을(를) 호출해 재귀 순환으로 이어집니다.`)
      )),
    },
  );
}

function visitCalls(value: unknown, names: Set<string>, found: (call: CallNode) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => visitCalls(item, names, found));
    return;
  }
  const node = value as Node & Record<string, unknown>;
  if (node.type === 'Call' && names.has((node as unknown as CallNode).callee)) {
    found(node as unknown as CallNode);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== 'loc') visitCalls(child, names, found);
  }
}

function diagnoseInitialSceneEvents(ctx: Context): void {
  const firstScene = ctx.scenes[0];
  if (!firstScene) return;
  const handlers: Array<{ objectName: string; node: Node }> = [];
  for (const object of ctx.objects) {
    if (object.scene.id !== firstScene.id) continue;
    for (const member of object.node.body) {
      if (member.type !== 'Event' || member.event !== 'scene_start') continue;
      handlers.push({ objectName: object.name, node: member });
    }
  }
  const first = handlers[0];
  if (!first) return;
  ctx.warn(
    first.node,
    `첫 장면 '${firstScene.name}' 의 'when scene start' ${handlers.length}개는 Entry에서 작품을 처음 시작할 때 실행되지 않습니다.`,
    {
      code: 'W0005',
      help: "처음 실행할 코드라면 'when start do'를 쓰세요. 다른 장면에서 이 장면으로 전환할 때만 실행할 코드라면 그대로 두어도 됩니다.",
      related: handlers.slice(1, 8).map(({ objectName, node }) => (
        ctx.diagnostic(node, `'${objectName}' 오브젝트의 같은 첫 장면 이벤트입니다.`)
      )),
    },
  );
}
