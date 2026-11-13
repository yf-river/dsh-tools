# Pinned sessions board

Adds a pinned-session board at the very top of the sidebar's Workspace list,
with a custom order, custom groups, and a running spinner.

## Install

```bash
dsh plugin --profile web add @yf-river/dsh-pinned-sessions
```

Or from this repository directly:

```bash
dsh plugin --profile web add github:yf-river/dsh-tools#plugins/dsh-pinned-sessions
```

## Why this replaces a built-in plugin

The sidebar's browsing region is a single `single` slot (`sidebar.workspaces`)
owned by `@deepseek-ai/dsh-client-ui-workspace`, and it exposes no seat above its
"Workspaces" section header. The only way to put a board there is to render that
region, so this bundle ships a copy of the built-in browser with one addition.

The copy is the installed package's `lib/client.js` verbatim, with these changes:

1. `window.__ModuleLoader__.load({ id })` registers as
   `@local/dsh-pinned-sessions`.
2. A `Pinboard` component is added and rendered as the first child of the
   browser root, above the section header (guarded by `wide`, so the collapsed
   icon rail is untouched).
3. The workspace view store gains pinboard fields and actions (see below).
4. Internal self-references (CSS `data-plugin-css` tag ids) are renamed to this
   package so the copy and the original never share a style tag.

Everything else — search, grouping, group collapse, drag reordering, workspace
context menu, rename/archive/fork dialogs, row hover buttons, the scheduled-task
row marks, the directory picker flow — is the shipped implementation, unchanged.
Because the copy keeps the original `children` declaration, the
`sidebar.session.row.*` seats and `sidebar.workspaces.directoryFlow` keep working.

`cordis.patch.yml` disables the `ui-workspace` row so the two copies never both
register into the same single slot.

## The board

**Rows.** One row per pinned Session; archived pins stay visible but muted. Click
opens the Session; right-click raises the shipped Session context menu through
the same `openSessionMenu` the built-in rows use, so pin, unpin, rename, archive,
fork, and copy id are the built-in actions with no duplicated logic.

**Order.** Drag a row within the board to reorder it. The drop line shows where
it will land. Until the first drag, rows follow the Host pin order (most recently
pinned first); after that the board keeps its own order, and rows pinned later
are appended. The order only positions rows that are still pinned: ids the pin
set no longer contains are skipped, so unpinning cannot leave a hole.

**Groups.** Press `+` in the board header to create a named group. Click a group
header to fold it; the chevron shows the state. A group is a layout over the pin
set, not a second pin store: deleting a group returns its rows to the board and
unpins nothing. A group header can be deleted with its `×`; an empty bucket is
pruned from the persisted map rather than kept as an empty array. Groups render
above an explicitly labelled ungrouped section, which is styled dashed and muted
so the two kinds of section are never confused.

**Moving rows in.** Drop a row from the Workspace list onto a group header to file
it there. Because the board renders the pin set, an outside row is pinned as part
of that drop — otherwise the row would hold a group slot that nothing draws. Drop
a row onto another row inside the same group to reorder that group; drop it on a
row in a different group to move it across. Dragging a row out of a group with
its `↩` button remembers the slot it left, so returning it lands back in place
instead of at the end.

**Status.** The row dot distinguishes four states by shape, not just colour:
idle is a small grey dot, running is a spinning ring, a pending question or
approval is a hollow warning ring, and a finished run is a solid ringed dot.
Under `prefers-reduced-motion` the spinner freezes into a static ring.

## Persistence

The layout lives in the browser-local workspace view store under the same
`dsh.workspace.view.v5` key, in `pinboardOrder`, `pinboardGroups`,
`pinboardGroupMembers`, and `pinboardSlotMemory`. The key was deliberately not
bumped: reading with defaults (`?? []`) keeps an existing profile's grouping and
expansion settings, and a store written before these fields existed simply reads
as an empty layout. Every pinboard action also tolerates a legacy draft — a
missing `pinboardOrder` is treated as an empty list rather than read blindly,
because `init()` only seeds a brand-new store and an upgraded profile holds data
written by the previous version. Nothing about pins is persisted here — the Host
pin set remains the single source of truth.

## Files

| File | Role |
|---|---|
| `index.js` | Host half; empty (pure Client plugin, matching the built-in). |
| `client.js` | The copied browser plus the pinboard. |
| `cordis.patch.yml` | Disables `ui-workspace`, inserts this bundle. |
| `locale/{en,zh}.json` | Plugin Manager metadata. |
| `icon.svg` | Bundle artwork. |

## Maintenance

`client.js` is a copy of a shipped bundle. When the Harness updates
`@deepseek-ai/dsh-client-ui-workspace`, re-copy its `lib/client.js` and re-apply
the changes above; verify with `cordis_inspect_query` that the
`sidebar.workspaces` occupant is this plugin and that the child slots still
declare. If the shipped store schema changes, keep the new fields and re-check
that old persisted data still reads through the `??` defaults. Disabling this
bundle in Plugins settings restores the built-in browser immediately.

## License

MIT. See [LICENSE](../../LICENSE) at the repository root.

---

侧边栏置顶会话面板：把跨工作区的置顶会话汇总成一个可折叠列表，支持自定义排序、自定义分组，并按状态区分每一行（运行中转圈、等你回答整行高亮、已完成淡绿、空闲）。
