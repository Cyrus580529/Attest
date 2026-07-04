export type RefKind = 'object' | 'action' | 'control' | 'surface';

/** 内核生成的稳定引用。模型只能引用 harness 给出的 ref。 */
export interface Ref {
  readonly kind: RefKind;
  readonly id: string; // 同一快照内唯一，如 "object:task:42"
}

export type Risk = 'low' | 'high';

/** handle 的来源：authored=页面用 data-agent-* 声明；inferred=从语义/ARIA 推断。未设视为 authored。 */
export type Provenance = 'authored' | 'inferred';

export interface ObjectNode {
  readonly ref: Ref; // kind: 'object'
  readonly type: string; // 如 "task"
  readonly objectId: string; // 如 "42"
  readonly label: string;
  readonly provenance?: Provenance;
}

/** 动作参数（如 VOIX <prop>）：带类型的输入声明。 */
export interface ParamSpec {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean';
  readonly description?: string;
  readonly required?: boolean;
}

export interface ActionNode {
  readonly ref: Ref; // kind: 'action'
  readonly name: string; // 如 "apply"
  readonly label: string;
  readonly risk: Risk;
  readonly provenance?: Provenance;
  /** 语义分类：'nav' = 导航/切视图类动作（模块链接、tab），不代表任务真正要求的变更。 */
  readonly category?: 'nav';
  /** 可选：调用时需要的参数（VOIX 带参 tool）。无参动作省略。 */
  readonly params?: readonly ParamSpec[];
}

export interface ControlNode {
  readonly ref: Ref; // kind: 'control'
  readonly name: string;
  readonly label: string;
  readonly value: string | null;
  readonly provenance?: Provenance;
}

export interface SurfaceNode {
  readonly ref: Ref; // kind: 'surface'
  readonly name: string;
  readonly text: string;
  readonly provenance?: Provenance;
}

export interface PageSnapshot {
  readonly url: string;
  readonly objects: readonly ObjectNode[];
  readonly actions: readonly ActionNode[];
  readonly controls: readonly ControlNode[];
  readonly surfaces: readonly SurfaceNode[];
}
