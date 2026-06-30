export interface Intent {
  actionRef: string;
  label: string;
  expectedEvidence: string[];
}

export interface Evidence {
  changed: boolean;
  details: string[];
}

export type LedgerEntry =
  | { kind: 'observe'; tool: string; detail: string }
  | { kind: 'intent'; refId: string; label: string; expectedEvidence: string[] }
  | { kind: 'grant'; refId: string; approved: boolean; scope?: 'once' | 'all' }
  | { kind: 'write'; tool: string; refId: string; verified: boolean; evidence: string[] }
  | { kind: 'error'; tool: string; detail: string };

export type Outcome = 'completed' | 'failed' | 'cancelled' | 'partial';

/**
 * 高危确认。返回 approved；可选 scope：'all' 表示在本次 run 内对同名动作授权，
 * 后续同名 invoke 不再追问（但每个写仍逐个独立 verify）。省略 scope 视作 'once'。
 */
export type ConfirmFn = (intent: Intent) => Promise<{ approved: boolean; scope?: 'once' | 'all' }>;
