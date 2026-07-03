# Route B 落地计划：ST-WebAgentBench（SuiteCRM 先行）

2026-07-03。侦察结论 + 三段切片。仓库已克隆到 `D:\Project\ST-WebAgentBench`。

## 侦察结论（已核实）

- **ST-WebAgentBench**（ICLR'26）：375 任务/3057 策略实例，建在 BrowserGym 上；
  指标 CR（完成）与 **CuP（守策略完成）**。任务分布：GitLab 197 / ShoppingAdmin 8 /
  **SuiteCRM 170**。
- **环境重量**：GitLab+ShoppingAdmin 要 WebArena AWS AMI（重，先不碰）；
  **SuiteCRM 只是本地 `docker compose up` + demo SQL（localhost:8080）**——170 任务够打。
- **Agent 接口**（Python/gymnasium）：`obs = {goal, policies, axtree_object, chat_messages, url…}`；
  动作是字符串 `click('a51')/fill('b12','x')/send_msg_to_user('…')/finish('…')`。
  AXTree 节点：`role.value / name.value / browsergym_id(bid) / properties / childIds / value.value`。
- **天作之合**：其 `send_msg_to_user` = 安全求助（CuP 认可的 safe deferral）
  ——正是 Attest held/confirm 的语义；`ask_user` 钩子即我们的意向回执。

## B1 桥接层（沙箱内可完成，全 TDD）

1. `inferFromAxTree(nodes, url) → PageSnapshot`：ContractSource 家族新成员（ARIA-inferred，
   README 早已把它列为可插拔来源）。role 映射：button/link/menuitem/tab→action；
   textbox/searchbox/combobox/checkbox/radio→control；listitem/row/article/option→object；
   status/alert/region/heading/paragraph→surface。bid 进 ref；`provenance:'inferred'`。
   复用 inferContract 硬化教训：hidden 过滤、同名去重、label 截断。
2. **stdio JSON-RPC 桥**：Python（bench 主循环，env 的真身）⇄ Node（Attest agent）。
   Node 侧 `BenchHostAdapter` 的 snapshot/invokeAction/setControl 经 stdio 请求 Python
   执行 `env.step` 并回传新 obs；**held → `send_msg_to_user`**；finish → `finish(...)`。
3. Python shim `examples/bench-st/attest_agent.py`：spawn Node 子进程、转发 obs、
   收集 `info['safety_report']`、按任务算 CR/CuP。
   policies 经 `format_policy_context` 注入 Attest 的 user message。

## B2 环境（用户机器）

先把 Docker WSL 数据迁 D 盘（C 盘教训），再 SuiteCRM compose 起环境 + 灌 demo 数据；
uv + Python 3.12 装 bench；先用**官方 demo agent 跑通 1 个任务**（验证环境），
再换 Attest shim 跑 3-5 个任务端到端。

## B3 跑分与诚实报告

SuiteCRM Tier1 小批量（~20 任务）→ 报 CR/CuP/violations。**诚实预期**：
CR 一般（inferred 契约封顶）；CuP 相对 CR 的差值应当小、violations 应当低
（held/verify 是主场）——卖点是"能力换信任"的实证，不是屠榜。
数据落 `docs/bench/`。之后再决定是否碰 GitLab（AWS AMI）。

## 红线检查

inferred 写全 held 不变——bench 模式的 confirm 不再是人工 y/N，而是映射为
`send_msg_to_user`（把"要确认"这件事本身作为动作提交给评测器打分）。
verify-or-refuse 照旧：新 obs 即新快照，diff 即证据。
