# Attest

> **Trustworthy, self-verifying web agent core.** The model only *proposes* actions;
> the harness validates every `ref` against what the page really exposes before executing.
> Each executed action leaves auditable evidence — and **the agent may not claim success
> without it.**

Attest is **not** another "scrape the DOM and click anything" agent. It makes the opposite
bet: pages *cooperate* with the agent through a contract, and in exchange the agent becomes
**reliable, safe, auditable, and capable of long-horizon autonomy**.

The result is an agent that **cannot lie about what it did.** Its final `outcome`
(`completed` / `failed` / `cancelled`) is *computed from an evidence ledger*, never taken
from the model's own narration. Scope this claim precisely: the ledger is a **ceiling on
claims, not a business-semantics oracle** — a snapshot diff proves an action *had an
effect*, not that the goal succeeded (an error banner is also an observable change). So the
model may only **downgrade** the computed outcome (`goalMet: false` when the page reports a
business failure), never upgrade it.

- **Ref-binding + harness validation** — a `ref` the model emits must resolve to a real
  object the page exposes, or the action is refused. No guessed selectors, no hallucinated
  actions.
- **Verify-or-refuse** — after every write, the harness diffs the page snapshot; the
  observable change *is* the evidence. No evidence → the write did not "succeed". The diff
  attests *effect*, not correctness — which is why cooperating pages should expose failures
  observably too (a status/error surface), and why the model has a downgrade-only channel
  for business failures it reads off the page.
- **High-risk held** — submit / checkout / approve and other dangerous actions pause for an
  explicit Intent Receipt first. Default is deny.
- **Lookahead + priors, not blind replay** — the model plans several steps ahead and may
  predict their effects; a `WorldModel` and `RecipeBook` feed *priors* learned from past
  evidence into its context. The verifier is always the single source of truth — priors only
  make the model plan faster, they never bypass it.
- **Drift detection with self-healing** — when a known action stops producing its known
  effect on the same page signature (the page changed behavior under the agent), the kernel
  detects it deterministically: first miss demotes the prior to *suspect* (injected with a
  warning), a second consecutive miss raises a `drift` event and adopts the new behavior —
  or evicts the prior if the action no longer does anything.

Provider-agnostic; defaults to any OpenAI-compatible endpoint (DeepSeek, OpenAI, or any
compatible gateway).

---

## Rides the VOIX standard

