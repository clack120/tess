import { exprOf, conditionOf, isJudgement, targetName } from "./expr.ts";
import {
  append,
  entropyString,
  entropyNumber,
  entropyComment,
  entropyCommentLines,
  ownsResource,
  isExactNumber,
  entropyLiteral,
  displayNamePart,
  resourceInfo,
} from "./ident.ts";
import type {
  DecompileContext,
  FunctionInfo,
  RawBlock,
  ResourceInfo,
} from "./types.ts";

const REVERSE_STOP_TARGET: Record<string, string> = {
  thisThread: "",
  // This legacy stop mode also stops every clone of the object.
  thisObject: "object",
  otherThread: "other",
  thisOnly: "me",
  other_objects: "them",
  all: "all",
};
const REVERSE_EFFECT: Record<string, string> = {
  color: "effect_color",
  brightness: "effect_brightness",
  transparency: "effect_alpha",
};
const REVERSE_TEXT_EFFECT: Record<string, string> = {
  fontBold: "text_bold",
  fontItalic: "text_italic",
  underLine: "text_underline",
  strike: "text_strikethrough",
};
const REVERSE_TTS_SPEAKER: Record<string, string> = {
  kyuri: "female",
  jinho: "male",
  hana: "kind",
  dinna: "sweet",
  brown: "echo",
  minions: "mischievous",
  sally: "dainty",
  nsabina: "nsabina",
  nmammon: "nmammon",
  nmeow: "kitty",
  nwoof: "doggy",
};

export function indent(lines: string[]): string[] {
  return lines.map((line) => (line === "" ? line : `  ${line}`));
}

export function blocksToLines(
  blocks: RawBlock[] | undefined,
  ctx: DecompileContext,
): string[] {
  const lines: string[] = [];
  for (const block of blocks ?? []) {
    append(lines, commentLines(block));
    append(lines, statementLines(block, ctx));
  }
  return lines;
}

// Write attached block notes above the statement so compilation attaches them again.
export function commentLines(block: RawBlock | undefined): string[] {
  const value = String(block?.comment?.value ?? "").trimEnd();
  if (!value.trim()) return [];
  return entropyCommentLines(value);
}

function branch(
  block: RawBlock,
  index: number,
  ctx: DecompileContext,
): string[] {
  return indent(blocksToLines(block.statements?.[index] ?? [], ctx));
}

function loopBranch(
  block: RawBlock,
  index: number,
  ctx: DecompileContext,
): string[] {
  ctx.loopDepth += 1;
  try {
    return branch(block, index, ctx);
  } finally {
    ctx.loopDepth -= 1;
  }
}

function unsupported(
  ctx: DecompileContext,
  block: RawBlock | undefined,
): string[] {
  const type = block?.type ?? "(알 수 없음)";
  ctx.warn(`문장 블록 '${type}' 은(는) 아직 옮길 수 없습니다.`, {
    code: 'D1002', help: '이 문장은 주석으로 남으며 재컴파일한 작품에서 실행되지 않습니다. 원본 블록을 확인하세요.',
  });
  const paramsText = JSON.stringify(summarizeParams(block?.params)).slice(
    0,
    200,
  );
  return [
    entropyComment(`[decompile] 지원하지 않는 블록: ${type} params=${paramsText}`),
  ];
}

function summarizeParams(params: any[] | undefined) {
  return (params ?? []).map((p) => {
    if (p === null || p === undefined) return null;
    if (typeof p !== "object") return p;
    return p.type;
  });
}

// eslint-disable-next-line complexity
function tableLine(property: unknown): string {
  return String(property) === "COL" ? "column" : "row";
}

// Wrap a callable x coordinate so it cannot consume the following y expression.
function point(x: string, y: string): string {
  const looksLikeCall = /[\p{L}\p{N}_]$/u.test(x) && y.startsWith("(");
  return `${looksLikeCall ? `(${x})` : x} ${y}`;
}

// Flow blocks in value slots run before their parent and can restart or end the loop.
const LOOP_TRICK: Record<string, string> = {
  continue_repeat: "skip",
  stop_repeat: "skip",
};

