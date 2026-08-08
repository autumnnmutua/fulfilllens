# 依赖许可证审查

- 审查日期：2026-08-08
- 项目拟采用：MIT
- 结论：当前安装依赖中未发现 AGPL、GPL、LGPL、SSPL、BUSL 或 Commons Clause；MIT 与当前组合兼容。

这是一份工程审查记录，不替代法律意见。发布二进制、容器或离线依赖包时仍需保留依赖自带的许可证与通知，并在每次升级后重新检查。

## 方法

1. 以 `package-lock.json`、`apps/web/package.json`、`apps/api/requirements*.txt` 和实际安装元数据为来源；
2. 扫描 327 个唯一 Node 包和 77 个 Python 分发包的 SPDX/metadata 许可证；
3. 单独审查强传染许可证、MPL、CC、未知许可证和直接运行依赖；
4. 使用 `python scripts/check_dependency_licenses.py` 在 CI 中阻止已知不兼容许可证和未知直接依赖。

## 前端直接运行依赖

| 包                |   版本 | 许可证     | 备注                                     |
| ----------------- | -----: | ---------- | ---------------------------------------- |
| React / React DOM | 19.2.8 | MIT        | 运行时                                   |
| Ant Design        |  6.5.2 | MIT        | 运行时 UI                                |
| Ant Design Icons  |  6.3.2 | MIT        | 运行时图标                               |
| Apache ECharts    |  6.1.0 | Apache-2.0 | 运行时图表，分发时保留许可证/NOTICE 要求 |

其余前端直接依赖为开发、测试、格式和构建工具，主要采用 MIT 或 Apache-2.0。

## Python 直接运行依赖

| 包                           |            版本 | 许可证类别   | 用途               |
| ---------------------------- | --------------: | ------------ | ------------------ |
| FastAPI                      |        0.140.13 | MIT          | API                |
| Pydantic / pydantic-settings | 2.13.4 / 2.14.2 | MIT          | Schema 与设置      |
| DuckDB                       |           1.5.5 | MIT          | 本地分析           |
| Pandas                       |           3.0.5 | BSD-3-Clause | 表格转换与批量导入 |
| NumPy                        |           2.2.6 | BSD-3-Clause | 数值依赖           |
| openpyxl                     |           3.1.5 | MIT          | XLSX 读取          |
| defusedxml                   |           0.7.1 | PSF-2.0      | XML 安全加固       |
| jsonschema                   |          4.26.0 | MIT          | 数据 Schema 校验   |
| python-multipart             |          0.0.32 | Apache-2.0   | 上传解析           |
| Uvicorn                      |          0.51.0 | BSD-3-Clause | 本地 API 服务器    |
| tzdata                       |          2026.3 | Apache-2.0   | 跨平台时区         |

其他直接运行依赖 `python-dotenv` 及其传递依赖同样为宽松许可证。确切版本以 requirements 与安装元数据为准。

## 需要保留声明的注意项

| 依赖                           | 许可证     | 结论                                                                       |
| ------------------------------ | ---------- | -------------------------------------------------------------------------- |
| `axe-core`                     | MPL-2.0    | 仅开发测试；MPL 为文件级要求，不要求本项目整体改用 MPL。不要移除其许可证。 |
| `lightningcss` 及平台包        | MPL-2.0    | Vite 构建链传递依赖；保留包内许可证，不复制修改其源码到本项目。            |
| `certifi`、`pathspec`          | MPL-2.0    | Python 传递/开发依赖；保留原许可证。                                       |
| `caniuse-lite`                 | CC-BY-4.0  | 浏览器兼容数据集；保留归属与许可证元数据。                                 |
| Apache ECharts / TypeScript 等 | Apache-2.0 | 与 MIT 组合兼容；再分发时保留版权、许可证及适用 NOTICE。                   |

MPL/CC 项不是 AGPL/GPL，也没有触发将 FulfillLens CN 整体改为其他许可证的要求。若未来直接修改并分发 MPL 文件，必须按 MPL 对相应文件提供源码和声明。

## 未发现项

- AGPL、GPL、LGPL；
- SSPL、BUSL、Commons Clause；
- 许可证未知的第三方直接依赖；
- 需要购买商业许可证才能运行当前 MVP 的依赖。

此前扫描中的唯一 `UNKNOWN` 是尚未声明许可证的本项目工作区包；阶段 11 已为根包和 Web 包补充 `MIT` 元数据。

## 新依赖准入

提交新依赖时必须说明：

- 是否为运行时必需，能否用现有依赖或标准库实现；
- SPDX 许可证、传递依赖和再分发义务；
- 安全漏洞、维护活跃度、安装体积和浏览器包体影响；
- 是否访问网络、读取文件、执行本机命令或处理个人信息。

AGPL/GPL/LGPL、源代码不可得、用途限制或未知许可证默认阻断，直至维护者完成书面兼容性决定。

## 复验

```powershell
npm ci
python -m pip install -r apps/api/requirements-dev.txt
npm run licenses:check
npm run audit
```

依赖版本改变后应更新本记录的日期、数量、异常项和结论。
