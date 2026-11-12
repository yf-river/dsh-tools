# ChainWeaver Bundle

- 本仓库拥有 ChainWeaver profile、产品组合配置及后续 ChainWeaver 插件；DSH 底层运行时位于相邻的 `chainweaver-studio` 仓库。
- `profiles/chainweaver.json` 是 profile 组合真源，按 `base → web-app → chainweaver-bundle` 加载。
- 产品裁剪与默认值写在 `cordis.patch.yml`。需要新增业务或界面行为时实现对应插件，由 bundle 组装。
- Superagent 的 Router、Worker 是内部执行预设，不随手动模式一起禁用。
- 本地验证使用 `.local/dsh`，不修改用户正在使用的 DSH_HOME，不自动提交、推送或部署。
- 修改后检查真实 profile 合成结果，并在真实页面检查受影响界面。区分配置、启动、界面与模型执行的完成层级。

- `packages/superagent` 为内置任务能力真源，`packages/platform` 为账号、隔离运行和项目管理真源。原相邻 Superagent 仓库不作为运行依赖。
