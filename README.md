# dsh-acpx-bridge

一个 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件，做两件事：

1. **注册 LLM 适配器**：把配置里的模型放进 dsh 的模型选择框，真实模型调用走 OpenAI 兼容端点。
2. **注册 `acpx_delegate` / `acpx_agents` 工具**：让 dsh 里的模型通过 [acpx](https://acpx.sh/) 调度其他编码 agent。

```
dsh 模型选择器 ──(provider: acpx-bridge)──▶ OpenAI 兼容端点
dsh 里的模型 ──tool call──▶ acpx_delegate ──spawn──▶ acpx <agent> [--model <id>] exec "<task>"
```

## 文件

- `src/index.js` — 插件入口：`apply`、两个工具、纯函数 `buildAcpxArgs`、导出 `Config`
- `src/config.js` — Config schema、环境变量回退、模型 id ↔ 显示名 ↔ wire 模型名 的映射
- `src/openai-stream.js` — OpenAI chat/completions SSE 请求、分帧、`StreamChunk` 转换
- `src/llm-adapter.js` — `LlmAdapter` 实现（`listModels` / `resolveModel` / `stream`）
- `src/selftest.mjs` — 纯逻辑自检（无需 acpx、无需网络）
- `src/verify-live.mjs` — 直连真实端点验证 PONG（需环境变量提供密钥）
- `cordis.patch.yml` — dsh profile 挂载配置（见安装）
- `package.json` — 包元数据

## 模型注册

- provider 路由名（全局唯一）：`acpx-bridge`
- 默认模型 id：`gs/deepseek-flash-deepseek.com`
- 选择框显示名：`acpx/deepseek-flash`
- 实际发给端点的 wire 模型名：`deepseek-flash`

模型 id 来自 Config 的 `tools[].models[]`；`listModels()` 返回去重后的全部模型，`resolveModel()` 返回 `contextWindow=131072`、`defaultMaxTokens=8192`。

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
| `agent` | string | 可选值来自 `tools[].name`；未配置 tools 时回退内置 agent 列表 |
| `model` | string | 可选值来自该 agent 的 `models`，传给 acpx 的 `--model <id>` |
| `cwd` | string | 子 agent 工作目录，默认继承 dsh 工作区 |
| `mode` | `exec` \| `session` | 一次性 / 持久会话 |
| `session` | string | `mode=session` 时的会话名 |
| `approve` | `reads` \| `all` \| `none` | 权限策略，默认 `reads` |
| `format` | `quiet` \| `json` \| `text` | 输出格式，默认 `quiet` |
| `timeoutMs` | number | 超时，默认 600000 |

返回结构化值：`ok / agent / mode / session / command / exitCode / stdout / stderr / durationMs / diagnostic`。

### `acpx_agents`

列出配置的命令工具及其模型、内置 acpx agent profile、当前使用的 acpx 二进制路径。

## 自检

```bash
node src/selftest.mjs                                  # 纯逻辑，无网络
ACPX_BRIDGE_API_KEY=<key> node src/verify-live.mjs     # 直连真实端点，校验 PONG
```

## 第二阶段待办

- **设置卡片**：第一阶段先把 Config schema 和持久化结构落地，保证不配置也能用、端点/密钥可被环境变量覆盖；设置卡片需要在 dsh web 的设置页里接上 Config schema 的表单（含密钥掩码），涉及前端注入与 schema 表单联动，独立成一个阶段更稳妥。
- 真正的「dsh 选中模型 → 模型调用 `acpx_delegate` → 子 agent 执行 ping → 返回百度 IP」端到端链路，需在设置卡片完成后联调（依赖 agent 侧认证）。

## 前置要求

- Node ≥ 22.19（dsh 0.2.2-rc.5 要求 ≥ 24.9）
- dsh 0.2.2-rc.x
- 真实调度 agent 时需安装 acpx 及对应底层 CLI 并完成认证

## License

MIT
