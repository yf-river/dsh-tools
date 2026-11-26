# dsh-suggest-prompt

每个 agent 回合完成后，在输入框里垫一行浅灰幽灵文字，预测你的下一句；按 `Tab` 采纳进草稿。

上游：[`studyzy/dsh-suggest-prompt`](https://github.com/studyzy/dsh-suggest-prompt)（MIT）。本目录是 fork，包名改为 `@yf-river/dsh-suggest-prompt`，收进本仓库统一维护。

**为什么不是又一个「AI 建议」面板**：它只发最后一轮（你的输入 + AI 最终回答），不读工具调用与推理过程；发送前按密钥形状脱敏；输出做净化与语义过滤，套话和元文本当作「无建议」丢弃；整个链路不写会话日志，建议存在插件自己的 storage domain 里。

**代价**：每个完成回合多一次有界辅助 LLM 调用（默认 `reasoningEffort: off`、输出上限 512 token）。高频使用时可把建议模型显式指到更便宜的路由。

完整文档见 [README.md](./README.md)，用户操作指南见 [USAGE.zh.md](./USAGE.zh.md)。
