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
  | { kind: 'grant'; refId: string; approved: boolean }
  | { kind: 'write'; tool: string; refId: string; verified: boolean; evidence: string[] }
  | { kind: 'error'; tool: string; detail: string };

export type Outcome = 'completed' | 'failed' | 'cancelled';

export type ConfirmFn = (intent: Intent) => Promise<{ approved: boolean }>;
