export interface Intent {
  actionRef: string;
  label: string;
  expectedEvidence: string[];
  /** held 缘由：高危动作 vs 仅因来源是推断（未声明契约）。宿主可按此决定确认形式的轻重。 */
  reason?: 'high-risk' | 'inferred';
}

export interface Evidence {
  changed: boolean;
  details: string[];
}

export type LedgerEntry =
  | { kind: 'observe'; tool: string; detail: string }
  | { kind: 'intent'; refId: string; label: string; expectedEvidence: string[] }
  | { kind: 'grant'; refId: string; approved: boolean; scope?: 'once' | 'all' }
  | { kind: 'write'; tool: string; refId: string; verified: boolean; evidence: string[]; navLike?: boolean }
  | { kind: 'clarify'; question: string; answered: boolean }
  | { kind: 'error'; tool: string; detail: string };

export type Outcome = 'completed' | 'failed' | 'cancelled' | 'partial';

/**
 * 高危确认。返回 approved；可选 scope：'all' 表示在本次 run 内对同名动作授权，
 * 后续同名 invoke 不再追问（但每个写仍逐个独立 verify）。省略 scope 视作 'once'。
 */
export type ConfirmFn = (intent: Intent) => Promise<{ approved: boolean; scope?: 'once' | 'all' }>;

/**
 * 澄清回调——confirm 的姊妹：confirm 管「动作安全」的不确定（要许可），ask 管「任务信息」的
 * 不确定（要信息）。任务关键参数缺失/歧义时 agent 主动提问。交互宿主返回 answer；非交互宿主
 * 返回 {}（无人应答），agent 据此只用任务明确给的值继续、缺失留空，绝不编造填入。
 */
export type AskFn = (question: string) => Promise<{ answer?: string }>;
