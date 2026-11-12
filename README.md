# dsh-skills

DeepSeek Harness 的技能集合。每个子目录是一个独立的 skill，由 dsh 在任务匹配时加载到 agent 上下文。

## 技能不是插件

| | Plugin | Skill |
|---|---|---|
| 本质 | 可执行代码，注入浏览器 | Markdown 文档 |
| 运行 | 在页面里运行，改变 UI | 不运行，只被 agent 阅读 |
| 用户 | 人 + agent | 只有 agent |
| 位置 | `~/.dsh/profiles/<name>/` | `~/.dsh/skills/` |
| 是否出现在插件列表 | 是 | 否 |

一个 skill 只写「怎么做」，不提供任何运行时能力。

## 安装

```bash
# 单个技能
cp -r dsh-ui-plugin-dev ~/.dsh/skills/

# 或全部
cp -r ./* ~/.dsh/skills/
```

技能以 `SKILL.md` 的 frontmatter 为入口，`name` 必须与目录名一致：

```yaml
---
name: my-skill
description: "何时使用这个技能。这段描述决定 agent 会不会加载它。"
---
```

`description` 是唯一的选择依据——写清楚触发场景，而不是写这个技能包含什么。

## 目录

### [dsh-ui-plugin-dev](./dsh-ui-plugin-dev/SKILL.md)

开发与调试 dsh 客户端 UI 插件时的约定。收录的每一条都来自真实事故：

- **内置图标**：`dsh-client-ui-primitives` 提供图标组件，自写 SVG 与宿主不一致
- **插槽优先级**：数值小者先渲染，`-1` 才盖得住内置的 `0`；同值直接抛错
- **子插槽不可转授**：接管一个插槽必须整份复制原组件，连 `children` 一起搬
- **React 元素**：`jsx('i', null)` 在 dev 运行时会抛错，导致整个插槽空白
- **拖放语义**：`dragover` 期间 `getData()` 返回空串；`preventDefault` 不调就不派发 `drop`
- **验证流程**：离线单测通不过不代表能用，必须读真实渲染结果

适用：涉及插槽、侧边栏、面板、装饰组件的任何改动。

## 写作约定

- `description` 写触发条件，不写内容摘要
- 只写「本框架特有」的事实。通用 React 知识、能一次试错学到的内容不值得写
- 每条约定附上违反后的**具体症状**，否则读的人不知道为什么要遵守
- 不要写「必须小心」这类没有操作性的告诫
