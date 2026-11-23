# dsh-acpx-bridge

一个 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件，做两件事：

1. **注册 LLM 适配器**：把配置里的模型放进 dsh 的模型选择框，真实模型调用走 OpenAI 兼容端点。
2. **注册 `acpx_delegate` / `acpx_agents` 工具**：让 dsh 里的模型通过 [acpx](https://acpx.sh/) 调度其他编码 agent。

```
dsh 模型选择器 ──(provider: acpx-bridge)──▶ OpenAI 兼容端点
dsh 里的模型 ──tool call──▶ acpx_delegate ──spawn──▶ acpx <agent> [--model <id>] exec "<task>"
```

## 文件

- `src/index.js` — 插件入口：`apply`、两个工具、纯函数 `buildAcpxArgs`、路由注册与模型列表广播、导出 `Config`
- `src/config.js` — Config schema、环境变量回退、端点来源判定、模型 id ↔ 显示名 ↔ wire 模型名 的映射
- `src/prefs.js` — 插件自有偏好文档（`prefs.json`）的校验 / 合并 / 模型过滤 / 显示名覆盖 + 原子写与串行队列
- `src/api.js` — 设置页的 4 个 HTTP 路由（state / prefs / verify / acpx-check）+ 同源与体积限额、纯函数探测
- `src/agents.js` — 7 个平台 CLI 的授权表与纯探测逻辑（探测命令、状态正则、动作矩阵、qwen argv 改写辅助）
- `src/agent-jobs.js` — 登录 job 生命周期（spawn / 环形缓冲 / 超时与取消 / SSE 帧）
- `src/agent-keys.js` — 密钥落盘与回滚（opencode `auth.json`、qwen acpx argv）、logout、真实 test 探针
- `src/agent-api.js` — 授权相关的 9 条 HTTP 路由（状态 / 登录 / SSE / stdin / 取消 / 密钥 / 移除 / 退出 / 测试）
- `src/openai-stream.js` — OpenAI chat/completions SSE 请求、分帧、`StreamChunk` 转换
- `src/llm-adapter.js` — `LlmAdapter` 实现（`listModels` 过滤停用模型 / `resolveModel` / `stream`，连接每次调用重算）
- `client/index.js` — 浏览器半部分（手写 lazy-CJS，无构建）：设置页 6 个分组 + 插件页摘要卡
- `src/selftest.mjs` — 纯逻辑自检（无需 acpx、无需网络、无需 dsh）
- `src/verify-live.mjs` — 直连真实端点验证 PONG（需环境变量提供密钥）
- `docs/设置页.md` — 设置页说明：分组、开关生效时机、密钥约定、接口与安全措施
- `docs/平台授权.md` — 7 个平台的实测命令、状态判定、四类动作、SSE 协议、密钥落盘位置与限制
- `cordis.patch.yml` — dsh profile 挂载配置（见安装）
- `package.json` — 包元数据

## 模型注册

- provider 路由名（全局唯一）：`acpx-bridge`
- 默认模型 id：`gs/deepseek-flash-deepseek.com`
- 选择框显示名：`acpx/deepseek-flash`
- 实际发给端点的 wire 模型名：`deepseek-flash`

模型 id 来自 Config 的 `tools[].models[]`；`listModels()` 返回去重后的模型（**减去设置页停用的**），`resolveModel()` 返回 `contextWindow=131072`、`defaultMaxTokens=8192`。

## 设置页

**设置（左下角）→ acpx-bridge** 是一整页设置，6 个分组：运行概览（常显）、授权：模型端点、模型显示、命令工具授权、`acpx_delegate` 默认参数、诊断。同时插件管理页保留一张简短摘要卡。

- 密钥只进本机凭据库（引用名 `ACPX_BRIDGE_API_KEY`），**不落盘到任何设置文件**，页面只显示「已配置 / 未配置」；
- 模型/端点/默认参数的偏好写在 `<DSH_HOME>/storages/acpx-bridge/prefs.json`（原子写，目录 0700、文件 0600），不碰 profile 的 `cordis.patch.yml`；
- 模型开关即时生效：选择器重新拉取、被停用模型不再出现，`acpx_delegate` 执行时也会拒绝；
- 页面自带 4 个接口，注册在 dsh Connection 的鉴权 Fetch 路由上（浏览器会话鉴权在前，业务侧同源校验在后）：`GET /api/acpx-bridge/state`、`POST /api/acpx-bridge/prefs`、`POST /api/acpx-bridge/verify`、`POST /api/acpx-bridge/acpx-check`；
- 第 4 组「命令工具授权」另加 9 条接口，见下方「命令工具授权」。

完整说明（接口形状、安全措施、生效时机、默认参数优先级）见 [docs/设置页.md](docs/设置页.md)。

## 命令工具授权（设置页第 4 组）

本机已安装的 7 个平台 CLI 可以在页面上直接完成授权，不需要切终端：

| 平台 | 状态判定 | 页面能做的动作 |
|---|---|---|
| Kimi | `kimi login`（已授权输出 `Logged in…`） | 开登录 job（设备码/链接实时流）、测试 |
| Trae | `traecli login status` | 开登录 job、把回调 URL 写回 stdin、退出、测试 |
| OpenCode | `opencode auth list`（`N credentials`） | 写 `auth.json` 密钥、移除（logout）、测试 |
| Qwen | 读 `~/.acpx/config.json` 的 argv | 写 key/baseURL/model、移除、测试 |
| CodeBuddy | 无法自动探测（首启 TUI） | 复制登录命令、测试 |
| DeepSeek Harness | 免授权 | 测试（真实 exec ping，花钱需确认） |
| Antigravity | 二进制需 avx，本机 SIGILL | 只显示不可用原因 |

- 组头 meta：`已授权 n / 已安装 7`；右上「全部检测」走 `GET /api/acpx-bridge/agents?force=1`；
- 探测只读：并发 7 个、单个 8 秒超时、结果缓存 30 秒；不写文件、不跑 `acpx … exec`；
- 授权面板行内展开（不弹窗）：状态行、抓到的链接（复制/打开）、实时输出（等宽、自动滚底、保留最近 200 行）、取消；
- 登录 job：最多 3 个并发、单平台 1 个（重复启动 409 复用现有 job）、5 分钟超时、取消 SIGTERM→2s→SIGKILL、断连即 kill；
- 密钥只写各平台自己的配置（opencode `auth.json` / qwen `~/.acpx/config.json`），写前 `.bak-<时间戳>`、原子 rename、写后回读校验、失败回滚；响应只回 `maskedKey`（末四位）；
- [测试] 会真实调用一次子 agent（可能产生费用），页面先 `window.confirm` 二次确认；同平台 60 秒冷却。

接口（都在 Connection 鉴权 Fetch 上，agent id 走 query/body 因为该契约只支持精确路径 + GET/HEAD/POST）：
`GET …/agents`、`POST …/agents/login`、`GET …/agents/login/events`(SSE)、`POST …/agents/login/input`、`POST …/agents/login/cancel`、`POST …/agents/key`、`POST …/agents/key/remove`、`POST …/agents/logout`、`POST …/agents/test`。

细节（实测命令、SSE 帧格式、回滚策略、明文风险）见 [docs/平台授权.md](docs/平台授权.md)。

## Config schema

```js
{
  tools: [                                  // 命令工具 = acpx agent
    { name: 'deepseek-harness', models: ['gs/deepseek-flash-deepseek.com'] },
  ],
  apiKey: '',                               // 默认空，从环境变量/cordis 注入
  baseURL: 'http://…/v1',                  // OpenAI 兼容端点根路径
}
```

所有字段都是 schemastery `z` 声明的 `.volatile()` 引用，设置变化不会触发插件重挂载。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ACPX_BRIDGE_API_KEY` | 空（必须提供） | OpenAI 兼容端点密钥。优先取 cordis `config.apiKey`，为空时回退到本变量 |
| `ACPX_BRIDGE_BASE_URL` | config.js 中的默认端点 | 覆盖端点根路径 |
| `ACPX_BIN` | `acpx` | acpx 可执行文件路径 |
| `ACPX_DEFAULT_AGENT` | `codex` | 未配置 tools 时的兜底 agent |

保密约定：**密钥不写进本仓库任何文件**。`cordis.patch.yml` 用 `!!js process.env.ACPX_BRIDGE_API_KEY` 注入；插件代码只从 Config / 环境变量读取。

## 安装到 dsh

把插件绝对路径写进 dsh profile 的 `cordis.patch.yml`（`insert` 一行），然后用 `--patch` 启动：

```bash
ACPX_BRIDGE_API_KEY=<key> npx @deepseek-ai/dsh web --patch ./cordis.patch.yml
```

仓库内的 `cordis.patch.yml` 已包含 `config.apiKey` 的 `!!js` 注入示例。

## 工具

### `acpx_delegate`

| 参数 | 类型 | 说明 |
|---|---|---|
| `task` | string (必填) | 交给子 agent 的完整、自包含任务描述 |
| `agent` | string | 可选值来自 `tools[].name`（未配置 tools 时回退内置 agent 列表）；未传时用设置页默认 agent，再回退第一个 |
| `model` | string | 可选值来自该 agent 的 `models`，传给 acpx 的 `--model <id>`；**设置页停用的模型会被拒绝**（enum 无法热更新，执行时挡） |
| `cwd` | string | 子 agent 工作目录，默认继承 dsh 工作区 |
| `mode` | `exec` \| `session` | 一次性 / 持久会话；未传时用设置页默认值 |
| `session` | string | `mode=session` 时的会话名 |
| `approve` | `reads` \| `all` \| `none` | 权限策略；未传时用设置页默认值，再回退 `reads` |
| `format` | `quiet` \| `json` \| `text` | 输出格式；未传时用设置页默认值，再回退 `quiet` |
| `timeoutMs` | number | 超时毫秒（60000–3600000）；未传时用设置页默认值，再回退 600000 |

返回结构化值：`ok / agent / mode / session / command / exitCode / stdout / stderr / durationMs / diagnostic`。

### `acpx_agents`

列出配置的命令工具及其模型（逐模型标注 `enabled` / `placeholder`）、内置 acpx agent profile、当前使用的 acpx 二进制路径。

## 自检

```bash
node src/selftest.mjs                                  # 纯逻辑，无网络
ACPX_BRIDGE_API_KEY=<key> node src/verify-live.mjs     # 直连真实端点，校验 PONG
```

## 阶段记录

- ✅ **第一阶段**：Config schema + 环境变量回退，保证不配置也能用。
- ✅ **第二阶段（设置页，已完成）**：设置面板里的独立页面（6 个分组）、凭据库密钥写入/清除、端点覆盖与测试连接、模型启停（真的影响选择器与工具）、`acpx_delegate` 默认参数、诊断与重置；偏好写进插件自有 `prefs.json`，密钥只进凭据库。
- ✅ **第三阶段（平台授权，已完成）**：设置页第 4 组「命令工具授权」——7 个平台的探测、登录 job + SSE、密钥写入/移除、logout、真实 exec ping 测试，全部页面内完成。
- ⬜ **待联调**：真正的「dsh 选中模型 → 模型调用 `acpx_delegate` → 子 agent 执行 ping → 返回百度 IP」端到端链路（依赖子 agent 侧认证）。

## 前置要求

- Node ≥ 22.19（dsh 0.2.2-rc.5 要求 ≥ 24.9）
- dsh 0.2.2-rc.x
- 真实调度 agent 时需安装 acpx 及对应底层 CLI 并完成认证

## License

MIT
