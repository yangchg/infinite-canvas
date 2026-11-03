# 账号与项目服务

本分支需要前端与 Node.js 24.13+ 后端同时运行。SQLite 存账号、项目、成员、画布、发布快照和审计记录，附件存部署机器的数据目录。浏览器清缓存不会删除服务端画布。

## 权限与使用方式

- 注册只能获得普通用户身份。初始管理员由部署者执行命令创建，后续管理员通过管理页面授权。
- 管理员创建项目并分配成员；普通用户只看自己加入的项目。管理员可维护项目和成员，但不能直接读取或编辑他人的私有草稿。
- 新画布默认私有，只有所有者修改。公共画布是显式发布的快照，展示所有者；继续编辑草稿不改变公共版本，须再次发布。
- 每张画布首次保存时由数据库统一分配 `HB-000001` 格式的唯一编号，同一部署内跨项目不重复。编号固定不变，复制、导入和使用记录分配新编号；已有画布启动时补号。编号不是访问凭证，所有接口仍检查项目与所有者权限。
- “使用”创建当前用户的私有使用记录；“复制”创建独立私有画布。生成操作使用使用者自己的模型配置，结果不会写回原画布。使用记录不能直接发布，独立画布可以发布。
- 公共范围是项目内，不支持匿名访问。撤销发布不撤回别人已经复制、使用或导出的内容。
- 管理员可转移所有权、下架公共版本、管理回收站；原所有者失去编辑权。项目归档后禁止新建、保存、发布和使用，仍可查看与导出；管理员仍可下架、转移和管理画布回收站。已删除项目先恢复，再管理其中画布。
- 删除为软删除，不自动清空。恢复画布不会自动恢复公开状态。附件与历史快照暂不物理清理，部署者需监控磁盘空间。

## 本地开发

在 `server` 目录执行 `npm ci`，然后在 PowerShell 设置：

```powershell
$env:ADMIN_USERNAME = 'admin'
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host '初始管理员密码' -AsSecureString)).Password
npm run create-admin
Remove-Item Env:ADMIN_PASSWORD
$env:PORT = '3001'
$env:APP_ORIGIN = 'http://localhost:3000'
npm start
```

另开终端在 `web` 按原项目依赖安装方式启动开发服务，访问 `http://localhost:3000`。Vite 将 `/api` 转发到 `127.0.0.1:3001`。创建项目并分配成员后，普通用户才能创建画布。不自动导入旧浏览器数据；需要时先在旧版导出 ZIP，再在新版项目内导入。

## Docker 部署

仓库根目录执行 `docker compose up -d --build`。初始管理员使用环境变量传给容器，不写入镜像：

```powershell
$env:ADMIN_USERNAME = 'admin'
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host '初始管理员密码' -AsSecureString)).Password
docker compose exec -e ADMIN_USERNAME -e ADMIN_PASSWORD backend npm run create-admin
Remove-Item Env:ADMIN_PASSWORD
```

上述示例在本地将安全输入转为临时进程环境变量，执行后清除。Windows 部署脚本见 [说明](../deploy/windows/README.md)，使用对应 Compose 文件执行初始化。没有默认密码，注册账号不会自动升级管理员。

数据绑定到仓库的 `data/canvas-server/`，不能只备份镜像。若通过域名或局域网访问，先配置实际 Origin（协议、主机、端口必须一致）。公网部署应由反向代理提供 HTTPS；后端不直接暴露端口。`TRUST_PROXY=1` 仅适合本仓库的单层代理，代理必须覆盖客户端传来的转发地址头。

| 后端环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| DATA_DIR | data | SQLite 与附件目录 |
| HOST / PORT | 0.0.0.0 / 3000 | 监听地址 |
| APP_ORIGIN | http://localhost:3000 | 允许的前端来源 |
| APP_ORIGINS | 未设置 | 可选逗号分隔来源列表，覆盖 APP_ORIGIN |
| MAX_CANVAS_BYTES | 20971520 | JSON 请求上限 20 MiB |
| MAX_FILE_BYTES | 104857600 | 单附件上限 100 MiB |
| AUTH_ATTEMPTS_PER_MINUTE | 10 | 同 IP 每分钟失败登录上限；注册请求同样限流 |
| SESSION_TTL_MS | 604800000 | 会话有效期 7 天 |
| TRUST_PROXY | 未设置 | 设为 1 时信任一层反向代理 |

Docker 更改限制需在 Compose 的 `backend.environment` 中添加对应变量并重建容器；调高附件上限还需同步修改 Nginx 的 `client_max_body_size`。所有来源均为 HTTPS 时会话 Cookie 自动启用 Secure。更改密码、禁用或更改角色会撤销已有会话。

## 保存、隐私与数据范围

画布自动保存带版本号，多标签页冲突返回 409，不覆盖服务端新版本。断网、超限、权限撤销或会话过期时，当前页面保留未保存草稿，可重试或导出；关闭页面前务必导出，未保存草稿仅在内存中。登录过期可在新标签页重新登录原账号，再回原页面重试。

发布不包含助手对话，且拒绝常见凭据字段。发布前仍须自行确认提示词、图片和自定义节点内容适合项目成员查看。公共预览展示节点位置、文字和媒体；完整插件交互和生成操作在自己的使用记录中进行。

AI API Key、素材库列表、独立图片/视频工作台历史仍存浏览器，按账号隔离；AI 调用仍由浏览器直接请求供应商。WebDAV 不再同步画布，避免绕过项目权限。服务端管理员拥有部署机器的操作权限，可读取磁盘数据；应用内私有权限不等于对机器管理员加密。

## 备份与恢复

本地在 `server` 执行 `npm run backup -- <数据目录之外的全新备份路径>`。命令使用 SQLite 在线备份，再复制不可变附件。将备份目录复制到其他机器；不要只拷贝正在写入的 SQLite 主文件。

Docker 可先执行 `docker compose exec backend npm run backup -- /tmp/canvas-backup`，再执行 `docker compose cp backend:/tmp/canvas-backup ./canvas-backup`；每次使用新的备份目录名称，命令不会覆盖已有目录。

恢复时停止后端，保留当前数据目录作为回滚备份；将备份中的 `canvas.sqlite` 与 `files/` 放入一个全新数据目录，并将 `DATA_DIR` 或容器绑定目录指向它。不要把备份数据库覆盖在旧的 `-wal`、`-shm` 文件旁。启动后验证账号、成员、私有画布、公共版本和附件。

## 验证

`npm test` 运行临时数据库上的接口行为测试，不操作部署数据。前端页面和 Docker 部署仍需按 [待验收清单](../docs/content/docs/progress/pending-test.mdx) 验收。
