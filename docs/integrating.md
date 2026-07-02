# Integrating Attest: bring your own host, contract, or LLM

Attest's trust core is deliberately small. Everything page- or provider-specific plugs in
through three seams. This guide states the **contracts your implementation must honor** —
the kernel's honesty guarantees are only as good as the adapter under them.

## The three seams

| Seam | Interface | Ship your own when… |
|---|---|---|
| Page driver | `HostAdapter` | your pages aren't plain DOM (canvas app, native webview bridge, remote browser, test rig) |
| Contract format | `ContractSource` (`(root, url) => PageSnapshot`) | your pages expose capabilities in a format other than VOIX / `data-agent-*` (WebMCP, ARIA-inferred, OpenAPI…) |
| Model provider | `LlmAdapter` | you're not on an OpenAI-compatible endpoint |

## Writing a `HostAdapter`

```ts
interface HostAdapter {
  snapshot(): PageSnapshot;                    // re-observe current page state
  readSurface(ref: Ref): string;               // text of a surface listed in the snapshot
  openObject(ref: Ref): Promise<HostResult>;   // HostResult = { ok, snapshot, note? }
  navigate(ref: Ref): Promise<HostResult>;
  setControl(ref: Ref, value: string): Promise<HostResult>;
  invokeAction(ref: Ref, args?: Record<string, unknown>): Promise<HostResult>;
}
```

**Invariants the kernel assumes — violate these and honesty silently degrades:**

1. **Snapshots are cheap and repeatable.** The kernel snapshots before *and* after every
   write (verify-or-refuse), re-snapshots after `confirm` waits (TOCTOU), and re-snapshots
   during settle backoff. If the page hasn't changed, two snapshots must expose the **same
   ref ids** — refs are how the kernel re-finds things.
2. **Effects must be observable in the snapshot.** `verify` is literally
   `diffSnapshots(before, after)`. If your `setControl` succeeds but the next snapshot
   still shows the old value, every write will be reported "unverified" forever. This
   includes *failures*: a page that rejects an operation should surface that rejection
   (status/error text) so the outcome is attestable.
3. **Don't throw for expected failure.** Return `{ ok: false, snapshot, note }`. Thrown
   exceptions are treated as host faults (ledgered as errors, never crash the loop) — but
   they carry less signal than a note.
4. **Ref ids are opaque but stable.** The kernel never parses ids beyond exact match;
   mint them however you like (`RefMinter` gives you `kind:key` with dedupe), just keep
   them stable across snapshots of an unchanged page.
5. **Async rendering is tolerated, not unlimited.** After a no-change write the kernel
   re-snapshots at 25/75ms. If your page settles slower, make `invokeAction` resolve when
   the effect is applied (the VOIX adapter waits for the page's `return` event — that's
   the pattern).

**Validate before you trust it** — run the conformance checker in your test suite:

```ts
import { checkHostContract } from 'attest-agent';

const results = await checkHostContract(host);                     // read-only checks
// const results = await checkHostContract(host, { mutating: true, // + write-effect checks
//   probeValue: '42', safeActionRef: 'action:ping' });            //   on a page you own
expect(results.filter(r => !r.pass)).toEqual([]);
```

Checks: snapshot repeatability, ref uniqueness, ref-kind consistency, surface readability,
and (opt-in `mutating`) open-object behavior and **write-effect observability** — the one
integrators get wrong most often. Action probing only runs against a `safeActionRef` you
name explicitly, so the checker can never trip a dangerous action.

## Writing a `ContractSource`

A contract source is just `(root: ParentNode, url: string) => PageSnapshot`. Look at
`parseVoix` (~60 lines) as the template. Rules of thumb:

- **Only expose what the page really offers.** The kernel refuses refs it can't resolve —
  that's the anti-hallucination gate. A parser that invents capabilities defeats it.
- **Mark risk.** Anything irreversible or outward-facing → `risk: 'high'` so the kernel
  holds it for user confirmation. When inferring (no authored contract), set
  `provenance: 'inferred'` — the kernel then holds **all** writes on those handles.
- **Make state legible.** Surfaces are what the model reads and what appears in snapshot
  previews. Expose success *and failure* states as surface text (see: business failures
  must be attestable).
- Use `queryAllDeep` if your pages hide structure in open shadow DOM / same-origin iframes.

## Writing an `LlmAdapter`

One method: `step(messages, tools) => Promise<{ content, toolCalls }>`. The built-in
`createOpenAiAdapter` covers OpenAI-compatible endpoints (retry/backoff/429 included);
wrap anything else so it emits tool calls in that shape.

## API stability (pre-1.0)

| Tier | Surface | Promise |
|---|---|---|
| **Stable** | `createAgent`, `AgentStep`, `HostAdapter`, `HostResult`, `PageSnapshot`, `Ref`, `Outcome`, `LedgerEntry`, `FinishFacts`, `parseVoix`, `parseContract` | breaking changes only with a major bump and changelog entry |
| **Settling** | `WorldModel`, `RecipeBook`, program AST (`runProgram`, `Node`), `checkHostContract` | shape may still move; changes called out in commits |
| **Internal** | anything not exported from `attest-agent` | no promises — don't deep-import |

`test/index.test.ts` guards the export surface; if it's exported, it's at least Settling.
