# dsh-suggest-prompt

每个 agent 回合完成后，在输入框里垫一行浅灰幽灵文字，预测你的下一句；按 `Tab` 采纳进草稿。

上游：[`studyzy/dsh-suggest-prompt`](https://github.com/studyzy/dsh-suggest-prompt)（MIT）。本目录是 fork，包名改为 `@yf-river/dsh-suggest-prompt`，收进本仓库统一维护。

**为什么不是又一个「AI 建议」面板**：它只发最后一轮（你的输入 + AI 最终回答），不读工具调用与推理过程；发送前按密钥形状脱敏；输出做净化与语义过滤，套话和元文本当作「无建议」丢弃；整个链路不写会话日志，建议存在插件自己的 storage domain 里。

**代价**：每个完成回合多一次有界辅助 LLM 调用（默认 `reasoningEffort: off`、输出上限 512 token）。高频使用时可把建议模型显式指到更便宜的路由。

完整文档见 [README.md](./README.md)，用户操作指南见 [USAGE.zh.md](./USAGE.zh.md)。

## 本机的两个必要配置

**建议模型不能选 codebuddy。** `dsh-codebuddy-sdk` 在工具列表为空时直接抛 `CODEBUDDY_NO_TOOLS`（「工具策略过滤后没有可用工具」），而建议生成本来就不带工具，于是每次都在 `catch` 里被吞掉、页面上什么都不显示。改成不要求工具的 provider，本机用的是 `deepseek-account`：

```yaml
- id: suggest-prompt
  name: '@yf-river/dsh-suggest-prompt'
  config:
    maxInputBytes: 4096
    maxOutputTokens: 512
    timeoutMs: 60000
    maxRecentTurns: 1
    maxTranscriptChars: 12000
    maxSuggestionChars: 240
    provider: deepseek-account
    model: deepseek-chat
    acceptKey: Tab
```

**覆盖 config 时必须把全部必填字段重写一遍。** 补丁层按行替换整个 `config`，不是深合并；漏掉 `maxInputBytes` / `maxOutputTokens` / `timeoutMs` / `maxTranscriptChars` / `maxSuggestionChars` 任何一个，插件在加载期就校验失败被整条禁用，`/api/suggest-prompt` 直接 404——而且 web profile 没有挂 console exporter，`ctx.logger` 的报错在 journalctl 里看不到。
