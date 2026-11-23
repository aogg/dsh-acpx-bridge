/**
 * dsh-acpx-bridge — browser half.
 *
 * Two surfaces, both registered through `ctx.slots`:
 *
 *   1. `settings.section` (id `acpx-bridge`, order 25) — the full settings page
 *      in the bottom-left Settings panel: six groups, only the first fixed.
 *   2. `plugins.item` — the short summary card required by the project's plugin
 *      conventions, shown on the Plugins page; it points at the settings page.
 *
 * Shape: a hand-written lazy-CJS module (`window.__ModuleLoader__.load`). It
 * requires only `react` and the static platform module
 * `@deepseek-ai/dsh-client-ui-primitives` — no bundler, no JSX.
 *
 * Secrets: this file never receives one. The credential section only renders
 * `{ configured, source, writable }` from `GET /state`, and writes go through
 * the official client remote (`ctx.remote.credentials.set/unset`).
 *
 * Refresh policy: no polling. The page loads once on mount and again on
 * `document.visibilitychange` → visible, plus after every write.
 *
 * Transport: writes go to `POST /api/acpx-bridge/prefs` (Connection's Fetch
 * contract allows GET/HEAD/POST); reads to `GET …/state`.
 */

window.__ModuleLoader__.load({ id: 'dsh-acpx-bridge', factory: require => {
  var module = { exports: {} }
  var exports = module.exports
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

  const React = require('react')
  const P = require('@deepseek-ai/dsh-client-ui-primitives')
  const h = React.createElement

  const NS = 'settings.acpxBridge'
  const PROVIDER = 'acpx-bridge'
  const API = '/api/acpx-bridge'
  const CREDENTIAL_REF = 'ACPX_BRIDGE_API_KEY'
  /** localStorage key holding the collapsed-group state (one JSON object). */
  const GROUPS_KEY = 'acpx-bridge:settings:groups'
  /** Separate key for the per-agent sub-accordions inside the models group. */
  const AGENTS_KEY = 'acpx-bridge:settings:agents'
  const EMPTY_DEFAULTS = Object.freeze({})
  const NOTICE_MS = 2000
  const TIMEOUT_MIN = 60000
  const TIMEOUT_MAX = 3600000
  const DEFAULT_TIMEOUT = 600000

  /** Only the first group is fixed; the rest start collapsed except groups 2/3. */
  const GROUP_DEFAULTS = Object.freeze({
    overview: true,
    auth: true,
    models: true,
    agents: false,
    defaults: false,
    diagnostics: false,
  })

  /** Static login hint per acpx agent (login itself always happens in its CLI). */
  const LOGIN_COMMANDS = Object.freeze({
    kimi: 'kimi login',
    qoder: 'qodercli login',
    qwen: 'qwen /auth',
    codebuddy: 'codebuddy',
    kiro: 'kiro-cli login',
    cursor: 'cursor-agent login',
    gemini: 'gemini',
    claude: 'claude',
    codex: 'codex login',
    copilot: 'copilot',
    opencode: 'opencode auth login',
    trae: 'trae login',
    antigravity: 'acpx antigravity ...',
  })

  /** Authorization state → StateDot state (the page's own five-state vocabulary). */
  const AGENT_DOT = Object.freeze({
    authorized: 'done',
    unauthorized: 'warning',
    'no-auth': 'idle',
    unavailable: 'error',
    unknown: 'idle',
  })

  /** Provider choices offered by the opencode key form. */
  const OPENCODE_PROVIDERS = Object.freeze([
    'opencode', 'openai', 'anthropic', 'google', 'openrouter', 'deepseek',
    'groq', 'xai', 'mistral', 'vercel', 'github-copilot',
  ])

  /** How many output lines the login panel keeps (and renders). */
  const LOGIN_MAX_LINES = 200
  /** How many characters of login output the panel buffers. */
  const LOGIN_MAX_CHARS = 60000

  // -------------------------------------------------------------------------
  // Copy (zh primary; en mirrors the same key set)
  // -------------------------------------------------------------------------

  const ZH = {
    nav: 'acpx-bridge',
    title: 'acpx-bridge',
    lead: '命令工具（acpx agent）与 OpenAI 兼容模型端点的桥接：模型从这里进选择器，acpx_delegate 从这里调度子 agent。',
    loading: '加载中…',
    loadFailed: '读取插件状态失败',
    retry: '重试',
    saved: '已保存',
    saveFailed: '保存失败',
    overview: '运行概览',
    auth: '授权：模型端点',
    models: '模型显示',
    agents: '命令工具状态',
    defaults: 'acpx_delegate 默认参数',
    diagnostics: '诊断',
    statusReady: '可用',
    statusUnauthorized: '未授权',
    statusAcpxMissing: 'acpx 缺失',
    endpoint: '生效端点',
    sourcePrefs: '页面覆盖',
    sourceConfig: '配置',
    sourceEnv: '环境变量',
    sourceDefault: '默认',
    credential: '密钥状态',
    configured: '已配置',
    unconfigured: '未配置',
    modelCount: '模型计数',
    enabled: '已启用',
    total: '共',
    acpxBinary: 'acpx 可执行',
    version: '版本',
    notDetected: '未检测到',
    authHint: '密钥只写入本机凭据库（credential store），不写进任何设置文件；本页只显示「已配置 / 未配置」，任何接口都不会回传密钥明文。',
    credentialRef: '凭据引用名',
    apiKey: 'API 密钥',
    apiKeyPlaceholder: '输入密钥（每次打开都为空）',
    saveKey: '保存密钥',
    clearKey: '清除密钥',
    saving: '保存中…',
    keyEnvReadonly: '当前由环境变量 ACPX_BRIDGE_API_KEY 提供，删除该环境变量后才能在这里写入。',
    keyConfigReadonly: '当前由插件配置注入（通常来自启动环境变量），改这里不会生效；请修改配置注入源。',
    keyNotWritable: '当前凭据源不允许从本页写入。',
    keyWritableHint: '保存后立即生效，无需重启。',
    keyRequired: '请输入密钥',
    keySaved: '密钥已保存',
    keyCleared: '密钥已清除',
    endpointLabel: '端点地址',
    endpointPlaceholder: '留空表示使用兜底端点',
    fallbackEndpoint: '兜底端点',
    resetDefault: '恢复默认',
    invalidUrl: '端点必须是 http(s) 地址',
    testConnection: '测试连接',
    testing: '测试中…',
    testOk: '连接成功',
    testFailed: '连接失败',
    latency: '延迟',
    modelEcho: '模型',
    status: '状态',
    allOn: '全部启用',
    allOff: '全部停用',
    allOffWarning: '所有模型都已停用：dsh 模型选择器中将不再出现 acpx-bridge 的模型。',
    placeholderTag: '占位（未探测到真实模型）',
    realModels: '有真实模型',
    placeholderOnly: '仅占位',
    redetect: '重新检测',
    loginCommand: '登录命令',
    copy: '复制',
    copied: '已复制',
    agentsHint: '各 agent 的登录必须在各自的 CLI 中完成，本页只展示与复制命令。',
    defaultAgent: '默认 agent',
    defaultMode: '默认模式',
    defaultApprove: '默认权限',
    defaultFormat: '默认输出格式',
    defaultTimeout: '默认超时（毫秒）',
    modeExec: 'exec（一次性）',
    modeSession: 'session（持久会话）',
    approveReads: 'reads（只读自动批准）',
    approveAll: 'all（全部自动批准）',
    approveNone: 'none（全部拒绝）',
    formatQuiet: 'quiet（仅最终文本）',
    formatJson: 'json（NDJSON 事件）',
    formatText: 'text（人类可读）',
    defaultsHint: '只在模型调用 acpx_delegate 时未显式传参才生效。',
    unsetAgent: '（未设置，使用第一个 agent）',
    pluginVersion: '插件版本',
    providerRoute: 'provider 路由名',
    entryId: 'profile 条目 id',
    wireModels: 'wire 模型映射',
    wireEmpty: '（空，模型 id 原样转发）',
    refreshModels: '刷新模型列表',
    refreshed: '已通知模型选择器重新拉取',
    resetPrefs: '重置本页设置为默认',
    resetConfirm: '确认重置？',
    resetDone: '已重置为默认设置',
    docsLabel: 'docs/设置页.md',
    docsHint: '说明文档（仓库内）：',
    settingsHint: '设置位置：左下角设置 → acpx-bridge',
    summaryLine: 'acpx-bridge 模型桥接',
    agentModels: '模型',
    switchLabel: '启用该模型',
    probeOk: '已检测',
    noModels: '（没有配置模型）',
    // --- 命令工具授权（7 个平台） ---
    agentAuth: '命令工具授权',
    authorizedCount: '已授权',
    installedCount: '已安装',
    detectAll: '全部检测',
    detectingAll: '正在探测 7 个平台…',
    agentsProbeFailed: '探测平台授权状态失败',
    agentsEmpty: '（没有探测到任何平台）',
    stateAuthorized: '已授权',
    stateUnauthorized: '未授权',
    stateNoAuth: '免授权',
    stateUnavailable: '不可用',
    stateUnknown: '未知',
    methodDeviceCode: '设备码',
    methodApiKey: 'API Key',
    methodNone: '免授权',
    methodInteractive: '交互式',
    methodUnknown: '—',
    actionLogin: '开始授权',
    actionLogout: '退出',
    actionSetKey: '设置密钥',
    actionRemoveKey: '移除密钥',
    actionCopyLogin: '复制登录命令',
    actionTest: '测试',
    actionClose: '关闭',
    actionCancel: '取消',
    actionSubmit: '提交',
    actionDetail: '详情',
    actionLess: '收起',
    notInstalled: '未安装',
    agentDocs: '文档',
    agentModelsCount: '模型数',
    loginStarting: '启动中…',
    loginWaiting: '等待回调/确认…',
    loginEnded: '已结束',
    loginExitCode: '退出码',
    loginLinks: '抓到的链接',
    loginOutput: '实时输出',
    loginEmpty: '（还没有输出）',
    loginReused: '该平台已有一个登录 job，直接连上了它',
    loginStreamBroken: '输出流中断（job 可能已结束）',
    callbackLabel: '回调 URL',
    callbackPlaceholder: '把浏览器里的回调地址粘到这里',
    callbackRequired: '请输入回调 URL',
    testConfirm: '这会真实调用一次子 agent，可能产生费用，继续？',
    testRunning: '测试中（最长 120 秒）…',
    testOk: '测试通过',
    testFailed: '测试失败',
    removeKeyConfirm: '确认移除该平台已保存的密钥/凭据？',
    keyWritten: '密钥已写入',
    keyRemoved: '密钥已移除',
    keyNotConfigured: '（没有可移除的密钥）',
    logoutConfirm: '确认退出该平台的登录？',
    logoutDone: '已退出登录',
    keyFormTitle: '设置密钥',
    keyProviderLabel: 'provider',
    keyApiKeyLabel: 'API Key',
    keyBaseURLLabel: 'baseURL（可选，http(s)）',
    keyModelLabel: 'model（可选）',
    keySave: '写入',
    keyRequired: '请输入密钥',
    keyRemoveHint: '移除后该平台恢复未授权状态。',
    logoutNoProvider: '退出 opencode 需要指定 provider（用「设置密钥」里的 provider 选择）。',
    agentsAuthHint: '密钥与凭据只写入各平台自己的配置文件（明文落盘），页面所有响应只回传掩码后的末四位；探测过程不写文件、不调用会花钱的子 agent。',
  }

  const EN = {
    nav: 'acpx-bridge',
    title: 'acpx-bridge',
    lead: 'Bridges command tools (acpx agents) and an OpenAI-compatible endpoint: models enter the selector here, acpx_delegate dispatches sub-agents here.',
    loading: 'Loading…',
    loadFailed: 'Could not read the plugin state',
    retry: 'Retry',
    saved: 'Saved',
    saveFailed: 'Save failed',
    overview: 'Overview',
    auth: 'Authorization: model endpoint',
    models: 'Model display',
    agents: 'Command tool status',
    defaults: 'acpx_delegate defaults',
    diagnostics: 'Diagnostics',
    statusReady: 'Ready',
    statusUnauthorized: 'Unauthorized',
    statusAcpxMissing: 'acpx missing',
    endpoint: 'Effective endpoint',
    sourcePrefs: 'page override',
    sourceConfig: 'config',
    sourceEnv: 'env',
    sourceDefault: 'default',
    credential: 'API key',
    configured: 'Configured',
    unconfigured: 'Not configured',
    modelCount: 'Models',
    enabled: 'enabled',
    total: 'of',
    acpxBinary: 'acpx binary',
    version: 'version',
    notDetected: 'not detected',
    authHint: 'The key is written only to the local credential store, never to a settings file. This page shows configured / not configured; no endpoint ever returns the secret.',
    credentialRef: 'Credential reference',
    apiKey: 'API key',
    apiKeyPlaceholder: 'Enter a key (always empty on open)',
    saveKey: 'Save key',
    clearKey: 'Clear key',
    saving: 'Saving…',
    keyEnvReadonly: 'Currently supplied by the ACPX_BRIDGE_API_KEY environment variable; remove it before writing here.',
    keyConfigReadonly: 'Currently injected by the plugin config (usually a launch environment variable); editing here has no effect — change the injection source.',
    keyNotWritable: 'The active credential source refuses writes from this page.',
    keyWritableHint: 'Takes effect immediately after saving, no restart.',
    keyRequired: 'Enter a key',
    keySaved: 'Key saved',
    keyCleared: 'Key cleared',
    endpointLabel: 'Endpoint',
    endpointPlaceholder: 'Leave blank to use the fallback endpoint',
    fallbackEndpoint: 'Fallback endpoint',
    resetDefault: 'Reset to default',
    invalidUrl: 'The endpoint must be an http(s) URL',
    testConnection: 'Test connection',
    testing: 'Testing…',
    testOk: 'Connected',
    testFailed: 'Connection failed',
    latency: 'latency',
    modelEcho: 'model',
    status: 'status',
    allOn: 'Enable all',
    allOff: 'Disable all',
    allOffWarning: 'Every model is disabled: the model selector will no longer offer acpx-bridge models.',
    placeholderTag: 'placeholder (no real model discovered)',
    realModels: 'real models',
    placeholderOnly: 'placeholder only',
    redetect: 'Detect again',
    loginCommand: 'Login command',
    copy: 'Copy',
    copied: 'Copied',
    agentsHint: 'Each agent must complete its own login in its CLI; this page only shows and copies the command.',
    defaultAgent: 'Default agent',
    defaultMode: 'Default mode',
    defaultApprove: 'Default approval',
    defaultFormat: 'Default output format',
    defaultTimeout: 'Default timeout (ms)',
    modeExec: 'exec (one-shot)',
    modeSession: 'session (persistent)',
    approveReads: 'reads (auto-approve reads)',
    approveAll: 'all (auto-approve everything)',
    approveNone: 'none (deny all)',
    formatQuiet: 'quiet (final text)',
    formatJson: 'json (NDJSON events)',
    formatText: 'text (human readable)',
    defaultsHint: 'Applies only when the model calls acpx_delegate without an explicit argument.',
    unsetAgent: '(unset — first agent is used)',
    pluginVersion: 'Plugin version',
    providerRoute: 'provider route',
    entryId: 'profile entry id',
    wireModels: 'wire model mapping',
    wireEmpty: '(empty — model ids are forwarded as-is)',
    refreshModels: 'Refresh model list',
    refreshed: 'The model selector was told to re-read',
    resetPrefs: 'Reset this page to defaults',
    resetConfirm: 'Confirm reset?',
    resetDone: 'Reset to defaults',
    docsLabel: 'docs/设置页.md',
    docsHint: 'Documentation in the repository: ',
    settingsHint: 'Location: Settings (bottom-left) → acpx-bridge',
    summaryLine: 'acpx-bridge model bridge',
    agentModels: 'models',
    switchLabel: 'Enable this model',
    probeOk: 'detected',
    noModels: '(no models configured)',
    // --- command-tool authorization (7 platforms) ---
    agentAuth: 'Command tool authorization',
    authorizedCount: 'authorized',
    installedCount: 'installed',
    detectAll: 'Detect all',
    detectingAll: 'Probing all 7 platforms…',
    agentsProbeFailed: 'Could not probe the platform authorization state',
    agentsEmpty: '(no platform detected)',
    stateAuthorized: 'Authorized',
    stateUnauthorized: 'Unauthorized',
    stateNoAuth: 'No auth needed',
    stateUnavailable: 'Unavailable',
    stateUnknown: 'Unknown',
    methodDeviceCode: 'device code',
    methodApiKey: 'API key',
    methodNone: 'no auth',
    methodInteractive: 'interactive',
    methodUnknown: '—',
    actionLogin: 'Start authorization',
    actionLogout: 'Log out',
    actionSetKey: 'Set key',
    actionRemoveKey: 'Remove key',
    actionCopyLogin: 'Copy login command',
    actionTest: 'Test',
    actionClose: 'Close',
    actionCancel: 'Cancel',
    actionSubmit: 'Submit',
    actionDetail: 'Detail',
    actionLess: 'Hide',
    notInstalled: 'not installed',
    agentDocs: 'Docs',
    agentModelsCount: 'models',
    loginStarting: 'Starting…',
    loginWaiting: 'Waiting for confirmation…',
    loginEnded: 'Finished',
    loginExitCode: 'exit code',
    loginLinks: 'Links found',
    loginOutput: 'Live output',
    loginEmpty: '(no output yet)',
    loginReused: 'A login job was already running; attached to it',
    loginStreamBroken: 'The output stream broke (the job may have ended)',
    callbackLabel: 'Callback URL',
    callbackPlaceholder: 'Paste the callback URL from the browser here',
    callbackRequired: 'Enter the callback URL',
    testConfirm: 'This really invokes a sub-agent and may cost money. Continue?',
    testRunning: 'Testing (up to 120s)…',
    testOk: 'Test passed',
    testFailed: 'Test failed',
    removeKeyConfirm: 'Remove the stored credential for this platform?',
    keyWritten: 'Key written',
    keyRemoved: 'Key removed',
    keyNotConfigured: '(no stored key to remove)',
    logoutConfirm: 'Log this platform out?',
    logoutDone: 'Logged out',
    keyFormTitle: 'Set key',
    keyProviderLabel: 'provider',
    keyApiKeyLabel: 'API key',
    keyBaseURLLabel: 'baseURL (optional, http(s))',
    keyModelLabel: 'model (optional)',
    keySave: 'Write',
    keyRequired: 'Enter a key',
    keyRemoveHint: 'Removing restores the unauthorized state.',
    logoutNoProvider: 'Logging out of opencode needs a provider (pick it in the key form).',
    agentsAuthHint: 'Keys are written only into each platform\'s own config file (plaintext on disk); every response carries the masked last four characters. Probing never writes a file and never invokes a paid sub-agent.',
  }

  // -------------------------------------------------------------------------
  // Theme-token styles (works in light and dark themes alike)
  // -------------------------------------------------------------------------

  const T = {
    fg: 'var(--dsw-alias-label-primary)',
    fg2: 'var(--dsw-alias-label-secondary)',
    fg3: 'var(--dsw-alias-label-tertiary)',
    dim: 'var(--dsw-alias-label-dimmed)',
    bg1: 'var(--dsw-alias-bg-layer-1)',
    bg3: 'var(--dsw-alias-bg-layer-3)',
    border: 'var(--dsw-alias-border-l4)',
    border3: 'var(--dsw-alias-border-l3)',
    danger: 'var(--dsw-alias-state-error-primary)',
    warn: 'var(--dsw-alias-state-warn-primary)',
    ok: 'var(--dsw-alias-state-success-primary)',
    info: 'var(--dsw-alias-state-business-primary)',
    radius: 'var(--dsw-radius-md)',
    radiusSm: 'var(--dsw-radius-sm)',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  }

  const S = {
    page: { display: 'flex', flexDirection: 'column', gap: 12, color: T.fg, fontSize: 13, lineHeight: 1.6 },
    title: { margin: 0, fontSize: 18, fontWeight: 600, color: T.fg },
    lead: { margin: 0, color: T.fg2, fontSize: 12.5 },
    card: { border: `1px solid ${T.border}`, borderRadius: T.radius, background: T.bg1, overflow: 'hidden' },
    head: {
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box',
      padding: '10px 14px', background: 'transparent', border: 'none', color: T.fg,
      font: 'inherit', fontWeight: 600, textAlign: 'left', cursor: 'pointer',
    },
    headStatic: { cursor: 'default' },
    chevron: { display: 'inline-block', width: 12, color: T.fg3, transition: 'transform 120ms ease' },
    headTitle: { flex: '1 1 auto', minWidth: 0 },
    headMeta: { color: T.fg3, fontSize: 12, fontWeight: 400 },
    body: { padding: '4px 14px 14px', display: 'flex', flexDirection: 'column', gap: 10 },
    row: { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '4px 0' },
    rowLabel: { flex: '0 0 132px', color: T.fg2, fontSize: 12.5, paddingTop: 2 },
    rowValue: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
    hint: { color: T.fg3, fontSize: 12 },
    mono: { fontFamily: T.mono, fontSize: 12, wordBreak: 'break-all' },
    notice: {
      border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: '8px 10px',
      background: T.bg3, color: T.fg2, fontSize: 12,
    },
    noticeError: { borderColor: T.danger, color: T.danger },
    noticeWarn: { borderColor: T.warn, color: T.fg },
    noticeOk: { borderColor: T.ok, color: T.fg },
    actions: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
    field: { display: 'flex', flexDirection: 'column', gap: 6 },
    fieldLabel: { color: T.fg2, fontSize: 12.5 },
    inline: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    agent: { border: `1px solid ${T.border}`, borderRadius: T.radiusSm, background: T.bg3, overflow: 'hidden' },
    agentHead: {
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box',
      padding: '7px 10px', background: 'transparent', border: 'none', color: T.fg,
      font: 'inherit', fontWeight: 500, textAlign: 'left', cursor: 'pointer',
    },
    agentBody: { padding: '2px 10px 8px', display: 'flex', flexDirection: 'column', gap: 2 },
    modelRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' },
    modelName: { flex: '0 0 auto', fontSize: 12.5, color: T.fg },
    modelId: { flex: '1 1 auto', minWidth: 0, fontFamily: T.mono, fontSize: 11.5, color: T.fg3, wordBreak: 'break-all' },
    muted: { color: T.fg3, fontSize: 12 },
    table: { display: 'flex', flexDirection: 'column', gap: 6 },
    line: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    select: {
      font: 'inherit', fontSize: 12.5, color: T.fg, background: T.bg1,
      border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: '5px 8px', minWidth: 180,
    },
    numberInput: { width: 140 },
    noticePill: {
      display: 'inline-flex', alignItems: 'center', gap: 6, color: T.ok, fontSize: 12,
    },
    summary: { display: 'flex', flexDirection: 'column', gap: 6, color: T.fg, fontSize: 13 },
  }

  // -------------------------------------------------------------------------
  // Pure helpers
  // -------------------------------------------------------------------------

  function sourceLabel(t, source) {
    if (source === 'prefs') return t('sourcePrefs')
    if (source === 'config') return t('sourceConfig')
    if (source === 'env') return t('sourceEnv')
    return t('sourceDefault')
  }

  function credentialSourceNote(t, state) {
    const credential = state.credential || {}
    if (credential.configured && credential.source === 'env') return t('keyEnvReadonly')
    if (credential.configured && credential.source === 'config') return t('keyConfigReadonly')
    if (credential.writable === false) return t('keyNotWritable')
    return t('keyWritableHint')
  }

  function statusOf(state) {
    if (!state) return 'loading'
    if (!state.acpx || state.acpx.ok !== true) return 'acpx-missing'
    if (!state.credential || state.credential.configured !== true) return 'unauthorized'
    return 'ready'
  }

  function loginCommandFor(agent) {
    return LOGIN_COMMANDS[agent] || `acpx ${agent} ...`
  }

  function uniqueIds(catalog) {
    const ids = []
    const seen = new Set()
    for (const group of catalog || []) {
      for (const model of group.models || []) {
        if (seen.has(model.id)) continue
        seen.add(model.id)
        ids.push(model.id)
      }
    }
    return ids
  }

  function errorText(error) {
    if (!error) return '未知错误'
    if (typeof error === 'string') return error
    return error.message || String(error)
  }

  /** Normalize a RemoteResult / HTTP error body into an Error. */
  function remoteError(result) {
    const failure = result && result.error
    if (failure && typeof failure.message === 'string' && failure.message) {
      return new Error(failure.message)
    }
    return new Error('远端调用失败')
  }

  function isValidEndpoint(text) {
    const trimmed = String(text || '').trim()
    if (!trimmed) return true
    try {
      const url = new URL(trimmed)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch (error) {
      console.warn('[dsh-acpx-bridge] endpoint is not a URL:', error && error.message)
      return false
    }
  }

  async function fetchJson(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: options.body === undefined ? { accept: 'application/json' } : {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: options.body,
      signal: options.signal,
    })
    let payload = null
    try {
      payload = await response.json()
    } catch (error) {
      console.warn('[dsh-acpx-bridge] response is not JSON:', error && error.message)
      payload = null
    }
    if (!response.ok) {
      const failure = payload && payload.error
      throw new Error(failure && failure.message ? failure.message : `HTTP ${response.status}`)
    }
    if (payload === null) throw new Error('响应不是 JSON')
    return payload
  }

  // -------------------------------------------------------------------------
  // Bridge store: one shared snapshot for the page and the plugin card
  // -------------------------------------------------------------------------

  function createBridgeStore(ctx) {
    let snapshot = {
      phase: 'idle', // idle | loading | ready | error
      data: null,
      error: '',
      busy: '',
      notice: '',
      verify: null, // { phase:'testing'|'done', result }
      // The seven-platform authorization probe has its own lifecycle: it is
      // slower than /state and must never block the page.
      agents: { phase: 'idle', data: null, error: '', probedAt: 0 },
    }
    const listeners = new Set()
    let noticeTimer = null
    let loadToken = 0
    let agentsToken = 0

    const publish = () => {
      for (const listener of listeners) listener()
    }
    const set = patch => {
      snapshot = Object.assign({}, snapshot, patch)
      publish()
    }

    /** Show one dictionary key in the 2s notice pill. */
    function flash(noticeKey) {
      if (noticeTimer !== null) clearTimeout(noticeTimer)
      set({ notice: noticeKey })
      noticeTimer = setTimeout(() => {
        noticeTimer = null
        set({ notice: '' })
      }, NOTICE_MS)
      noticeTimer.unref?.()
    }

    async function load({ quiet = false } = {}) {
      const token = ++loadToken
      if (!quiet) set({ phase: snapshot.data ? 'ready' : 'loading', error: '' })
      try {
        const data = await fetchJson('/state')
        if (token !== loadToken) return null
        set({ phase: 'ready', data, error: '' })
        return data
      } catch (error) {
        if (token !== loadToken) return null
        set({ phase: snapshot.data ? 'ready' : 'error', error: errorText(error) })
        return null
      }
    }

    /** Merge the post-write state the host echoes back. */
    function applyWrite(payload) {
      if (payload && payload.state) {
        set({ data: payload.state, error: '', busy: '' })
      } else {
        set({ busy: '' })
      }
    }

    async function savePrefs(patch, { optimistic = null, label = '', notice = 'saved' } = {}) {
      const before = snapshot.data
      if (optimistic && before) set({ data: optimistic(before), busy: label })
      else set({ busy: label })
      try {
        const payload = await fetchJson('/prefs', { method: 'POST', body: JSON.stringify(patch) })
        applyWrite(payload)
        flash(notice)
        return true
      } catch (error) {
        set({ data: before, busy: '', error: errorText(error) })
        return false
      }
    }

    function credentialsApi() {
      const remote = ctx.remote
      return remote && remote.credentials ? remote.credentials : null
    }

    async function writeKey(value) {
      const api = credentialsApi()
      if (!api) {
        set({ error: '当前部署没有提供凭据服务（credentials）' })
        return false
      }
      set({ busy: 'key' })
      try {
        const result = await api.set(CREDENTIAL_REF, value)
        if (!result || result.ok !== true) throw remoteError(result)
        await load({ quiet: true })
        set({ busy: '' })
        flash('keySaved')
        return true
      } catch (error) {
        set({ busy: '', error: errorText(error) })
        return false
      }
    }

    async function clearKey() {
      const api = credentialsApi()
      if (!api) {
        set({ error: '当前部署没有提供凭据服务（credentials）' })
        return false
      }
      set({ busy: 'key' })
      try {
        const result = await api.unset(CREDENTIAL_REF)
        if (!result || result.ok !== true) throw remoteError(result)
        await load({ quiet: true })
        set({ busy: '' })
        flash('keyCleared')
        return true
      } catch (error) {
        set({ busy: '', error: errorText(error) })
        return false
      }
    }

    async function runVerify() {
      set({ verify: { phase: 'testing', result: null } })
      try {
        const result = await fetchJson('/verify', { method: 'POST' })
        set({ verify: { phase: 'done', result } })
      } catch (error) {
        set({ verify: { phase: 'done', result: { ok: false, error: errorText(error), latencyMs: 0, status: 0, model: '' } } })
      }
    }

    async function redetectAcpx() {
      set({ busy: 'acpx' })
      try {
        const result = await fetchJson('/acpx-check', { method: 'POST' })
        const data = snapshot.data
        if (data) {
          set({ data: Object.assign({}, data, { acpx: Object.assign({ bin: 'acpx' }, result) }), busy: '' })
        } else {
          set({ busy: '' })
        }
        return true
      } catch (error) {
        set({ busy: '', error: errorText(error) })
        return false
      }
    }

    // -----------------------------------------------------------------------
    // Command-tool authorization (7 platforms)
    // -----------------------------------------------------------------------

    /**
     * Load `GET /agents`. Its own token, so a slow probe cannot clobber a newer
     * answer, and its own phase, so the page keeps rendering while it runs.
     */
    async function loadAgents({ force = false, quiet = false } = {}) {
      const token = ++agentsToken
      if (!quiet) {
        set({
          agents: Object.assign({}, snapshot.agents, {
            phase: snapshot.agents.data ? 'ready' : 'loading',
            error: '',
          }),
        })
      }
      try {
        const payload = await fetchJson(`/agents${force ? '?force=1' : ''}`)
        if (token !== agentsToken) return null
        set({
          agents: {
            phase: 'ready',
            data: payload.agents || [],
            error: '',
            probedAt: payload.probedAt || 0,
          },
        })
        return payload
      } catch (error) {
        if (token !== agentsToken) return null
        set({
          agents: Object.assign({}, snapshot.agents, {
            phase: snapshot.agents.data ? 'ready' : 'error',
            error: errorText(error),
          }),
        })
        return null
      }
    }

    function reportError(message) {
      set({ error: String(message || '') })
    }

    /** One agent write: busy flag, JSON POST, then a forced status refresh. */
    async function agentPost(path, body, { label = 'agent' } = {}) {
      set({ busy: label })
      try {
        const payload = await fetchJson(path, { method: 'POST', body: JSON.stringify(body) })
        set({ busy: '' })
        await loadAgents({ force: true, quiet: true })
        return payload
      } catch (error) {
        set({ busy: '', error: errorText(error) })
        return null
      }
    }

    /**
     * Start one login job. A 409 means "this platform already has a job" and
     * still carries its jobId on purpose: the page attaches to the running job
     * instead of failing the click.
     */
    async function agentLoginStart(agentId, { region = '' } = {}) {
      set({ busy: 'agent-login' })
      try {
        const response = await fetch(`${API}/agents/login`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ agent: agentId, region }),
        })
        let payload = null
        try {
          payload = await response.json()
        } catch (error) {
          console.warn('[dsh-acpx-bridge] login start: non-JSON response:', error && error.message)
        }
        if (payload && payload.jobId && (response.ok || response.status === 409)) {
          set({ busy: '' })
          return {
            jobId: payload.jobId,
            argv: payload.argv || '',
            startedAt: payload.startedAt || 0,
            reused: response.status === 409,
          }
        }
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
      } catch (error) {
        set({ busy: '', error: errorText(error) })
        return null
      }
    }

    /** One stdin line for a login job (Trae's pasted callback URL). */
    async function agentLoginInput(agentId, jobId, text) {
      try {
        return await fetchJson('/agents/login/input', {
          method: 'POST',
          body: JSON.stringify({ agent: agentId, jobId, text }),
        })
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    }

    /** SIGTERM a login job (page leaves / user cancels). */
    async function agentLoginCancel(agentId, jobId) {
      try {
        return await fetchJson('/agents/login/cancel', {
          method: 'POST',
          body: JSON.stringify({ agent: agentId, jobId }),
        })
      } catch (error) {
        console.warn('[dsh-acpx-bridge] login cancel failed:', error && error.message)
        return { ok: false }
      }
    }

    /** One real `acpx … exec ping` (the caller confirms first). */
    async function agentTest(agentId) {
      set({ busy: `agent-test:${agentId}` })
      try {
        const result = await fetchJson('/agents/test', {
          method: 'POST',
          body: JSON.stringify({ agent: agentId }),
        })
        set({ busy: '' })
        await loadAgents({ force: true, quiet: true })
        return result
      } catch (error) {
        set({ busy: '', error: errorText(error) })
        return null
      }
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    return {
      subscribe,
      getSnapshot: () => snapshot,
      load,
      savePrefs,
      writeKey,
      clearKey,
      runVerify,
      redetectAcpx,
      flash,
      loadAgents,
      reportError,
      agentPost,
      agentLoginStart,
      agentLoginInput,
      agentLoginCancel,
      agentTest,
      dismissError: () => set({ error: '' }),
      dispose() {
        if (noticeTimer !== null) clearTimeout(noticeTimer)
        noticeTimer = null
        listeners.clear()
      },
    }
  }

  // -------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------

  function useBridge(store) {
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    React.useEffect(() => {
      // One fetch per mount (page open / card open); later refreshes ride
      // visibility changes and writes, never a timer.
      store.load({ quiet: store.getSnapshot().data !== null })
      // The authorization probe is slower (up to 8s per platform, 30s cache on
      // the host); it must never delay /state, so it runs beside it.
      store.loadAgents({ quiet: true })
      const onVisibility = () => {
        if (document.visibilityState === 'visible') {
          store.load({ quiet: true })
          store.loadAgents({ quiet: true })
        }
      }
      document.addEventListener('visibilitychange', onVisibility)
      return () => {
        document.removeEventListener('visibilitychange', onVisibility)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return snapshot
  }

  function useLocaleTick(ctx) {
    const subscribe = React.useCallback(
      listener => (typeof ctx.on === 'function' ? ctx.on('locale/change', listener) : () => {}),
      [ctx],
    )
    const getSnapshot = React.useCallback(() => {
      const locale = ctx.locale && typeof ctx.locale.getLocale === 'function' ? ctx.locale.getLocale() : null
      return (locale && locale.active) || ''
    }, [ctx])
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  }

  /** Persisted boolean map (group / agent collapse state). */
  function usePersistedMap(storageKey, defaults) {
    const [overrides, setOverrides] = React.useState(() => {
      try {
        const raw = window.localStorage.getItem(storageKey)
        if (!raw) return {}
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      } catch (error) {
        console.warn(`[dsh-acpx-bridge] unable to read ${storageKey}:`, error && error.message)
        return {}
      }
    })
    const isOpen = React.useCallback(
      id => (Object.prototype.hasOwnProperty.call(overrides, id) ? Boolean(overrides[id]) : defaults[id] !== false),
      [overrides, defaults],
    )
    const toggle = React.useCallback(id => {
      setOverrides(previous => {
        const current = Object.prototype.hasOwnProperty.call(previous, id)
          ? Boolean(previous[id])
          : defaults[id] !== false
        const next = Object.assign({}, previous, { [id]: !current })
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(next))
        } catch (error) {
          console.warn(`[dsh-acpx-bridge] unable to persist ${storageKey}:`, error && error.message)
        }
        return next
      })
    }, [defaults, storageKey])
    return { isOpen, toggle }
  }

  // -------------------------------------------------------------------------
  // Small presentational pieces
  // -------------------------------------------------------------------------

  function StatusTag({ t, state }) {
    const status = statusOf(state)
    if (status === 'loading') return h(P.Tag, { tone: 'neutral' }, t('loading'))
    if (status === 'acpx-missing') return h(P.Tag, { tone: 'danger' }, t('statusAcpxMissing'))
    if (status === 'unauthorized') return h(P.Tag, { tone: 'warning' }, t('statusUnauthorized'))
    return h(P.Tag, { tone: 'success' }, t('statusReady'))
  }

  function Row({ label, children }) {
    return h('div', { style: S.row },
      h('div', { style: S.rowLabel }, label),
      h('div', { style: S.rowValue }, children),
    )
  }

  function Notice({ tone, children }) {
    const style = tone === 'error' ? Object.assign({}, S.notice, S.noticeError)
      : tone === 'warn' ? Object.assign({}, S.notice, S.noticeWarn)
        : tone === 'ok' ? Object.assign({}, S.notice, S.noticeOk)
          : S.notice
    return h('div', { style, role: tone === 'error' ? 'alert' : undefined }, children)
  }

  function Section({ id, title, meta, open, collapsible, onToggle, children }) {
    const headStyle = collapsible ? S.head : Object.assign({}, S.head, S.headStatic)
    const titleNode = h('span', { style: S.headTitle }, title)
    const metaNode = meta ? h('span', { style: S.headMeta }, meta) : null
    const header = collapsible
      ? h('button', {
        type: 'button',
        style: headStyle,
        'aria-expanded': open ? 'true' : 'false',
        'aria-controls': `acpx-bridge-group-${id}`,
        onClick: onToggle,
      },
        h('span', {
          style: Object.assign({}, S.chevron, { transform: open ? 'rotate(90deg)' : 'none' }),
          'aria-hidden': 'true',
        }, '▸'),
        titleNode,
        metaNode,
      )
      : h('div', { style: headStyle },
        h('span', { style: Object.assign({}, S.chevron, { visibility: 'hidden' }), 'aria-hidden': 'true' }, '▸'),
        titleNode,
        metaNode,
      )
    return h('section', { style: S.card },
      header,
      collapsible && !open ? null : h('div', { style: S.body, id: `acpx-bridge-group-${id}` }, children),
    )
  }

  function CopyCommand({ t, command }) {
    const [copied, setCopied] = React.useState(false)
    React.useEffect(() => {
      if (!copied) return undefined
      const timer = setTimeout(() => setCopied(false), 1000)
      return () => clearTimeout(timer)
    }, [copied])
    async function copy() {
      const ok = await P.writeClipboard(command)
      if (ok) setCopied(true)
    }
    return h('span', { style: S.inline },
      h('code', { style: Object.assign({}, S.mono, { background: T.bg3, padding: '1px 6px', borderRadius: 4 }) }, command),
      h(P.Button, { size: 'sm', variant: 'ghost', onClick: copy }, copied ? t('copied') : t('copy')),
    )
  }

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  function OverviewBody({ t, state }) {
    const acpx = state.acpx || {}
    const credential = state.credential || {}
    const counts = state.counts || { total: 0, enabled: 0 }
    return h(React.Fragment, null,
      h(Row, { label: t('endpoint') },
        h('span', { style: S.mono }, state.endpoint && state.endpoint.effective ? state.endpoint.effective : '—'),
        h(P.Tag, { tone: 'info' }, sourceLabel(t, state.endpoint && state.endpoint.source)),
      ),
      h(Row, { label: t('credential') },
        h(P.StateDot, { state: credential.configured ? 'done' : 'warning', size: 8 }),
        h('span', null, credential.configured ? t('configured') : t('unconfigured')),
        h('span', { style: S.hint }, `${t('credentialRef')} ${credential.ref || CREDENTIAL_REF}`),
      ),
      h(Row, { label: t('modelCount') },
        h('span', null, `${t('enabled')} ${counts.enabled ?? 0} / ${t('total')} ${counts.total ?? 0}`),
      ),
      h(Row, { label: t('acpxBinary') },
        acpx.ok
          ? h(React.Fragment, null,
            h(P.Tag, { tone: 'success' }, `${t('version')} ${acpx.version || '?'}`),
            h('span', { style: S.mono }, acpx.path || acpx.bin || 'acpx'),
          )
          : h(React.Fragment, null,
            h(P.Tag, { tone: 'danger' }, t('notDetected')),
            h('span', { style: Object.assign({}, S.mono, { color: T.danger }) }, acpx.error || acpx.bin || 'acpx'),
          ),
      ),
    )
  }

  function AuthBody({ t, state, store, snapshot }) {
    const [keyText, setKeyText] = React.useState('')
    const [endpointText, setEndpointText] = React.useState(
      (state.prefs && state.prefs.baseURLOverride) || '',
    )
    const [endpointError, setEndpointError] = React.useState('')
    const [keyError, setKeyError] = React.useState('')
    const credential = state.credential || {}
    const readOnly = credential.writable === false || credential.source === 'config'
    const busyKey = snapshot.busy === 'key'
    const fallback = (state.endpoint && state.endpoint.fallback) || ''

    React.useEffect(() => {
      setEndpointText((state.prefs && state.prefs.baseURLOverride) || '')
    }, [state.prefs && state.prefs.baseURLOverride])

    async function commitEndpoint() {
      const trimmed = endpointText.trim()
      if (!isValidEndpoint(trimmed)) {
        setEndpointError(t('invalidUrl'))
        return
      }
      setEndpointError('')
      if (trimmed === ((state.prefs && state.prefs.baseURLOverride) || '')) return
      await store.savePrefs({ baseURLOverride: trimmed }, { label: 'endpoint' })
    }

    async function saveKey() {
      const value = keyText.trim()
      if (!value) {
        setKeyError(t('keyRequired'))
        return
      }
      setKeyError('')
      const ok = await store.writeKey(value)
      if (ok) setKeyText('')
    }

    return h(React.Fragment, null,
      h(Notice, null, t('authHint')),
      h('div', { style: S.field },
        h('div', { style: S.fieldLabel }, t('apiKey')),
        h('div', { style: S.inline },
          h(P.Input, {
            type: 'password',
            autoComplete: 'new-password',
            value: keyText,
            placeholder: t('apiKeyPlaceholder'),
            disabled: readOnly || busyKey,
            style: { width: 280 },
            onChange: event => setKeyText(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter') saveKey()
            },
          }),
          h(P.Button, {
            variant: 'primary',
            size: 'sm',
            disabled: readOnly || busyKey || keyText.trim() === '',
            onClick: saveKey,
          }, busyKey ? t('saving') : t('saveKey')),
          credential.configured
            ? h('span', { style: S.inline },
              h(P.StateDot, { state: 'done', size: 8 }),
              h('span', { style: S.hint }, t('configured')),
              h(P.Button, {
                variant: 'ghost',
                size: 'sm',
                disabled: readOnly || busyKey,
                onClick: () => store.clearKey(),
              }, t('clearKey')),
            )
            : h('span', { style: S.hint }, t('unconfigured')),
        ),
        keyError ? h('div', { style: Object.assign({}, S.hint, { color: T.danger }) }, keyError) : null,
        h('div', { style: S.hint }, credentialSourceNote(t, state)),
        h('div', { style: S.hint }, `${t('credentialRef')}：${CREDENTIAL_REF}`),
      ),
      h('div', { style: S.field },
        h('div', { style: S.fieldLabel }, t('endpointLabel')),
        h('div', { style: S.inline },
          h(P.Input, {
            type: 'text',
            value: endpointText,
            placeholder: fallback ? `${t('endpointPlaceholder')}：${fallback}` : t('endpointPlaceholder'),
            style: { width: 380 },
            onChange: event => setEndpointText(event.target.value),
            onBlur: commitEndpoint,
            onKeyDown: event => {
              if (event.key === 'Enter') commitEndpoint()
            },
          }),
          h(P.Button, {
            variant: 'ghost',
            size: 'sm',
            disabled: !(state.prefs && state.prefs.baseURLOverride),
            onClick: async () => {
              setEndpointText('')
              setEndpointError('')
              await store.savePrefs({ baseURLOverride: '' }, { label: 'endpoint' })
            },
          }, t('resetDefault')),
        ),
        endpointError
          ? h('div', { style: Object.assign({}, S.hint, { color: T.danger }) }, endpointError)
          : h('div', { style: S.hint }, `${t('fallbackEndpoint')}：${fallback}`),
      ),
      h('div', { style: S.inline },
        h(P.Button, {
          variant: 'outline',
          size: 'sm',
          disabled: snapshot.verify && snapshot.verify.phase === 'testing',
          onClick: () => store.runVerify(),
        }, snapshot.verify && snapshot.verify.phase === 'testing' ? t('testing') : t('testConnection')),
        h(VerifyResult, { t, verify: snapshot.verify }),
      ),
    )
  }

  function VerifyResult({ t, verify }) {
    if (!verify || verify.phase === 'testing') {
      return verify && verify.phase === 'testing' ? h('span', { style: S.hint }, t('testing')) : null
    }
    const result = verify.result || {}
    if (result.ok) {
      return h('span', { style: Object.assign({}, S.muted, { color: T.ok }) },
        `${t('testOk')} · ${t('latency')} ${result.latencyMs ?? 0}ms · ${t('modelEcho')} ${result.model || '-'}`,
      )
    }
    const head = `${t('testFailed')}${result.status ? ` · ${t('status')} HTTP ${result.status}` : ''}`
    return h('span', { style: Object.assign({}, S.muted, { color: T.danger }) },
      `${head}${result.error ? ` · ${result.error}` : ''}`,
    )
  }

  function ModelsBody({ t, state, store }) {
    const catalog = state.catalog || []
    const counts = state.counts || { total: 0, enabled: 0 }
    const agents = usePersistedMap(AGENTS_KEY, EMPTY_DEFAULTS)
    const allDisabled = counts.total > 0 && counts.enabled === 0
    const disabledModels = (state.prefs && state.prefs.disabledModels) || []

    function setEnabled(id, nextEnabled) {
      const next = nextEnabled
        ? disabledModels.filter(entry => entry !== id)
        : (disabledModels.includes(id) ? disabledModels : disabledModels.concat([id]))
      const optimistic = data => Object.assign({}, data, {
        prefs: Object.assign({}, data.prefs, { disabledModels: next }),
        catalog: (data.catalog || []).map(group => Object.assign({}, group, {
          models: (group.models || []).map(model => (
            model.id === id ? Object.assign({}, model, { enabled: nextEnabled }) : model
          )),
        })),
        counts: computeCounts(data.catalog || [], next),
      })
      store.savePrefs({ disabledModels: next }, { optimistic, label: 'models' })
    }

    function computeCounts(currentCatalog, disabled) {
      const disabledSet = new Set(disabled)
      const ids = uniqueIds(currentCatalog)
      const enabled = ids.filter(id => !disabledSet.has(id)).length
      return { total: ids.length, enabled }
    }

    function disableAll() {
      const all = uniqueIds(catalog)
      const optimistic = data => Object.assign({}, data, {
        prefs: Object.assign({}, data.prefs, { disabledModels: all }),
        catalog: (data.catalog || []).map(group => Object.assign({}, group, {
          models: (group.models || []).map(model => Object.assign({}, model, { enabled: false })),
        })),
        counts: { total: all.length, enabled: 0 },
      })
      store.savePrefs({ disabledModels: all }, { optimistic, label: 'models' })
    }

    function enableAll() {
      const optimistic = data => Object.assign({}, data, {
        prefs: Object.assign({}, data.prefs, { disabledModels: [] }),
        catalog: (data.catalog || []).map(group => Object.assign({}, group, {
          models: (group.models || []).map(model => Object.assign({}, model, { enabled: true })),
        })),
        counts: { total: uniqueIds(data.catalog || []).length, enabled: uniqueIds(data.catalog || []).length },
      })
      store.savePrefs({ disabledModels: [] }, { optimistic, label: 'models' })
    }

    return h(React.Fragment, null,
      h('div', { style: Object.assign({}, S.inline, { justifyContent: 'space-between' }) },
        h('span', { style: S.muted }, `${t('enabled')} ${counts.enabled ?? 0} / ${t('total')} ${counts.total ?? 0}`),
        h('span', { style: S.actions },
          h(P.Button, { size: 'sm', variant: 'ghost', onClick: enableAll }, t('allOn')),
          h(P.Button, { size: 'sm', variant: 'ghost', onClick: disableAll }, t('allOff')),
        ),
      ),
      allDisabled ? h(Notice, { tone: 'error' }, t('allOffWarning')) : null,
      catalog.length === 0 ? h('div', { style: S.muted }, t('noModels')) : null,
      catalog.map(group => {
        const open = agents.isOpen(group.agent)
        const enabledCount = (group.models || []).filter(model => model.enabled).length
        return h('div', { key: group.agent, style: S.agent },
          h('button', {
            type: 'button',
            style: S.agentHead,
            'aria-expanded': open,
            onClick: () => agents.toggle(group.agent),
          },
            h('span', {
              style: Object.assign({}, S.chevron, { transform: open ? 'rotate(90deg)' : 'none' }),
              'aria-hidden': 'true',
            }, '▸'),
            h('span', { style: S.headTitle }, group.agent),
            h('span', { style: S.headMeta }, `${t('enabled')} ${enabledCount}/${(group.models || []).length}`),
          ),
          open
            ? h('div', { style: S.agentBody }, (group.models || []).map((model, index) => h('div', {
              key: `${model.id}-${index}`,
              style: S.modelRow,
            },
              h(P.Switch, {
                checked: model.enabled,
                label: `${t('switchLabel')}: ${model.name}`,
                onChange: next => setEnabled(model.id, next),
              }),
              h('span', {
                style: Object.assign({}, S.modelName, model.enabled ? null : { color: T.fg3, textDecoration: 'line-through' }),
              }, model.name),
              h('span', { style: S.modelId }, model.id),
              model.placeholder
                ? h(P.Tag, { tone: model.enabled ? 'warning' : 'neutral' }, t('placeholderTag'))
                : null,
            )))
            : null,
        )
      }),
    )
  }

  // -------------------------------------------------------------------------
  // 命令工具授权：7 个平台的 CLI 授权全部在页面内完成
  // -------------------------------------------------------------------------

  /** Parse one `event: … / data: {json}` payload; a broken frame is ignored. */
  function parseFrame(data) {
    try {
      const parsed = JSON.parse(data)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch (error) {
      console.warn('[dsh-acpx-bridge] unparsable SSE frame:', error && error.message)
      return null
    }
  }

  /** De-duplicate + cap the link list shown in the login panel. */
  function mergeLinks(previous, extra) {
    const merged = Array.isArray(previous) ? previous.slice() : []
    for (const link of extra || []) {
      const clean = typeof link === 'string' ? link.replace(/[.,;:)！。，；）]+$/, '') : ''
      if (!clean || merged.includes(clean)) continue
      merged.push(clean)
    }
    return merged.slice(-10)
  }

  /** Live URLs in a chunk of CLI output (the panel is the only consumer). */
  function extractLinks(text) {
    const found = String(text || '').match(/https?:\/\/[^\s"'`<>()[\]{}]+/g)
    return found || []
  }

  function methodLabel(t, method) {
    if (method === 'device-code') return t('methodDeviceCode')
    if (method === 'api-key') return t('methodApiKey')
    if (method === 'none') return t('methodNone')
    if (method === 'interactive') return t('methodInteractive')
    return t('methodUnknown')
  }

  function stateLabel(t, state) {
    if (state === 'authorized') return t('stateAuthorized')
    if (state === 'unauthorized') return t('stateUnauthorized')
    if (state === 'no-auth') return t('stateNoAuth')
    if (state === 'unavailable') return t('stateUnavailable')
    return t('stateUnknown')
  }

  /** Status dot: green / yellow / grey / red, and a grey "?" for unknown. */
  function AgentStatusDot({ state }) {
    if (state === 'unknown') {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 2 }, title: 'unknown' },
        h(P.StateDot, { state: 'idle', size: 8 }),
        h('span', { style: { color: T.fg3, fontSize: 11, lineHeight: 1 } }, '?'),
      )
    }
    return h(P.StateDot, { state: AGENT_DOT[state] || 'idle', size: 8 })
  }

  /** Copy button that reports success for one second (no polling, no re-render). */
  function CopyText({ t, text, label }) {
    const [copied, setCopied] = React.useState(false)
    React.useEffect(() => {
      if (!copied) return undefined
      const timer = setTimeout(() => setCopied(false), 1000)
      return () => clearTimeout(timer)
    }, [copied])
    return h(P.Button, {
      size: 'sm',
      variant: 'ghost',
      onClick: async () => {
        const ok = await P.writeClipboard(text)
        if (ok) setCopied(true)
      },
    }, copied ? t('copied') : (label || t('copy')))
  }

  /**
   * Inline authorization panel: one EventSource on one login job.
   *
   * Snapshot → chunk* → exit is the server's frame order. The panel closes its
   * EventSource on exit, unmount or group switch, and cancels the job when the
   * user (or the page) walks away, so no CLI is left waiting for input.
   */
  function LoginPanel({ t, agent, job, store, onClose, onFinished }) {
    const [lines, setLines] = React.useState([])
    const [links, setLinks] = React.useState([])
    const [phase, setPhase] = React.useState('starting')
    const [exitCode, setExitCode] = React.useState(null)
    const [broken, setBroken] = React.useState(false)
    const [callback, setCallback] = React.useState('')
    const [inputError, setInputError] = React.useState('')
    const [inputBusy, setInputBusy] = React.useState(false)
    const bufferRef = React.useRef('')
    const doneRef = React.useRef(false)
    const preRef = React.useRef(null)
    const finishedRef = React.useRef(onFinished)
    const cancelRef = React.useRef(null)
    finishedRef.current = onFinished

    React.useEffect(() => {
      let source = null
      const append = text => {
        bufferRef.current = (bufferRef.current + text).slice(-LOGIN_MAX_CHARS)
        setLines(bufferRef.current.split('\n').slice(-LOGIN_MAX_LINES))
        const found = extractLinks(bufferRef.current)
        if (found.length > 0) setLinks(previous => mergeLinks(previous, found))
      }
      const finish = payload => {
        if (doneRef.current) return
        doneRef.current = true
        setPhase('ended')
        if (payload) {
          setExitCode(typeof payload.exitCode === 'number' ? payload.exitCode : null)
          if (Array.isArray(payload.links)) setLinks(previous => mergeLinks(previous, payload.links))
        }
        if (source) source.close()
        if (typeof finishedRef.current === 'function') finishedRef.current(agent.id)
      }
      const url = `${API}/agents/login/events?agent=${encodeURIComponent(agent.id)}&job=${encodeURIComponent(job.jobId)}`
      try {
        source = new window.EventSource(url)
      } catch (error) {
        console.warn('[dsh-acpx-bridge] EventSource unavailable:', error && error.message)
        setBroken(true)
        setPhase('ended')
        return undefined
      }
      source.addEventListener('snapshot', event => {
        const payload = parseFrame(event.data)
        if (!payload) return
        bufferRef.current = String(payload.text || '').slice(-LOGIN_MAX_CHARS)
        setLines(bufferRef.current.split('\n').slice(-LOGIN_MAX_LINES))
        if (Array.isArray(payload.links) && payload.links.length > 0) {
          setLinks(previous => mergeLinks([], payload.links))
        }
        if (payload.done === true) finish(payload)
        else setPhase('waiting')
      })
      source.addEventListener('chunk', event => {
        const payload = parseFrame(event.data)
        if (!payload || typeof payload.text !== 'string' || !payload.text) return
        append(payload.text)
        setPhase(current => (current === 'ended' ? current : 'waiting'))
      })
      source.addEventListener('exit', event => finish(parseFrame(event.data)))
      // eslint-disable-next-line no-param-reassign
      source.onerror = () => {
        if (doneRef.current) {
          if (source) source.close()
          return
        }
        doneRef.current = true
        setBroken(true)
        setPhase('ended')
        if (source) source.close()
      }
      return () => {
        if (source) source.close()
        if (!doneRef.current) store.agentLoginCancel(agent.id, job.jobId)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agent.id, job.jobId])

    React.useEffect(() => {
      const node = preRef.current
      if (node) node.scrollTop = node.scrollHeight
    }, [lines])

    cancelRef.current = async () => {
      const result = await store.agentLoginCancel(agent.id, job.jobId)
      if (!result || result.ok !== true) setInputError(t('loginStreamBroken'))
    }

    async function submitCallback() {
      const text = callback.trim()
      if (!text) {
        setInputError(t('callbackRequired'))
        return
      }
      setInputError('')
      setInputBusy(true)
      const result = await store.agentLoginInput(agent.id, job.jobId, text)
      setInputBusy(false)
      if (result && result.ok === true) setCallback('')
      else setInputError((result && result.error) || t('loginStreamBroken'))
    }

    const phaseLabel = phase === 'starting' ? t('loginStarting')
      : phase === 'waiting' ? t('loginWaiting')
        : t('loginEnded')

    return h('div', {
      style: {
        borderTop: `1px solid ${T.border}`, padding: '8px 10px',
        display: 'flex', flexDirection: 'column', gap: 8, background: T.bg1,
      },
    },
      h('div', { style: S.inline },
        h(P.Tag, { tone: phase === 'ended' ? 'neutral' : 'info' }, phaseLabel),
        exitCode !== null ? h('span', { style: S.muted }, `${t('loginExitCode')} ${exitCode}`) : null,
        job.reused ? h('span', { style: S.hint }, t('loginReused')) : null,
        h('span', { style: { flex: '1 1 auto' } }),
        phase === 'ended'
          ? h(P.Button, { size: 'sm', variant: 'ghost', onClick: onClose }, t('actionClose'))
          : h(P.Button, {
            size: 'sm',
            variant: 'ghost',
            onClick: () => cancelRef.current && cancelRef.current(),
          }, t('actionCancel')),
      ),
      job.argv ? h('div', { style: S.mono }, `$ ${job.argv}`) : null,
      links.length > 0
        ? h('div', { style: S.field },
          h('div', { style: S.fieldLabel }, t('loginLinks')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            links.map(link => h('div', { key: link, style: S.inline },
              h('code', {
                style: Object.assign({}, S.mono, {
                  maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }),
              }, link),
              h(CopyText, { t, text: link }),
              h(P.Button, {
                size: 'sm',
                variant: 'ghost',
                onClick: () => window.open(link, '_blank', 'noopener,noreferrer'),
              }, t('openLink')),
            )),
          ),
        )
        : null,
      agentNeedsCallback(agent)
        ? h('div', { style: S.field },
          h('div', { style: S.fieldLabel }, t('callbackLabel')),
          h('div', { style: S.inline },
            h(P.Input, {
              type: 'text',
              value: callback,
              placeholder: t('callbackPlaceholder'),
              disabled: inputBusy || phase === 'ended',
              style: { width: 380 },
              onChange: event => setCallback(event.target.value),
              onKeyDown: event => {
                if (event.key === 'Enter') submitCallback()
              },
            }),
            h(P.Button, {
              size: 'sm',
              variant: 'primary',
              disabled: inputBusy || phase === 'ended' || callback.trim() === '',
              onClick: submitCallback,
            }, t('actionSubmit')),
          ),
          inputError ? h('div', { style: Object.assign({}, S.hint, { color: T.danger }) }, inputError) : null,
        )
        : null,
      h('div', { style: S.field },
        h('div', { style: S.fieldLabel }, t('loginOutput')),
        h('pre', {
          ref: preRef,
          style: Object.assign({}, S.mono, {
            margin: 0, padding: '8px 10px', background: T.bg3,
            border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
            maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 11.5,
          }),
        }, lines.length > 0 ? lines.join('\n') : t('loginEmpty')),
      ),
      broken ? h('div', { style: Object.assign({}, S.hint, { color: T.danger }) }, t('loginStreamBroken')) : null,
    )
  }

  /** Whether this platform's login wants a pasted callback URL. */
  function agentNeedsCallback(agent) {
    return agent.id === 'trae'
  }

  /**
   * Per-platform key form: provider + key for opencode, key/baseURL/model for
   * qwen. Writes go through the store, which refreshes the row afterwards.
   */
  function KeyForm({ t, agent, store, onDone }) {
    const isOpencode = agent.id === 'opencode'
    const [provider, setProvider] = React.useState(OPENCODE_PROVIDERS[0])
    const [key, setKey] = React.useState('')
    const [baseURL, setBaseURL] = React.useState('')
    const [model, setModel] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')

    async function submit() {
      const value = key.trim()
      if (!value) {
        setError(t('keyRequired'))
        return
      }
      setError('')
      setBusy(true)
      const body = isOpencode
        ? { agent: agent.id, provider, key: value }
        : { agent: agent.id, apiKey: value, baseURL: baseURL.trim(), model: model.trim() }
      const result = await store.agentPost('/agents/key', body, { label: 'agent-key' })
      setBusy(false)
      if (result) {
        setKey('')
        store.flash('keyWritten')
        if (onDone) onDone()
      }
    }

    async function remove() {
      if (!window.confirm(t('removeKeyConfirm'))) return
      setBusy(true)
      const body = isOpencode ? { agent: agent.id, provider } : { agent: agent.id }
      const result = await store.agentPost('/agents/key/remove', body, { label: 'agent-key' })
      setBusy(false)
      if (result) store.flash(result.removed === false ? 'keyNotConfigured' : 'keyRemoved')
    }

    return h('div', {
      style: {
        borderTop: `1px solid ${T.border}`, padding: '8px 10px',
        display: 'flex', flexDirection: 'column', gap: 8,
      },
    },
      h('div', { style: S.fieldLabel }, `${t('keyFormTitle')} · ${agent.name}`),
      isOpencode
        ? h('div', { style: S.inline },
          h('span', { style: S.hint }, t('keyProviderLabel')),
          h('select', {
            style: S.select,
            value: provider,
            onChange: event => setProvider(event.target.value),
          }, OPENCODE_PROVIDERS.map(id => h('option', { key: id, value: id }, id))),
          h('span', { style: S.hint }, '~/.local/share/opencode/auth.json'),
        )
        : null,
      h('div', { style: S.inline },
        h('span', { style: S.hint }, t('keyApiKeyLabel')),
        h(P.Input, {
          type: 'password',
          autoComplete: 'new-password',
          value: key,
          placeholder: t('apiKeyPlaceholder'),
          disabled: busy,
          style: { width: 300 },
          onChange: event => setKey(event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter') submit()
          },
        }),
      ),
      isOpencode
        ? null
        : h(React.Fragment, null,
          h('div', { style: S.inline },
            h('span', { style: S.hint }, t('keyBaseURLLabel')),
            h(P.Input, {
              type: 'text',
              value: baseURL,
              disabled: busy,
              style: { width: 380 },
              onChange: event => setBaseURL(event.target.value),
            }),
          ),
          h('div', { style: S.inline },
            h('span', { style: S.hint }, t('keyModelLabel')),
            h(P.Input, {
              type: 'text',
              value: model,
              disabled: busy,
              style: { width: 300 },
              onChange: event => setModel(event.target.value),
            }),
          ),
          h('div', { style: S.hint }, '~/.acpx/config.json → agents.qwen.argv（其它 agent 与未知字段保留，写前留 .bak）'),
        ),
      error ? h('div', { style: Object.assign({}, S.hint, { color: T.danger }) }, error) : null,
      h('div', { style: S.actions },
        h(P.Button, {
          size: 'sm',
          variant: 'primary',
          disabled: busy || key.trim() === '',
          onClick: submit,
        }, busy ? t('saving') : t('keySave')),
        h(P.Button, {
          size: 'sm',
          variant: 'ghost',
          disabled: busy,
          onClick: remove,
        }, t('actionRemoveKey')),
        h('span', { style: S.hint }, t('keyRemoveHint')),
      ),
    )
  }

  /**
   * One platform row: status dot, name, version, method, detail and its
   * actions. The login panel and the key form expand inline (never a modal).
   */
  function AgentRow({
    t, agent, store, test, login, formOpen, open, busy,
    onToggleOpen, onStartLogin, onCloseLogin, onJobFinished,
    onToggleForm, onCloseForm, onTest, onRemoveKey, onLogout,
  }) {
    const actions = Array.isArray(agent.actions) ? agent.actions : []
    const canLogin = actions.includes('login')
    const canSetKey = actions.includes('set-key')
    const canRemoveKey = actions.includes('remove-key')
    const canCopyLogin = actions.includes('copy-login')
    const canLogout = actions.includes('logout')
    const canTest = actions.includes('test')
    const testing = test && test.phase === 'testing'
    const detail = agent.detail || ''
    const shown = open ? detail : (detail.length > 150 ? `${detail.slice(0, 150)}…` : detail)

    return h('div', { style: S.agent },
      h('div', { style: Object.assign({}, S.agentHead, { cursor: 'default', flexWrap: 'wrap' }) },
        h(AgentStatusDot, { state: agent.state }),
        h('span', { style: { fontWeight: 500 } }, agent.name),
        agent.version ? h('span', { style: S.muted }, `v${agent.version}`) : null,
        agent.installed === false ? h(P.Tag, { tone: 'danger' }, t('notInstalled')) : null,
        h(P.Tag, { tone: 'neutral' }, methodLabel(t, agent.method)),
        typeof agent.models === 'number'
          ? h('span', { style: S.muted }, `${t('agentModelsCount')} ${agent.models}`)
          : null,
        h('span', { style: { flex: '1 1 auto' } }),
        h('span', { style: S.hint }, stateLabel(t, agent.state)),
        h('span', { style: S.actions },
          canLogin
            ? h(P.Button, {
              size: 'sm',
              variant: login ? 'outline' : 'primary',
              disabled: busy === 'agent-login',
              onClick: () => (login ? onCloseLogin() : onStartLogin()),
            }, login ? t('actionLess') : t('actionLogin'))
            : null,
          canSetKey
            ? h(P.Button, {
              size: 'sm',
              variant: formOpen ? 'outline' : 'primary',
              onClick: () => (formOpen ? onCloseForm() : onToggleForm()),
            }, formOpen ? t('actionLess') : t('actionSetKey'))
            : null,
          canCopyLogin ? h(CopyCommand, { t, command: loginCommandFor(agent.id) }) : null,
          canLogout
            ? h(P.Button, { size: 'sm', variant: 'ghost', onClick: onLogout }, t('actionLogout'))
            : null,
          canRemoveKey && !formOpen
            ? h(P.Button, { size: 'sm', variant: 'ghost', onClick: onRemoveKey }, t('actionRemoveKey'))
            : null,
          canTest
            ? h(P.Button, {
              size: 'sm',
              variant: 'ghost',
              disabled: testing,
              onClick: onTest,
            }, testing ? t('testRunning') : t('actionTest'))
            : null,
          detail || open
            ? h(P.Button, {
              size: 'sm',
              variant: 'ghost',
              onClick: onToggleOpen,
            }, open ? t('actionLess') : t('actionDetail'))
            : null,
        ),
      ),
      shown
        ? h('div', {
          style: { padding: '0 10px 8px 30px', color: T.fg3, fontSize: 12, wordBreak: 'break-word' },
        }, shown)
        : null,
      open
        ? h('div', { style: { padding: '0 10px 10px 30px', display: 'flex', flexDirection: 'column', gap: 6 } },
          agent.bin ? h('div', { style: S.mono }, agent.bin) : null,
          agent.docs ? h('div', { style: S.hint }, `${t('agentDocs')}：${agent.docs}`) : null,
          h('div', { style: S.actions },
            h(CopyText, { t, text: agent.id, label: `id: ${agent.id}` }),
            canTest
              ? h(P.Button, {
                size: 'sm',
                variant: 'ghost',
                disabled: testing,
                onClick: onTest,
              }, testing ? t('testRunning') : t('actionTest'))
              : null,
          ),
        )
        : null,
      test && test.phase === 'done' && test.result
        ? h(TestResult, { t, agent, result: test.result })
        : null,
      login
        ? h(LoginPanel, {
          t,
          agent,
          job: login,
          store,
          onClose: onCloseLogin,
          onFinished: onJobFinished,
        })
        : null,
      formOpen ? h(KeyForm, { t, agent, store, onDone: onCloseForm }) : null,
    )
  }

  /** One test answer: a one-line verdict plus the (collapsed) raw output. */
  function TestResult({ t, agent, result }) {
    const [open, setOpen] = React.useState(false)
    const ok = result.ok === true
    const head = ok
      ? `${t('testOk')} · ${result.durationMs || 0}ms`
      : `${t('testFailed')} · ${result.diagnostic || `exit ${result.exitCode}`}`
    const raw = [result.stdout, result.stderr].filter(Boolean).join('\n')
    return h('div', { style: { padding: '0 10px 8px 30px', display: 'flex', flexDirection: 'column', gap: 4 } },
      h('div', { style: S.inline },
        h(P.Tag, { tone: ok ? 'success' : 'danger' }, head),
        raw
          ? h(P.Button, { size: 'sm', variant: 'ghost', onClick: () => setOpen(value => !value) },
            open ? t('actionLess') : t('actionDetail'))
          : null,
      ),
      open && raw
        ? h('pre', {
          style: Object.assign({}, S.mono, {
            margin: 0, padding: '6px 8px', background: T.bg3, border: `1px solid ${T.border}`,
            borderRadius: T.radiusSm, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap',
          }),
        }, raw)
        : null,
    )
  }

  /**
   * Group 4 — the seven installed platform CLIs, authorized from this page.
   *
   * Every write refreshes only this slice (`GET /agents?force=1`); /state is not
   * re-fetched, so the rest of the page does not flicker. The login panel owns
   * its EventSource and cancels its job when it unmounts (group collapse, page
   * leave), which is the only thing keeping a waiting CLI from leaking.
   */
  function AgentsBody({ t, snapshot, store }) {
    const slice = snapshot.agents || { phase: 'idle', data: null, error: '' }
    const rows = Array.isArray(slice.data) ? slice.data : []
    const [logins, setLogins] = React.useState({})
    const [forms, setForms] = React.useState({})
    const [tests, setTests] = React.useState({})
    const [open, setOpen] = React.useState({})
    const busy = snapshot.busy || ''

    async function startLogin(agent) {
      const started = await store.agentLoginStart(agent.id)
      if (!started) return
      setLogins(previous => Object.assign({}, previous, { [agent.id]: started }))
      setOpen(previous => Object.assign({}, previous, { [agent.id]: true }))
    }

    function closeLogin(agent) {
      setLogins(previous => {
        const next = Object.assign({}, previous)
        delete next[agent.id]
        return next
      })
    }

    async function runTest(agent) {
      if (!window.confirm(t('testConfirm'))) return
      setTests(previous => Object.assign({}, previous, { [agent.id]: { phase: 'testing' } }))
      const result = await store.agentTest(agent.id)
      setTests(previous => Object.assign({}, previous, { [agent.id]: { phase: 'done', result } }))
    }

    async function removeKey(agent) {
      if (!window.confirm(t('removeKeyConfirm'))) return
      if (agent.id === 'opencode') {
        // opencode needs the provider whose credential should be dropped.
        setForms(previous => Object.assign({}, previous, { [agent.id]: true }))
        store.reportError(t('logoutNoProvider'))
        return
      }
      const result = await store.agentPost('/agents/key/remove', { agent: agent.id }, { label: 'agent-key' })
      if (result) store.flash(result.removed === false ? 'keyNotConfigured' : 'keyRemoved')
    }

    async function logout(agent) {
      if (!window.confirm(t('logoutConfirm'))) return
      if (agent.id === 'opencode') {
        setForms(previous => Object.assign({}, previous, { [agent.id]: true }))
        store.reportError(t('logoutNoProvider'))
        return
      }
      const result = await store.agentPost('/agents/logout', { agent: agent.id }, { label: 'agent-logout' })
      if (result) store.flash('logoutDone')
    }

    function refreshAfterJob() {
      store.loadAgents({ force: true, quiet: true })
    }

    return h(React.Fragment, null,
      h('div', { style: Object.assign({}, S.inline, { justifyContent: 'space-between' }) },
        h('span', { style: S.muted },
          slice.phase === 'loading' || slice.phase === 'idle'
            ? t('detectingAll')
            : `${t('authorizedCount')} ${rows.filter(row => row.state === 'authorized').length} / ${t('installedCount')} ${rows.filter(row => row.installed === true).length}`,
        ),
        h('span', { style: S.actions },
          h(P.Button, {
            size: 'sm',
            variant: 'outline',
            disabled: slice.phase === 'loading' || busy === 'agent-detect',
            onClick: () => store.loadAgents({ force: true }),
          }, t('detectAll')),
        ),
      ),
      slice.error
        ? h(Notice, { tone: 'error' },
          h('div', null, `${t('agentsProbeFailed')}：${slice.error}`),
        )
        : null,
      rows.length === 0
        ? h('div', { style: S.muted }, t('agentsEmpty'))
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          rows.map(agent => h(AgentRow, {
            key: agent.id,
            t,
            agent,
            store,
            test: tests[agent.id],
            login: logins[agent.id] || null,
            formOpen: Boolean(forms[agent.id]),
            open: Boolean(open[agent.id]),
            busy,
            onToggleOpen: () => setOpen(previous => Object.assign({}, previous, { [agent.id]: !previous[agent.id] })),
            onStartLogin: () => startLogin(agent),
            onCloseLogin: () => closeLogin(agent),
            onJobFinished: refreshAfterJob,
            onToggleForm: () => setForms(previous => Object.assign({}, previous, { [agent.id]: true })),
            onCloseForm: () => setForms(previous => Object.assign({}, previous, { [agent.id]: false })),
            onTest: () => runTest(agent),
            onRemoveKey: () => removeKey(agent),
            onLogout: () => logout(agent),
          })),
        ),
      h(Notice, null, t('agentsAuthHint')),
    )
  }

  function DefaultsBody({ t, state, store }) {
    const defaults = (state.prefs && state.prefs.defaults) || {
      agent: '', mode: 'exec', approve: 'reads', format: 'quiet', timeoutMs: DEFAULT_TIMEOUT,
    }
    const catalog = state.catalog || []
    const [timeoutText, setTimeoutText] = React.useState(String(defaults.timeoutMs))
    const timerRef = React.useRef(null)

    React.useEffect(() => {
      setTimeoutText(String(defaults.timeoutMs))
    }, [defaults.timeoutMs])

    React.useEffect(() => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }, [])

    function saveDefaults(patch) {
      store.savePrefs({ defaults: patch }, { label: 'defaults' })
    }

    function onTimeoutChange(event) {
      const text = event.target.value
      setTimeoutText(text)
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        const numeric = Number(text)
        if (!Number.isFinite(numeric)) return
        const clamped = Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(numeric)))
        saveDefaults({ timeoutMs: clamped })
      }, 500)
    }

    return h(React.Fragment, null,
      h('div', { style: S.field },
        h('div', { style: S.fieldLabel }, t('defaultAgent')),
        h('select', {
          style: S.select,
          value: defaults.agent || '',
          onChange: event => saveDefaults({ agent: event.target.value }),
        },
          h('option', { value: '' }, t('unsetAgent')),
          catalog.map(group => h('option', { key: group.agent, value: group.agent }, group.agent)),
        ),
      ),
      h('div', { style: S.field },
        h('div', { style: S.fieldLabel }, t('defaultMode')),
        h(P.SegmentedControl, {
          id: 'acpx-bridge-default-mode',
          label: t('defaultMode'),
          value: defaults.mode,
          options: [
            { value: 'exec', label: t('modeExec') },
            { value: 'session', label: t('modeSession') },
          ],
          onChange: next => saveDefaults({ mode: next }),
        }),
      ),
      h('div', { style: S.field },
        h('div', { style: S.fieldLabel }, t('defaultApprove')),
        h(P.SegmentedControl, {
          id: 'acpx-bridge-default-approve',
          label: t('defaultApprove'),
          value: defaults.approve,
          options: [
            { value: 'reads', label: t('approveReads') },
            { value: 'all', label: t('approveAll') },
            { value: 'none', label: t('approveNone') },
          ],
          onChange: next => saveDefaults({ approve: next }),
        }),
      ),
      h('div', { style: S.field },
        h('div', { style: S.fieldLabel }, t('defaultFormat')),
        h(P.SegmentedControl, {
          id: 'acpx-bridge-default-format',
          label: t('defaultFormat'),
          value: defaults.format,
          options: [
            { value: 'quiet', label: t('formatQuiet') },
            { value: 'json', label: t('formatJson') },
            { value: 'text', label: t('formatText') },
          ],
          onChange: next => saveDefaults({ format: next }),
        }),
      ),
      h('div', { style: S.field },
        h('div', { style: S.fieldLabel }, t('defaultTimeout')),
        h(P.Input, {
          type: 'number',
          min: TIMEOUT_MIN,
          max: TIMEOUT_MAX,
          step: 1000,
          value: timeoutText,
          style: S.numberInput,
          onChange: onTimeoutChange,
          onBlur: () => {
            if (timerRef.current !== null) {
              clearTimeout(timerRef.current)
              timerRef.current = null
            }
            const numeric = Number(timeoutText)
            if (!Number.isFinite(numeric)) {
              setTimeoutText(String(defaults.timeoutMs))
              return
            }
            const clamped = Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(numeric)))
            if (clamped !== defaults.timeoutMs) saveDefaults({ timeoutMs: clamped })
            setTimeoutText(String(clamped))
          },
        }),
        h('span', { style: S.hint }, `${TIMEOUT_MIN} – ${TIMEOUT_MAX} ms`),
      ),
      h(Notice, null, t('defaultsHint')),
    )
  }

  function DiagnosticsBody({ t, state, store, snapshot }) {
    const [confirming, setConfirming] = React.useState(false)
    React.useEffect(() => {
      if (!confirming) return undefined
      const timer = setTimeout(() => setConfirming(false), 4000)
      timer.unref?.()
      return () => clearTimeout(timer)
    }, [confirming])
    const wire = state.wireModels || {}
    const wireText = Object.keys(wire).length > 0 ? JSON.stringify(wire, null, 2) : ''

    return h(React.Fragment, null,
      h(Row, { label: t('pluginVersion') }, h('span', { style: S.mono }, state.version || '—')),
      h(Row, { label: t('providerRoute') }, h('span', { style: S.mono }, state.provider || PROVIDER)),
      h(Row, { label: t('entryId') }, h('span', { style: S.mono }, state.entryId || 'acpx-bridge')),
      h(Row, { label: t('wireModels') },
        wireText
          ? h('pre', {
            style: Object.assign({}, S.mono, {
              margin: 0, whiteSpace: 'pre-wrap', background: T.bg3,
              border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: '6px 8px', maxWidth: '100%',
            }),
          }, wireText)
          : h('span', { style: S.hint }, t('wireEmpty')),
      ),
      h('div', { style: S.actions },
        h(P.Button, {
          size: 'sm',
          variant: 'outline',
          disabled: snapshot.busy !== '',
          onClick: () => store.savePrefs({}, { label: 'refresh', notice: 'refreshed' }),
        }, t('refreshModels')),
        h(P.Button, {
          size: 'sm',
          variant: 'ghost',
          onClick: async () => {
            if (!confirming) {
              setConfirming(true)
              return
            }
            setConfirming(false)
            await store.savePrefs({ reset: true }, { label: 'reset', notice: 'resetDone' })
          },
          style: confirming ? { color: T.danger } : undefined,
        }, confirming ? t('resetConfirm') : t('resetPrefs')),
      ),
      h('div', { style: S.hint },
        // Plain text on purpose: the GUI has no route serving docs/ setting file,
        // so a relative link would 404. The path is for humans reading the repo.
        `${t('docsHint')}${(state.notes && state.notes.docs) || t('docsLabel')} · ${t('settingsHint')}`,
      ),
    )
  }

  // -------------------------------------------------------------------------
  // The settings page
  // -------------------------------------------------------------------------

  function AcpxBridgePage(props) {
    const ctx = props.bridge.ctx
    const store = props.bridge.store
    useLocaleTick(ctx)
    const t = key => (ctx.locale.bind(NS)(key))
    const snapshot = useBridge(store)
    const groups = usePersistedMap(GROUPS_KEY, GROUP_DEFAULTS)
    const data = snapshot.data

    if (snapshot.phase === 'loading' && !data) {
      return h('div', { style: S.page },
        h('div', { style: S.muted }, t('loading')),
      )
    }
    if (snapshot.phase === 'error' && !data) {
      return h('div', { style: S.page },
        h('h2', { style: S.title }, t('title')),
        h(Notice, { tone: 'error' },
          h('div', null, `${t('loadFailed')}：${snapshot.error}`),
          h('div', { style: { marginTop: 8 } },
            h(P.Button, { size: 'sm', variant: 'outline', onClick: () => store.load() }, t('retry')),
          ),
        ),
      )
    }
    if (!data) return h('div', { style: S.page }, h('div', { style: S.muted }, t('loading')))

    const counts = data.counts || { total: 0, enabled: 0 }
    // Group 4's header meta: authorized / installed, from the plugin's own
    // seven-platform probe (never from /state, which knows nothing about CLIs).
    const agentRows = (snapshot.agents && snapshot.agents.data) || []
    const agentsMeta = agentRows.length === 0
      ? ''
      : `${t('authorizedCount')} ${agentRows.filter(row => row.state === 'authorized').length} / ${t('installedCount')} ${agentRows.filter(row => row.installed === true).length}`

    return h('div', { style: S.page },
      h('div', null,
        h('h2', { style: S.title }, t('title')),
        h('p', { style: S.lead }, t('lead')),
      ),
      snapshot.error
        ? h(Notice, { tone: 'error' },
          h('div', { style: S.inline },
            h('span', null, `${t('saveFailed')}：${snapshot.error}`),
            h(P.Button, { size: 'sm', variant: 'ghost', onClick: store.dismissError }, '×'),
          ),
        )
        : null,
      snapshot.notice
        ? h('div', { style: S.noticePill },
          h(P.StateDot, { state: 'done', size: 8 }),
          h('span', null, t(snapshot.notice)),
        )
        : null,
      h(Section, {
        id: 'overview',
        title: t('overview'),
        meta: '',
        open: true,
        collapsible: false,
        onToggle: () => {},
      },
        h('div', { style: S.inline }, h(StatusTag, { t, state: data })),
        h(OverviewBody, { t, state: data }),
      ),
      h(Section, {
        id: 'auth',
        title: t('auth'),
        open: groups.isOpen('auth'),
        collapsible: true,
        onToggle: () => groups.toggle('auth'),
      }, h(AuthBody, { t, state: data, store, snapshot })),
      h(Section, {
        id: 'models',
        title: t('models'),
        meta: `${counts.enabled}/${counts.total}`,
        open: groups.isOpen('models'),
        collapsible: true,
        onToggle: () => groups.toggle('models'),
      }, h(ModelsBody, { t, state: data, store })),
      h(Section, {
        id: 'agents',
        title: t('agentAuth'),
        meta: agentsMeta,
        open: groups.isOpen('agents'),
        collapsible: true,
        onToggle: () => groups.toggle('agents'),
      }, h(AgentsBody, { t, snapshot, store })),
      h(Section, {
        id: 'defaults',
        title: t('defaults'),
        open: groups.isOpen('defaults'),
        collapsible: true,
        onToggle: () => groups.toggle('defaults'),
      }, h(DefaultsBody, { t, state: data, store })),
      h(Section, {
        id: 'diagnostics',
        title: t('diagnostics'),
        open: groups.isOpen('diagnostics'),
        collapsible: true,
        onToggle: () => groups.toggle('diagnostics'),
      }, h(DiagnosticsBody, { t, state: data, store, snapshot })),
    )
  }

  // -------------------------------------------------------------------------
  // Plugins page card (short summary; the page above is the real surface)
  // -------------------------------------------------------------------------

  function AcpxBridgeCard(props) {
    const ctx = props.bridge.ctx
    const store = props.bridge.store
    useLocaleTick(ctx)
    const t = key => (ctx.locale.bind(NS)(key))
    const snapshot = useBridge(store)
    const data = snapshot.data
    const counts = (data && data.counts) || { total: 0, enabled: 0 }

    if (props.view === 'summary') {
      return h('span', null, `${t('summaryLine')} · ${t('enabled')} ${counts.enabled}/${counts.total} · ${t('settingsHint')}`)
    }

    return h('div', { style: S.summary },
      h('div', { style: S.line },
        data ? h(StatusTag, { t, state: data }) : h(P.Tag, { tone: 'neutral' }, t('loading')),
        h('span', { style: S.muted }, `${t('enabled')} ${counts.enabled} / ${t('total')} ${counts.total}`),
      ),
      h('div', { style: S.hint },
        data && data.acpx && data.acpx.ok
          ? `acpx ${data.acpx.version || '?'} · ${data.acpx.path || data.acpx.bin}`
          : t('statusAcpxMissing'),
      ),
      h('div', { style: S.hint }, t('settingsHint')),
    )
  }

  // -------------------------------------------------------------------------
  // Plugin entry
  // -------------------------------------------------------------------------

  function apply(ctx) {
    const store = createBridgeStore(ctx)
    const bridge = { ctx, store }

    ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-acpx-bridge: dictionaries')

    ctx.effect(() => () => store.dispose(), 'dsh-acpx-bridge: store')

    ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'acpx-bridge',
      order: 25,
      label: () => ctx.locale.bind(NS)('nav'),
      locale: NS,
      inject: () => ({ bridge }),
    }, AcpxBridgePage)), 'dsh-acpx-bridge: settings section')

    ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
      name: 'plugins.item',
      id: 'acpx-bridge',
      order: 20,
      label: () => ctx.locale.bind(NS)('nav'),
      locale: NS,
      inject: () => ({ bridge }),
    }, AcpxBridgeCard)), 'dsh-acpx-bridge: plugins card')
  }

  exports.NS = NS
  exports.apply = apply
  exports.inject = ['slots', 'locale', 'remote', 'remote.credentials']
  return module.exports
} })
