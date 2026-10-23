import type { EntropyHandle } from '../../../vm/src/web/boot.ts';
import type { Entity, Target } from '../../../vm/src/runtime/model.ts';

const HOST = '.css-hxgsd9.e1edvhig3';
const ROW = 28;
const STYLE = `
.entropy-inspector { box-sizing:border-box; width:100%; min-width:0; margin:0 0 8px; border:1px solid #aaa; background:#fff; color:#222; color-scheme:light; font:12px/1.4 system-ui,sans-serif; text-align:left; }
.entropy-inspector[hidden] { display:none!important; }
.entropy-inspector .ti-head { position:sticky; top:0; z-index:1; display:flex; align-items:center; gap:6px; padding:4px 6px; border-bottom:1px solid #ccc; background:#eee; cursor:grab; user-select:none; touch-action:none; }
.entropy-inspector .ti-head strong { flex:1; font-weight:600; }
.entropy-inspector summary { cursor:pointer; padding:4px 6px; overflow-wrap:anywhere; }
.entropy-inspector .ti-body { padding:0 6px 6px; }
.entropy-inspector .ti-tools { display:flex; flex-wrap:wrap; gap:4px; align-items:center; padding:5px 0; border-bottom:1px solid #ddd; }
.entropy-inspector button { padding:2px 5px; border:1px solid #bbb; border-radius:0; background:transparent; color:inherit; font:inherit; cursor:pointer; }
.entropy-inspector button:hover, .entropy-inspector button[aria-pressed=true] { background:#e6e6e6; }
.entropy-inspector :focus-visible { outline:2px solid #b82168; outline-offset:1px; }
.entropy-inspector label { display:flex; align-items:center; gap:5px; cursor:pointer; }
.entropy-inspector input { margin:0; }
.entropy-inspector .ti-status { margin:4px 0; color:#666; font-variant-numeric:tabular-nums; }
.entropy-inspector .ti-tree { max-height:360px; overflow:auto; overscroll-behavior:contain; }
.entropy-inspector .ti-target { margin-left:12px; }
.entropy-inspector .ti-target > summary { display:flex; align-items:center; gap:4px; padding:0; }
.entropy-inspector .ti-target > summary::before { content:'▸'; width:12px; flex:none; }
.entropy-inspector .ti-target[open] > summary::before { content:'▾'; }
.entropy-inspector .ti-entity { flex:1; min-width:0; width:100%; height:28px; border:0; padding:2px 6px; text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; background:transparent; }
.entropy-inspector .ti-entity[aria-pressed=true] { background:#ddd; }
.entropy-inspector .ti-clones { position:relative; max-height:224px; overflow:auto; margin-left:18px; overscroll-behavior:contain; }
.entropy-inspector .ti-clone-space { position:relative; }
.entropy-inspector .ti-clone-space > button { position:absolute; left:0; }
.entropy-inspector .ti-info { margin:6px 0 0; padding:6px 0 0; border-top:1px solid #ddd; max-height:180px; overflow:auto; font:11px/1.5 ui-monospace,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
.entropy-inspector.ti-floating { position:absolute; right:8px; top:8px; z-index:20; width:min(320px,calc(100% - 16px)); margin:0; max-height:calc(100% - 16px); overflow:auto; }
.entropy-inspector.ti-detached { position:fixed; z-index:2147483646; width:min(320px,calc(100vw - 16px)); max-height:calc(100vh - 16px); }
.entropy-player.ti-picking canvas { cursor:crosshair!important; }
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
export function mountInspector(player: HTMLElement, live: EntropyHandle) {
  const { vm, renderer } = live;
  const panel = document.createElement('section');
  panel.hidden = true;
  panel.className = 'entropy-inspector';
  const style = document.createElement('style');
  style.textContent = STYLE;
  panel.appendChild(style);
  const title = document.createElement('header'); title.className = 'ti-head';
  const name = document.createElement('strong'); name.textContent = 'Entropy'; title.appendChild(name);
  panel.appendChild(title);
  const body = document.createElement('div'); body.className = 'ti-body'; panel.appendChild(body);
  const tools = document.createElement('div'); tools.className = 'ti-tools'; body.appendChild(tools);
  const button = (label: string, action: () => void) => {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = label;
    node.onclick = action; tools.appendChild(node); return node;
  };
  button('현재 상태', () => live.inspect());
  button('진단 파일', () => live.downloadDiagnostics());
  const pickButton = button('화면에서 선택', () => setPicking(!picking));
  pickButton.setAttribute('aria-pressed', 'false');
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
  let picking = false;
  let pickPress: number | null = null;
  let position: { left: number; top: number } | null = null;
  let drag: { id: number; x: number; y: number; left: number; top: number; moved: boolean } | null = null;

  const dock = document.createElement('button'); dock.type = 'button'; dock.textContent = '↩';
  dock.title = '원래 위치로'; dock.setAttribute('aria-label', dock.title);
  dock.onclick = () => { position = null; hostAt = -Infinity; syncHost(); };
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '×';
  close.title = '디버그 끄기'; close.setAttribute('aria-label', close.title);
  close.onclick = () => { panel.hidden = true; activity(); };
  title.append(dock, close);

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

  function setPicking(on: boolean) {
    picking = on;
    player.classList.toggle('ti-picking', on);
    pickButton.setAttribute('aria-pressed', String(on));
    hovered = null;
    highlight();
  }

  function reveal(entity: Entity) {
    selected = entity;
    const branch = branches.find(branch => branch.target === entity.target);
    if (!branch) return;
    (branch.root.parentElement as HTMLDetailsElement).open = true;
    if (entity.isClone) {
      branch.root.open = true;
      branch.clones.scrollTop = Math.max(0, entity.target.clones.indexOf(entity)) * ROW;
    }
    update();
    const row = entity.isClone ? branch.rows.find(row => entities.get(row) === entity) : branch.label;
    row?.scrollIntoView?.({ block: 'nearest' });
    row?.focus({ preventScroll: true });
  }

  const pick = (event: PointerEvent) => {
    if (!picking || !(event.target instanceof Element) || !event.target.closest('.entropy-stage canvas')) return;
    if (event.type === 'pointerdown' && event.button !== 0) return;
    const rect = renderer.canvasRect();
    if (!rect.width || !rect.height) return;
    const entity = vm.entityAtPoint(
      (event.clientX - rect.left) / rect.width * live.stage.worldWidth,
      (event.clientY - rect.top) / rect.height * live.stage.worldHeight,
    );
    event.preventDefault(); event.stopImmediatePropagation();
    hovered = entity; highlight();
    if (event.type === 'pointerdown') {
      pickPress = event.pointerId;
      if (entity) { setPicking(false); reveal(entity); }
    }
  };
  const releasePick = (event: PointerEvent) => {
    if (pickPress === null || pickPress !== event.pointerId) return;
    pickPress = null; event.preventDefault(); event.stopImmediatePropagation();
  };
  const cancelPick = (event: KeyboardEvent) => { if (event.key === 'Escape' && picking) setPicking(false); };
  player.addEventListener('pointermove', pick, true);
  player.addEventListener('pointerdown', pick, true);
  window.addEventListener('pointerup', releasePick, true);
  window.addEventListener('pointercancel', releasePick, true);
  document.addEventListener('keydown', cancelPick, true);

  function place(left: number, top: number) {
    const local = panel.parentElement === player;
    const rect = local ? player.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
    position = {
      left: Math.max(8, Math.min(left, rect.width - panel.offsetWidth - 8)),
      top: Math.max(8, Math.min(top, rect.height - panel.offsetHeight - 8)),
    };
    panel.style.left = `${position.left}px`; panel.style.top = `${position.top}px`; panel.style.right = 'auto';
  }
  const dragMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      position = { left: drag.left, top: drag.top };
      hostAt = -Infinity; syncHost();
    }
    place(drag.left + dx, drag.top + dy);
    event.preventDefault();
  };
  const endDrag = () => {
    drag = null;
    document.removeEventListener('pointermove', dragMove, true);
    document.removeEventListener('pointerup', endDrag, true);
    document.removeEventListener('pointercancel', endDrag, true);
  };
  const blur = () => { endDrag(); pickPress = null; setPicking(false); };
  window.addEventListener('blur', blur);
  title.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    setPicking(false);
    const rect = panel.getBoundingClientRect();
    const host = document.fullscreenElement?.contains(player) ? player.getBoundingClientRect() : { left: 0, top: 0 };
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY,
      left: rect.left - host.left, top: rect.top - host.top, moved: false };
    document.addEventListener('pointermove', dragMove, true);
    document.addEventListener('pointerup', endDrag, true);
    document.addEventListener('pointercancel', endDrag, true);
    event.preventDefault();
  });

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
    } else text(info, '화면에서 고르거나 트리에서 선택하세요.');
    highlight();
  }

  function activity() {
    const next = !panel.hidden && visible && !document.hidden && panel.isConnected;
    if (next === active) return;
    active = next;
    window.clearInterval(timer); timer = 0;
    if (active) { update(); timer = window.setInterval(update, 500); }
    else { endDrag(); setPicking(false); }
  }
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
    const host = fullscreen?.contains(player) ? player : position ? document.body : document.querySelector<HTMLElement>(HOST) ?? player;
    if (panel.parentElement !== host) host.prepend(panel);
    panel.classList.toggle('ti-floating', host === player || host === document.body);
    panel.classList.toggle('ti-detached', host === document.body);
    if (position && !panel.hidden) place(position.left, position.top);
    else if (!position) { panel.style.left = ''; panel.style.top = ''; panel.style.right = ''; }
    activity();
  }
  const fullscreen = () => { hostAt = -Infinity; syncHost(); };
  document.addEventListener('fullscreenchange', fullscreen);
  const resize = () => { if (position && !panel.hidden) place(position.left, position.top); };
  window.addEventListener('resize', resize);
  syncHost();
  return {
    syncHost,
    get enabled() { return !panel.hidden; },
    open() { panel.hidden = false; hostAt = -Infinity; syncHost(); panel.scrollIntoView?.({ block: 'nearest' }); activity(); },
    toggle() {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) { hostAt = -Infinity; syncHost(); }
      activity();
    },
    dispose() {
      if (disposed) return;
      disposed = true; active = false; window.clearInterval(timer);
      endDrag(); setPicking(false);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', activity);
      document.removeEventListener('fullscreenchange', fullscreen);
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', blur);
      player.removeEventListener('pointermove', pick, true);
      player.removeEventListener('pointerdown', pick, true);
      window.removeEventListener('pointerup', releasePick, true);
      window.removeEventListener('pointercancel', releasePick, true);
      document.removeEventListener('keydown', cancelPick, true);
      renderer.setInspection(null);
      if (vm.state !== 'run') renderer.flush();
      panel.remove();
    },
  };
}
