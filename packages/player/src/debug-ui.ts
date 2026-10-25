// @ts-ignore -- The browser resolves /preact; globals.d.ts supplies its types.
import { h, render } from "/preact/preact.mjs";

const TABS = [
  { id: "run", label: "실행" },
  { id: "data", label: "자료" },
  { id: "objects", label: "오브젝트" },
  { id: "errors", label: "오류" },
];
const STATE_TEXT: Record<string, string> = { run: "실행 중", pause: "일시정지됨", stop: "멈춰 있음" };
const RUN_TOGGLE_TEXT: Record<string, string> = {
  run: "일시정지", pause: "이어서 하기", stop: "시작하기",
};
const DEFAULT_SECTION_HEIGHT = 200;

// Snap small sections closed while leaving their handles available to reopen them.
const STICKY = 56;
const sticky = (size: number) => (size < STICKY ? 0 : size);

const panel = document.getElementById("debug-panel")!;

let scheduled = false;

// Use microtasks or timers because animation frames stop in hidden tabs.
function schedule() {
  if (scheduled) return;
  scheduled = true;
  const draw = () => {
    scheduled = false;
    render(h(Panel, null), panel);
  };
  if (typeof queueMicrotask === "function") queueMicrotask(draw);
  else setTimeout(draw, 0);
}

const proxies = new WeakMap();

function observable(target: any) {
  const cached = proxies.get(target);
  if (cached) return cached;
  const proxy = new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key);
      return value && typeof value === "object" ? observable(value) : value;
    },
    set(object, key, value) {
      if (Reflect.get(object, key) === value) return true;
      Reflect.set(object, key, value);
      schedule();
      return true;
    },
  });
  proxies.set(target, proxy);
  return proxy;
}

const state = observable({
  open: false,
  tab: "run",
  errors: [],
  runState: "",
  env: { boost: "", device: "", touch: "", userId: "", nickname: "" },
  // The actual renderer is fixed at startup; environment overrides cannot change it.
  realBoost: null as boolean | null,
  scenes: [],
  currentId: "",
  currentName: "",
  variables: [],
  messages: [],
  functions: [],
  expanded: "",
  editing: "",
  heights: {
    "run-control": DEFAULT_SECTION_HEIGHT,
    "data-vars": DEFAULT_SECTION_HEIGHT,
    "data-signals": DEFAULT_SECTION_HEIGHT,
    "objects-tree": DEFAULT_SECTION_HEIGHT,
    "objects-info": DEFAULT_SECTION_HEIGHT,
  },
  tick: 0,
  inspecting: false,
  pinned: false,
});

const touch = () => {
  state.tick += 1;
};

// Keep large block data outside reactive state.
let project: any = null;
const blockOwner = new Map<string, any>();
const blockById = new Map<string, any>();
const functionContentById = new Map<string, any>();
let currentThreads: any[] = [];
let highlighted: string[] = [];

const syncPanelWidth = () => {
  const width = state.open ? panel.getBoundingClientRect().width : 0;
  document.documentElement.style.setProperty(
    "--debug-panel-width",
    width + "px",
  );
  window.entropyLayoutCanvas();
};
const setOpen = (open: boolean, tab?: string) => {
  state.open = open;
  if (tab) state.tab = tab;
  panel.classList.toggle("open", open);
  panel.setAttribute("aria-hidden", open ? "false" : "true");
  syncPanelWidth();
};
const openPanel = (tab?: string) => {
  // Restore the width when reopening a snapped-shut panel.
  if (panel.style.width === "0px") panel.style.width = "";
  setOpen(true, tab);
};
const closePanel = () => setOpen(false);

// Look up the runtime adapter on each call so either engine can load later.
const engine = () => (window.Entry && Entry.engine) || null;

const entryRuntime = {
  state(): string {
    const e = engine();
    if (!e || typeof e.isState !== "function") return "";
    for (const s of ["run", "pause", "stop"]) {
      try {
        if (e.isState(s)) return s;
      } catch (error) {
      }
    }
    return "";
  },
  run() {
    const e = engine();
    if (!e) return;
    if (entryRuntime.state() === "pause") e.togglePause();
    else e.toggleRun();
  },
  pause() {
    engine()?.togglePause();
  },
  stop() {
    engine()?.toggleStop();
  },
  variable(id: string) {
    const box = (window.Entry && Entry.variableContainer) || null;
    return box && box.getVariable ? box.getVariable(id) : null;
  },
  list(id: string) {
    const box = (window.Entry && Entry.variableContainer) || null;
    return box && box.getList ? box.getList(id) : null;
  },
  sendSignal(id: string) {
    Entry.engine.fireEvent("when_message_cast", id);
  },
  object(objectId: string) {
    const object =
      window.Entry && Entry.container && Entry.container.getObject
        ? Entry.container.getObject(objectId)
        : null;
    return object && object.entity ? { object, entity: object.entity } : null;
  },
  // Entry cannot test arbitrary pixels; null lets picking fall back to bounds.
  hitTest(_entity: any, _x: number, _y: number): boolean | null {
    return null;
  },
  // Other scenes remain visible in memory, so filter picks to the current scene.
  currentObjects(): any[] {
    const container = window.Entry && Entry.container;
    if (!container) return [];
    try {
      const current = container.getCurrentObjects?.();
      if (Array.isArray(current)) return current;
    } catch (error) {
    }
    const all = Array.isArray(container.objects_) ? container.objects_ : [];
    const sceneId = window.Entry?.scene?.selectedScene?.id;
    if (!sceneId) return all;
    return all.filter(
      (object: any) => (object.scene?.id ?? object.scene) === sceneId,
    );
  },
  // Start or resume before firing the scene-start event; selecting a scene alone leaves it frozen.
  goToScene(sceneId: string) {
    const scene = Entry.scene.getSceneById(sceneId);
    const runner = engine();
    if (!scene) return;
    Entry.scene.selectScene(scene);
    if (!runner) return;
    // Entry drops events while stopped or paused, so run the engine first.
    if (entryRuntime.state() === "pause") runner.togglePause();
    else if (entryRuntime.state() !== "run") runner.toggleRun();
    runner.fireEvent("when_scene_start");
  },
  requestUpdate() {
    if (window.Entry) Entry.requestUpdate = true;
  },
  // Show renderer state only when boost actually selects a renderer.
  realBoost(): boolean | null {
    return Boolean(window.Entry && Entry.options && Entry.options.useWebGL);
  },
  // Wrap browser checks so they read the panel's current environment overrides.
  patchEnvironment(env: {
    boost: string;
    device: string;
    touch: string;
    userId: string;
    nickname: string;
  }) {
    const blocks = window.Entry && Entry.block;
    if (!blocks) return;
    const wrap = (type: string, forced: (args: any[]) => any) => {
      const spec = blocks[type];
      if (!spec || typeof spec.func !== "function" || spec.entropyWrapped) return;
      const original = spec.func;
      spec.func = function (this: any, ...args: any[]) {
        const value = forced(args);
        return value === null ? original.apply(this, args) : value;
      };
      spec.entropyWrapped = true;
    };
    wrap("is_boost_mode", () => choice(env.boost));
    wrap("is_touch_supported", () => choice(env.touch));
    wrap("is_current_device_type", (args) => {
      if (env.device === "") return null;
      try {
        return args[1].getField("DEVICE", args[1]) === env.device;
      } catch (e) {
        return null;
      }
    });
    // Override Entry's window.user only when the panel supplies a value.
    wrap("get_user_name", () => (env.userId === "" ? null : env.userId));
    wrap("get_nickname", () => (env.nickname === "" ? null : env.nickname));
  },
  // Use logical stage dimensions regardless of the displayed canvas size.
  stageSize() {
    return { width: 480, height: 270 };
  },
  stageCanvas: () => entryStageCanvas(),
  layoutCanvas: () => entryLayoutCanvas(),
  refreshRect: () => refreshBoundRect(),
};

