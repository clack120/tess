// Source spans exclude the end offset.
export interface Loc {
  start: number;
  end: number;
  // Included nodes retain their source file for diagnostics.
  file?: string;
}

interface Base {
  loc: Loc;
}

export interface StringNode extends Base {
  type: 'String';
  value: string;
}

export interface NumberNode extends Base {
  type: 'Number';
  value: number;
}

export interface BooleanNode extends Base {
  type: 'Boolean';
  value: boolean;
}

export interface ColorNode extends Base {
  type: 'Color';
  value: string;
}

export interface TransparentNode extends Base {
  type: 'Transparent';
}

export interface Identifier extends Base {
  type: 'Identifier';
  name: string;
}

// Option nodes may have no source span.
export interface KeywordNode {
  type: 'Keyword';
  name: string;
  loc?: Loc;
}

export interface BinaryNode extends Base {
  type: 'Binary';
  operator: string;
  left: Expr;
  right: Expr;
}

export interface UnaryNode extends Base {
  type: 'Unary';
  operator: 'not' | '-';
  argument: Expr;
}

export interface CallNode extends Base {
  type: 'Call';
  callee: string;
  arguments: Expr[];
}

export interface IndexNode extends Base {
  type: 'Index';
  target: Expr;
  index: Expr;
  column: Expr | null;
}

export interface ListLiteralNode extends Base {
  type: 'ListLiteral';
  elements: Expr[];
}

export type Expr =
  | StringNode
  | NumberNode
  | BooleanNode
  | ColorNode
  | TransparentNode
  | Identifier
  | KeywordNode
  | BinaryNode
  | UnaryNode
  | CallNode
  | IndexNode
  | ListLiteralNode;

export type LValue = Identifier | IndexNode;

export interface UseNode extends Base {
  type: 'Use';
  path: string;
}

export interface UseObjectNode extends Base {
  type: 'UseObject';
  kind: 'object' | 'text';
  path: string;
}

export interface ProjectFieldNode extends Base {
  type: 'ProjectField';
  field: string;
  value: StringNode | NumberNode;
}

export interface ProjectNode extends Base {
  type: 'Project';
  fields: ProjectFieldNode[];
}

export interface SceneNode extends Base {
  type: 'Scene';
  name: string;
  body: SceneMember[];
}

export interface ObjectNode extends Base {
  type: 'Object';
  kind: string;
  name: string;
  body: ObjectMember[];
}

export interface PropertyNode extends Base {
  type: 'Property';
  name: string;
  value: Expr;
}

export interface BoxSizeNode extends Base {
  type: 'BoxSize';
  width: number;
  height: number;
}

export interface CenterNode extends Base {
  type: 'Center';
  x: number;
  y: number;
}

export interface CostumeNode extends Base {
  type: 'Costume';
  id: string;
  displayName: string | null;
  file: string;
  isDefault: boolean;
  width: number | null;
  height: number | null;
  forceId: string | null;
}

export interface SoundNode extends Base {
  type: 'Sound';
  id: string;
  displayName: string | null;
  file: string;
  duration: number | null;
  forceId: string | null;
}

export interface FunctionDeclNode extends Base {
  type: 'FunctionDecl';
  name: string;
  params: string[];
  booleanParams: string[];
  body: Stmt[];
}

export interface TableDeclNode extends Base {
  type: 'TableDecl';
  name: string;
  displayName: string | null;
  columns: Expr[];
  rows: Expr[][];
  charts: TableChartNode[];
}

export type StorageScope = 'shared' | 'realtime' | 'store';

export interface TableChartNode {
  kind: string;
  title: string | null;
  x: Expr | null;
  y: Expr | null;
  series: Expr[];
}

export interface VarDeclNode extends Base {
  type: 'VarDecl';
  name: string;
  displayName: string | null;
  scope: StorageScope | null;
  value: Expr;
  range: { min: Expr; max: Expr } | null;
  shown: boolean;
  // Null lets the runtime choose the monitor position.
  at: { x: Expr; y: Expr } | null;
  order?: number;
}

