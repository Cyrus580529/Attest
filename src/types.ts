export type RefKind = 'object' | 'action' | 'control' | 'surface';

/** 内核生成的稳定引用。模型只能引用 harness 给出的 ref。 */
export interface Ref {
  readonly kind: RefKind;
  readonly id: string; // 同一快照内唯一，如 "object:task:42"
}

export type Risk = 'low' | 'high';

export interface ObjectNode {
  readonly ref: Ref; // kind: 'object'
  readonly type: string; // 如 "task"
  readonly objectId: string; // 如 "42"
  readonly label: string;
}

export interface ActionNode {
  readonly ref: Ref; // kind: 'action'
  readonly name: string; // 如 "apply"
  readonly label: string;
  readonly risk: Risk;
}

export interface ControlNode {
  readonly ref: Ref; // kind: 'control'
  readonly name: string;
  readonly label: string;
  readonly value: string | null;
}

export interface SurfaceNode {
  readonly ref: Ref; // kind: 'surface'
  readonly name: string;
  readonly text: string;
}

export interface PageSnapshot {
  readonly url: string;
  readonly objects: readonly ObjectNode[];
  readonly actions: readonly ActionNode[];
  readonly controls: readonly ControlNode[];
  readonly surfaces: readonly SurfaceNode[];
}
