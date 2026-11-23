/**
 * Login jobs: one spawned CLI process per interactive authorization, plus the
 * SSE framing the page subscribes to.
 *
 * Why a job store instead of "run the command and await it": a device-code login
 * is a CONVERSATION. Kimi prints a code and waits, Trae starts a local callback
 * listener and then wants the callback URL pasted back on stdin. The page must
 * see that text as it appears and answer it, so the process is spawned once, its
 * output is kept in a bounded ring buffer with monotonically increasing `seq`,
 * and every browser attaches an EventSource to it.
 *
 * Containment, all in this closure:
 *   - at most {@link MAX_CONCURRENT_JOBS} running jobs process-wide;
 *   - one job per agent (a second start answers 409 with the existing jobId);
 *   - every job is killed after {@link JOB_TIMEOUT_MS};
 *   - cancel = SIGTERM, then SIGKILL after {@link KILL_GRACE_MS};
 *   - a dropped SSE connection kills its job (nobody is watching it any more);
 *   - `killAll()` on plugin unload.
 *
 * The ring buffer keeps only the last {@link RING_BYTES} of output, but `seq`
 * keeps counting, so a late subscriber can tell what it missed. Secrets are
 * scrubbed on the way in: output never carries a complete key.
 *
 * Everything is injectable (`spawnImpl`, `now`) so the self-test drives real
 * frame ordering without ever spawning a login process.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { extractAuthLinks, redactKey, stripAnsi } from './agents.js'

/** Hard cap for one login job. */
export const JOB_TIMEOUT_MS = 5 * 60 * 1000
/** Maximum number of login jobs alive at once. */
export const MAX_CONCURRENT_JOBS = 3
/** How much output a job keeps (bytes of text). */
export const RING_BYTES = 64 * 1024
/** Grace period between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 2_000
/** How long a finished job stays queryable (a reconnecting EventSource). */
export const FINISHED_RETENTION_MS = 120 * 1000
/** SSE keep-alive comment interval (stops proxies from closing an idle stream). */
export const HEARTBEAT_MS = 15_000
/** Largest stdin line accepted from the page (a pasted callback URL). */
export const MAX_INPUT_CHARS = 4_096

/**
 * One SSE frame.
 * @param event - event name (`snapshot` | `chunk` | `exit`).
 * @param payload - JSON-serializable body.
 * @returns the encoded frame.
 */
