---
name: dsh-ui-plugin-dev
description: "开发或调试 DeepSeek Harness 的客户端 UI 插件（插槽、侧边栏、面板、装饰组件）时使用。提供该框架特有的约定与已踩过的陷阱，避免重复犯错：内置图标、插槽优先级方向、React 元素构造、拖放语义、以及必须验证真实渲染的工作流程。"
---

# dsh 客户端 UI 插件开发

写这类插件时，**框架自身的约定**比通用 React 经验更重要。下面每一条都来自真实事故，违反任意一条都会让 UI 静默失效或整块崩溃。

## 一、动手前：先确认事实，不要假设

按顺序做完，再写第一行代码：

1. `cordis_inspect_list` —— 看当前有哪些 provider 可用
2. `cordis_inspect_query(provider:"Slots", method:"listSubTree", input:{root:"<目标插槽>"})`
   —— 确认插槽的 `kind`、`scope`、现有 `occupants` 及其 `priority`
3. `cordis_inspect_query(provider:"Service", method:"listService", input:{service:"<名字>"})`
   —— 确认服务是否存在、方法签名是什么
4. `cordis_inspect_query(provider:"Theme", method:"listTokens")` —— 只用真实存在的颜色 token

**禁止凭印象写 API。** 这一轮所有严重 bug 都源于「以为 API 是这样的」。

## 二、图标一律用内置的

`@deepseek-ai/dsh-client-ui-primitives` 提供内置图标组件（在内置插件里能观察到 **102 个**在用，实际导出更多）。自写 SVG 是错的：形状、尺寸、深浅都和宿主不一致。

**命名规律**：`Icon<Name><Fill|Outline><Regular|Medium>`

常用：

| 用途 | 组件 |
|---|---|
| 置顶（已置顶） | `IconPinFillRegular` |
| 置顶（未置顶） | `IconPinOutlineRegular` |
| 文件夹开/合 | `IconFolderOpenRegular` / `IconFolderCloseRegular` |
| 归档 / 取消归档 | `IconArchiveOutlineRegular` / `IconArchiveOffOutlineRegular` |
| 勾选 / 关闭 | `IconCheckOutlineRegular` / `IconCloseOutlineRegular` |
| 拖拽手柄 | `IconDragHandleOutlineRegular` |
| 复制 | `IconCopyOutlineRegular` |
| 编辑 | `IconEditOutlineRegular` |

**取值规律**：同一语义下 `Fill` = 已激活/已选中，`Outline` = 未激活。尺寸传 `size`，常用 `12`/`14`/`18`。

查全部：在任意已安装的 `dsh-client-ui-*/lib/client.js` 里搜
`grep -o "_deepseek_ai_dsh_client_ui_primitives\.Icon[A-Za-z]*" */lib/client*.js | sed 's/.*\.//' | sort -u`

## 三、插槽优先级：数值小者先渲染

这是最容易搞反的一条。`single` 插槽抢占时：

- 内置插件通常注册在 `priority: 0`
- **要盖过它，用 `priority: -1`**（更小），不是更大

```js
ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
  { name: 'sidebar.workspaces', priority: -1, locale: NS, inject: () => actions },
  MyComponent,
))
```

`occupants` 全部存在，实际渲染的是最小 priority 的那个；`active: false` 表示该注册被更小 priority 压过。

同一 priority 重复注册会直接抛错：
`single slot "x" already has a registration at priority 0 — register at a different priority to shadow it (lowest renders)`

**另一条路：禁用内置行。** 若只是想替换某个内置插件，在 `cordis.patch.yml` 里
`- id: <内置行id>\n  disabled: true` 比调 priority 更干净——不必猜测对方的 priority，也不会留下双份占用。代价是必须重启 dsh 进程才生效。

**子插槽不能转授。** 别的插件声明的 child slot（如 `sidebar.workspaces.directoryFlow`）绑定在它的 entry 上，你在自己的 `children` 里重新声明会抛
`slot "<key>" is already declared`。要接管就整份复制内置组件，连 `children` 一起搬，子插槽才能继续工作。

## 四、React 元素构造陷阱

手写 `jsx()` 调用（不经 Babel）时：

```js
jsx('i', null)   // ✗ dev 运行时抛 "Cannot read properties of null (reading 'key')"
jsx('i', {})     // ✓
```

