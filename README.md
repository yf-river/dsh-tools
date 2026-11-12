# dsh-tools

DeepSeek Harness 的技能与插件集合。

| 目录 | 内容 | 给谁用 |
|---|---|---|
| `skills/` | Markdown 文档，任务匹配时加载进 agent 上下文 | 只有 agent |
| `plugins/` | 可运行代码，注入浏览器或 Host | 人 + agent |

两者解决的是不同问题：技能让 agent **知道怎么做**，插件**提供运行时能力**。

## 安装

### 技能

```bash
cp -r skills/* ~/.dsh/skills/
```

技能以 `SKILL.md` 的 frontmatter 为入口，`name` 必须与目录名一致：

```yaml
---
name: my-skill
description: "何时使用这个技能。这段描述决定 agent 会不会加载它。"
---
```

`description` 是唯一的选择依据——写触发场景，不写内容摘要。

### 插件

```bash
# 本地开发：用 plugin_manager 装本地目录
# dsh 插件管理器会自动写入 profile 的 bundles 列表
```

插件需要 `package.json` 携带 `dsh.bundle.patch` 与 `dsh.client`，通过 `cordis.patch.yml` 插入 Loader。

---

## skills/

### [dsh-ui-plugin-dev](./skills/dsh-ui-plugin-dev/SKILL.md)

开发与调试 dsh 客户端 UI 插件时的约定。收录的每一条都来自真实事故：

- **内置图标**：`dsh-client-ui-primitives` 提供图标组件，自写 SVG 与宿主不一致
- **插槽优先级**：数值小者先渲染，`-1` 才盖得住内置的 `0`；同值直接抛错
- **子插槽不可转授**：接管一个插槽必须整份复制原组件，连 `children` 一起搬
- **React 元素**：`jsx('i', null)` 在 dev 运行时会抛错，导致整个插槽空白
- **拖放语义**：`dragover` 期间 `getData()` 返回空串；`preventDefault` 不调就不派发 `drop`
- **验证流程**：离线单测通不过不代表能用，必须读真实渲染结果

---

## plugins/

### [dsh-pinned-sessions](./plugins/dsh-pinned-sessions/README.md)

在侧边栏最上方加一个「置顶会话」区：跨工作区汇总所有置顶会话，支持自定义排序、自定义分组、折叠，并按状态区分行（运行中转圈 / 等你回答整行高亮 / 已完成淡绿 / 空闲）。

**为什么是复制的内置组件**：侧边栏浏览区是一个 `single` 插槽，它没有留出置顶区的座位。唯一的办法是把那个区域整个接管下来，所以本插件内含一份 `ui-workspace` 的浏览器副本，只加了置顶区这一处改动。代价是内置插件升级时需要重新复制。

**与工作区共用一个滚动条**：置顶会话多起来会挤掉工作区，所以两者被放进同一个滚动容器，置顶标题吸附在顶部。

### [dsh-agent-eyes](./plugins/dsh-agent-eyes/README.md)

让 agent 能读到页面的真实渲染结果。注册一个 inspect provider，暴露四个只读方法：

| 方法 | 回答什么 |
|---|---|
| `errors` | 有没有报错，堆栈是什么 |
| `dom` | 实际画出了什么，按所属插件的类名前缀归组 |
| `events` | 交互事件流，含 `defaultPrevented` |
| `probe` | 在页面里执行任意只读表达式 |

**为什么需要它**：agent 跑在 Host，插件跑在浏览器，两者之间只有结构化查询通道。所有「数据对、结构对、画面错」的 bug 在那边完全不可见。

### [dsh-restart-button](./plugins/dsh-restart-button/README.md)

在 设置 → 插件 增加一个「重启」页面。点击后由守护进程重新拉起 dsh，页面等待服务恢复并自动重载。

**为什么需要守护进程**：进程无法重启自己，只能退出。是否有东西把它拉回来，完全取决于谁启动了它。所以 Host 侧会先检测 `systemd`/`pm2`，没有守护时拒绝执行——否则这个按钮就成了关机按钮。

**什么时候真的需要它**：多数插件变更不用重启（HMR 会增量重载）。只有 `plugin_manager` 报告 `restart-required`，或改动涉及进程本身（端口、绑定地址）时才用得上。

---

## 写作约定

适用于本仓库的技能与插件：

- 注释写「为什么」，不写「是什么」
- 每条约定附上违反后的**具体症状**，否则读者不知道为什么要遵守
- 不写「必须小心」这类没有操作性的告诫
- 插件只用主题 token 着色，并提供 `prefers-reduced-motion` 降级
