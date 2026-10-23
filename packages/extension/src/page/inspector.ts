import type { TessVmHandle } from '../../../tessvm/src/web/boot.ts';
import type { Entity, Target } from '../../../tessvm/src/runtime/model.ts';

const HOST = '.css-hxgsd9.e1edvhig3';
const ROW = 28;
const STYLE = `
.tessvm-inspector { box-sizing:border-box; width:100%; min-width:0; margin:12px 0; border:1px solid #cbd2dc; border-radius:8px; background:#fff; color:#20242b; color-scheme:light; font:13px/1.5 system-ui,sans-serif; text-align:left; }
.tessvm-inspector summary { cursor:pointer; padding:7px 10px; overflow-wrap:anywhere; }
.tessvm-inspector > summary { font-weight:650; }
.tessvm-inspector .ti-body { padding:0 10px 10px; }
.tessvm-inspector .ti-tools { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:6px 0; }
.tessvm-inspector button { padding:4px 7px; border:1px solid #cbd2dc; border-radius:4px; background:#fff; color:inherit; font:inherit; cursor:pointer; }
.tessvm-inspector button:hover { background:#fff0f7; }
.tessvm-inspector :focus-visible { outline:2px solid #b82168; outline-offset:1px; }
.tessvm-inspector label { display:flex; align-items:center; gap:5px; cursor:pointer; }
.tessvm-inspector input { margin:0; }
.tessvm-inspector .ti-status { margin:6px 0; color:#525b68; font-variant-numeric:tabular-nums; }
.tessvm-inspector .ti-tree { max-height:360px; overflow:auto; overscroll-behavior:contain; }
.tessvm-inspector .ti-target { margin-left:12px; }
.tessvm-inspector .ti-target > summary { display:flex; align-items:center; gap:4px; padding:0; }
.tessvm-inspector .ti-target > summary::before { content:'▸'; width:12px; flex:none; }
.tessvm-inspector .ti-target[open] > summary::before { content:'▾'; }
.tessvm-inspector .ti-entity { flex:1; min-width:0; width:100%; height:28px; border:0; padding:2px 6px; text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; background:transparent; }
.tessvm-inspector .ti-entity[aria-pressed=true] { background:#ffe1ef; color:#9f174e; }
.tessvm-inspector .ti-clones { position:relative; max-height:224px; overflow:auto; margin-left:18px; overscroll-behavior:contain; }
.tessvm-inspector .ti-clone-space { position:relative; }
.tessvm-inspector .ti-clone-space > button { position:absolute; left:0; }
.tessvm-inspector .ti-info { margin:8px 0 0; padding:8px; max-height:200px; overflow:auto; background:#f5f7fa; border-radius:4px; font:12px/1.6 ui-monospace,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
.tessvm-inspector.ti-floating { position:absolute; right:8px; top:8px; z-index:20; width:min(360px,calc(100% - 16px)); margin:0; max-height:calc(100% - 16px); overflow:auto; box-shadow:0 4px 18px #17233b22; }
`;

interface Branch {
  target: Target;
  root: HTMLDetailsElement;
  label: HTMLButtonElement;
  clones: HTMLDivElement;
  space: HTMLDivElement;
  rows: HTMLButtonElement[];
}

