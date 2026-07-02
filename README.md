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
from the model's own narration.

- **Ref-binding + harness validation** — a `ref` the model emits must resolve to a real
  object the page exposes, or the action is refused. No guessed selectors, no hallucinated
  actions.
- **Verify-or-refuse** — after every write, the harness diffs the page snapshot; the
  observable change *is* the evidence. No evidence → the write did not "succeed".
- **High-risk held** — submit / checkout / approve and other dangerous actions pause for an
  explicit Intent Receipt first. Default is deny.
- **Lookahead + priors, not blind replay** — the model plans several steps ahead and may
  predict their effects; a `WorldModel` and `RecipeBook` feed *priors* learned from past
  evidence into its context. The verifier is always the single source of truth — priors only
  make the model plan faster, they never bypass it.

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
planned over, and driven.

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
npm test          # 186 deterministic tests (FakeLlm + FakeHost)
npm run typecheck
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
```

See `docs/LIVE-ACCEPTANCE.md` for the full real-model acceptance checklist.

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
| `narrationGuard` | Computes `outcome` from the ledger; forbids narrating a failure or cancellation as success |
| `WorldModel` / `RecipeBook` | Opt-in priors — learned (action → diff) and successful programs — injected into context to plan faster; never bypass the verifier |

## Status

Core is complete — contract layer (VOIX + native), single tool-calling read loop with
lookahead, honesty layer (verifier + ledger + narration guard + high-risk held), long-horizon
+ references, code-as-action with recipe priors, world-model priors, and cross-session
persistence (`toJSON` / `fromJSON`). **186 deterministic tests green**, and live-accepted
against a real model (`deepseek-v4-pro`). Design notes and the live-acceptance checklist live
in `docs/`.

License: MIT.