// Boolean slots can carry loop control without spending a frame.
function slotTrick(param: unknown): string | null {
  const not = param as RawBlock | undefined;
  if (not?.type !== "boolean_not") return null;
  const inner = not.params?.[1] as RawBlock | undefined;
  return LOOP_TRICK[inner?.type ?? ""] ?? null;
}

// Read flow blocks in value slots before their parent block.
function parkedStatement(param: unknown): RawBlock | null {
  const field = param as RawBlock | undefined;
  if (
    field?.type !== "function_field_string" &&
    field?.type !== "function_field_boolean"
  )
    return null;
  const inner = field.params?.[0] as RawBlock | undefined;
  return inner && typeof inner === "object" ? inner : null;
}

// Keep carriers with other side effects because Entry evaluates every input slot.
function inertValue(param: unknown): boolean {
  const pending = [param];
  while (pending.length) {
    const value = pending.pop();
    if (value === null || value === undefined || typeof value !== "object") continue;
    const block = value as RawBlock;
    if ((block.statements?.length ?? 0) > 0) return false;
    if (block.type?.startsWith("func_") || block.type === "calc_rand") return false;
    if (
      block.type === "function_field_string" ||
      block.type === "function_field_boolean"
    )
      return false;
    pending.push(...(block.params ?? []));
  }
  return true;
}

export function carriedTrick(block: RawBlock | undefined): string | null {
  if (!block || (block.statements?.length ?? 0) > 0) return null;
  let carried: string | null = null;
  for (const param of block.params ?? []) {
    const trick =
      param !== null && param !== undefined && typeof param === "object"
        ? LOOP_TRICK[(param as RawBlock).type ?? ""]
        : undefined;
    if (trick) {
      carried = trick;
      continue;
    }
    if (!inertValue(param)) return null;
  }
  return carried;
}

// Parenthesize row or column values so list additions cannot parse as table operations.
function listValue(text: string): string {
  return /^(row|column)(?![\p{L}\p{N}_])/u.test(text) ? `(${text})` : text;
}

const TEXT_BOX_STATEMENTS = new Set([
  "text_write",
  "text_append",
  "text_prepend",
  "text_flush",
  "text_change_font",
  "text_change_font_color",
  "text_change_bg_color",
  "text_change_effect",
]);

// Recover a value-function statement from its empty-if wrapper.
function discardedCall(block: any, ctx: DecompileContext): any | null {
  if (block.statements?.[0]?.length) return null;
  const test = block.params?.[0];
  if (test?.type !== "boolean_basic_operator" || test.params?.[1] !== "EQUAL") return null;
  const [call, , empty] = test.params;
  if (empty?.type !== "text" || String(empty.params?.[0] ?? "") !== "") return null;
  if (typeof call?.type !== "string" || !call.type.startsWith("func_")) return null;
  return ctx.functionsById.has(call.type.slice("func_".length)) ? call : null;
}

function statementLines(block: any, ctx: DecompileContext): string[] {
  const previous = ctx.currentBlock;
  ctx.currentBlock = block;
  try { return renderStatement(block, ctx); }
  finally { ctx.currentBlock = previous; }
}