export type DebugRuntime = typeof entryRuntime;

const rt = (): DebugRuntime => window.entropyRuntime ?? entryRuntime;

// Runtime errors must not take down the debug panel.
const guard = <T,>(what: string, fallback: T, action: () => T): T => {
  try {
    return action();
  } catch (error) {
    failed(what, error);
    return fallback;
  }
};

const engineState = () => {
  try {
    return rt().state();
  } catch (error) {
    return "";
  }
};

const failed = (what: string, error: any) => window.entropyReportError(what, error);

const control = (action: () => void) => {
  guard("실행 제어", undefined, action);
  state.runState = engineState();
  setTimeout(() => {
    state.runState = engineState();
  }, 60);
};
const doRun = () => control(() => rt().run());
const doPause = () => control(() => rt().pause());
const doStop = () => control(() => rt().stop());
const doRunToggle = () => (engineState() === "run" ? doPause() : doRun());

const choice = (value: any) => (value === "" ? null : value === "true");

const realBoostLabel = () => (state.realBoost ? "켜짐 (WebGL)" : "꺼짐 (2D)");

window.entropyPatchEnvironmentBlocks = function patchEnvironmentBlocks() {
  state.realBoost = guard("실행 환경 읽기", null, () => rt().realBoost());
  guard("실행 환경 흉내내기", undefined, () => rt().patchEnvironment(state.env));
};

const preview = (value: any) => {
  if (value === null || value === undefined) return "(없음)";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? text.slice(0, 80) + "…" : text;
};

const liveVariable = (id: string) => {
  try {
    return rt().variable(id);
  } catch (e) {
    return null;
  }
};
const liveList = (id: string) => {
  try {
    return rt().list(id);
  } catch (e) {
    return null;
  }
};

const listArray = (entry: any) => {
  const list = liveList(entry.id);
  try {
    if (list && typeof list.getArray === "function") return list.getArray();
  } catch (error) {
    // Show initial values when the runtime is unavailable.
  }
  return entry.array || [];
};

const rawValue = (entry: any) => {
  const variable = liveVariable(entry.id);
  try {
    if (variable && typeof variable.getValue === "function")
      return variable.getValue();
  } catch (error) {
  }
  return entry.value;
};

const liveValue = (entry: any) => {
  if (entry.variableType === "list") {
    const array = listArray(entry);
    return (
      "[" +
      array.length +
      "개] " +
      preview(array.map((item: any) => item && item.data))
    );
  }
  return preview(rawValue(entry));
};

// Parse numeric edits so Entry arithmetic receives numbers.
const coerce = (text: string) => {
  const trimmed = String(text).trim();
  if (trimmed === "" || !Number.isFinite(Number(trimmed))) return text;
  return Number(trimmed);
};

const setVariable = (id: string, text: string) => {
  try {
    const variable = liveVariable(id);
    if (variable && typeof variable.setValue === "function")
      variable.setValue(coerce(text));
  } catch (error) {
    failed("변수 값 바꾸기", error);
  }
  touch();
};

const setListItem = (id: string, index: number, text: string) => {
  try {
    const list = liveList(id);
    // Entry list APIs use one-based indices.
    if (list && typeof list.replaceValue === "function")
      list.replaceValue(index + 1, coerce(text));
  } catch (error) {
    failed("리스트 항목 바꾸기", error);
  }
  touch();
};

const addListItem = (id: string) => {
  try {
    const list = liveList(id);
    if (list && typeof list.appendValue === "function") list.appendValue("");
  } catch (error) {
    failed("리스트 항목 넣기", error);
  }
  touch();
};

const removeListItem = (id: string, index: number) => {
  try {
    const list = liveList(id);
    if (list && typeof list.deleteValue === "function")
      list.deleteValue(index + 1);
  } catch (error) {
    failed("리스트 항목 지우기", error);
  }
  touch();
};

const liveEntryOf = (entry: any) =>
  entry.variableType === "list" ? liveList(entry.id) : liveVariable(entry.id);

const entryVisible = (entry: any) => {
  const live = liveEntryOf(entry);
  try {
    if (live && typeof live.isVisible === "function") return live.isVisible();
  } catch (error) {
  }
  return Boolean(entry.visible);
};

const setEntryVisible = (entry: any, visible: boolean) => {
  const live = liveEntryOf(entry);
  try {
    if (live && typeof live.setVisible === "function")
      live.setVisible(Boolean(visible));
  } catch (error) {
    failed("변수 보이기 바꾸기", error);
  }
  touch();
};

const sendSignal = (id: string) => {
  guard("신호 보내기", undefined, () => rt().sendSignal(id));
};

const describeFunction = (fn: any) => {
  let name = fn.id;
  let params = 0;
  let kind = "일반 함수";
  try {
    const create = JSON.parse(fn.content || "[]")[0][0];
    if (create && create.type === "function_create_value") kind = "값 함수";
    let node = create && create.params && create.params[0];
    const labels = [];
    while (node && typeof node === "object") {
      if (node.type === "function_field_label")
        labels.push(String(node.params[0] ?? ""));
      else if (
        node.type === "function_field_string" ||
        node.type === "function_field_boolean"
      )
        params += 1;
      else break;
      node = node.params[1];
    }
    if (labels.length) name = labels.join(" … ");
  } catch (error) {
    // Fall back to the ID when the function header cannot be read.
  }
  return { id: fn.id, name, params, kind };
};

const liveEntity = (objectId: string) => {
  try {
    return rt().object(objectId);
  } catch (error) {
    return null;
  }
};

const round = (value: any) =>
  typeof value === "number" ? Math.round(value * 100) / 100 : value;
const call = (target: any, name: string, fallback: any) => {
  try {
    return target && typeof target[name] === "function"
      ? round(target[name]())
      : fallback;
  } catch (error) {
    return fallback;
  }
};

const setEntityNumber = (name: string) => (objectId: string, text: string) => {
  const live = liveEntity(objectId);
  const value = Number(String(text).trim());
  if (!live || !Number.isFinite(value)) {
    touch();
    return;
  }
  try {
    if (typeof live.entity[name] === "function") live.entity[name](value);
    rt().requestUpdate();
  } catch (error) {
    failed("오브젝트 값 바꾸기", error);
  }
  touch();
};

