# 可视 demo（examples/demo-web）设计

一页速记。2026-07-02。

- **形态**：Vite 单页，`npm run demo`。key 不进浏览器——dev server 把 `/api` 代理到
  DeepSeek 并注入 `Authorization`（读 `ATTEST_API_KEY`）。agent 在浏览器内跑，
  `createDomHostAdapter({ root: 左半屏 })` 驱动你看见的真实 DOM。
- **左半屏 工单工作台**（`data-agent-*` 契约活页面）：工单 objects + 详情 surface；
  `resolve`（高危，演 held + 作用域授权 y/a/N）；`clear_all`（高危）；
  `archive` 带业务规则——有未解决工单时 status 弹"无法归档"（演 goalMet 降级）。
- **右半屏 证据面板**：AgentStep 实时时间线（observe/action+evidence/held/cancelled/
  ⚡speculate/mispredict/drift）；held 弹意向回执确认框（批准/本次全部授权/拒绝）；
  收尾卡 narration（模型原话）与 facts（账本执行记录）**并列分区**+outcome 橡皮章。
  底部自由输入。
- **加分**：WorldModel 存 localStorage，跨会话先验/预测命中肉眼可见。
- **气质**：账本纸（左，暖纸+衬线+红边线）× 飞行记录仪（右，墨色+等宽）。无 webfont。
- **边界**：纯 examples，不动内核不进 dist；vite 仅 devDependency。