function renderStatement(block: any, ctx: DecompileContext): string[] {
  if (!block || typeof block.type !== 'string') return unsupported(ctx, block);
  if (!block || typeof block !== "object" || !block.type) return [];
  const p = block.params ?? [];
  const at = (i: number) => p[i];
  const e = (i: number) => exprOf(at(i), ctx);

  // Check flow carriers first because their input can prevent the parent block from running.
  {
    const carried = carriedTrick(block);
    if (carried) return ctx.loopDepth > 0 ? [carried] : [];
  }

  // Entry ignores text-box operations on sprites; Entropy rejects them there.
  if (ctx.spriteScripts && TEXT_BOX_STATEMENTS.has(block.type)) {
    ctx.notice(`글상자 블록 '${block.type}' 이(가) 그림 오브젝트에 있어 주석으로 남겼습니다 (엔트리에서도 아무 일도 하지 않습니다).`);
    return [entropyComment(`[decompile] 그림 오브젝트의 글상자 블록 (실행되지 않음): ${block.type}`)];
  }

  switch (block.type) {
    // Event hats are handled separately and are skipped in thread bodies.
    case "when_run_button_click":
    case "when_scene_start":
    case "when_some_key_pressed":
    case "when_object_click":
    case "when_message_cast":
    case "when_clone_start":
      return [];

    case "_if": {
      const discarded = discardedCall(block, ctx);
      if (discarded) return [exprOf(discarded, ctx)];
      return [`if ${conditionOf(at(0), ctx)}:`, ...branch(block, 0, ctx), "end"];
    }
    case "if_else":
      return [
        `if ${conditionOf(at(0), ctx)}:`,
        ...branch(block, 0, ctx),
        "else:",
        ...branch(block, 1, ctx),
        "end",
      ];
    case "repeat_basic":
      return [`repeat ${e(0)}:`, ...loopBranch(block, 0, ctx), "end"];
    case "repeat_inf":
      return ["forever:", ...loopBranch(block, 0, ctx), "end"];
    // Maze loops do not spend frames, so add skip to nonempty bodies.
    case "ai_repeat_until_reach": {
      if (!block.statements?.[0]?.length) return [];
      return [
        "forever:",
        ...loopBranch(block, 0, ctx),
        ...indent(["skip"]),
        "end",
      ];
    }
    case "repeat_while_true": {
      const kind = at(1) === "until" ? "until" : "while";
      return [`${kind} ${conditionOf(at(0), ctx)}:`, ...loopBranch(block, 0, ctx), "end"];
    }
    case "wait_second":
      return [`wait ${e(0)}`];
    case "wait_until_true": {
      const trick = slotTrick(at(0));
      if (!trick) return [`wait ${isJudgement(at(0)) ? "" : "until "}${conditionOf(at(0), ctx)}`];
      // Outside a loop, this wait keeps returning its own scope and never finishes.
      if (ctx.loopDepth === 0) return ["wait false"];
      return [trick];
    }
    case "stop_repeat":
      return ["break"];
    case "continue_repeat":
      return ["continue"];
    case "restart_project":
      return ["restart"];
    case "stop_run":
      return ["stop project"];
    case "stop_object": {
      const target = REVERSE_STOP_TARGET[at(0)];
      return [
        target === undefined
          ? unsupported(ctx, block)[0]
          : `stop${target ? ` ${target}` : ""}`,
      ];
    }

    case "message_cast":
    case "message_cast_wait": {
      const name = ctx.messageName(at(0));
      return [
        `${block.type === "message_cast_wait" ? "call" : "send"} ${entropyString(name)}`,
      ];
    }
    case "create_clone": {
      const target = at(0);
      return [
        target === "self"
          ? "clone"
          : `clone ${entropyString(targetName(ctx, target))}`,
      ];
    }
    case "delete_clone":
      return ["del clone"];
    case "remove_all_clones":
      return ["del clones"];
    case "start_scene": {
      const scene = ctx.scenesById.get(at(0));
      // Keep deleted scene targets as notes because their jumps cannot run.
      if (!scene) {
        ctx.warn(
          `장면 id '${at(0)}' 이(가) 작품에 없어 그 자리로 가는 'jump' 를 주석으로 남겼습니다.`,
        );
        return [
          entropyComment(
            `[decompile] jump ${entropyString(String(at(0)))} — 작품에 없는 장면입니다`,
          ),
        ];
      }
      return [`jump ${entropyString(scene.identifier)}`];
    }
    case "start_neighbor_scene":
      return [`jump ${at(0) === "next" ? "next" : "back"}`];

    case "move_direction":
      return [`forward ${e(0)}`];
    case "move_to_angle":
      return [`forward ${e(1)} at ${e(0)}`];
    case "bounce_wall":
      return ["bounce"];
    case "move_xy_time":
      return [`move ${e(1)} ${e(2)} in ${e(0)}`];
    case "move_x":
      return [`x += ${e(0)}`];
    case "move_y":
      return [`y += ${e(0)}`];
    case "locate": {
      const target = at(0);
      return [
        target === "self"
          ? "# go self (엔트리 원본이 자기 자신으로 이동)"
          : `go ${entropyString(targetName(ctx, target))}`,
      ];
    }
    case "locate_object_time": {
      const target = at(1);
      return [`go ${entropyString(targetName(ctx, target))} in ${e(0)}`];
    }
    case "locate_x":
      return [`x = ${e(0)}`];
    case "locate_y":
      return [`y = ${e(0)}`];
    case "locate_xy":
      return [`go ${point(e(0), e(1))}`];
    case "locate_xy_time":
      return [`go ${point(e(1), e(2))} in ${e(0)}`];
    case "rotate_relative":
      return [`turn ${e(0)}`];
    case "rotate_by_time":
      return [`turn ${e(1)} in ${e(0)}`];
    case "rotate_absolute":
      return [`angle = ${e(0)}`];
    case "direction_relative":
      return [`steer ${e(0)}`];
    case "direction_relative_duration":
      return [`steer ${e(1)} in ${e(0)}`];
    case "direction_absolute":
      return [`way = ${e(0)}`];
    case "see_angle_object":
      return [`look ${entropyString(targetName(ctx, at(0)))}`];

    case "show":
      return ["show"];
    case "hide":
      return ["hide"];
    case "show_variable":
      return [`show ${ctx.varName(at(0))}`];
    case "hide_variable":
      return [`hide ${ctx.varName(at(0))}`];
    case "show_list":
      return [`show ${ctx.varName(at(0))}`];
    case "hide_list":
      return [`hide ${ctx.varName(at(0))}`];
    case "set_visible_project_timer":
      return [`${at(1) === "SHOW" ? "show" : "hide"} timer`];
    case "set_visible_answer":
      return [`${at(0) === "SHOW" ? "show" : "hide"} answer`];
    case "change_to_next_shape":
      return [at(0) === "prev" ? "prev costume" : "next costume"];
    case "change_to_some_shape":
      return [`costume = ${resourceExpr(at(0), ctx, ctx.picturesById)}`];
    case "dialog":
      return [`${at(1) === "think" ? "think" : "say"} ${e(0)}`];
    case "dialog_time":
      return [`${at(2) === "think" ? "think" : "say"} ${e(0)} for ${e(1)}`];
    case "flip_y":
      return ["flip x"]; // Entry's flip_x flips vertically and flip_y horizontally.
    case "flip_x":
      return ["flip y"];
    case "change_object_index":
      return [
        (
          {
            FRONT: "order first",
            FORWARD: "order front",
            BACKWARD: "order back",
            BACK: "order last",
          } as Record<string, string>
        )[at(0)]!,
      ];
    case "reset_scale_size":
      return ["reset size"];
    case "set_scale_size":
      return [`size = ${e(0)}`];
    case "change_scale_size":
      return [`size += ${e(0)}`];
    case "stretch_scale_size":
      return [`${at(0) === "WIDTH" ? "scale_x" : "scale_y"} += ${e(1)}`];
    case "change_effect_amount":
      return [`${REVERSE_EFFECT[at(0)] ?? at(0)} = ${e(1)}`];
    case "add_effect_amount":
      return [`${REVERSE_EFFECT[at(0)] ?? at(0)} += ${e(1)}`];
    case "erase_all_effects":
      return ["clear effects"];

    // Legacy size blocks use a percentage of the object's saved scale.
    case "set_scale_percent": {
      const saved = ctx.objectScale;
      if (!saved) return unsupported(ctx, block);
      const value = e(0);
      return [
        `scale_x = ${value} * ${entropyNumber(saved.x)} / 100`,
        `scale_y = ${value} * ${entropyNumber(saved.y)} / 100`,
      ];
    }
    // Entry's reported size scales with both axes, so multiply it directly.
    case "change_scale_percent":
      return [`size = size * (${e(0)} + 100) / 100`];
    // Legacy opacity runs in the opposite direction from transparency.
    case "set_effect":
    case "set_entity_effect": {
      const name = at(0) === "opacity" ? "transparency" : at(0);
      const value = at(0) === "opacity" ? `100 - ${e(1)}` : e(1);
      return [`${REVERSE_EFFECT[name] ?? name} = ${value}`];
    }
    case "set_effect_amount":
      return [`${REVERSE_EFFECT[at(0)] ?? at(0)} += ${e(1)}`];
    case "reset_project_timer":
      return ["reset timer"];
    case "remove_dialog":
      return ["clear bubble"];

    case "text_write":
      return [`write ${e(0)}`];
    case "text_append":
      return [`append ${e(0)}`];
    case "text_prepend":
      return [`prepend ${e(0)}`];
    case "text_flush":
      return ["clear text"];
    case "text_change_font":
      return [`font = ${entropyString(at(0))}`];
    case "text_change_font_color":
      return [`font_color = ${colorExpr(at(0), ctx)}`];
    case "text_change_bg_color":
      return [`bg_color = ${colorExpr(at(0), ctx)}`];
    case "text_change_effect": {
      const name = REVERSE_TEXT_EFFECT[at(0)];
      return name
        ? [`${name} = ${at(1) === "on" ? "true" : "false"}`]
        : unsupported(ctx, block);
    }

    case "start_drawing":
      return ["start draw"];
    case "stop_drawing":
      return ["stop draw"];
    case "start_fill":
      return ["start fill"];
    case "stop_fill":
      return ["stop fill"];
    case "brush_stamp":
      return ["stamp"];
    case "brush_erase_all":
      return ["clear draw"];
    case "set_color":
      return [`draw_color = ${colorExpr(at(0), ctx)}`];
    case "set_fill_color":
      return [`fill_color = ${colorExpr(at(0), ctx)}`];
    case "set_random_color":
      return ["draw_color = random_color()"];
    case "set_thickness":
      return [`draw_width = ${e(0)}`];
    case "change_thickness":
      return [`draw_width += ${e(0)}`];
    case "set_brush_tranparency":
      return [`draw_alpha = ${e(0)}`];
    case "change_brush_transparency":
      return [`draw_alpha += ${e(0)}`];

    case "choose_project_timer_action": {
      const action = (
        {
          START: "start timer",
          STOP: "stop timer",
          RESET: "reset timer",
        } as Record<string, string>
      )[at(1)];
      return action ? [action] : unsupported(ctx, block);
    }

    case "sound_something_with_block":
      return [`play sound ${resourceExpr(at(0), ctx, ctx.soundsById)}`];
    case "sound_something_wait_with_block":
      return [
        `play sound ${resourceExpr(at(0), ctx, ctx.soundsById)} and wait`,
      ];
    case "sound_something_second_with_block":
      return [
        `play sound ${resourceExpr(at(0), ctx, ctx.soundsById)} for ${e(1)}`,
      ];
    case "sound_something_second_wait_with_block":
      return [
        `play sound ${resourceExpr(at(0), ctx, ctx.soundsById)} for ${e(1)} and wait`,
      ];
    case "sound_from_to":
      return [
        `play sound ${resourceExpr(at(0), ctx, ctx.soundsById)} from ${e(1)} to ${e(2)}`,
      ];
    case "sound_from_to_and_wait":
      return [
        `play sound ${resourceExpr(at(0), ctx, ctx.soundsById)} from ${e(1)} to ${e(2)} and wait`,
      ];
    case "play_bgm":
      return [`play bgm ${resourceExpr(at(0), ctx, ctx.soundsById)}`];
    case "stop_bgm":
      return ["stop bgm"];
    case "sound_silent_all":
      return [`stop sound ${at(0) === "thisOnly" ? "this" : "all"}`];
    case "sound_volume_set":
      return [`sound_volume = ${e(0)}`];
    case "sound_volume_change":
      return [`sound_volume += ${e(0)}`];
    case "sound_speed_set":
      return [`sound_speed = ${e(0)}`];
    case "sound_speed_change":
      return [`sound_speed += ${e(0)}`];

    case "read_text":
      return [`read ${e(0)}`];
    case "read_text_wait_with_block":
      return [`read ${e(0)} and wait`];
    case "set_tts_property": {
      // Keep TTS speed and pitch codes because their aliases have opposite directions.
      return [
        `tts voice ${entropyString(REVERSE_TTS_SPEAKER[at(0)] ?? at(0))} ` +
          `speed ${entropyString(String(at(1)))} pitch ${entropyString(String(at(2)))}`,
      ];
    }

    case "append_row_to_table":
      return [`in ${ctx.tableName(at(0))} add ${tableLine(at(1))}`];
    case "insert_row_to_table":
      return [
        `in ${ctx.tableName(at(0))} insert ${tableLine(at(2))} at ${exprOf(at(1), ctx)}`,
      ];
    case "delete_row_from_table":
      return [
        `remove ${ctx.tableName(at(0))} ${tableLine(at(2))} ${exprOf(at(1), ctx)}`,
      ];
    case "set_value_from_table":
      return [
        `${ctx.tableName(at(0))}[${exprOf(at(1), ctx)}, ${exprOf(at(2), ctx)}] = ${e(3)}`,
      ];
    case "set_value_from_cell":
      return [`${ctx.tableName(at(0))}[${exprOf(at(1), ctx)}] = ${e(2)}`];
    case "save_current_table":
      return [`save ${ctx.tableName(at(0))}`];
    case "open_table":
      return [`show ${ctx.tableName(at(0))}`];
    case "open_table_wait":
      return [`show ${ctx.tableName(at(0))} for ${e(1)}`];
    case "open_table_chart":
      // Convert zero-based Entry chart indices to one-based Entropy indices.
      return [
        `show ${ctx.tableName(at(0))} chart ${entropyNumber(Number(at(1) ?? 0) + 1)}`,
      ];
    case "close_table_chart":
      return ["hide chart"];

    case "ask_and_wait":
      return [`ask ${e(0)}`];
    case "add_value_to_list":
      return [`in ${ctx.varName(at(1))} add ${listValue(e(0))}`];
    case "insert_value_to_list":
      return [
        `in ${ctx.varName(at(1))} insert ${listValue(e(0))} at ${exprOf(at(2), ctx)}`,
      ];
    case "remove_value_from_list":
      return [`remove ${ctx.varName(at(1))}[${exprOf(at(0), ctx)}]`];
    case "change_value_list_index":
      return [`${ctx.varName(at(0))}[${exprOf(at(1), ctx)}] = ${e(2)}`];

    case "set_variable":
      return [`${ctx.varName(at(0))} = ${e(1)}`];
    case "change_variable":
      return [`${ctx.varName(at(0))} += ${e(1)}`];
    case "set_func_variable": {
      const name = ctx.funcLocalName(at(0));
      if (name === null) {
        // Entry throws before writing a missing target; omit the failed assignment in Entropy.
        ctx.notice(
          `'${at(0)}' 은(는) 다른 함수의 지역변수라 엔트리에서도 값이 들어가지 않습니다. 그 문장은 옮기지 않았습니다.`,
        );
        return [];
      }
      return [`${name} = ${e(1)}`];
    }

    default: {
      if (block.type.startsWith("func_"))
        return functionCallStatement(block, ctx);
      // Statements in value slots run before the parent block.
      const parked = (block.params ?? [])
        .map(parkedStatement)
        .filter((inner: RawBlock | null): inner is RawBlock => inner !== null)
        .flatMap((inner: RawBlock) => statementLines(inner, ctx));
      return [...parked, ...unsupported(ctx, block)];
    }
  }
}