const ENTITY_FIELDS = [
  {
    key: "x",
    label: "x 좌표",
    get: (e: any) => call(e, "getX", 0),
    set: setEntityNumber("setX"),
  },
  {
    key: "y",
    label: "y 좌표",
    get: (e: any) => call(e, "getY", 0),
    set: setEntityNumber("setY"),
  },
  {
    key: "size",
    label: "크기",
    get: (e: any) => call(e, "getSize", 100),
    set: setEntityNumber("setSize"),
  },
  {
    key: "direction",
    label: "방향",
    get: (e: any) => call(e, "getRotation", 0),
    set: setEntityNumber("setRotation"),
  },
  {
    key: "way",
    label: "이동 방향",
    get: (e: any) => call(e, "getDirection", 90),
    set: setEntityNumber("setDirection"),
  },
  { key: "scaleX", label: "가로 배율", get: (e: any) => call(e, "getScaleX", 1) },
  { key: "scaleY", label: "세로 배율", get: (e: any) => call(e, "getScaleY", 1) },
];

const pictureInfo = (live: any) => {
  const pictures = (live.object && live.object.pictures) || [];
  const current = live.entity.picture;
  if (!current) return { name: "(없음)", index: "-" };
  const at = pictures.findIndex((picture: any) => picture.id === current.id);
  return {
    name: current.name || current.id,
    index: at < 0 ? "-" : String(at + 1) + " / " + pictures.length,
  };
};

const setPicture = (objectId: string, pictureId: any) => {
  const live = liveEntity(objectId);
  try {
    const picture =
      live && live.object.getPicture ? live.object.getPicture(pictureId) : null;
    if (picture) live!.entity.setImage(picture);
    rt().requestUpdate();
  } catch (error) {
    failed("모양 바꾸기", error);
  }
  touch();
};

const setRotateMethod = (objectId: string, method: any) => {
  const live = liveEntity(objectId);
  try {
    if (live && typeof live.object.setRotateMethod === "function")
      live.object.setRotateMethod(method);
    rt().requestUpdate();
  } catch (error) {
    failed("회전 방식 바꾸기", error);
  }
  touch();
};

const setEntityVisible = (objectId: string, visible: boolean) => {
  const live = liveEntity(objectId);
  try {
    if (live && typeof live.entity.setVisible === "function")
      live.entity.setVisible(Boolean(visible));
    rt().requestUpdate();
  } catch (error) {
    failed("보이기 바꾸기", error);
  }
  touch();
};

const setEntityText = (objectId: string, text: string) => {
  const live = liveEntity(objectId);
  try {
    if (live && typeof live.entity.setText === "function")
      live.entity.setText(String(text));
    rt().requestUpdate();
  } catch (error) {
    failed("글 내용 바꾸기", error);
  }
  touch();
};

const ROTATE_METHODS = [
  { value: "free", label: "자유 회전" },
  { value: "vertical", label: "좌우 회전" },
  { value: "none", label: "회전 안 함" },
];

const showObject = (object: any) => {
  state.currentId = object.id;
  state.currentName = object.name;
  try {
    currentThreads = JSON.parse(object.script);
  } catch (error) {
    currentThreads = [];
  }
  touch();
};

const goToScene = (sceneId: string) => {
  guard("장면 바로가기", undefined, () => rt().goToScene(sceneId));
  state.runState = engineState();
  touch();
};

const toggleExpanded = (key: string) => {
  state.expanded = state.expanded === key ? "" : key;
};

function editable(key: string, value: any, commit: any) {
  if (state.editing !== key) {
    const text = preview(value);
    return h(
      "button",
      {
        type: "button",
        title: "눌러서 고치기",
        class: "val debug-edit" + (text === "" ? " empty" : ""),
        onClick: () => {
          state.editing = key;
        },
        // Keep empty values clickable for editing.
      },
      text === "" ? "(빈 값)" : text,
    );
  }

  // Enter also triggers blur when the input disappears; commit only once.
  let settled = false;
  const done = (event: any) => {
    if (settled) return;
    settled = true;
    state.editing = "";
    commit(event.target.value);
  };
  return h("input", {
    class: "val debug-edit-input",
    type: "text",
    value: String(value ?? ""),
    ref: (node: any) => {
      if (!node || node.dataset.ready) return;
      node.dataset.ready = "1";
      node.value = String(value ?? "");
      node.focus();
      node.select();
    },
    onBlur: done,
    onKeyDown: (event: any) => {
      if (event.key === "Enter") done(event);
      if (event.key === "Escape") {
        settled = true;
        state.editing = "";
      }
    },
  });
}

function chooser(options: any, value: any, commit: any) {
  return h(
    "select",
    {
      class: "val debug-select",
      value: String(value),
      onChange: (event: any) => commit(event.target.value),
    },
    options.map((option: any) =>
      h(
        "option",
        {
          key: option.value,
          value: option.value,
          selected: option.value === String(value),
        },
        option.label,
      ),
    ),
  );
}

function toggle(on: boolean, commit: any, labels: any) {
  return h(
    "button",
    {
      type: "button",
      class: "val debug-toggle" + (on ? " on" : ""),
      onClick: () => commit(!on),
    },
    on ? labels[0] : labels[1],
  );
}

const blockLabel = (block: any) => {
  const params = (block.params || [])
    .filter((p: any) => p !== null && p !== undefined && typeof p !== "object")
    .map((p: any) => JSON.stringify(p));
  return block.type + (params.length ? " (" + params.join(", ") + ")" : "");
};

const blockClass = (block: any) => {
  const at = highlighted.indexOf(block.id);
  if (at === 0) return "block-highlight";
  return at > 0 ? "block-highlight-child" : "";
};

function blockNode(block: any) {
  return h(
    "li",
    { key: block.id, "data-block-id": block.id, class: blockClass(block) },
    [
      h("span", { class: "block-type" }, blockLabel(block)),
      ...(block.params || [])
        .filter((param: any) => param && typeof param === "object" && param.type)
        .map((param: any, i: number) =>
          h("ul", { key: "p" + i, class: "block-param" }, blockNode(param)),
        ),
      ...(block.statements || [])
        .filter((branch: any) => Array.isArray(branch) && branch.length > 0)
        .map((branch: any, i: number) =>
          h("ul", { key: "s" + i, class: "block-body" }, branch.map(blockNode)),
        ),
    ],
  );
}

