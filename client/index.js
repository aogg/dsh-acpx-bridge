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
    codebuddy: 'codebuddy login',
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
    }
    const listeners = new Set()
    let noticeTimer = null
    let loadToken = 0

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
      const onVisibility = () => {
        if (document.visibilityState === 'visible') store.load({ quiet: true })
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

  function AgentsBody({ t, state, store, snapshot }) {
    const acpx = state.acpx || {}
    const catalog = state.catalog || []
    return h(React.Fragment, null,
      h('div', { style: S.inline },
        h(P.Tag, { tone: acpx.ok ? 'success' : 'danger' }, acpx.ok ? t('probeOk') : t('notDetected')),
        h('span', { style: S.mono }, acpx.path || acpx.bin || 'acpx'),
        acpx.version ? h('span', { style: S.muted }, `v${acpx.version}`) : null,
        h(P.Button, {
          size: 'sm',
          variant: 'ghost',
          disabled: snapshot.busy === 'acpx',
          onClick: () => store.redetectAcpx(),
        }, snapshot.busy === 'acpx' ? t('testing') : t('redetect')),
      ),
      acpx.ok ? null : h(Notice, { tone: 'error' }, acpx.error || t('notDetected')),
      h('div', { style: S.table },
        catalog.map(group => {
          const models = group.models || []
          const real = models.filter(model => !model.placeholder)
          return h('div', { key: group.agent, style: S.row },
            h('div', { style: S.rowLabel }, group.agent),
            h('div', { style: S.rowValue },
              h('span', { style: S.hint }, `${t('agentModels')} ${models.length}`),
              h(P.Tag, { tone: real.length > 0 ? 'success' : 'neutral' }, real.length > 0 ? t('realModels') : t('placeholderOnly')),
              h('span', { style: S.actions },
                h('span', { style: S.hint }, `${t('loginCommand')}：`),
                h(CopyCommand, { t, command: loginCommandFor(group.agent) }),
              ),
            ),
          )
        }),
      ),
      h(Notice, null, t('agentsHint')),
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
        title: t('agents'),
        open: groups.isOpen('agents'),
        collapsible: true,
        onToggle: () => groups.toggle('agents'),
      }, h(AgentsBody, { t, state: data, store, snapshot })),
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
