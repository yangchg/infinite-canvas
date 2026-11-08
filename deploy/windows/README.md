# Windows 本地部署

本目录包含当前 Windows + Docker Desktop 部署需要的 Dockerfile、Compose、Nginx、固定供应商中转、启动和重启脚本。所有路径相对于仓库，不依赖 `D:\Canvas`。保留现有端口、超时和不自动重试行为。

## 首次部署

1. 安装并启动 Docker Desktop（Linux 容器），安装 Node.js 24，并确保 `docker`、`node.exe` 在 PATH 中。
2. 复制本目录 `.env.example` 为 `.env`，填写本机局域网 IPv4 地址 `CANVAS_LAN_IP`。换电脑后应修改此值。
3. 复制 `../../tools/dingtalk-notify/config.example.json` 为同目录的 `config.local.json`，填写企业应用凭据、AgentId 和接收用户。`allowedOrigins` 包含实际画布访问地址（含端口）。接收人需在应用可用范围内。
4. 双击 `Deploy.cmd` 构建并启动；日常启动双击 `Start.cmd`。局域网访问还需 Windows 防火墙允许所需来源访问 TCP 3000；脚本不会自动修改防火墙。
5. 按 [账号服务说明](../../server/README.md) 设置初始管理员环境变量，在本目录执行 `docker compose exec -e ADMIN_USERNAME -e ADMIN_PASSWORD backend npm run create-admin`，随后清除密码环境变量。使用 `http://localhost:3000` 或 `http://<本机局域网IP>:3000` 登录，创建项目并分配成员。旧浏览器画布不自动迁移，需要先在旧版导出后导入。

若构建网络需要代理，在 PowerShell 中设置自己的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY=localhost,127.0.0.1` 后运行 `./Start-Canvas.ps1 -Build`。代理地址不写死到脚本中。

## 更新与重启

- 日常更新推荐双击 `Update.cmd`：检查后台无运行中任务 → 构建镜像 → 在正在运行的后端容器内备份数据库和附件至仓库 `data/backups/before-update-*` → 更新容器 → 检查页面、通知服务和数据库。需要现有后端正在运行；首次安装仍用 `Deploy.cmd`。构建或备份失败不替换容器，更新后的检查失败会明确报错，不自动回滚。
- 构建需要代理时，在本目录终端运行 `Update.cmd -ProxyUrl http://127.0.0.1:7890`（换成你实际的代理地址）；不传参数则沿用环境代理。脚本结束恢复原环境变量。更新期间请勿开始新生成任务，也请其他使用者暂停操作；脚本会重复检查任务，但不会锁定全站。
- 更新代码后运行 `Deploy.cmd`，再刷新画布页面。它构建前端和账号后端容器，不自动提交代码。
- 通知配置或通知服务源码改变后，双击 `Restart-DingTalk.cmd`，再刷新画布页面。
- `Stop-Canvas.ps1` 停止前端和账号后端容器，保留 Windows 通知和供应商中转进程。
- 固定供应商中转只转发至 `https://api.niumatoken.com`，监听回环端口 17373；钉钉服务监听回环端口 17374。Nginx 通过 Docker Desktop 的 `host.docker.internal` 访问，DNS 禁用 IPv6。此套脚本面向 Windows Docker Desktop，不能直接作为 Linux 服务器部署方案。
- 若电脑上已有旧路径启动的供应商中转，它会继续复用现有健康服务。下次该进程停止后，新脚本将从本目录启动服务。同一 Compose 项目名称会接管现有前端容器。

## 必须单独保存的本地数据

后台图片任务由单个 backend 进程执行，任务、恢复检查点和撤销数据随 `data/canvas-server/` 持久化；当前不要将多个 backend 实例连接到同一数据库。关闭浏览器不会停止已提交任务；关闭电脑或服务会中断执行，重启后仅能继续查询已记录供应商任务 ID 的异步任务，结果未知的请求不会自动重提。部署前应先等待正在运行的任务完成。

Compose 已设置 `DINGTALK_NOTIFY_URL=http://app:3000/notifications/dingtalk`，供后台通过现有 Nginx 转发通知。手动启动后端时需设置对应可访问的通知服务地址，否则生成仍执行，但通知状态会显示未配置。任务快照包含服务器模型凭据，数据库与备份应按密钥文件保护，不提交版本库。

以下文件不提交 Git，也不送入 Docker 构建上下文：

- `tools/dingtalk-notify/config.local.json`：真实密钥和接收员工。
- `tools/dingtalk-notify/data/`：通知去重与任务记录；迁移服务前先停止服务再备份，恢复后启动。
- `deploy/windows/.env`：本机地址配置。

- `data/canvas-server/`：账号、项目、画布、发布版本和附件，使用 [备份恢复流程](../../server/README.md) 保存和迁移，不能只备份 Docker 镜像。

素材库列表、独立工作台历史与 AI API 配置仍在浏览器本地并按账号隔离，迁移电脑时另行导出。日志无需随部署迁移。部署链路仍需在实际机器验收。

钉钉服务的权限、通知状态及测试说明见 [通知服务说明](../../tools/dingtalk-notify/README.md)。