const startVerticalResize = (event: any, id: string) => {
  const section = event.currentTarget.closest(".debug-section");
  const startY = event.clientY;
  const startHeight = section.getBoundingClientRect().height;
  event.preventDefault();
  document.body.style.userSelect = "none";

  const move = (e: any) => {
    state.heights[id] = sticky(startHeight + (e.clientY - startY));
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    document.body.style.userSelect = "";
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
};

function sections(list: any) {
  return list.map((section: any, index: number) => {
    const last = index === list.length - 1;
    const height = state.heights[section.id] ?? DEFAULT_SECTION_HEIGHT;
    let name = "debug-section";
    if (last) name += " debug-section-last";
    else if (height === 0) name += " collapsed";

    return h(
      "section",
      {
        key: section.id,
        class: name,
        style: last ? "" : "height:" + height + "px",
      },
      [
        h("h3", null, section.title),
        h("div", { class: "debug-section-body" }, section.body),
        last
          ? null
          : h("div", {
              class: "debug-vresize",
              title: "드래그해서 높이 조절 (끝까지 줄이면 접힙니다)",
              onMouseDown: (e: any) => startVerticalResize(e, section.id),
            }),
      ],
    );
  });
}

const empty = (text: string) => h("p", { class: "debug-empty" }, text);
const emptyRow = (text: string) =>
  h("li", { key: "empty", class: "debug-empty" }, text);

function RunTab() {
  const field = (id: string, label: string, value: any, options: any) =>
    h("div", { class: "debug-field" }, [
      h("label", { for: id }, label),
      h(
        "select",
        {
          id,
          value,
          onChange: (event: any) => {
            state.env[id.replace("env-", "")] = event.target.value;
            // Push environment changes into runtimes that do not read the shared object directly.
            window.entropyPatchEnvironmentBlocks();
          },
        },
        options.map(([v, text]: [string, string]) =>
          h("option", { key: v, value: v, selected: v === value }, text),
        ),
      ),
    ]);

  const textField = (id: string, label: string, value: string, placeholder: string) =>
    h("div", { class: "debug-field" }, [
      h("label", { for: id }, label),
      h("input", {
        id,
        type: "text",
        class: "debug-field-input",
        value,
        placeholder,
        onInput: (event: any) => {
          state.env[id.replace("env-", "")] = event.target.value;
          window.entropyPatchEnvironmentBlocks();
        },
      }),
    ]);

  return sections([
    {
      id: "run-control",
      title: "실행 제어",
      body: [
        h(
          "p",
          {
            class:
              "debug-run-state" +
              (state.runState ? " state-" + state.runState : ""),
          },
          [
            h("span", { class: "dot" }),
            STATE_TEXT[state.runState] || "실행기를 기다리는 중…",
          ],
        ),
        h("div", { class: "debug-run-buttons" }, [
          h(
            "button",
            {
              type: "button",
              id: "run-btn",
              onClick: doRunToggle,
              disabled: !state.runState,
            },
            RUN_TOGGLE_TEXT[state.runState] || RUN_TOGGLE_TEXT.stop,
          ),
          h(
            "button",
            {
              type: "button",
              id: "stop-btn",
              onClick: doStop,
              disabled: !state.runState || state.runState === "stop",
            },
            "정지하기",
          ),
        ]),
        h("p", { class: "debug-note" }, [
          "정지한 뒤에도 ",
          h("b", null, "시작하기"),
          " 로 처음부터 다시 실행할 수 있습니다.",
        ]),
        h(
          "p",
          {
            class:
              "debug-note debug-pick-hint" + (state.inspecting ? " active" : ""),
            id: "pick-hint",
          },
          state.inspecting
            ? state.pinned
              ? "골라 둔 오브젝트에 붙박여 있습니다. 실행 화면을 한 번 더 누르면 풀립니다."
              : "실행 화면에 마우스를 대면 그 오브젝트가 열립니다. 누르면 거기에 붙박습니다."
            : "패널 머리의 고르기 단추를 켜면, 실행 화면에서 마우스를 댄 오브젝트가 오브젝트 탭에 바로 열립니다.",
        ),
      ],
    },
    {
      id: "run-env",
      title: "실행 환경 흉내내기",
      body: [
        field("env-boost", "부스트 모드", state.env.boost, [
          ["", "실제 값 그대로"],
          ["true", "켜짐 (참)"],
          ["false", "꺼짐 (거짓)"],
        ]),
        // entropy always uses WebGL, so it has no boost renderer state to display.
        state.realBoost === null
          ? h(
              "p",
              { class: "debug-note" },
              "이 실행기는 부스트 모드와 상관없이 늘 WebGL 로 그립니다. 위에서 고른 값은" +
                " '부스트 모드인가?' 블록이 돌려주는 값만 바꿉니다.",
            )
          : h("p", { class: "debug-note" }, [
              "지금 실행기는 부스트 모드 " + realBoostLabel() + " 입니다 (",
              h("code", null, "run --boost"),
              " 로 정합니다). 위에서 고른 값은 '부스트 모드인가?' 블록이 돌려주는 값만 바꾸고," +
                " 실제로 쓰는 렌더러는 그대로입니다.",
            ]),
        field("env-device", "기기 종류", state.env.device, [
          ["", "실제 값 그대로"],
          ["desktop", "컴퓨터"],
          ["tablet", "태블릿"],
          ["mobile", "스마트폰"],
        ]),
        field("env-touch", "터치 지원", state.env.touch, [
          ["", "실제 값 그대로"],
          ["true", "지원함 (참)"],
          ["false", "지원 안 함 (거짓)"],
        ]),
        textField("env-userId", "아이디", state.env.userId, "실제 값 그대로"),
        textField("env-nickname", "닉네임", state.env.nickname, "실제 값 그대로"),
        h(
          "p",
          { class: "debug-note" },
          "'아이디'·'닉네임' 블록이 돌려주는 값입니다. 비워 두면 실행기가 들고 있는 값을" +
            " 그대로 쓰고, 로그인하지 않았으면 둘 다 공백 한 칸입니다.",
        ),
      ],
    },
  ]);
}

const visibleToggle = (entry: any) =>
  toggle(
    entryVisible(entry.source),
    (next: any) => setEntryVisible(entry.source, next),
    ["보임", "숨김"],
  );

const expandClass = (key: string) =>
  "key debug-expand" + (state.expanded === key ? " open" : "");

function variableRow(entry: any) {
  return h("li", { key: entry.id }, [
    h("span", { class: "key" }, entry.name),
    " ",
    h("span", { class: "tag" }, entry.scope + " · " + entry.kind),
    " ",
    editable("var:" + entry.id, rawValue(entry.source), (text: string) =>
      setVariable(entry.id, text),
    ),
    " ",
    visibleToggle(entry),
  ]);
}

function listRow(entry: any) {
  const key = "list:" + entry.id;
  return h("li", { key: entry.id, class: "debug-list-head" }, [
    h(
      "button",
      {
        type: "button",
        class: expandClass(key),
        onClick: () => toggleExpanded(key),
      },
      entry.name,
    ),
    " ",
    h("span", { class: "tag" }, entry.scope + " · " + entry.kind),
    " ",
    h("span", { class: "val" }, liveValue(entry.source)),
    " ",
    visibleToggle(entry),
  ]);
}

function listItemsRow(entry: any) {
  const key = "list:" + entry.id;
  const array = listArray(entry.source);
  return h(
    "li",
    { key: entry.id + ":items", class: "debug-items-row" },
    h("div", { class: "debug-list-items" }, [
      h(
        "button",
        {
          type: "button",
          class: "debug-mini-btn debug-add-btn",
          onClick: () => addListItem(entry.id),
        },
        "항목 추가",
      ),
      array.length === 0
        ? h("p", { class: "debug-empty" }, "비어 있습니다.")
        : h(
            "ol",
            { class: "debug-list-ol" },
            array.map((_item: any, index: number) =>
              h("li", { key: index }, [
                h("span", { class: "debug-list-index" }, index + 1),
                editable(key + ":" + index, (array[index] || {}).data, (text: string) =>
                  setListItem(entry.id, index, text),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "debug-mini-btn",
                    title: "이 항목 지우기",
                    onClick: () => removeListItem(entry.id, index),
                  },
                  "−",
                ),
              ]),
            ),
          ),
    ]),
  );
}

