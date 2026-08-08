# 故障排查

先记录操作系统、Node/npm、Python、浏览器和运行方式。只使用合成输入，粘贴日志前删除姓名、手机号、地址、身份证、订单号、Token 和个人绝对路径。

## 环境诊断

```powershell
node --version
npm.cmd --version
python --version
git --version
docker --version
```

项目要求 Node.js `>=22.12 <25`、npm `>=10`、Python `>=3.11`。Docker 仅在使用 Compose 时需要。

## PowerShell 拒绝运行 npm.ps1

使用 `npm.cmd`：

```powershell
npm.cmd ci
npm.cmd run dev
```

不需要为了本项目降低全局 PowerShell 安全策略。

## Python 命令找不到项目依赖

确认虚拟环境已创建并激活：

```powershell
python -m venv apps/api/.venv
.\apps\api\.venv\Scripts\Activate.ps1
python -m pip install -r apps/api/requirements-dev.txt
python -m pip check
```

如果组织策略禁止运行激活脚本，可临时把虚拟环境脚本目录放到本次终端 PATH：

```powershell
$env:PATH = "$(Resolve-Path apps/api/.venv/Scripts);$env:PATH"
python -m pip check
```

## 5173 或 8000 端口被占用

开发脚本使用固定端口并在冲突时失败，避免误连其他服务。Windows 可检查：

```powershell
Get-NetTCPConnection -LocalPort 5173,8000 -ErrorAction SilentlyContinue
```

停止你确认属于自己的进程，或在 `.env` 中调整 API 端口并同步配置 `FL_API_PROXY_TARGET`。不要盲目终止未知系统进程。

## Web 显示 API 不可用

分别检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod http://127.0.0.1:8000/api/version
```

开发 Web 通过 `/api` 和 `/health` 代理到 `127.0.0.1:8000`。检查 `.env` 中 CORS 源是否为完整的明确 HTTP/HTTPS 来源；生产配置不允许 `*`。

## CSV 中文乱码或编码不确定

- 优先从来源系统导出 UTF-8 CSV；
- 无法可靠识别时，在导入向导中明确选择 GB18030/GBK 或 UTF-8；
- 不要因预览“看起来大致正确”就忽略替换字符；
- 可先使用 `data/templates/` 的空模板验证列名。

## XLSX 无法打开或被拒绝

系统不会执行宏或公式，并检查 ZIP 条目、压缩后/解压后大小和工作表。确认文件是 `.xlsx`，不是旧 `.xls`、带宏 `.xlsm`、伪装扩展名或受密码保护的工作簿。用可信办公软件另存为普通 XLSX 后重试。

## 导入无法进入“可分析”

在常驻质量报告中检查：

- 必填字段是否映射；
- 无时区时间是否指定默认时区；
- 数量能否解析且不为负；
- 同一订单的事件时间是否倒序；
- 未知状态是否需要项目级映射；
- 重复键是完全重复还是冲突记录。

不要用删除异常行的方式制造漂亮结果。修正源文件或映射后重新校验。

## 指标显示不可计算或覆盖率低

OT 依赖承诺和实际交付时间，IF 依赖订购和交付数量，OTIF 同时依赖两组字段。不可计算不会混入成功/失败分母。打开指标说明查看字段依赖、不可计算数和警告，再判断是否需要补数据。

## 图表为空但没有报错

常见原因是当前筛选没有样本、必要字段覆盖率为零，或所选维度全部未知。先清除筛选，再查看数据上下文条和图表文字摘要。系统不会用 0 冒充缺失数据。

## 报告导出失败或过大

- 缩小时间范围或取消订单样例章节；
- 检查默认 50 MiB 结果上限；
- 等待任务状态明确变为完成，不要重复点击；
- HTML/Markdown 是主路径，PDF 当前未开放；
- 导出 CSV 前缀会被安全转义，这是防电子表格公式执行的预期行为。

## Workers AI 探针失败

默认关闭不影响其他功能。若明确启用：

1. 确认 Account ID 为 32 位十六进制；
2. Token 与账户匹配且状态 active；
3. Token 具有 Workers AI 所需最小权限；
4. 使用 `POST /api/integrations/workers-ai/probe` 并附 `X-FulfillLens-External-Call: confirm`；
5. 不要把凭据写入浏览器、Issue、README 或测试。

任何曾出现在聊天或日志中的 Token 都应轮换。

## 清理本地数据

优先使用设置页。API 运行时，可在 PowerShell 列出并逐个删除：

```powershell
$datasets = (Invoke-RestMethod http://127.0.0.1:8000/api/datasets).datasets
$datasets | ForEach-Object {
  Invoke-RestMethod -Method Delete -Uri "http://127.0.0.1:8000/api/datasets/$($_.dataset_id)"
}
```

Docker 用户若确定要删除全部持久卷：

```powershell
docker compose down --volumes
```

该操作不可恢复。不要对工作区根目录运行递归删除命令。

## 质量检查失败

按顺序单独运行，保留第一个失败的完整脱敏输出：

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
npm run docs:check
npm run licenses:check
```

不要使用 skip、`@ts-ignore`、降低断言或删除测试绕过失败。

## Docker Compose

```powershell
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-WebRequest http://127.0.0.1:5173
docker compose down
```

若 `docker` 命令不存在，说明本机未安装或未启动 Docker；YAML 能被解析不能替代实际构建和健康检查。

## 仍无法解决

使用 Bug Issue 模板，提供合成复现、环境、最小日志、预期与实际结果和已执行命令。安全问题按 [SECURITY.md](../SECURITY.md) 私密报告。
