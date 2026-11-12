# 实施与验收

已确认：默认管理员 admin/123456；账号与容器隔离；Superagent 源码内置；单机公平队列；授权仓库对象缓存；确认交付七天后安全回收；联调通过后替换 3080 并删除旧演示运行数据。

- [x] 内部 Superagent 源码与独立构建，原仓库未修改。
- [x] DSH 内置 profile、必选组件、配置重载与移除保护。
- [x] 账号、会话撤销、管理员界面与个人 Git 凭据。
- [x] 用户容器、网络、UID、存储容量与统一入口代理。
- [x] 项目、多仓库、授权缓存租约与延迟创建 worktree。
- [x] 公平调度、中断确认、后台执行与安全回收。
- [x] 40 账号真实 HTTP 登录、队列上限与账号饥饿回归。
- [x] 双用户真实容器、Git 缓存、worktree、停用与恢复联调。
- [x] 指定 Node 22.15.0 的真实安装、版本选择与安全回收。
- [x] 独立镜像与当前源码构建一致；3080 入口的聊天、任务、账号返回与浏览器检查通过。
- [x] 3080 已切换为账号入口，空的旧 DSH_HOME 与旧访问地址文件已删除。

验证证据：

| 范围 | 结果与位置 |
|---|---|
| Superagent 回归 | 66 个文件、1,214 项通过，`.local/superagent-tests.log` |
| 平台与进程停止 | 8 项通过，`.local/platform-tests.log` |
| DSH profile 和必选组件 | 42 项及 CLI 初始化 18 项通过，`/tmp/cw-core-tests.log` |
| DSH 插件管理 | 271 项通过；初次运行的包管理环境问题修复后复验，`/tmp/cw-manager-tests.log`、`/tmp/cw-manager-rerun.log` |
| DSH 构建及类型检查 | 10 个构建关卡、2 个最终聚合检查通过，`/tmp/chainweaver-accounts-dsh-build.log`、`/tmp/cw-final-build-check.log` |
| 真实双用户 | `.local/isolation-verification-v2/verification.json` |
| 工具版本 | `.local/toolchain-verification/verification.json` |
| 页面检查 | `.local/live-browser-acceptance.log`、`.local/verification/` |
| WebSocket 与真实 CLI | 停用后连接在 29 ms 关闭；实际 CLI 拒绝移除内置 bundle，`.local/stream-verification/verification.json` |
| 执行策略 | 模拟 Agent 事件、真实协调服务，验证子 Agent 继承、Router Shell 与后台占位；`.local/runtime-policy-verification.log` |

40 账号验证覆盖登录与调度；真实 Docker 联调使用两个账号，默认最多驻留八个个人运行空间。真实模型执行验收需要测试账号自己的模型凭据，目前未执行。