function functionRow(fn: any) {
  const key = "func:" + fn.id;
  return h("li", { key: fn.id, class: "debug-list-head" }, [
    h(
      "button",
      {
        type: "button",
        class: expandClass(key),
        onClick: () => toggleExpanded(key),
      },
      fn.name,
    ),
    " ",
    h("span", { class: "tag" }, fn.params + "개 인자"),
    " ",
    h("span", { class: "val" }, fn.kind),
  ]);
}

function functionCodeRow(fn: any) {
  const content = functionContentById.get(fn.id);
  return h(
    "li",
    { key: fn.id + ":code", class: "debug-items-row" },
    h(
      "div",
      { class: "debug-list-items debug-func-code" },
      !content || content.length === 0
        ? h("p", { class: "debug-empty" }, "블록을 읽지 못했습니다.")
        : h("ul", null, content.map(blockNode)),
    ),
  );
}

function DataTab() {
  const varRows = [];
  if (state.variables.length === 0)
    varRows.push(emptyRow("변수나 리스트가 없습니다."));
  else {
    for (const entry of state.variables) {
      if (entry.source.variableType !== "list") {
        varRows.push(variableRow(entry));
        continue;
      }
      varRows.push(listRow(entry));
      if (state.expanded === "list:" + entry.id)
        varRows.push(listItemsRow(entry));
    }
  }

  const fnRows = [];
  if (state.functions.length === 0) fnRows.push(emptyRow("함수가 없습니다."));
  else {
    for (const fn of state.functions) {
      fnRows.push(functionRow(fn));
      if (state.expanded === "func:" + fn.id) fnRows.push(functionCodeRow(fn));
    }
  }

  return sections([
    {
      id: "data-vars",
      title: "변수 · 리스트",
      body: h(
        "div",
        { id: "var-list" },
        h("ul", { class: "debug-rows" }, varRows),
      ),
    },
    {
      id: "data-signals",
      title: "신호",
      body: h(
        "div",
        { id: "signal-list" },
        state.messages.length === 0
          ? empty("신호가 없습니다.")
          : h(
              "ul",
              { class: "debug-rows" },
              state.messages.map((message: any) =>
                h("li", { key: message.id }, [
                  h("span", { class: "key" }, message.name),
                  h(
                    "button",
                    {
                      type: "button",
                      class: "debug-send-btn",
                      onClick: () => sendSignal(message.id),
                    },
                    "보내기",
                  ),
                ]),
              ),
            ),
      ),
    },
    {
      id: "data-functions",
      title: "함수",
      body: h(
        "div",
        { id: "function-list" },
        h("ul", { class: "debug-rows" }, fnRows),
      ),
    },
  ]);
}

const currentLive = () =>
  state.currentId ? liveEntity(state.currentId) : null;

function objectInfoRows() {
  const live = currentLive();
  const infoRow = (label: string, body: any) =>
    h("li", { key: label }, [h("span", { class: "key" }, label), " ", body]);

  if (!live) {
    return [
      infoRow(
        "",
        h(
          "span",
          { class: "debug-empty" },
          state.currentId
            ? "실행기가 이 오브젝트를 아직 만들지 않았습니다. 한 번 실행해 보세요."
            : "위 목록에서 오브젝트를 고르세요.",
        ),
      ),
    ];
  }

  // Check object type because some runtimes give sprites an empty text field too.
  const isText = live.object && live.object.objectType
    ? live.object.objectType === "textBox"
    : live.entity.text !== undefined;
  const rows = [];
  for (const field of ENTITY_FIELDS) {
    const value = field.get(live.entity);
    rows.push(
      infoRow(
        field.label,
        field.set
          ? editable("entity:" + field.key, value, (text: string) =>
              field.set(state.currentId, text),
            )
          : h("span", { class: "val" }, String(value)),
      ),
    );
  }

  if (!isText) {
    const pictures = ((live.object && live.object.pictures) || []).map((p: any) => ({
      value: p.id,
      label: p.name || p.id,
    }));
    rows.push(
      infoRow(
        "모양",
        chooser(
          pictures,
          live.entity.picture ? live.entity.picture.id : "",
          (id: string) => setPicture(state.currentId, id),
        ),
      ),
    );
    rows.push(
      infoRow(
        "모양 번호",
        h("span", { class: "val" }, pictureInfo(live).index),
      ),
    );
  }

  rows.push(
    infoRow(
      "보이기",
      toggle(
        call(live.entity, "getVisible", true),
        (next: any) => setEntityVisible(state.currentId, next),
        ["보임", "숨김"],
      ),
    ),
  );

  if (!isText) {
    rows.push(
      infoRow(
        "회전 방식",
        chooser(
          ROTATE_METHODS,
          (live.object && live.object.rotateMethod) || "free",
          (method: any) => setRotateMethod(state.currentId, method),
        ),
      ),
    );
  } else {
    rows.push(
      infoRow(
        "글 내용",
        editable("entity:text", live.entity.text, (text: string) =>
          setEntityText(state.currentId, text),
        ),
      ),
    );
  }
  return rows;
}

function ObjectsTab() {
  const suffix = state.currentName ? "— " + state.currentName : "";
  return sections([
    {
      id: "objects-tree",
      title: "장면 · 오브젝트",
      body: h(
        "div",
        { id: "scene-tree" },
        state.scenes.length === 0
          ? empty("불러오는 중…")
          : state.scenes.map((scene: any) =>
              h("div", { key: scene.id }, [
                h("div", { class: "debug-scene-title" }, [
                  h("span", null, scene.name),
                  h(
                    "button",
                    {
                      type: "button",
                      class: "debug-mini-btn debug-scene-go",
                      "data-scene-id": scene.id,
                      title: "이 장면으로 넘어가서 바로 실행하기",
                      onClick: () => goToScene(scene.id),
                    },
                    "바로가기",
                  ),
                ]),
                h(
                  "ul",
                  { class: "debug-object-list" },
                  scene.objects.length === 0
                    ? h("li", { class: "debug-empty" }, "(오브젝트 없음)")
                    : scene.objects.map((object: any) =>
                        h(
                          "li",
                          { key: object.id },
                          h(
                            "button",
                            {
                              type: "button",
                              class:
                                "debug-object-btn" +
                                (state.currentId === object.id
                                  ? " active"
                                  : ""),
                              "data-object-id": object.id,
                              onClick: () => showObject(object),
                            },
                            object.name,
                          ),
                        ),
                      ),
                ),
              ]),
            ),
      ),
    },
    {
      id: "objects-info",
      title: ["오브젝트 정보 ", h("span", { id: "object-info-name" }, suffix)],
      body: h(
        "div",
        { id: "object-info" },
        h("ul", { class: "debug-rows" }, objectInfoRows()),
      ),
    },
    {
      id: "objects-blocks",
      title: ["컴파일된 블록 ", h("span", { id: "block-object-name" }, suffix)],
      body: h("div", { id: "block-tree" }, blockTree()),
    },
  ]);
}

