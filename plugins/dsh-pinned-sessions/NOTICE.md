# Upstream provenance

`client.js` is a **modified copy** of a file shipped with the DeepSeek Harness
Web UI, not an original work. Its upstream is:

| | |
|---|---|
| Source package | `@deepseek-ai/dsh-client-ui-workspace` |
| Upstream repository | <https://github.com/deepseek-ai/deepseek-harness> |
| Upstream path | `packages/client/ui-workspace` |
| File copied | the built client bundle `lib/client.js` |
| License | MIT (see `LICENSE`) |

## Why a copy exists

The sidebar's browsing region is a single `single` slot (`sidebar.workspaces`)
owned by `@deepseek-ai/dsh-client-ui-workspace`. A `single` slot renders exactly
one occupant, and the shipped occupant exposes no seat above its "Workspaces"
section header. There is no supported way for a third-party plugin to add a
pinned-session board above that list, so this project renders the region itself.

Copying the shipped bundle — rather than reimplementing the browser — keeps every
built-in behaviour intact: search, grouping, group collapse, drag reordering,
workspace context menus, rename/archive/fork dialogs, row hover actions, the
scheduled-task row marks, and the directory picker flow. It also preserves the
region's declared child slots (`sidebar.session.row.*`,
`sidebar.workspaces.directoryFlow`), so other plugins' contributions still render.

## What was changed

Applied to the copy, and nothing else:

1. `window.__ModuleLoader__.load({ id })` registers as `@local/dsh-pinned-sessions`.
2. A `Pinboard` component is added and rendered above the section header, gated
   on `wide` so the collapsed icon rail is untouched.
3. The workspace view store gains `pinboardOrder`, `pinboardGroups`,
   `pinboardGroupMembers`, and `pinboardSlotMemory`, plus the actions that
   maintain them.
4. `SessionTree` accepts a `pinnedSessionIds` prop and omits those rows from the
   Workspace list, so a pinned Session is not listed twice.
5. Internal CSS `data-plugin-css` tag identifiers are renamed to this package so
   the copy and the original never share a style tag.

## Maintaining the copy

When the Harness updates `@deepseek-ai/dsh-client-ui-workspace`, re-copy its
`lib/client.js` and re-apply the five changes above. Verify with the Harness
slot inspector that this plugin occupies `sidebar.workspaces` and that the child
slots still declare.

The upstream project is licensed MIT, which permits this redistribution provided
the original copyright notice is retained — hence `LICENSE` carries both the
DeepSeek and the contributor copyright lines.