export function encodeSse(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

/** One SSE keep-alive comment line. */
export function encodeSsePing() {
  return ': ping\n\n'
}

/** Login argv for one spec, with the optional `--region` for Kimi appended. */
export function buildLoginArgv(spec, region = '') {
  const base = Array.isArray(spec?.auth?.loginArgv) ? [...spec.auth.loginArgv] : []
  const allowed = Array.isArray(spec?.auth?.regionValues) ? spec.auth.regionValues : []
  const chosen = typeof region === 'string' ? region.trim() : ''
  if (base.length > 0 && chosen && allowed.includes(chosen)) base.push('--region', chosen)
  return base
}

/**
 * Create the in-process job store. Call once per plugin apply(); the returned
 * object owns every login child process of this plugin instance.
 *
 * @param options.spawnImpl - injectable `child_process.spawn` (tests).
 * @param options.logger - receives contained failures.
 * @param options.now - injectable clock.
 * @param options.timeoutMs - job lifetime cap.
 * @param options.killGraceMs - SIGTERM → SIGKILL delay.
 * @param options.maxConcurrent - running job cap.
 * @param options.retentionMs - how long a finished job stays in the map.
 */
export function createJobStore({
  spawnImpl = spawn,
  logger = null,
  now = () => Date.now(),
  timeoutMs = JOB_TIMEOUT_MS,
  killGraceMs = KILL_GRACE_MS,
  maxConcurrent = MAX_CONCURRENT_JOBS,
  retentionMs = FINISHED_RETENTION_MS,
  secretKey = '',
} = {}) {
  /** jobId → job (running and recently finished). */
  const jobs = new Map()

  function runningCount() {
    let count = 0
    for (const job of jobs.values()) if (!job.done) count += 1
    return count
  }

  /** Kill one job's child process, logging a refusal instead of throwing. */
  function signalJob(job, signal) {
    const child = job.child
    if (!child || job.done) return
    try {
      child.kill(signal)
    } catch (error) {
      logger?.debug?.(`[acpx-bridge] login job ${job.id}: kill(${signal}) failed: ${error?.message ?? error}`)
    }
  }

  function scheduleForceKill(job) {
    if (job.killTimer !== null) clearTimeout(job.killTimer)
    job.killTimer = setTimeout(() => {
      job.killTimer = null
      if (!job.done) signalJob(job, 'SIGKILL')
    }, killGraceMs)
    job.killTimer.unref?.()
  }

  function finish(job, exitCode, signal) {
    if (job.done) return
    job.done = true
    job.exitCode = Number.isInteger(exitCode) ? exitCode : null
    job.signal = typeof signal === 'string' ? signal : null
    job.finishedAt = now()
    if (job.timeoutTimer !== null) clearTimeout(job.timeoutTimer)
    job.timeoutTimer = null
    if (job.killTimer !== null) clearTimeout(job.killTimer)
    job.killTimer = null
    const frame = job.exitFrame()
    logger?.info?.(
      `[acpx-bridge][命令工具授权][登录] job 结束 (jobId=${job.id} job标识, agent=${job.agentId} 平台, `
      + `exitCode=${job.exitCode} 退出码, timedOut=${job.timedOut} 是否超时, durationMs=${frame.durationMs} 耗时毫秒)`,
    )
    for (const listener of job.doneListeners) {
      try {
        listener(frame)
      } catch (error) {
        logger?.warn?.(`[acpx-bridge] login job ${job.id}: exit listener failed: ${error?.message ?? error}`)
      }
    }
    job.doneListeners.clear()
    const reap = setTimeout(() => jobs.delete(job.id), retentionMs)
    reap.unref?.()
  }

  function push(job, rawText) {
    const text = redactKey(stripAnsi(rawText), secretKey)
    if (!text) return
    job.seq += 1
    const chunk = { seq: job.seq, text }
    job.chunks.push(chunk)
    job.bytes += Buffer.byteLength(text, 'utf8')
    while (job.bytes > RING_BYTES && job.chunks.length > 1) {
      const dropped = job.chunks.shift()
      job.bytes -= Buffer.byteLength(dropped.text, 'utf8')
    }
    if (job.bytes > RING_BYTES && job.chunks.length === 1) {
      // A single huge chunk: keep its tail so the buffer stays bounded.
      const only = job.chunks[0]
      const tail = Buffer.from(only.text, 'utf8').subarray(-RING_BYTES).toString('utf8')
      job.chunks[0] = { seq: only.seq, text: tail }
      job.bytes = Buffer.byteLength(tail, 'utf8')
    }
    for (const link of extractAuthLinks(text)) {
      if (job.links.includes(link)) continue
      job.links.push(link)
      if (job.links.length > 20) job.links.splice(0, job.links.length - 20)
    }
    for (const listener of job.listeners) {
      try {
        listener(chunk)
      } catch (error) {
        logger?.warn?.(`[acpx-bridge] login job ${job.id}: chunk listener failed: ${error?.message ?? error}`)
      }
    }
  }

  /** Build the job object (public shape is exactly what the routes need). */
  function makeJob({ spec, argv, region }) {
    const job = {
      id: randomUUID(),
      agentId: spec.id,
      argv: [...argv],
      region: region || '',
      startedAt: now(),
      finishedAt: 0,
      seq: 0,
      chunks: [],
      bytes: 0,
      links: [],
      done: false,
      timedOut: false,
      exitCode: null,
      signal: null,
      child: null,
      listeners: new Set(),
      doneListeners: new Set(),
      timeoutTimer: null,
      killTimer: null,
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      onDone(listener) {
        if (this.done) {
          listener(this.exitFrame())
          return () => {}
        }
        this.doneListeners.add(listener)
        return () => this.doneListeners.delete(listener)
      },
      /** Everything a (re)connecting subscriber needs before live chunks. */
      snapshot() {
        return {
          jobId: this.id,
          agent: this.agentId,
          argv: this.argv.join(' '),
          startedAt: this.startedAt,
          seq: this.seq,
          text: this.chunks.map(chunk => chunk.text).join(''),
          done: this.done,
          exitCode: this.exitCode,
          signal: this.signal,
          timedOut: this.timedOut,
          links: [...this.links],
        }
      },
      exitFrame() {
        return {
          jobId: this.id,
          agent: this.agentId,
          exitCode: this.exitCode,
          signal: this.signal,
          done: true,
          timedOut: this.timedOut,
          durationMs: Math.max(0, (this.finishedAt || now()) - this.startedAt),
          links: [...this.links],
        }
      },
    }
    return job
  }

  /**
   * Start one login job.
   * @param spec - agent spec (needs `auth.loginArgv`).
   * @param options.region - optional `--region` value for Kimi.
   * @returns `{ ok:true, job }` | `{ ok:false, conflict:true, job }` |
   *          `{ ok:false, limit:true, running }`.
   */
  function start(spec, { region = '' } = {}) {
    for (const existing of jobs.values()) {
      if (!existing.done && existing.agentId === spec.id) {
        return { ok: false, conflict: true, job: existing }
      }
    }
    const running = runningCount()
    if (running >= maxConcurrent) return { ok: false, limit: true, running }

    const argv = buildLoginArgv(spec, region)
    if (argv.length === 0) return { ok: false, unsupported: true }

    const job = makeJob({ spec, argv, region })
    let child
    try {
      child = spawnImpl(argv[0], argv.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        windowsHide: true,
      })
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] login job for ${spec.id} could not spawn: ${error?.message ?? error}`)
      push(job, `无法启动 ${argv.join(' ')}：${error?.message ?? error}\n`)
      job.done = true
      job.exitCode = null
      job.finishedAt = now()
      jobs.set(job.id, job)
      return { ok: true, job }
    }
    job.child = child
    jobs.set(job.id, job)

    child.stdout?.on?.('data', data => push(job, String(data)))
    child.stderr?.on?.('data', data => push(job, String(data)))
    child.on?.('error', error => {
      push(job, `进程错误：${error?.message ?? error}\n`)
      finish(job, null, null)
    })
    child.on?.('exit', (code, signal) => finish(job, code, signal))
    logger?.info?.(
      `[acpx-bridge][命令工具授权][登录] job 已启动 (jobId=${job.id} job标识, agent=${spec.id} 平台, `
      + `argv=${argv.join(' ')} 命令)`,
    )

    job.timeoutTimer = setTimeout(() => {
      job.timeoutTimer = null
      if (job.done) return
      job.timedOut = true
      push(job, `\n[acpx-bridge] 登录超过 ${Math.round(timeoutMs / 1000)} 秒，已结束该进程。\n`)
      signalJob(job, 'SIGTERM')
      scheduleForceKill(job)
    }, timeoutMs)
    job.timeoutTimer.unref?.()

    return { ok: true, job }
  }

  /** Look a job up; the caller must still check `job.agentId`. */
  function get(jobId) {
    const id = typeof jobId === 'string' ? jobId.trim() : ''
    if (!id) return undefined
    return jobs.get(id)
  }

  /**
   * Write one line to a job's stdin (Trae's "paste callback URL").
   * @returns true when the write was accepted.
   */
  function writeInput(job, text) {
    if (!job || job.done) return false
    const stdin = job.child?.stdin
    if (!stdin || stdin.destroyed === true || stdin.writableEnded === true) return false
    const line = String(text ?? '')
    if (!line.trim()) return false
    const clipped = line.length > MAX_INPUT_CHARS ? line.slice(0, MAX_INPUT_CHARS) : line
    push(job, `> ${clipped}\n`)
    try {
      stdin.write(clipped.endsWith('\n') ? clipped : `${clipped}\n`)
      return true
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] login job ${job.id}: stdin write failed: ${error?.message ?? error}`)
      return false
    }
  }

  /** SIGTERM now, SIGKILL after the grace period. */
  function cancel(job) {
    if (!job) return { ok: false, reason: 'not-found' }
    if (job.done) return { ok: false, reason: 'already-done' }
    signalJob(job, 'SIGTERM')
    scheduleForceKill(job)
    return { ok: true }
  }

  /** Kill every live job (plugin unload). */
  function killAll() {
    for (const job of jobs.values()) {
      if (job.done) continue
      if (job.timeoutTimer !== null) clearTimeout(job.timeoutTimer)
      job.timeoutTimer = null
      signalJob(job, 'SIGTERM')
      scheduleForceKill(job)
    }
  }

  return { start, get, cancel, writeInput, killAll, runningCount, size: () => jobs.size }
}