function blockTree() {
  if (!state.currentId) return empty("위 목록에서 오브젝트를 고르세요.");
  if (currentThreads.length === 0)
    return empty("이 오브젝트에는 블록이 없습니다.");
  return currentThreads.map((thread, index) =>
    h("div", { key: index, class: "debug-thread" }, [
      h("div", { class: "debug-thread-label" }, "스크립트 " + (index + 1)),
      h("ul", null, thread.map(blockNode)),
    ]),
  );
}

function ErrorsTab() {
  return sections([
    {
      id: "errors-log",
      title: "오류 로그",
      body: h(
        "div",
        { id: "error-log" },
        state.errors.length === 0
          ? empty(
              "아직 오류가 없습니다. entryjs 가 실행 중 panic 을 내면 여기와 이 서버를 띄운 터미널에 같이 찍힙니다.",
            )
          : state.errors.map((error: any, index: number) =>
              h(
                "details",
                {
                  key: error.key,
                  class: "error-item",
                  open: index < 3,
                },
                [
                  h(
                    "summary",
                    null,
                    "[" + error.at + "] " + error.kind + ": " + error.message,
                  ),
                  error.stack ? h("pre", null, error.stack) : null,
                ],
              ),
            ),
      ),
    },
  ]);
}

const TAB_BODY: Record<string, () => any> = {
  run: RunTab,
  data: DataTab,
  objects: ObjectsTab,
  errors: ErrorsTab,
};

const startHorizontalResize = (event: any) => {
  event.preventDefault();
  document.body.style.userSelect = "none";
  const move = (e: any) => {
    const max = Math.max(STICKY, window.innerWidth - 240);
    const width = sticky(Math.min(window.innerWidth - e.clientX, max));
    panel.style.width = width + "px";
    panel.classList.toggle("collapsed", width === 0);
    syncPanelWidth();
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    document.body.style.userSelect = "";
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
};

function Panel() {
  return [
    h("div", {
      id: "debug-resize-handle",
      title: "드래그해서 크기 조절 (끝까지 줄이면 접힙니다)",
      onMouseDown: startHorizontalResize,
    }),
    h("div", { class: "debug-header" }, [
      h("h2", null, "디버그"),
      h(
        "button",
        {
          id: "inspect-btn",
          type: "button",
          class: "debug-inspect" + (state.inspecting ? " active" : ""),
          "aria-pressed": state.inspecting ? "true" : "false",
          "aria-label": "무대에서 오브젝트 고르기",
          title:
            "무대에서 오브젝트 고르기 — 마우스를 댄 것이 열리고, 누르면 거기에 붙박습니다",
          onClick: toggleInspect,
        },
        inspectIcon(),
      ),
      h(
        "button",
        {
          id: "debug-close",
          type: "button",
          "aria-label": "닫기",
          onClick: closePanel,
        },
        "×",
      ),
    ]),
    h(
      "div",
      { class: "debug-tabs", role: "tablist" },
      TABS.map((tab) =>
        h(
          "button",
          {
            key: tab.id,
            type: "button",
            role: "tab",
            class: "debug-tab",
            "data-tab": tab.id,
            "aria-controls": "tab-" + tab.id,
            "aria-selected": state.tab === tab.id ? "true" : "false",
            onClick: () => {
              state.tab = tab.id;
            },
          },
          [
            tab.label,
            tab.id === "errors"
              ? h(
                  "span",
                  {
                    id: "error-count",
                    class: "badge",
                    hidden: state.errors.length === 0,
                  },
                  state.errors.length,
                )
              : null,
          ],
        ),
      ),
    ),
    // Skip hidden tabs because a block tree can contain tens of thousands of nodes.
    ...TABS.map((tab) =>
      h(
        "div",
        {
          key: tab.id,
          class: "debug-panelbody",
          id: "tab-" + tab.id,
          role: "tabpanel",
          hidden: state.tab !== tab.id,
        },
        state.tab === tab.id ? h(TAB_BODY[tab.id], null) : null,
      ),
    ),
  ];
}

render(h(Panel, null), panel);

const toggleBtn = document.getElementById("debug-toggle")!;
const badge = document.getElementById("debug-badge")!;
toggleBtn.addEventListener("click", () =>
  state.open ? closePanel() : openPanel(),
);

window.entropyDebugSink((item) => {
  state.errors.unshift({
    key: item.time + "-" + state.errors.length,
    at: new Date(item.time).toLocaleTimeString("ko-KR", { hour12: false }),
    kind: item.kind,
    message: item.message,
    stack: item.stack,
  });
  badge.hidden = false;
  badge.textContent = String(state.errors.length);
  if (state.errors.length === 1) openPanel("errors");
});

const indexBlocks = (node: any, object: any) => {
  if (Array.isArray(node)) {
    for (const item of node) indexBlocks(item, object);
    return;
  }
  if (!node || typeof node !== "object" || !node.id) return;
  blockOwner.set(node.id, object);
  blockById.set(node.id, node);
  for (const param of node.params || []) indexBlocks(param, object);
  for (const branch of node.statements || []) indexBlocks(branch, object);
};

window.entropyRenderProjectDebug = function renderProjectDebug(loaded) {
  project = loaded;
  const nameById = new Map(
    project.objects.map((object: any) => [object.id, object.name]),
  );

  state.scenes = project.scenes.map((scene: any) => ({
    id: scene.id,
    name: scene.name,
    objects: project.objects
      .filter((object: any) => object.scene === scene.id)
      .map((object: any) => ({
        id: object.id,
        name: object.name,
        script: object.script,
      })),
  }));

  state.variables = (project.variables || [])
    .filter(
      (entry: any) =>
        entry.variableType !== "timer" && entry.variableType !== "answer",
    )
    .map((entry: any) => ({
      id: entry.id,
      name: entry.name,
      scope: entry.object ? nameById.get(entry.object) || "오브젝트" : "전역",
      kind: entry.variableType === "list" ? "리스트" : "변수",
      source: entry,
    }));
  state.messages = (project.messages || []).map((message: any) => ({
    id: message.id,
    name: message.name,
  }));
  state.functions = (project.functions || []).map(describeFunction);

  // Render function blocks only when expanded and keep their data outside reactive state.
  functionContentById.clear();
  for (const fn of project.functions || []) {
    try {
      // Accept both inline function bodies and bodies nested inside the definition block.
      const stack = JSON.parse(fn.content || "[]")[0] || [];
      const create = stack[0];
      const nested = create && create.statements && create.statements[0];
      functionContentById.set(
        fn.id,
        (nested && nested.length ? nested : stack.slice(1)) || [],
      );
      indexBlocks(stack, { id: "func:" + fn.id, name: fn.id });
    } catch (error) {
      // Keep the function visible even when its blocks cannot be read.
    }
  }

  for (const object of project.objects) {
    try {
      indexBlocks(JSON.parse(object.script), object);
    } catch (e) {
    }
  }
  if (project.objects.length > 0) showObject(project.objects[0]);
};

// Include nested value IDs because the failing block may be inside an input.
window.entropyCollectParamIds = function collectParamIds(node, out) {
  out = out || [];
  if (!node || typeof node !== "object" || !node.id) return out;
  out.push(node.id);
  for (const param of node.params || []) {
    if (param && typeof param === "object" && param.type)
      collectParamIds(param, out);
  }
  return out;
};

window.entropyBlockDataById = blockById;

window.entropyHighlightBlock = function highlightBlock(blockId) {
  const owner = blockOwner.get(blockId);
  if (!owner) return;
  if (state.currentId !== owner.id) showObject(owner);
  highlighted = window.entropyCollectParamIds(blockById.get(blockId), []);
  touch();
  openPanel("objects");
  requestAnimationFrame(() => {
    const target = panel.querySelector('[data-block-id="' + blockId + '"]');
    if (target && target.scrollIntoView)
      target.scrollIntoView({ block: "center" });
  });
};

const selectObjectById = (objectId: string) => {
  const found =
    (project &&
      project.objects &&
      project.objects.find((o: any) => o.id === objectId)) ||
    blockOwner.get(objectId);
  if (!found || !found.script) return;
  showObject(found);
  openPanel("objects");
  // Scroll the selected row into view for long object lists.
  requestAnimationFrame(() => {
    const row = panel.querySelector('[data-object-id="' + objectId + '"]');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  });
};

window.entropySelectObjectById = selectObjectById;

function inspectIcon() {
  return h(
    "svg",
    { width: "15", height: "15", viewBox: "0 0 16 16", "aria-hidden": "true" },
    [
      h("path", {
        key: "frame",
        d: "M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "1.4",
        "stroke-linecap": "round",
      }),
      h("path", {
        key: "arrow",
        d: "M7 6.4l5.6 3.2-2.4.6 1.5 2.7-1.3.8-1.5-2.7-1.6 1.9z",
        fill: "currentColor",
      }),
    ],
  );
}

// Clear pinned selection when disabling the picker so re-enabling follows the pointer.
function toggleInspect() {
  state.inspecting = !state.inspecting;
  state.pinned = false;
  showInspectCursor();
}

function showInspectCursor() {
  const canvas = stageCanvas();
  const host = canvas?.parentElement ?? canvas;
  if (host && host.classList) {
    host.classList.toggle("debug-inspecting", state.inspecting);
  }
}

// Select Entry's named stage canvas; PIXI may create zero-sized helper canvases first.
function entryStageCanvas() {
  const named = document.getElementById("entryCanvas");
  if (named) return named;

  // If the canvas name changes, use the largest visible canvas.
  let best = null;
  let bestArea = 0;
  for (const canvas of document.querySelectorAll("#workspace canvas")) {
    const rect = canvas.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = canvas;
      bestArea = area;
    }
  }
  return best;
}

