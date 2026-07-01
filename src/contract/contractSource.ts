import type { PageSnapshot } from '../types';

/**
 * 契约来源：把某种"页面声明"解析成内核统一的 PageSnapshot。
 * 内核的信任核心（execWrite/verifier/ledger/lookahead）跑在 PageSnapshot 之上，
 * 因此可插拔——`parseContract`(data-agent-*)、`parseVoix`(VOIX)、未来 W3C WoT 皆为其实现。
 */
export type ContractSource = (root: ParentNode, url: string) => PageSnapshot;