`key` 必须作为**第三个参数**传，不能放进 props：

```js
jsxs('div', {...}, 'row-1')   // ✓
jsx('div', { key: 'row-1' })  // ✗ 警告 "props object containing a key prop is being spread"
```

数组里混了字面量和表达式时，每项都要 key，否则控制台刷屏。用 `...arr.map(...)` 展开，而不是把 `arr.map(...)` 作为一个数组元素。

**崩溃代价**：组件抛错会被插槽错误边界捕获，整个 `single` 插槽渲染为空白——侧边栏会整块消失，而不只是这一行。

## 五、HTML5 拖放的真实语义

两条必须记住的浏览器行为：

1. **`dragover` 期间 `dataTransfer.getData()` 返回空字符串。** 只有 `drop` 才能读数据。判断「可不可以接收」只能用 `dataTransfer.types`：

```js
const types = event.dataTransfer?.types
if (!types?.includes('text/plain')) return
event.preventDefault()   // 不调这个，浏览器根本不派发 drop
```

2. **`dataTransfer` 不跨组件共享状态。** 别的插件发起的拖动，你只能从 `dataTransfer` 里的 payload 得知拖动源；自己的内部状态（如 ref）读不到它。

**落点指示器用独立的零高度元素，不要给行加边框。** 边框会让行位移 2px，鼠标跨行时整个列表抖动。

**事件冒泡会覆盖精确落点。** 行和容器都监听 `dragover` 时，容器会覆盖行的结果。容器里要判断：

```js
if (event.target !== event.currentTarget && event.target.closest?.('.my-row') !== null) return
```

## 六、必须验证真实渲染

**离线单测通不过 ≠ 能用。** jsdom 里手写的假对象远比浏览器宽松，会掩盖真实行为——这一轮有 4 个 bug 是这样漏掉的。

改完插件后，固定走这个循环：

```text
1. cordis_inspect_query(provider:"agent-eyes", method:"errors")
   → 必须为空。有报错就不要往下走。

2. cordis_inspect_query(provider:"agent-eyes", method:"dom",
     input:{selector:".<你的类名前缀>"})
   → 确认节点数、painted 数、box 尺寸符合预期。

3. 让用户做一次交互，然后
   cordis_inspect_query(provider:"agent-eyes", method:"events",
     input:{type:"dragover"})
   → 确认 defaultPrevented 为 true；false 说明闸门没开，drop 不会发生。

4. cordis_inspect_query(provider:"agent-eyes", method:"probe",
     input:{expression:"..."})
   → 任何其它临时问题。
```

**没有读过真实结果，不许说「修好了」。** agent-eyes 不可用时明确说明，让用户代为确认。

## 七、插件包结构

```
my-plugin/
  package.json      # dsh.bundle.patch + dsh.client{platform:"web", inject:[...]}
  cordis.patch.yml  # - insert: [{id, name}]
  index.js          # export function apply() {}  Host 半身，纯 UI 插件留空
  client.js         # window.__ModuleLoader__.load({id, factory(require){...}})
  locale/{en,zh}.json
```

`dsh.client.inject` 里**列模块包名**（做加载顺序），不是服务名；服务通过
`ctx.get('<service>')` 取，并在导出的 `inject` 数组里声明。

改了 `cordis.patch.yml` 必须重启 dsh 进程才生效；只改 `client.js` 由 HMR 轮询自动重载，刷新页面即可。

## 八、主题与样式

- 只用 `Theme.listTokens` 返回的 token，不写死颜色
- 透明度用 `color-mix()` 或 rgba 叠加，不要假设浅色背景
- 过渡统一 `120ms var(--ds-ease-in-out, ease)`
- 必须提供 `@media (prefers-reduced-motion: reduce)` 降级
- 行高对齐宿主：会话行 `32px`，分组标题 `26px`，小组件按钮 `28×28`

## 九、数据兼容

给已有 store 加字段时，**`init()` 只在全新存储时执行**。老数据没有新字段，读写都要兜底：

```js
const list = Array.isArray(d.myNewList) ? d.myNewList : []
```

读取端用 `?? []`，写入端用 `Array.isArray()` 守卫。升 `persist` 键会让用户丢掉所有现有设置，宁可写兼容代码也不要升版本。