function stageCanvas() {
  try {
    return rt().stageCanvas();
  } catch (error) {
    return null;
  }
}

// Convert to runtime stage coordinates with the origin centered and y increasing upward.
function toStagePoint(clientX: number, clientY: number) {
  const canvas = stageCanvas();
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const size = rt().stageSize();
  return {
    x: ((clientX - rect.left) / rect.width) * size.width - size.width / 2,
    y: size.height / 2 - ((clientY - rect.top) / rect.height) * size.height,
  };
}

// Test canvas bounds because Entry's stopped-work cover sits outside the workspace element.
function insideStage(event: any) {
  const canvas = stageCanvas();
  if (!canvas) {
    // Fall back to stage bounds when there is no canvas.
    const stage = document.getElementById("workspace");
    return Boolean(stage && stage.contains(event.target));
  }
  const rect = canvas.getBoundingClientRect();
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
}

// Pick directly from bounds because the stopped cover and renderers can intercept clicks.
function stageObjects() {
  try {
    return rt().currentObjects();
  } catch (error) {
    return [];
  }
}

// Keep picking with bounds if the runtime cannot provide a pixel hit test.
function pixelHit(entity: any, x: number, y: number): boolean | null {
  try {
    return rt().hitTest(entity, x, y) ?? null;
  } catch (error) {
    return null;
  }
}

function objectAtPoint(clientX: number, clientY: number) {
  const point = toStagePoint(clientX, clientY);
  const objects = stageObjects();
  if (!point) return null;

  for (const object of objects) {
    const entity = object && object.entity;
    if (!entity) continue;
    try {
      if (typeof entity.getVisible === "function" && !entity.getVisible())
        continue;
      // Skip transparent objects so invisible overlays cannot hide visible picks.
      if (entity.effect && entity.effect.alpha === 0) continue;
      // Use pixel tests when available so empty texture areas do not hide objects below.
      const exact = pixelHit(entity, point.x, point.y);
      if (exact !== null) {
        if (exact) return object;
        continue;
      }
      const halfWidth =
        Math.abs(entity.getWidth() * (entity.getScaleX() ?? 1)) / 2;
      const halfHeight =
        Math.abs(entity.getHeight() * (entity.getScaleY() ?? 1)) / 2;
      if (
        Math.abs(point.x - entity.getX()) <= halfWidth &&
        Math.abs(point.y - entity.getY()) <= halfHeight
      )
        return object;
    } catch (error) {
    }
  }
  return null;
}

// Install stage-pick listeners only once.
let stagePicksArmed = false;