export interface ListDeclNode extends Base {
  type: 'ListDecl';
  name: string;
  displayName: string | null;
  scope: StorageScope | null;
  value: Expr;
  shown: boolean;
  // Null lets the runtime choose the monitor position.
  at: { x: Expr; y: Expr } | null;
  // Null uses Entry's default list size of 100 by 120.
  size: { width: Expr; height: Expr } | null;
  order?: number;
}

export type EventName =
  | 'start'
  | 'scene_start'
  | 'key'
  | 'key_up'
  | 'click'
  | 'click_up'
  | 'stage_click'
  | 'stage_click_up'
  | 'signal'
  | 'cloned';

export interface EventNode extends Base {
  type: 'Event';
  event: EventName;
  key?: string;
  signal?: string;
  body: Stmt[];
}

export interface IfNode extends Base {
  type: 'If';
  test: Expr;
  consequent: Stmt[];
  alternate: Stmt[] | null;
}

export interface SwitchCase extends Base {
  values: Expr[];
  body: Stmt[];
}

export interface SwitchNode extends Base {
  type: 'Switch';
  value: Expr;
  cases: SwitchCase[];
  alternate: Stmt[] | null;
}

export interface RepeatNode extends Base {
  type: 'Repeat';
  count: Expr;
  body: Stmt[];
}

export interface ForNode extends Base {
  type: 'For';
  name: string;
  from: Expr;
  to: Expr;
  step: number;
  body: Stmt[];
}

export interface WhileNode extends Base {
  type: 'While';
  test: Expr;
  body: Stmt[];
}

export interface UntilNode extends Base {
  type: 'Until';
  test: Expr;
  body: Stmt[];
}

export interface ForeverNode extends Base {
  type: 'Forever';
  body: Stmt[];
}

export interface WaitNode extends Base {
  type: 'Wait';
  value: Expr;
  until?: boolean;
}

export interface ReturnNode extends Base {
  type: 'Return';
  value: Expr | null;
}

export type NullaryStatementType =
  | 'Break'
  | 'Continue'
  | 'Skip'
  | 'Restart'
  | 'StopDraw'
  | 'StopFill'
  | 'StopBgm'
  | 'StopTimer'
  | 'StopProject'
  | 'StartDraw'
  | 'StartFill'
  | 'StartTimer'
  | 'ResetSize'
  | 'ResetTimer'
  | 'DeleteClone'
  | 'DeleteClones'
  | 'Bounce'
  | 'Stamp';

export interface NullaryNode extends Base {
  type: NullaryStatementType;
}

export interface StopSoundNode extends Base {
  type: 'StopSound';
  target: string;
}

export interface StopNode extends Base {
  type: 'Stop';
  target: string;
}

export interface ClearNode extends Base {
  type: 'Clear';
  target: string;
}

export interface SendNode extends Base {
  type: 'Send';
  signal: Expr;
  wait: boolean;
}

export interface CloneNode extends Base {
  type: 'Clone';
  target: Expr | null;
}

export interface JumpNode extends Base {
  type: 'Jump';
  target: Expr | string;
}

export interface ForwardNode extends Base {
  type: 'Forward';
  distance: Expr;
  angle: Expr | null;
}

export interface MoveNode extends Base {
  type: 'Move';
  x: Expr;
  y: Expr;
  duration: Expr | null;
}

export interface GoNode extends Base {
  type: 'Go';
  x: Expr | null;
  y: Expr | null;
  target: Expr | null;
  duration: Expr | null;
}

export interface TurnNode extends Base {
  type: 'Turn' | 'Steer';
  angle: Expr;
  duration: Expr | null;
}

export interface LookNode extends Base {
  type: 'Look';
  target: Expr;
}

export interface ShowHideNode extends Base {
  type: 'Show' | 'Hide';
  target: Expr | null;
  seconds: Expr | null;
  chart: Expr | null;
}

export interface CostumeStepNode extends Base {
  type: 'CostumeStep';
  direction: string;
}

export interface SayNode extends Base {
  type: 'Say' | 'Think';
  message: Expr;
  duration: Expr | null;
}

export interface FlipNode extends Base {
  type: 'Flip';
  axis: string;
}

export interface OrderNode extends Base {
  type: 'Order';
  to: string;
}

export interface TextWriteNode extends Base {
  type: 'TextWrite';
  mode: string;
  value: Expr;
}