// Read runtime references only while visible; clone rows are recycled as the list scrolls.
export function mountInspector(player: HTMLElement, live: TessVmHandle) {
  const { vm, renderer } = live;
  const panel = document.createElement('details');
  panel.className = 'tessvm-inspector';
  const style = document.createElement('style');
  style.textContent = STYLE;
  panel.appendChild(style);
  const title = document.createElement('summary');
  title.textContent = 'TessVM 디버그';
  panel.appendChild(title);
  const body = document.createElement('div'); body.className = 'ti-body'; panel.appendChild(body);
  const tools = document.createElement('div'); tools.className = 'ti-tools'; body.appendChild(tools);
  const button = (label: string, action: () => void) => {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = label;
    node.onclick = action; tools.appendChild(node); return node;
  };
  button('현재 상태', () => live.inspect());
  button('진단 파일', () => live.downloadDiagnostics());
  const boundsLabel = document.createElement('label');
  const bounds = document.createElement('input'); bounds.type = 'checkbox';
  boundsLabel.append(bounds, '전체 경계'); tools.appendChild(boundsLabel);
  button('선택 해제', () => { selected = null; hovered = null; update(); });
  const status = document.createElement('p'); status.className = 'ti-status'; body.appendChild(status);
  const tree = document.createElement('div'); tree.className = 'ti-tree';
  tree.setAttribute('aria-label', '장면·오브젝트·클론'); body.appendChild(tree);
  const info = document.createElement('pre'); info.className = 'ti-info';
  info.setAttribute('aria-live', 'off'); body.appendChild(info);
  const branches: Branch[] = [];
  const entities = new WeakMap<HTMLButtonElement, Entity>();
  let selected: Entity | null = null;
  let hovered: Entity | null = null;
  let timer = 0;
  let visible = true;
  let disposed = false;
  let hostAt = -Infinity;
  let active = false;

  const text = (node: HTMLElement, value: string) => {
    if (node.textContent !== value) node.textContent = value;
  };
  const valid = (entity: Entity | null) => entity && !entity.removed
    && (entity.isClone ? entity.target.clones.includes(entity) : vm.targets.includes(entity.target)) ? entity : null;
  const entityButton = () => {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'ti-entity';
    node.onclick = () => { selected = entities.get(node) ?? null; update(); };
    return node;
  };
  const bind = (node: HTMLButtonElement, entity: Entity, label: string) => {
    entities.set(node, entity);
    text(node, label);
    node.title = `${entity.target.name} · ${entity.id}`;
    const pressed = String(entity === selected);
    if (node.getAttribute('aria-pressed') !== pressed) node.setAttribute('aria-pressed', pressed);
  };
  const drawClones = (branch: Branch) => {
    const clones = branch.target.clones;
    const total = clones.length;
    const height = Math.min(224, total * ROW);
    branch.clones.style.height = `${height}px`;
    branch.space.style.height = `${total * ROW}px`;
    const first = Math.max(0, Math.min(total - 1, Math.floor(branch.clones.scrollTop / ROW) - 2));
    const count = Math.min(Math.max(0, total - first), Math.ceil(height / ROW) + 4);
    while (branch.rows.length > count) branch.rows.pop()!.remove();
    while (branch.rows.length < count) {
      const row = entityButton(); branch.rows.push(row); branch.space.appendChild(row);
    }
    branch.rows.forEach((row, index) => {
      const at = first + index;
      const clone = clones[at];
      bind(row, clone, `클론 ${at + 1} · ${clone.id}${clone.visible ? '' : ' · 숨김'}`);
      row.style.top = `${at * ROW}px`;
    });
  };
  for (const scene of vm.scenes) {
    const group = document.createElement('details'); group.open = scene.id === vm.currentSceneId;
    const summary = document.createElement('summary'); text(summary, scene.name); group.appendChild(summary);
    tree.appendChild(group);
    group.addEventListener('toggle', () => { if (active) update(); });
    for (const target of vm.targets) {
      if (target.sceneId !== scene.id) continue;
      const root = document.createElement('details'); root.className = 'ti-target';
      const head = document.createElement('summary');
      const label = entityButton(); head.appendChild(label); root.appendChild(head);
      // Clicking the object selects it; the disclosure arrow expands its clone list.
      label.addEventListener('click', event => event.preventDefault());
      const clones = document.createElement('div'); clones.className = 'ti-clones';
      const space = document.createElement('div'); space.className = 'ti-clone-space';
      clones.appendChild(space); root.appendChild(clones); group.appendChild(root);
      const branch = { target, root, label, clones, space, rows: [] };
      branches.push(branch);
      clones.addEventListener('scroll', () => { if (active) drawClones(branch); }, { passive: true });
      root.addEventListener('toggle', () => { if (active) update(); });
    }
  }

  const highlight = () => {
    renderer.setInspection(active ? valid(hovered) ?? valid(selected) : null, active && bounds.checked);
    if (vm.state !== 'run') renderer.flush();
  };
  const entityAt = (target: EventTarget | null) => {
    const node = target instanceof Element ? target.closest<HTMLButtonElement>('.ti-entity') : null;
    return node ? entities.get(node) ?? null : null;
  };
  tree.addEventListener('pointerover', event => { hovered = entityAt(event.target); if (active) highlight(); });
  tree.addEventListener('pointerleave', () => { hovered = null; if (active) highlight(); });
  tree.addEventListener('focusin', event => { hovered = entityAt(event.target); if (active) highlight(); });
  tree.addEventListener('focusout', () => { hovered = null; if (active) highlight(); });
  bounds.onchange = highlight;

  function update() {
    if (!active) return;
    selected = valid(selected); hovered = valid(hovered);
    let cloneCount = 0;
    for (const branch of branches) {
      const target = branch.target;
      cloneCount += target.clones.length;
      if (!(branch.root.parentElement as HTMLDetailsElement).open) continue;
      bind(branch.label, target.entity, `${target.name} · ${target.clones.length} 클론${target.entity.visible ? '' : ' · 숨김'}`);
      if (branch.root.open) drawClones(branch);
      else if (branch.rows.length) {
        branch.rows.forEach(row => row.remove()); branch.rows.length = 0;
      }
    }
    const state = vm.state === 'run' ? '실행 중' : vm.state === 'pause' ? '일시정지' : '정지';
    text(status, `${state} · 오브젝트 ${vm.targets.length} · 클론 ${cloneCount} · ${vm.frame}틱`);
    const entity = selected;
    if (entity) {
      const threads = entity.target.threads.filter(thread => thread.entity === entity && !thread.done);
      const n = (value: number) => Number.isFinite(value) ? String(Math.round(value * 100) / 100) : String(value);
      text(info, `${entity.target.name}${entity.isClone ? ' (클론)' : ''}\n${entity.id}\n`
        + `X ${n(entity.x)}  Y ${n(entity.y)}  회전 ${n(entity.rotation)}°\n`
        + `크기 ${n(entity.width)} × ${n(entity.height)}  배율 ${n(entity.scaleX)} × ${n(entity.scaleY)}\n`
        + `${entity.visible ? '보임' : '숨김'} · 불투명도 ${n(entity.effect.alpha)} · 모양 ${entity.picture?.name ?? '없음'}\n`
        + `실행 스레드 ${threads.length}${threads.slice(0, 10).map(thread => `\n  ${thread.script.event} · 깊이 ${thread.depth}`).join('')}`);
    } else text(info, '대상을 가리키면 분홍색으로 표시합니다. 클릭하면 선택을 고정합니다.\n트리 0.5초 · 전체 경계 0.1초 간격으로 갱신합니다.');
    highlight();
  }

  function activity() {
    const next = panel.open && visible && !document.hidden && panel.isConnected;
    if (next === active) return;
    active = next;
    window.clearInterval(timer); timer = 0;
    if (active) { update(); timer = window.setInterval(update, 500); }
    else { hovered = null; highlight(); }
  }
  panel.addEventListener('toggle', activity);
  document.addEventListener('visibilitychange', activity);
  const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
    visible = entries[0]?.isIntersecting ?? false; activity();
  });
  observer?.observe(panel);

  function syncHost() {
    if (disposed) return;
    const now = performance.now();
    if (now - hostAt < 1000) return;
    hostAt = now;
    const fullscreen = document.fullscreenElement;
    const host = fullscreen?.contains(player) ? player : document.querySelector<HTMLElement>(HOST) ?? player;
    if (panel.parentElement !== host) host.appendChild(panel);
    panel.classList.toggle('ti-floating', host === player);
    activity();
  }
  const fullscreen = () => { hostAt = -Infinity; syncHost(); };
  document.addEventListener('fullscreenchange', fullscreen);
  syncHost();
  return {
    syncHost,
    open() { panel.open = true; panel.scrollIntoView?.({ block: 'nearest' }); activity(); },
    dispose() {
      if (disposed) return;
      disposed = true; active = false; window.clearInterval(timer);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', activity);
      document.removeEventListener('fullscreenchange', fullscreen);
      renderer.setInspection(null);
      if (vm.state !== 'run') renderer.flush();
      panel.remove();
    },
  };
}
