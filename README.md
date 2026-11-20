# dsh-acpx-bridge

一个 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件，向模型注册 `acpx_delegate` 工具，让 dsh 里的模型通过 [acpx](https://acpx.sh/)（ACP headless 客户端）调度其他编码 agent（Codex / Claude / Gemini / Qwen / Kimi …）。

```
dsh 里的模型  ──tool call──▶  acpx_delegate  ──spawn──▶  acpx <agent> exec "<task>"
```

## 为什么做成 tool 而不是 subagent provider

acpx 本身是 ACP **客户端**，内置 30 个 agent profile，且有稳定的一次性 `exec` 命令。把它包装成单个工具是最小、最稳的集成方式，同时把 CLI 的全部能力（选 agent、`--cwd`、权限策略、`--format json`）都暴露给模型。dsh 原生 subagent provider 需要实现 `SubagentProvider` 接口且旗标受限，改造成本更高。

## 文件

- `src/index.js` — 插件主体（`apply`、`acpx_delegate`、`acpx_agents` 工具，纯函数 `buildAcpxArgs`）
- `src/selftest.mjs` — 命令构造自检（`node src/selftest.mjs`）
- `testing/mock-acpx` — acpx 替身，仅用于无真实 acpx 时的端到端验证
- `cordis.patch.yml` — dsh profile 挂载配置（见安装）
- `package.json` — 包元数据

## 注册的工具

### `acpx_delegate`

| 参数 | 类型 | 说明 |
|---|---|---|
| `task` | string (必填) | 交给子 agent 的完整、自包含任务描述（子 agent 看不到当前对话） |
| `agent` | string | acpx agent profile，默认 `codex`。可选 codex/claude/gemini/qwen/kimi/… 或 `deepseek-harness` |
| `cwd` | string | 子 agent 工作目录（repo 根），默认继承 dsh 工作区 |
| `mode` | `exec` \| `session` | `exec` 一次性；`session` 持久会话（配合 `session` 名） |
| `session` | string | `mode=session` 时的会话名，如 `backend`、`pr-842` |
| `approve` | `reads` \| `all` \| `none` | 权限策略，默认 `reads` |
| `format` | `quiet` \| `json` \| `text` | `quiet` 仅最终文本；`json` 输出 NDJSON ACP 事件（含工具调用/diff）；`text` 人类可读 |
| `timeoutMs` | number | 超时，默认 600000 |

返回结构化值：`ok / agent / mode / session / command / exitCode / stdout / stderr / durationMs / diagnostic`。

### `acpx_agents`

列出内置 agent profile 与当前使用的 acpx 二进制路径。

## 前置要求

- Node ≥ 22.19（dsh 0.2.2-rc.5 本身要求 ≥ 24.9）
- dsh 0.2.2-rc.x
- 真实使用时需安装 acpx 且至少装好一个底层 agent 并完成认证：

```bash
npm install -g acpx@latest
# 例如 Codex：安装 codex CLI 并登录；其他 agent 见 https://acpx.sh/agents.html
```

## 安装到 dsh

### 方式 A：通过 patch 挂载（推荐本地开发/测试）

把插件绝对路径写进 dsh profile 的 `cordis.patch.yml`（`insert` 一行），然后用 `--patch` 启动：

```yaml
- insert:
    - id: acpx-bridge
      name: '/Applications/code/www/my/github/dsh-acpx-bridge/src/index.js'
```

```bash
npx @deepseek-ai/dsh web --patch ./cordis.patch.yml
```

### 方式 B：`dsh plugin add`

```bash
dsh plugin --profile web add /Applications/code/www/my/github/dsh-acpx-bridge
# 重启 harness 后生效
```

## 配置环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ACPX_BIN` | `acpx` | acpx 可执行文件路径。用 mock 测试时指向 `testing/mock-acpx` |
| `ACPX_DEFAULT_AGENT` | `codex` | 未指定 agent 时的默认 profile |

## 自检

```bash
node src/selftest.mjs                 # 命令构造（无需 acpx）
ACPX_BIN=$PWD/testing/mock-acpx node -e "..."   # 工具执行链路（见测试记录）
```

## License

MIT