export interface PlayBgmNode extends Base {
  type: 'PlayBgm';
  name: Expr;
}

export interface PlaySoundNode extends Base {
  type: 'PlaySound';
  name: Expr;
  duration: Expr | null;
  from: Expr | null;
  to: Expr | null;
  wait: boolean;
}

export interface ReadNode extends Base {
  type: 'Read';
  value: Expr;
  wait: boolean;
}

export interface TtsSettingNode extends Base {
  type: 'TtsSetting';
  voice: StringNode;
  speed: StringNode;
  pitch: StringNode;
}

export interface ListAddNode extends Base {
  type: 'ListAdd';
  list: LValue;
  value: Expr;
}

export interface ListInsertNode extends Base {
  type: 'ListInsert';
  list: LValue;
  value: Expr;
  index: Expr;
}

export interface ListRemoveNode extends Base {
  type: 'ListRemove';
  list: LValue;
  index: Expr;
}

export type TableLine = 'row' | 'column';

export interface TableAddLineNode extends Base {
  type: 'TableAddLine' | 'TableInsertLine';
  table: LValue;
  line: TableLine;
  index: Expr | null;
}

export interface TableRemoveLineNode extends Base {
  type: 'TableRemoveLine';
  table: LValue;
  line: TableLine;
  index: Expr;
}

export interface TableSaveNode extends Base {
  type: 'TableSave';
  table: Expr;
}

export interface StoreSaveNode extends Base {
  type: 'StoreSave';
  // Continue without waiting for storage when asynchronous.
  async: boolean;
}

export interface AskNode extends Base {
  type: 'Ask';
  question: Expr;
}

export interface ExpressionStatementNode extends Base {
  type: 'ExpressionStatement';
  expression: CallNode;
}

export interface AssignNode extends Base {
  type: 'Assign';
  operator: string;
  target: LValue;
  value: Expr;
}

export type Stmt =
  | SwitchNode
  | ForNode
  | IfNode
  | RepeatNode
  | WhileNode
  | UntilNode
  | ForeverNode
  | WaitNode
  | ReturnNode
  | NullaryNode
  | StopSoundNode
  | StopNode
  | ClearNode
  | SendNode
  | CloneNode
  | JumpNode
  | ForwardNode
  | MoveNode
  | GoNode
  | TurnNode
  | LookNode
  | ShowHideNode
  | CostumeStepNode
  | SayNode
  | FlipNode
  | OrderNode
  | TextWriteNode
  | PlayBgmNode
  | PlaySoundNode
  | ReadNode
  | TtsSettingNode
  | ListAddNode
  | ListInsertNode
  | ListRemoveNode
  | TableAddLineNode
  | TableRemoveLineNode
  | TableSaveNode
  | StoreSaveNode
  | AskNode
  | ExpressionStatementNode
  | AssignNode
  | VarDeclNode
  | ListDeclNode
  | FunctionDeclNode;

export type ObjectMember =
  | VarDeclNode
  | ListDeclNode
  | FunctionDeclNode
  | EventNode
  | UseNode
  | PropertyNode
  | BoxSizeNode
  | CenterNode
  | CostumeNode
  | SoundNode;

export type SceneMember = ObjectNode | UseObjectNode | UseNode | PropertyNode;

export type TopLevelItem =
  | ProjectNode
  | SceneNode
  | ObjectNode
  | FunctionDeclNode
  | UseObjectNode
  | UseNode
  | VarDeclNode
  | ListDeclNode
  | TableDeclNode;

export interface ProgramNode extends Base {
  type: 'Program';
  body: TopLevelItem[];
}

export type Node =
  | ProgramNode
  | TopLevelItem
  | SceneMember
  | ObjectMember
  | Stmt
  | Expr
  | ProjectFieldNode
  | EventNode;

export type ParseRoot = ProgramNode | SceneMember[] | ObjectMember[] | Stmt | Expr;

export interface Diagnostic {
  line: number;
  column: number;
  offset: number;
  endOffset?: number;
  message: string;
  file?: string;
  detail?: string | null;
  code?: string;
  help?: string;
  related?: Diagnostic[];
}

export interface ValidationResult {
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

export interface ParseResult<T = ParseRoot> {
  ok: boolean;
  ast: T | null;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}
