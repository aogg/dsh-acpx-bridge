/**
 * dsh-acpx-bridge — browser half (web client settings card).
 *
 * Lazy-CJS factory consumed by dsh's client module system. The Node half
 * (src/index.js) has no client behaviour of its own; this file registers a
 * configuration card into the Plugins page's `plugins.item` slot so the
 * command tools (acpx agents), their models, and the mapping into dsh's model
 * selector are visible in the browser.
 *
 * The card is intentionally read-only for now: the Host plugin does not expose
 * a settings namespace (its Config is a volatile Loader config), so there is
 * no Host-backed ConfigPageForm to mutate. The values shown here mirror
 * src/config.js DEFAULT_TOOLS / displayNameForModel, i.e. the live routing.
 */
window.__ModuleLoader__.load({ id: 'dsh-acpx-bridge', factory: require => {
  var module = { exports: {} }
  var exports = module.exports
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

  const React = require('react')
  const h = React.createElement

  const PROVIDER = 'acpx-bridge'
  const TOOLS = [
    { name: 'deepseek-harness', models: ['gs/deepseek-flash-deepseek.com'] },
  ]

  /** gs/deepseek-flash-deepseek.com -> acpx/deepseek-flash (same rule as src/config.js). */
  function selectorName(id) {
    let name = String(id)
    if (name.includes('/')) name = name.slice(name.lastIndexOf('/') + 1)
    name = name.replace(/-deepseek\.com$/i, '')
    return 'acpx/' + name
  }

  const C = {
    wrap: { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#d6d6d6', fontSize: 13, lineHeight: 1.55 },
    h2: { margin: '0 0 6px', fontSize: 16, fontWeight: 600, color: '#f0f0f0' },
    lead: { margin: '0 0 14px', color: '#a9a9a9' },
    card: { border: '1px solid #3a3a3a', borderRadius: 10, padding: '12px 14px', marginBottom: 10, background: '#202020' },
    toolName: { fontWeight: 600, color: '#7ee0c0', marginBottom: 6 },
    modelRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' },
    raw: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: '#9aa7b4' },
    arrow: { color: '#888' },
    chip: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: '#ffd479', background: '#3a2f18', border: '1px solid #6b5424', borderRadius: 6, padding: '1px 7px' },
    note: { marginTop: 12, padding: '10px 12px', borderRadius: 8, background: '#182a2a', border: '1px solid #2c504c', color: '#bfe6df' },
    foot: { marginTop: 12, color: '#8a8a8a', fontSize: 12 },
  }

  /** The card body rendered on the plugin's detail page. */
  function CardBody() {
    return h('div', { style: C.wrap },
      h('h2', { style: C.h2 }, 'acpx-bridge 命令工具与模型'),
      h('p', { style: C.lead },
        '本插件把命令工具（acpx agent）与模型分组配置，并将每个模型映射到 dsh 模型选择框中的一个选项。'),
      TOOLS.map((tool, i) => h('div', { key: i, style: C.card },
        h('div', { style: C.toolName }, '命令工具：' + tool.name),
        tool.models.map((model, j) => h('div', { key: j, style: C.modelRow },
          h('span', { style: C.raw }, model),
          h('span', { style: C.arrow }, '→'),
          h('span', { style: C.chip }, selectorName(model)),
        )),
      )),
      h('div', { style: C.note },
        '选择框里的 ' + TOOLS.flatMap(t => t.models).map(selectorName).join('、')
        + ' 即来自此配置；对应的 provider 是 ' + PROVIDER + '。'),
      h('div', { style: C.foot },
        '配置来源：src/config.js 的 tools（volatile）。当前只读展示；编辑请修改插件配置后重启。'),
    )
  }

  /** Registered card component; the renderer passes view='summary'|'page'. */
  function AcpxBridgeCard(props) {
    if (props && props.view === 'summary') {
      return h('span', null, '命令工具与模型 → 选择框映射（deepseek-harness / acpx-deepseek-flash）')
    }
    return h(CardBody)
  }

  function apply(ctx) {
    ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
      name: 'plugins.item',
      id: 'acpx-bridge',
      order: 20,
      label: () => 'acpx-bridge 命令工具与模型',
      inject: () => ({}),
    }, AcpxBridgeCard)), 'dsh-acpx-bridge: settings card')
  }

  exports.NS = 'settings.acpxBridge'
  exports.apply = apply
  exports.inject = ['slots']
  return module.exports
} })
