# ChainWeaver

ChainWeaver 是 DSH 的内置产品 bundle，包含独立发展的 Superagent 源码，以及账号、个人运行空间和项目管理。

## 入口与权限

管理员首次启动默认使用 `admin / 123456` 登录。管理员可以创建、停用和重置账号，查看资源及登记共享仓库；项目、任务、文件、模型配置和 Git 凭据属于各自账号。修改密码或停用账号会撤销旧登录；停用同时停止个人运行空间，数据保留。

每个账号使用独立 UID、Docker 网络、DSH_HOME 和持久卷。平台代理统一校验登录，后端端口仅绑定宿主机回环。默认登录有效期八小时。浏览器通过 `/app/` 使用自己的 DSH 与 Superagent。

## 开发

需要 Node.js 24.9 以上、pnpm 11，以及相邻的 `../chainweaver-studio` 源码与构建产物。

```sh
pnpm install
pnpm build
pnpm test
pnpm platform setup
pnpm platform
```

平台默认监听 `127.0.0.1:33090`。`CHAINWEAVER_HOST`、`CHAINWEAVER_PORT` 和 `CHAINWEAVER_PLATFORM_HOME` 指定监听地址、端口和数据目录。个人运行空间需要先构建运行镜像，并由具有 Docker 和 loopback 挂载权限的服务启动。

| 路径 | 职责 |
|---|---|
| `profiles/chainweaver.json` | base、Web 与内置产品 bundle 的组合真源 |
| `cordis.patch.yml` | 模式和界面配置、必选运行插件 |
| `packages/platform` | 账号、会话、代理、容器、项目及调度 |
| `packages/runtime` | Agent 执行租约、活动状态与账号入口 |
| `packages/superagent` | 内嵌任务服务、Router、Worker 与任务界面 |
| `deploy/runtime` | 个人开发环境镜像及容器内辅助命令 |

Superagent 不依赖相邻的原仓库；上游来源记录在 `packages/superagent/UPSTREAM.md`。`chainweaver` profile 的产品 bundle、运行插件和 Superagent 不能通过插件管理或配置重载关闭；`web`、`sdk`、`acp` 可独立使用。

## 部署

1. 在 DSH 仓库完成 `pnpm build`，在本仓库完成 `pnpm build`。
2. 运行 `node scripts/build-runtime.mjs` 构建 `chainweaver/runtime:0.1.0`。
3. 运行 `pnpm platform setup` 初始化平台控制 profile。
4. 安装 `deploy/chainweaver-users.slice` 与 `deploy/chainweaver.service`，检查服务中的路径及监听地址后启动服务。

默认全局执行并发为 2，每账号为 1；嵌套子 Agent 继承父执行。最多驻留 8 个个人运行空间。每个空间最多使用 2 核，空闲内存上限 768 MiB，执行时 4 GiB；所有个人空间合计受 16 GiB、8 核和 4096 个进程上限约束。无任务、后台作业和自动化职责的空间空闲二十分钟后可停止。服务重启后旧执行需要确认恢复。

用户卷默认 4 GiB，共享 Git 缓存卷默认 20 GiB，均使用独立 ext4 loopback 文件提供硬容量限制。平台创建新卷时预留宿主机十六 GiB 空间。UID 和共享缓存组通过 `/var/lib/chainweaver/identities.sqlite` 统一分配。专用容器网络从 `10.254.0.0/16` 分配 `/29`；部署前须确认该段未用于现有业务路由。

项目可以包含多个仓库；首次执行时才按仓库创建 worktree、记录基线。Node、Java、Go、Python 的版本文件和项目指定版本由容器内 [mise](https://mise.jdx.dev/dev-tools/) 准备，工具和依赖缓存保存在个人卷。容器不提供 Docker socket、数据库或 Compose 服务。

只有管理员登记为具有相同代码读取权限的账号才能借用同一仓库对象缓存。每个用户仍通过自己的 Git 身份验证访问。缓存只读挂载，租约覆盖项目仓库的整个借用周期；平台不对借用中的对象执行 GC。

确认交付七天后，在个人运行空间停止且调度入口暂停期间，仅回收无修改、无未跟踪或忽略文件、无额外成果且没有运行进程占用的执行目录，并保留成果 Git 引用。检测失败时保留目录。平台不会自动提交或推送。

验证记录见 `IMPLEMENTATION.md`。真实模型执行验收需要测试账号自己的模型凭据。
