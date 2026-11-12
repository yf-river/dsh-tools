# Agent eyes

Lets the agent see the live page. Registers one extra Client inspect provider
(`agent-eyes`) so the agent can read what the browser actually did, through the
same `cordis_inspect_query` tool it already uses.

## Why this exists

The agent runs in the Host process; plugins run in the browser. The shipped
inspect providers expose only *structure* — slot trees, service signatures,
theme tokens, config schemas. A plugin that renders the wrong thing, or throws
while rendering, is indistinguishable from a working one at that level.

Every bug in the pinned-sessions work that took multiple rounds was of exactly
that kind: data correct, structure correct, page wrong. This bundle closes the
gap without touching the shipped UI.

## The four methods

| Method | Answers |
|---|---|
| `errors` | What failed? Uncaught errors, unhandled rejections, `console.error`/`console.warn`, with stacks. |
| `dom` | What is actually painted? Painted nodes grouped by the class prefix of the owning plugin, with box sizes. |
| `events` | What did the user's interaction do? `click`/`dragstart`/`dragover`/`drop`/`dragend`/`keydown` with `defaultPrevented`. |
| `probe` | Anything else: evaluate one read-only expression in page scope. |

### Why `dom` filters for painted nodes

It skips anything with a zero box, `display:none`, `visibility:hidden`, or
`opacity:0`. A plain `querySelectorAll` cannot tell "rendered but invisible"
from "rendered" — and invisible-when-it-should-be-visible is the failure mode
that looks fine in logs and wrong on screen.

### Why attribution is by class prefix

This harness and its plugins namespace their classes (`psb-`, `bhn1Oq_`,
`YDXeBa_`). Grouping painted nodes by prefix answers "which plugin painted
this" without requiring that plugin to cooperate — so the observer covers
plugins that do not know it exists.

## Using it

```text
cordis_inspect_query(platform: "client", provider: "agent-eyes", method: "errors")
cordis_inspect_query(platform: "client", provider: "agent-eyes", method: "dom",
                     input: { selector: ".psb-group-block", limit: 20 })
cordis_inspect_query(platform: "client", provider: "agent-eyes", method: "events",
                     input: { type: "dragover" })
cordis_inspect_query(platform: "client", provider: "agent-eyes", method: "probe",
                     input: { expression: "document.querySelectorAll('.psb-row').length" })
```

A useful working loop: change a plugin, ask the user to reload, then read
`errors` first (did it crash?), `dom` second (did it paint?), `events` third
(did the interaction reach a handler?).

## Scope and limits

- **Observes only.** No application state is mutated, nothing is persisted.
- **Per-realm.** Counters start empty on every page load; a reload is a clean
  slate, which is what makes "check after reload" meaningful.
- **Bounded.** 80 errors and 200 events are retained; older entries are dropped.
- **This realm only.** It cannot see other tabs, and it cannot see the Host
  process.
- **`probe` is read-only by contract, not by enforcement.** It runs an
  expression in page scope with full page privileges. It is a debugging hatch
  for the local user's own agent, not a security boundary — do not treat its
  presence as sandboxing anything.

## Files

| File | Role |
|---|---|
| `index.js` | Host half; empty (pure Client plugin). |
| `client.js` | Capture hooks plus the inspect provider. |
| `cordis.patch.yml` | Inserts this bundle; disables nothing. |
| `locale/{en,zh}.json` | Plugin Manager metadata. |

## Relationship to a "self-check protocol"

This bundle makes the *page* observable. It does not make a plugin's
*intentions* observable: it can report that three nodes painted, but not that
the plugin expected five. That second layer — each plugin reporting its own
invariants — remains worth doing later, but it is a separate concern, and it
requires every participating plugin to adopt it. This bundle requires none.