window.entropyWatchStagePicks = function watchStagePicks() {
  if (stagePicksArmed) return;
  stagePicksArmed = true;

  // Check the tool's current state for each event so stale selection cannot intercept input.
  const ours = (event: any) => state.inspecting && insideStage(event);

  // Avoid rerendering while the pointer stays on the same object.
  let shownId: string | null = null;

  const track = (clientX: number, clientY: number) => {
    const object = objectAtPoint(clientX, clientY);
    const id = object && object.id ? String(object.id) : null;
    if (id === shownId) return;
    shownId = id;
    if (id) selectObjectById(id);
  };

  const onMove = (event: any) => {
    if (!ours(event) || state.pinned) return;
    track(event.clientX, event.clientY);
  };

  // Picker clicks pin selection and must not run object-click scripts.
  const onDown = (event: any) => {
    if (!ours(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (state.pinned) {
      state.pinned = false;
      shownId = null;
      track(event.clientX, event.clientY);
      return;
    }
    track(event.clientX, event.clientY);
    state.pinned = shownId !== null;
  };

  // Also swallow the following click so Entry's stopped-work cover cannot start the work.
  const swallow = (event: any) => {
    if (!ours(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  // Keep selection when leaving the stage so it can be inspected in the panel.
  document.addEventListener("pointermove", onMove, true);
  document.addEventListener("mousemove", onMove, true);
  // Listen for both mousedown from CreateJS and pointerdown from PIXI.
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("mouseup", swallow, true);
  document.addEventListener("pointerup", swallow, true);
  document.addEventListener("click", swallow, true);
  document.addEventListener("keydown", (event: any) => {
    if (event.key === "Escape" && state.inspecting) toggleInspect();
  });
};

// Add the list name and length to Entry's generic index error.
window.entropyDescribeListIndexError = function describeListIndexError(
  reportedBlockId,
  err,
) {
  if (!err || err.message !== "can not insert value to array") return null;
  const find = (node: any): any => {
    if (!node || typeof node !== "object") return null;
    if (node.type === "value_of_index_from_list") return node;
    for (const param of node.params || []) {
      const found = find(param);
      if (found) return found;
    }
    return null;
  };
  const culprit = find(blockById.get(reportedBlockId));
  if (!culprit) return null;
  try {
    const listId = culprit.params && culprit.params[1];
    const indexParam = culprit.params && culprit.params[3];
    const indexText =
      indexParam &&
      typeof indexParam === "object" &&
      indexParam.type === "number" &&
      Array.isArray(indexParam.params)
        ? indexParam.params[0]
        : null;

    let listName = listId;
    let count = null;
    const list = listId ? liveList(listId) : null;
    if (list) {
      if (typeof list.getName === "function") listName = list.getName();
      if (typeof list.getArray === "function") count = list.getArray().length;
    }

    let message = "'" + (listName || "리스트") + "' 리스트에서 ";
    message += indexText !== null ? indexText + "번째" : "요청한";
    message += " 항목을 찾지 못했습니다";
    message += count === null ? "." : " (지금 " + count + "개 들어 있습니다).";
    return message;
  } catch (e) {
    return "리스트에서 요청한 위치의 항목을 찾지 못했습니다 (범위를 벗어났습니다).";
  }
};

let resolutionFixed = false;

// Entry's hardcoded pixel offsets assume this buffer size.
const ENTRY_BUFFER_WIDTH = 640;
const ENTRY_BUFFER_HEIGHT = 360;

const wantedBufferWidth = () => {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const wanted =
    Math.max(window.screen?.width || window.innerWidth, window.innerWidth) *
    dpr;
  return Math.round(Math.min(Math.max(wanted, 960), 1920));
};

// Scale ask input lengths together to keep drawing and hit tests aligned with Entry coordinates.
const scaleInputFieldToBuffer = (bufferW: any) => {
  const stage = window.Entry && Entry.stage;
  const ratio = bufferW / ENTRY_BUFFER_WIDTH;
  if (!stage || typeof stage.showInputField !== "function" || ratio === 1)
    return;
  const showInputField = stage.showInputField;
  stage.showInputField = function entropyShowInputField(this: any, ...args: any[]) {
    showInputField.apply(this, args);
    const field = this.inputField;
    if (!field || field.entropyScaled || typeof field.width !== "function") return;
    field.entropyScaled = true;
    // Set dimensions before positions because the last setter redraws; setters cannot be chained.
    for (const name of [
      "fontSize",
      "borderWidth",
      "borderRadius",
      "padding",
      "width",
      "height",
      "x",
      "y",
    ]) {
      field[name](field[name]() * ratio);
    }
    Entry.requestUpdateTwice = true;
  };
};

// Set buffer resolution once because changing it clears the canvas and causes flicker.
const setCanvasResolution = () => {
  if (resolutionFixed) return;
  try {
    const stage = window.Entry && Entry.stage;
    const canvasEl = stage && stage.canvas && stage.canvas.canvas;
    if (!canvasEl) return;

    const bufferW = wantedBufferWidth();
    // Change PIXI resolution rather than canvas width so Entry's logical coordinates stay intact.
    const renderer = stage._app && stage._app.renderer;
    if (
      renderer &&
      typeof renderer.resize === "function" &&
      typeof renderer.resolution === "number"
    ) {
      renderer.resolution = bufferW / ENTRY_BUFFER_WIDTH;
      renderer.resize(ENTRY_BUFFER_WIDTH, ENTRY_BUFFER_HEIGHT);
      // Update PIXI's cached interaction resolution too, or pointer coordinates scale incorrectly.
      const interaction = renderer.plugins && renderer.plugins.interaction;
      if (interaction) interaction.resolution = renderer.resolution;
    } else {
      const bufferH = Math.round((bufferW * 9) / 16);
      canvasEl.width = bufferW;
      canvasEl.height = bufferH;
      stage.canvas.x = bufferW / 2;
      stage.canvas.y = bufferH / 2;
      stage.canvas.scaleX = bufferW / 480;
      stage.canvas.scaleY = bufferW / 480;
      scaleInputFieldToBuffer(bufferW);
    }
    Entry.requestUpdate = true;
    resolutionFixed = true;
  } catch (e) {
    // Keep Entry's default resolution if changing it fails.
  }
};

// Refresh Entry's cached canvas rect when the panel moves or resizes the stage.
const refreshBoundRect = () => {
  const stage = window.Entry && Entry.stage;
  if (stage && typeof stage.updateBoundRect === "function")
    stage.updateBoundRect();
};

const entryLayoutCanvas = function layoutCanvas() {
  const workspace = document.getElementById("workspace");
  const canvas = document.getElementById("entryCanvas");
  if (!workspace || !canvas) return;
  const engineBar = document.querySelector(".entryEngine");
  const engineHeight = engineBar ? engineBar.getBoundingClientRect().height : 0;
  // Exclude panel padding because clientWidth includes it.
  const panelWidth =
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--debug-panel-width",
      ),
    ) || 0;
  const availW = workspace.clientWidth - panelWidth;
  const availH = Math.max(workspace.clientHeight - engineHeight, 60);
  if (availW <= 0 || availH <= 0) return;
  const targetW = Math.min(availW, Math.floor((availH * 16) / 9));
  canvas.style.width = targetW + "px";
  canvas.style.height = Math.floor((targetW * 9) / 16) + "px";
  setCanvasResolution();
  refreshBoundRect();
};
window.entropyLayoutCanvas = function entropyLayoutCanvas() {
  guard("무대 배치", undefined, () => rt().layoutCanvas());
};
window.addEventListener("resize", () => window.entropyLayoutCanvas());

// Wait for the panel transition to finish before measuring the stage's final position.
document
  .getElementById("workspace")
  ?.addEventListener("transitionend", (event) => {
    if (event.propertyName === "padding-right") refreshBoundRect();
  });

setInterval(() => {
  state.runState = engineState();
  if (state.open && (state.tab === "data" || state.tab === "objects"))
    state.tick += 1;
  window.entropyWatchStagePicks?.();
  guard("무대 위치 재기", undefined, () => rt().refreshRect());
}, 400);