// Color slots may hold literal blocks or computed expressions; do not stringify the block object.
export function colorExpr(value: any, ctx?: DecompileContext): string {
  const literal = literalStringOf(value);
  if (literal !== null) {
    // Preserve alpha in eight-digit hex colors.
    if (/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(literal)) return literal;
    if (literal === "transparent") return "transparent";
    return entropyString(literal);
  }
  return ctx ? exprOf(value, ctx) : entropyString(String(value ?? ""));
}

function literalStringOf(value: any): string | null {
  const raw = literalOf(value);
  return typeof raw === "string" ? raw : null;
}

// Entry literal slots can hold strings or numbers, including inside text blocks.
function literalOf(value: any): string | number | null {
  if (typeof value === "string" || typeof value === "number") return value;
  if (
    value &&
    typeof value === "object" &&
    (value.type === "number" || value.type === "text")
  ) {
    const raw = value.params?.[0];
    if (typeof raw === "string" || typeof raw === "number") return raw;
  }
  return null;
}

// Resolve literal resource IDs to names before recompilation assigns new IDs.
function resourceExpr(
  value: any,
  ctx: DecompileContext,
  byId: Map<string, ResourceInfo>,
): string {
  const getter = byId === ctx.picturesById ? 'get_pictures' : 'get_sounds';
  const raw = value?.type === getter ? value.params?.[0] : literalOf(value);
  const literal = raw === null ? null : String(raw);
  if (literal !== null && byId.has(literal)) {
    const info = resourceInfo(ctx, literal, byId)!;
    // Keep forced IDs in global functions; object-owned functions can use local resource names.
    if (ctx.inFunction && !ownsResource(ctx, info)) return entropyString(literal);
    return entropyString(info.identifier);
  }
  // Resource indices can arrive as text blocks; emit numbers to avoid name lookup errors.
  if (literal !== null && isExactNumber(literal))
    return entropyNumber(Number(literal));
  if (value?.type === getter) {
    if (byId === ctx.picturesById) ctx.pictureName(literal ?? '');
    else ctx.soundName(literal ?? '');
  }
  return exprOf(value, ctx);
}