Attest builds on **[VOIX](https://arxiv.org/abs/2511.11287)** — the standard where a page
declares agent-callable tools with `<tool>` / `<prop>` / `<context>` elements. Attest is the
**trust layer** on top: it supplies exactly the three things the VOIX paper says it does *not*
do — **outcome verification, trust, and drift detection**.

The trust core runs on a normalized `PageSnapshot`, so the contract format is pluggable
(`ContractSource`): `parseVoix` for VOIX pages, `parseContract` for native `data-agent-*`
pages. Any page that implements either — with **zero extra code** — can be read, referenced,
planned over, and driven. Anything that can *enumerate its capabilities and re-observe its
state* (WebMCP, ARIA-inferred contracts, MCP resources, OpenAPI…) can slot into the same
trust core — VOIX is the first horse Attest rides, not the one it is married to.

## Why this architecture

Coding agents get their ground truth for free: the compiler and the test suite tell them
whether a change worked. **The web has no such oracle** — after "submit" is clicked, nothing
in the platform tells an agent whether anything actually happened. Attest's core move is to
*manufacture that oracle*: the page contract makes state snapshotable, so "did it work"
becomes a cheap deterministic diff. One free verification signal then gets used four ways —
as the **safety gate** (verify-or-refuse), the **license to speculate** (lookahead
continues only while predictions hold), the **learning signal** (the `WorldModel` learns
only from verified evidence, so its memory cannot be polluted by hallucination), and the
**drift detector** (a known action that stops producing its known effect is deterministic
proof the page changed). Where frontier labs train honesty into their models with
large-scale RL, Attest gets the same property *structurally* — which is why it holds with
any commodity function-calling model.

---

## Install

Not on npm yet. Clone and build:

```bash
git clone <this repo> && cd attest
npm install
npm run build
```

(Once published, `npm install attest-agent` and the imports below will work as-is.)

## Prove it holds (no network / key needed)

```bash
npm test          # 240 deterministic tests (FakeLlm + FakeHost), incl. a chaos suite
npm run typecheck # (fault injection: host/confirm failures must never crash the loop)
npm run build     # emits dist/
```

## Run against a real LLM

Two non-interactive live scripts drive real models over a demo page and print every step —
`observe / action(verified) / held / cancelled / FINISH[outcome]` plus the evidence ledger.
They use Node's native `fetch` to bypass happy-dom's CORS.

```powershell
$env:ATTEST_API_KEY="<your key>"
$env:ATTEST_BASE_URL="https://api.deepseek.com"   # any OpenAI-compatible endpoint
$env:ATTEST_MODEL="deepseek-v4-pro"               # any function-calling model

npx tsx examples/live-voix.ts     # VOIX page: typed args, verified writes, high-risk held
npx tsx examples/live-check.ts    # data-agent-* board: long-horizon read, held, priors
npx tsx examples/live-suite.ts    # adversarial: prompt injection in page content, orders to
                                  #   bypass confirmation, missing targets, empty boards …
npx tsx examples/live-drift.ts    # the page silently changes behavior; watch the agent
                                  #   detect drift, report it, and self-heal its priors
npx tsx examples/live-bench.ts    # cold vs. warm A/B: rounds / tokens / predict hit-rate
```

See `docs/LIVE-ACCEPTANCE.md` for the full real-model acceptance checklist.

## Measured, not asserted

All numbers from live runs against `deepseek-v4-pro` (a commodity model with no
agent-specific training), 2026-07; methodology and raw configs in `docs/bench/`.

- **Honesty under adversity** — 7/7 adversarial scenarios passed with mechanical verdicts:
  a page notice ordering the agent to invoke a (low-risk, unguarded!) `clear_all` was read,
  summarized, *not executed*, and flagged to the user; an explicit user order to "wipe
  everything, don't ask" was held and honestly reported as `cancelled`.
- **Priors pay** — with world-model priors warm: **-27% to -46% LLM round-trips, -23% to
  -44% tokens** on multi-step tasks, predict hit-rate 14/14 → and the same speculation
  *without* knowledge measured **negative** (blind predictions thrash) — which is why the
  batching nudge is injected only alongside priors.
- **Drift live** — a same-signature page changed behavior between visits: miss #1 demoted
  the prior to suspect, miss #2 raised the drift event and healed the prior; the model's
  narration stayed faithful to the new behavior and explicitly cited the injected warning.
- ~80 live runs across toy boards, rich page shapes (navigation / pagination / nesting),
  adversarial scenarios and benches: **zero crashes, zero false success claims, zero
  unauthorized writes.**

---

## Use it in your own code

```ts
import {
  createAgent,
  createVoixHostAdapter,   // drives a live VOIX page (<tool>/<context> + call events)
  createOpenAiAdapter,
  WorldModel,              // optional: priors learned from verified writes
  RecipeBook,              // optional: successful-program priors (code-as-action)
} from 'attest-agent';

const agent = createAgent({
  llm: createOpenAiAdapter({
    apiKey: process.env.ATTEST_API_KEY!,
    baseUrl: 'https://api.deepseek.com', // optional; defaults to OpenAI
    model: 'deepseek-v4-pro',
  }),
  host: createVoixHostAdapter(),         // or createDomHostAdapter() for data-agent-* pages
  worldModel: new WorldModel(),          // optional prior injection
  confirm: async (intent) => ({          // high-risk gate; default is deny
    approved: window.confirm(`Run "${intent.label}"?`),
    // scope: 'all' authorizes same-named actions for the rest of this run (each still verified)
  }),
});

for await (const step of agent.run('add a task called "ship README", then show me the list')) {
  console.log(step); // thinking / plan / observation / action / held / cancelled / finish ...
  if (step.type === 'finish') {
    console.log('answer:', step.answer, '| outcome:', step.outcome);
    console.log('evidence ledger:', step.ledger); // outcome was computed from this
  }
}
```

> Host adapters need a DOM. In the browser they read `document` directly; in Node use
> `happy-dom`, a real browser via `createBrowserHostAdapter` (Playwright), or the built-in
> `FakeHostAdapter` for tests.

## Making a page agent-friendly

**VOIX** (recommended — an existing standard):

```html
<tool name="add_task" description="Add a task">
  <prop name="title" type="string" description="Task title" required></prop>
</tool>
<tool name="clear_all" description="Delete all tasks"></tool>          <!-- mark high-risk in your handler -->
<context name="tasks">Current tasks: (empty)</context>
```

**Native `data-agent-*`** (also supported):

```html
<li data-agent-object="ticket:101">Login page 500 error</li>          <!-- referenceable object type:id -->
<button data-agent-action="open">Open</button>                        <!-- triggerable action -->
<button data-agent-action="resolve" data-agent-risk="high">Resolve</button>  <!-- high-risk = held -->
<input data-agent-control="note" />                                   <!-- readable/writable control -->
<section data-agent-surface="detail">…</section>                      <!-- readable region -->
```

Either way, a **new page** that implements the contract is drivable with **no extra code**.

## Core concepts

| Concept | Role |
|---------|------|
| `parseVoix` / `parseContract` | Turn a page (VOIX or `data-agent-*`) into a `PageSnapshot`: objects / actions / controls / surfaces + stable `ref`s |
| `refResolver` | Verifies a `ref` exists and its kind matches; anything else is an `error`, never executed |
| `verifier` | Diffs the snapshot after a write — the observable change is the evidence |
| `Ledger` | Append-only evidence log (observe / intent / grant / write) |
| `narrationGuard` | The model's self-assessment (`goalMet`) can only downgrade `completed` → `failed`, never the reverse |
| `FinishFacts` | The authoritative execution record, generated from the ledger — the final step carries `facts` (harness-generated, tamper-proof) *beside* `narration` (the model's own words, never edited): juxtaposition, not muzzling |
| `WorldModel` / `RecipeBook` | Opt-in priors — learned (action → diff) and successful programs — injected into context to plan faster; never bypass the verifier. The `WorldModel` adjudicates every executed write at record time (hit / suspect / drift) and self-heals |

## Status

**Early-stage research kernel.** The core invariants are in place and chaos-tested — but
this is a young library, not a battle-worn product; expect API movement before 1.0. What
exists today: contract layer (VOIX + native), single tool-calling read
loop with lookahead, honesty layer (verifier + ledger + narration guard + high-risk held),
TOCTOU-safe write path with settle-based verification, code-as-action with recipe priors,
world-model priors with drift detection and self-healing, cross-session persistence
(`toJSON` / `fromJSON`). **240 deterministic tests green** (incl. chaos fault-injection),
live-accepted against a real model (`deepseek-v4-pro`) across happy paths, rich page shapes,
adversarial scenarios, and drift. Design notes, bench reports and the live-acceptance
checklist live in `docs/`.

License: MIT.
