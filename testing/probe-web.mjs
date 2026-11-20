// 在启动 dsh web 的同一进程环境里探测它是否真的在监听
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const ROOT = '/Applications/code/www/my/github/dsh-acpx-bridge'
const log = fs.openSync('/tmp/dshweb-direct.log', 'w')

const child = spawn('dsh', ['web', '--host', '127.0.0.1', '--port', '3099', '--no-open'], {
  cwd: ROOT,
  env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
  stdio: ['ignore', log, log],
  detached: false,
})

console.log('[probe] spawned dsh web pid=', child.pid)

let done = false
const timer = setInterval(async () => {
  if (done) return
  try {
    const r = await fetch('http://127.0.0.1:3099/', { signal: AbortSignal.timeout(2000) })
    console.log('[probe] HTTP', r.status)
    done = true
    clearInterval(timer)
  } catch (e) {
    // not up yet
  }
}, 1500)

setTimeout(() => {
  if (!done) console.log('[probe] web did not come up in 20s')
  clearInterval(timer)
  try { child.kill('SIGTERM') } catch {}
  try { console.log('[probe] child exit?', child.exitCode, 'signal', child.signalCode) } catch {}
  console.log('=== captured output ===')
  try { console.log(fs.readFileSync('/tmp/dshweb-direct.log', 'utf8').slice(0, 2000) || '(empty)') } catch (e) { console.log('log err', e.message) }
  process.exit(0)
}, 20000)

child.on('exit', (code, sig) => {
  console.log(`[probe] dsh web exited early: code=${code} signal=${sig}`)
})