/**
 * Turn one job into a `text/event-stream` ReadableStream.
 *
 * Frame order is fixed: `snapshot` (everything buffered so far) → any number of
 * `chunk` frames → `exit`, then the stream closes. A `: ping` comment every
 * {@link HEARTBEAT_MS} keeps proxies from closing an idle login.
 *
 * @param job - job from the store.
 * @param request - the Fetch request (its `signal` aborts the job when the page
 *                  goes away).
 * @param options.onAbort - called when the client disconnects (kills the child).
 * @param options.heartbeatMs - keep-alive interval.
 * @param options.logger - receives contained failures.
 * @returns a ReadableStream of SSE bytes.
 */
export function createJobStream(job, request, { onAbort = null, heartbeatMs = HEARTBEAT_MS, logger = null } = {}) {
  const encoder = new TextEncoder()
  let closed = false
  let heartbeat = null
  let unsubscribe = null
  let stopDoneListener = null

  const cleanup = () => {
    if (heartbeat !== null) clearInterval(heartbeat)
    heartbeat = null
    if (typeof unsubscribe === 'function') unsubscribe()
    unsubscribe = null
    if (typeof stopDoneListener === 'function') stopDoneListener()
    stopDoneListener = null
    request?.signal?.removeEventListener?.('abort', onAborted)
  }

  const onAborted = () => {
    if (closed) return
    closed = true
    cleanup()
    try {
      onAbort?.()
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] login stream abort handler failed: ${error?.message ?? error}`)
    }
  }

  return new ReadableStream({
    start(controller) {
      const send = (event, payload) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(encodeSse(event, payload)))
          return true
        } catch (error) {
          // The client went away between our check and this write.
          logger?.debug?.(`[acpx-bridge] login stream enqueue failed: ${error?.message ?? error}`)
          closed = true
          return false
        }
      }
      const close = () => {
        if (closed) return
        closed = true
        cleanup()
        try {
          controller.close()
        } catch (error) {
          logger?.debug?.(`[acpx-bridge] login stream close failed: ${error?.message ?? error}`)
        }
      }

      if (job.done) {
        send('snapshot', job.snapshot())
        send('exit', job.exitFrame())
        close()
        return
      }

      // Subscribe first, then snapshot: no chunk emitted after this point can
      // land before the snapshot (single-threaded start()), and none is lost.
      unsubscribe = job.subscribe(chunk => send('chunk', chunk))
      send('snapshot', job.snapshot())
      stopDoneListener = job.onDone(frame => {
        send('exit', frame)
        close()
      })

      heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(encodeSsePing()))
        } catch (error) {
          logger?.debug?.(`[acpx-bridge] login stream heartbeat failed: ${error?.message ?? error}`)
          closed = true
          cleanup()
        }
      }, heartbeatMs)
      heartbeat.unref?.()

      request?.signal?.addEventListener?.('abort', onAborted, { once: true })
    },
    cancel() {
      if (closed) return
      closed = true
      cleanup()
      try {
        onAbort?.()
      } catch (error) {
        logger?.warn?.(`[acpx-bridge] login stream cancel handler failed: ${error?.message ?? error}`)
      }
    },
  })
}
