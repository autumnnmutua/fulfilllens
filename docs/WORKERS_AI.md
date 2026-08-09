# Cloudflare Workers AI 可选连接

- 状态：已实现连接状态与固定合成探针
- 默认：关闭
- 数据边界：不会自动读取或发送订单、仓库事件、物流轨迹、映射结果或个人信息

## 用途与非用途

当前接入只用于证明本机 API 能否安全连接 Cloudflare Workers AI。它不是履约指标的输入，
不参与 OT、IF、OTIF、时长、异常率或数据覆盖率计算，也不构成“大模型诊断”。
阶段 6 透明诊断同样完全由确定性规则生成，不调用 Workers AI。

阶段 4 只提供：

- 脱敏配置状态；
- Token active 状态核查；
- 向指定模型发送仓库固定的合成短句；
- 返回连接状态、固定文本是否匹配和本次 token 用量。

不提供：

- 自由输入提示词；
- 自动上传导入数据；
- 将模型文本解释为事实、指标、异常根因或预测；
- 浏览器保存 API Token；
- 无显式确认的外部请求。

## 本机配置

复制 `apps/api/.env.example` 为已被 Git 忽略的 `apps/api/.env`，只在本机填入：

```dotenv
FL_WORKERS_AI_ENABLED=true
FL_CLOUDFLARE_ACCOUNT_ID=<32 位 Account ID>
FL_CLOUDFLARE_API_TOKEN=<Workers AI API Token>
FL_WORKERS_AI_MODEL=@cf/meta/llama-3.1-8b-instruct-fast
FL_WORKERS_AI_TIMEOUT_SECONDS=20
```

不得把真实 Token 写入 `.env.example`、README、测试、截图、日志或提交记录。Token 至少需要
`Workers AI - Read` 与 `Workers AI - Edit` 权限，并应限制到账户、来源 IP 和合理有效期。

## 接口

### 读取脱敏状态

```text
GET /api/integrations/workers-ai/status
```

响应只包含启用状态、是否配置、模型和数据策略，不返回 Account ID 或 Token。

### 显式执行固定探针

```text
POST /api/integrations/workers-ai/probe
X-FulfillLens-External-Call: confirm
```

探针没有请求体。即使调用方附加 `prompt`，服务端也不会读取；发送内容固定在后端源码，
因此不能借此把订单数据转发到外部服务。自定义请求头同时降低第三方网页对本机接口发起
无感跨站请求并产生用量的风险。

## 令牌泄露处理

若真实 Token 曾出现在聊天、工单、终端历史或其他非密钥管理位置，应在 Cloudflare 控制台
立即轮换，并只把新 Token 写入本机 `.env` 或进程环境。Cloudflare 的新式 `cfut_` 前缀支持
凭据扫描识别，不应把“尚未提交到 Git”理解为无需轮换。

## 官方参考

- <https://developers.cloudflare.com/workers-ai/get-started/rest-api/>
- <https://developers.cloudflare.com/fundamentals/api/troubleshooting/>
- <https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fast/>
- <https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/>

## 部署到 Cloudflare 时

Cloudflare 在线演示已经使用 Workers AI `AI` binding，由 Worker 调用 `env.AI.run()`，
Account ID/API Token 不进入浏览器。当前模型仍只执行固定合成连通探针，不会自动点击网页、
计算指标或替代透明诊断；FastAPI、DuckDB、SQLite、真实文件和持久云数据路径仍需单独迁移验证。
详见 [Cloudflare 部署与 Workers AI 可行性评估](CLOUDFLARE_DEPLOYMENT.md)。