export function functionDeclarationLines(
  fn: FunctionInfo,
  createBlock: RawBlock,
  ctx: DecompileContext,
  ownerId: string | null = null,
): string[] {
  const p = createBlock.params ?? [];
  const isValue = createBlock.type === "function_create_value";
  // Keep resource IDs in global functions because different objects can call them.
  const previousInFunction = ctx.inFunction;
  const previousOwner = ctx.functionOwnerId;
  const previousFunctionId = ctx.functionId;
  const previousBlock = ctx.currentBlock;
  ctx.inFunction = true;
  ctx.functionOwnerId = ownerId;
  // Only the running function's parameters are in scope.
  ctx.functionId = fn.id;
  ctx.currentBlock = createBlock;
  let body: string[];
  let returnExpr: string | null;
  try {
    if (isValue && !(createBlock.statements?.[0]?.length)) {
      ctx.notice(`값 함수 '${fn.displayLabel}' 의 실행 본문이 비어 있습니다. EntryJS는 반환 식을 반복 평가할 수 있습니다.`, {
        code: 'D2001',
        help: '원래 빈 본문을 보존했습니다. EntryJS 4.0.23은 동기 반환 식을 3번 평가하고 실행을 양보합니다. 대기하는 반환 식은 경로에 따라 평가 횟수가 달라집니다.',
      });
    }
    body = indent(blocksToLines(createBlock.statements?.[0] ?? [], ctx));
    returnExpr = isValue ? exprOf(p[3], ctx) : null;
  } finally {
    ctx.inFunction = previousInFunction;
    ctx.functionOwnerId = previousOwner;
    ctx.functionId = previousFunctionId;
    ctx.currentBlock = previousBlock;
  }

  // Declare function locals at the start so each call initializes its own copy.
  const locals = (fn.locals ?? []).map(
    (local) =>
      `var ${local.name}${displayNamePart(local.name, local.entryName)} = ${entropyLiteral(local.value)}`,
  );

  const lines = [
    ...commentLines(createBlock),
    `function ${fn.name}(${fn.params.join(", ")})${displayNamePart(fn.name, fn.displayLabel)}${fn.order === undefined ? '' : ` order ${fn.order}`}:`,
    ...indent(locals),
    ...body,
  ];
  if (isValue) {
    if (body.length || locals.length) lines.push("");
    lines.push(...indent([`return ${returnExpr}`]));
  }
  lines.push("end");
  return lines;
}

function functionCallStatement(
  block: RawBlock,
  ctx: DecompileContext,
): string[] {
  const fn = ctx.functionsById.get(block.type!.slice("func_".length));
  if (!fn) return unsupported(ctx, block);
  if (fn.saveKind) return [fn.saveKind === "async" ? "save async" : "save"];
  const p = block.params ?? [];
  const args = p
    .filter((_: unknown, i: number) => i < fn.params.length)
    .map((param: unknown) => exprOf(param, ctx));
  return [`${fn.name}(${args.join(", ")})`];
}
