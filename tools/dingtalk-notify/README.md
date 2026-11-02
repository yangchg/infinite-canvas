# 钉钉工作通知（企业内部应用）

通知节点直接连接生成配置，监听该配置的执行结束；不放入流水线执行步骤。拖动通知节点左侧连接点到配置节点即可关联。手动生成、生成并替换、流水线触发均适用；多图生成汇总一次，部分失败记为失败；取消默认不通知，可勾选。通知发送独立于生成，不影响后续流水线和撤销，不重试收费生成。

## 配置与启动

1. 将此目录的 `config.example.json` 复制为 `config.local.json`。填写已有企业内部应用的 AppKey、AppSecret、数字 AgentId，以及允许接收通知的员工 userId 和显示名称。userId 是该企业下员工的标识，不是手机号、unionId 或昵称。接收员工必须在应用可用范围内，应用应具有发送工作通知权限。不要将真实凭据写进示例或提交到 Git；`config.local.json` 已忽略。
2. 配置 `allowedOrigins` 为实际画布地址。前端只读取应用名称和允许选择的员工，不读取密钥。服务仅绑定本机回环地址，通知通道通过现有 Nginx 同源代理访问。此方案沿用本地画布的访问边界，没有新增用户登录系统；能访问该画布服务的人可向白名单员工发送通知。
3. Windows 安装 Node.js 后运行 `tools/dingtalk-notify/Start-Notify.ps1`。它启动独立本地服务 `127.0.0.1:17374`。修改配置后需要重启这个服务。可在本地 `Start-Canvas.ps1` 中加入对该脚本的调用以随画布启动。
4. 将 `nginx-location.conf` 中的 location 加入 `D:\Canvas\nginx.local.conf` 的 server 内，检查配置并热加载。前端新节点还需按现有流程构建部署。
5. 新建“钉钉工作通知”，关联指定生成配置，选择应用、接收员工和成功/失败开关。每次执行使用开始时的通知设置；运行中新增连线不会追发通知。

服务尚未配置时，通知节点明确提示不可用，原生成行为不受影响。不需要外网回调地址，仅需本机能访问钉钉 HTTPS 接口。应用凭据不能放在画布节点、导出文件或前端环境变量中。

## 状态与边界

- “已提交”表示钉钉异步任务已受理，不代表送达或已读。点击“查询发送结果”查询；全部选定员工出现在已读/未读列表后才显示已发送。失败/不可用员工单独提示。
- 明确在提交前失败或被钉钉拒绝时，可“仅重发通知”。网络中断造成结果未知、部分员工发送失败时不提供自动重发，避免重复通知已收到的人。
- 服务保存事件 ID 和任务 ID 至本地 `data/deliveries.json`，重复事件不再发送；未知结果在重启后仍不会自动重发。记录不保存 AppSecret、访问令牌、图片或提示词，没有自动清理策略。不要删除运行中的记录文件。
- 前端最近一次状态保存在当前页面内存中；刷新后不恢复查询入口。关闭页面会中断浏览器执行及尚未提交的通知，不提供后台继续运行保证。服务已收到的通知继续处理。
- 通知包含画布名、配置名、成功/失败数量、耗时和运行 ID。失败详情留在画布，不向钉钉转发原始供应商错误、图片或提示词。单独重试输出图片、恢复视频任务不属于重新执行配置节点，不额外触发该配置的通知。
- 未配置可用模型而未开始执行时不会发通知。取消、替换目标被修改/断开不会误报成功。

## 验证

`node --test tools/dingtalk-notify/server.test.mjs web/tests/canvas-notifications.test.mjs web/tests/replace-config-output.test.mjs web/tests/canvas-pipeline.test.mjs`

测试使用模拟钉钉和生成接口，不发送实际消息、不产生生成费用。实际应用权限、可用范围、送达以及浏览器交互需配置后验收。

接口依据：[获取企业内部应用令牌](https://open.dingtalk.com/document/development/obtain-orgapp-token)、[发送工作通知](https://open.dingtalk.com/document/orgapp/asynchronous-sending-of-enterprise-session-messages)、[查询发送结果](https://open.dingtalk.com/document/orgapp/gets-the-result-of-sending-messages-asynchronously-to-the-enterprise)。
