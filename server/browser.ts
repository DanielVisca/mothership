// The agent browser: a dedicated "Agent" Chrome profile that perch launches and drives over CDP.
// You log into your accounts there once; every chat gets its own background window in it.
// Chrome runs detached, so its windows (and logins) survive perch restarts; perch re-attaches.
//
// Speed comes from doing less per model turn: compact snapshots with refs instead of screenshots,
// several steps per call, a fresh snapshot returned with every action, cached paths that replay
// without the model, and fetch with your cookies when a page isn't needed at all.
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CDP } from './cdp.ts'
import { PAGE_SCRIPT } from './browserpage.ts'
import { all, db, get, run } from './db.ts'
import { DATA_DIR, settings, updateSettings } from './settings.ts'
import { ownerName, possessive } from './owner.ts'

export const PROFILE_DIR = process.env.PERCH_AGENT_CHROME_DIR ?? join(DATA_DIR, 'agent-chrome')
export const REC_DIR = process.env.PERCH_BROWSER_REC_DIR ?? join(DATA_DIR, 'browser', 'recordings')
const headless = () => process.env.PERCH_BROWSER_HEADLESS === '1' || settings.browser.headless

db.exec(`
create table if not exists browser_sessions (owner text primary key, target_id text, created_at integer, updated_at integer, url text, title text, run_dir text);
create table if not exists site_memory (host text primary key, notes text not null default '', updated_at integer);
create table if not exists site_paths (id text primary key, host text not null, goal text not null, steps text not null, expect text, mode text,
  ok_count integer default 0, fail_count integer default 0, heal_count integer default 0, version integer default 1, created_at integer, last_ok integer, last_ms integer);
create index if not exists site_paths_host on site_paths(host);
`)
try { db.exec('alter table browser_sessions add column paused integer default 0') } catch {} // added later: a takeover survives restarts

// ---------- types ----------
export type Locator = { role: string; name: string; pattern?: string | null; testid?: string; id?: string; tag?: string; nth?: number; label?: string; placeholder?: string; inputName?: string; css?: string }
export type StepDo = 'click' | 'fill' | 'type' | 'select' | 'check' | 'uncheck' | 'press' | 'hover' | 'scroll' | 'navigate' | 'back' | 'forward' | 'reload' | 'wait'
export type Step = { do: StepDo; ref?: string; role?: string; name?: string; value?: string; key?: string; url?: string; dy?: number; ms?: number; text?: string; submit?: boolean; force?: boolean }
// What the action log keeps for each step: enough to replay it without refs.
export type LoggedStep = { do: StepDo; locator?: Locator; value?: string; key?: string; url?: string; dy?: number; ms?: number; text?: string; submit?: boolean; urlAfter: string; took: number; at: number; irreversible?: boolean; secret?: boolean }
type Net = { id: string; url: string; method: string; type: string; status?: number; mime?: string; at: number; ms?: number; failed?: string; rid?: string }

export type Session = {
  owner: string; targetId: string; sid: string; mainFrame: string; ctx: number | null; loaderId: string
  url: string; title: string; created: number; lastUsed: number
  inflight: Map<string, number>; navigating: boolean; lastNetAt: number
  net: Net[]; log: LoggedStep[]; goal?: string; goalStartUrl?: string; runDir: string
  paused: boolean; frames: Set<(jpegB64: string, meta: any) => void>; casting: boolean
  crashed: boolean
  resolution?: Resolution // the agent's screenshot resolution for this window (sticky per open); the live view is always high
  record?: boolean // visual recording (browserrec.ts) for this window, set when the agent asks for mode=visual
  shown: boolean // the owner opened it in Chrome: pages get a small "back to perch" pill
  adopted?: boolean // re-adopted at perch start and not used since: doesn't count toward the window cap
}
export type Approval = { id: string; owner: string; host: string; what: string; url: string; key: string; at: number; state: 'pending' | 'approved' | 'denied' }

// ---------- events ----------
// Owned sessions wake their conversation through the inbox (main.ts wires these), like terminals.
export const browserEvents = new Set<(owner: string, event: string, text: string) => void>()
export const onBrowserChange = new Set<() => void>()
// Recorders (browserrec.ts) and anything else that wants every step, navigation and session start/end.
export const browserHooks = new Set<(e: { type: 'open' | 'step' | 'navigate' | 'close' | 'finish'; session: Session; step?: LoggedStep; ok?: boolean }) => void>()
const emit = (owner: string, event: string, text: string) => browserEvents.forEach(f => { try { f(owner, event, text) } catch (e) { console.error('browserEvents', e) } })
const changed = () => onBrowserChange.forEach(f => { try { f() } catch {} })
const hook = (e: Parameters<typeof browserHooks extends Set<infer F> ? F : never>[0]) => browserHooks.forEach(f => { try { (f as any)(e) } catch (err) { console.error('browserHooks', err) } })

export const sessions = new Map<string, Session>()
export const approvals = new Map<string, Approval>()
// Whether the conversation owning a window is mid-turn (set by main.ts from chat.ts; tests leave it off).
let ownerBusy: (owner: string) => boolean = () => false
export const setOwnerBusy = (f: (owner: string) => boolean) => { ownerBusy = f }
let cdp: CDP | null = null
let connecting: Promise<CDP> | null = null
let chromePid: number | null = null // the Agent Chrome this perch process spawned
const recovery = { count: 0, last: null as number | null, reason: null as string | null }
let readopt = false
let recovering: Promise<void> | null = null
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------- Chrome lifecycle ----------
async function endpointFromFile(timeoutMs = 4000): Promise<string | null> {
  const f = join(PROFILE_DIR, 'DevToolsActivePort')
  if (!existsSync(f)) return null
  const [port, path] = readFileSync(f, 'utf8').split('\n')
  if (!port || !path) return null
  try {
    const r = await fetch(`http://127.0.0.1:${port.trim()}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return null
    return `ws://127.0.0.1:${port.trim()}${path.trim()}`
  } catch { return null }
}

// Chrome's SingletonLock is a symlink to "host-pid": a live pid means this profile is open already.
function lockPid(): number | null {
  try {
    const target = readlinkSync(join(PROFILE_DIR, 'SingletonLock'))
    const pid = Number(target.split('-').pop())
    if (!pid) return null
    process.kill(pid, 0)
    return pid
  } catch { return null }
}

export function chromeArgs() {
  return [
    `--user-data-dir=${PROFILE_DIR}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    // agent windows sit behind your other apps: keep them running and painting
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,MediaRouter', '--window-size=1280,860',
    ...(headless() ? ['--headless=new', '--hide-scrollbars', '--mute-audio'] : []),
    'about:blank',
  ]
}

async function launch() {
  mkdirSync(PROFILE_DIR, { recursive: true })
  let pid = lockPid()
  // A hung Agent Chrome can hold the profile lock with no reachable debug port (2026-11-18, pid 35888):
  // nothing ever times out, so quit it here. Only a process launched with our --user-data-dir.
  if (pid && await quitStaleAgentChrome(pid)) pid = lockPid()
  if (pid) throw new Error(`The Agent Chrome profile is already open (pid ${pid}) without Mothership's debug port. Quit that Chrome window (it's the one using ${PROFILE_DIR}) and try again.`)
  rmSync(join(PROFILE_DIR, 'DevToolsActivePort'), { force: true })
  const path = settings.browser.chromePath
  if (!existsSync(path)) throw new Error(`Chrome not found at ${path} (settings.browser.chromePath).`)
  // Spawned directly, not through Playwright/Puppeteer: no --enable-automation, so Google sign-in works
  // and sites see a normal Chrome. Detached so it outlives perch.
  const child = spawn(path, chromeArgs(), { detached: true, stdio: 'ignore' })
  chromePid = child.pid ?? null
  child.unref()
}

async function waitEndpoint(ms: number) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const url = await endpointFromFile()
    if (url) return url
    await sleep(150)
  }
  throw new Error('Agent Chrome did not start (no DevToolsActivePort after ' + ms / 1000 + 's).')
}

export async function ensureBrowser(): Promise<CDP> {
  if (cdp && !cdp.closed) return cdp
  if (connecting) return connecting
  if (recovering) await recovering // don't reconnect to the hung Chrome while it is being quit
  if (cdp && !cdp.closed) return cdp
  if (connecting) return connecting
  connecting = (async () => {
    try {
      let url = await endpointFromFile()
      if (!url) { await launch(); url = await waitEndpoint(20_000) }
      const c = await CDP.connect(url)
      wire(c)
      await c.send('Target.setDiscoverTargets', { discover: true })
      cdp = c
      changed()
      if (readopt) { readopt = false; setTimeout(() => { resumeBrowser().catch(e => console.error('resumeBrowser after recovery', e.message)) }, 0) }
      return c
    } finally { connecting = null }
  })()
  return connecting
}

// ---------- hang recovery ----------
// A CDP socket can stay open while Chrome stops answering: on 2026-11-18 every call timed out
// ("Target.getTargets timed out after 30000ms") for over an hour while status said connected.
// Two browser-level timeouts in a row, or any timeout followed by an unanswered 5s Browser.getVersion
// probe, mean the connection is dead: quit that Chrome and let the next ensureBrowser() launch a fresh one.
export const HANG_TIMEOUTS = 2
let probing: Promise<void> | null = null
function watchHang(c: CDP) {
  c.onTimeout.add((method, sid) => {
    if (cdp !== c || method === 'Browser.getVersion' || method === 'Browser.close') return
    if (!sid && c.timeouts >= HANG_TIMEOUTS) { void recoverBrowser(c, `${c.timeouts} CDP timeouts in a row (last ${method})`); return }
    probing ??= c.send('Browser.getVersion', {}, undefined, 5000)
      .then(() => {}, () => recoverBrowser(c, `${method} timed out and Browser.getVersion did not answer in 5s`))
      .finally(() => { probing = null })
  })
}

// The Chrome holding the Agent profile: the one this perch spawned, else the owner of the profile's
// SingletonLock (a Chrome started with our --user-data-dir by an earlier perch). Never any other Chrome.
function agentChromePid(): number | null {
  const lock = lockPid()
  if (chromePid && (!lock || lock === chromePid)) return chromePid
  return lock && isAgentChrome(lock) ? lock : null
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

// Whether pid was started with this agent profile as its --user-data-dir (so it's the Agent Chrome).
export function isAgentChrome(pid: number) {
  try {
    const cmd = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 })
    return cmd.includes(`--user-data-dir=${PROFILE_DIR}`)
  } catch { return false }
}

// The profile is locked by a live Agent Chrome perch can't reach: SIGTERM it (SIGKILL if it ignores
// that for 8s), then clear its lock files so a fresh one can launch. Returns whether it is gone.
export async function quitStaleAgentChrome(pid: number) {
  if (!isAgentChrome(pid)) return false
  recovery.count++; recovery.last = Date.now(); recovery.reason = `profile locked by unreachable Agent Chrome pid ${pid}`
  console.error(`agent browser: recovering unreachable Chrome (pid ${pid}, recovery #${recovery.count}): ${recovery.reason}`)
  const gone = async (ms: number) => { const until = Date.now() + ms; while (alive(pid) && Date.now() < until) await sleep(100); return !alive(pid) }
  try { process.kill(pid, 'SIGTERM') } catch {}
  if (!(await gone(8000))) { try { process.kill(pid, 'SIGKILL') } catch {} await gone(3000) }
  if (alive(pid)) return false
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']) rmSync(join(PROFILE_DIR, f), { force: true })
  if (chromePid === pid) chromePid = null
  changed()
  return true
}

export async function recoverBrowser(c: CDP, reason: string) {
  if (cdp !== c) return // already recovering, or replaced
  const pid = agentChromePid()
  cdp = null
  for (const s of sessions.values()) { s.ctx = null }
  sessions.clear()
  recovery.count++; recovery.last = Date.now(); recovery.reason = reason
  console.error(`agent browser: recovering hung Chrome (pid ${pid ?? 'unknown'}, recovery #${recovery.count}): ${reason}`)
  const gone = async (ms: number) => { const until = Date.now() + ms; while (pid && alive(pid) && Date.now() < until) await sleep(100); return !pid || !alive(pid) }
  recovering = (async () => {
    let quit = false
    try { await c.send('Browser.close', {}, undefined, 5000); quit = true } catch {}
    c.close()
    if (pid && !(quit && await gone(8000))) { try { process.kill(pid, 'SIGTERM') } catch {} await gone(8000) }
    if (chromePid === pid) chromePid = null
    if (await gone(0)) rmSync(join(PROFILE_DIR, 'DevToolsActivePort'), { force: true })
    readopt = true
    changed()
  })().finally(() => { recovering = null })
  return recovering
}

// At perch start: if the Agent Chrome is still running, reconnect and re-adopt every chat's window,
// so live views and approvals come back without waiting for the agent's next step. Never launches Chrome.
// keep: which windows to re-adopt now (main.ts: chats mid-turn); the rest stay in Chrome and their chat
// picks them up again on its next browser call. Taken-over windows always come back.
export async function resumeBrowser(keep: (owner: string) => boolean = () => true) {
  if (!(await endpointFromFile())) return 0
  const c = await ensureBrowser()
  const { targetInfos } = await c.send('Target.getTargets')
  let n = 0
  for (const row of all<{ owner: string; target_id: string; run_dir: string; paused: number }>('select owner, target_id, run_dir, paused from browser_sessions')) {
    if (sessions.has(row.owner)) continue
    if (!targetInfos.some((t: any) => t.targetId === row.target_id && t.type === 'page')) { run('delete from browser_sessions where owner = ?', row.owner); continue }
    if (!row.paused && !keep(row.owner)) continue
    try { (await attach(c, row.owner, row.target_id, row.run_dir && existsSync(row.run_dir) ? row.run_dir : undefined)).adopted = true; n++ } catch (e) { console.error('resumeBrowser', row.owner, e) }
  }
  return n
}

export function browserStatus() {
  return { connected: !!cdp && !cdp.closed, recoveries: recovery.count, lastRecovery: recovery.last ? new Date(recovery.last).toISOString() : null, lastRecoveryReason: recovery.reason, profileDir: PROFILE_DIR, headless: headless(), back: lastBack, sessions: listSessions(), approvals: [...approvals.values()].filter(a => a.state === 'pending') }
}

export async function quitBrowser() {
  const c = cdp
  if (!c) return
  try { await c.send('Browser.close', {}, undefined, 5000) } catch {}
  c.close()
  cdp = null
  sessions.clear()
  // wait for Chrome to really exit (it still writes the profile for a moment)
  const until = Date.now() + 8000
  while (lockPid() && Date.now() < until) await sleep(100)
  changed()
}

function wire(c: CDP) {
  watchHang(c)
  c.onClose.add(() => {
    if (cdp !== c) return
    cdp = null
    for (const s of sessions.values()) { s.ctx = null }
    sessions.clear()
    changed()
  })
  c.on('Target.targetCreated', p => {
    const m = String(p.targetInfo?.url ?? '').match(/^about:blank#perch-back:(.+)$/)
    if (!m) return
    c.send('Target.closeTarget', { targetId: p.targetInfo.targetId }).catch(() => {})
    backToPerch(decodeURIComponent(m[1]))
  })
  c.on('Target.targetInfoChanged', p => {
    const m = String(p.targetInfo?.url ?? '').match(/^about:blank#perch-back:(.+)$/)
    if (!m) return
    c.send('Target.closeTarget', { targetId: p.targetInfo.targetId }).catch(() => {})
    backToPerch(decodeURIComponent(m[1]))
  })
  c.on('Target.targetDestroyed', p => {
    for (const s of sessions.values()) if (s.targetId === p.targetId) dropSession(s, 'window closed')
  })
  c.on('Target.targetCrashed', p => {
    for (const s of sessions.values()) if (s.targetId === p.targetId) { s.crashed = true; emit(s.owner, 'browser_crashed', `Your browser window crashed (${p.status}). Open it again with action=open.`); dropSession(s, 'crashed') }
  })
  c.on('Target.targetInfoChanged', p => {
    for (const s of sessions.values()) if (s.targetId === p.targetInfo.targetId) { s.url = p.targetInfo.url; s.title = p.targetInfo.title; changed() }
  })
  c.on('Target.detachedFromTarget', p => {
    for (const s of sessions.values()) if (s.sid === p.sessionId) { sessions.delete(s.owner); changed() }
  })
  // Per-session page state, routed by CDP session id.
  const bySid = (sid?: string) => { for (const s of sessions.values()) if (s.sid === sid) return s }
  c.on('Page.frameNavigated', (p, sid) => {
    const s = bySid(sid); if (!s || p.frame.parentId) return
    s.mainFrame = p.frame.id
    if (p.frame.loaderId !== s.loaderId) { s.loaderId = p.frame.loaderId; s.ctx = null }
    s.url = p.frame.url
    hook({ type: 'navigate', session: s })
    if (s.shown) setTimeout(() => { pill(s) }, 400)
  })
  c.on('Page.frameStartedLoading', (p, sid) => { const s = bySid(sid); if (s && p.frameId === s.mainFrame) s.navigating = true })
  c.on('Page.frameStoppedLoading', (p, sid) => { const s = bySid(sid); if (s && p.frameId === s.mainFrame) s.navigating = false })
  c.on('Page.loadEventFired', (_p, sid) => { const s = bySid(sid); if (s) s.navigating = false })
  c.on('Page.javascriptDialogOpening', async (p, sid) => {
    // A dialog blocks the whole page; accept alerts/beforeunload, dismiss confirms and prompts, and tell the agent.
    const s = bySid(sid); if (!s) return
    const accept = p.type === 'alert' || p.type === 'beforeunload'
    try { await c.send('Page.handleJavaScriptDialog', { accept }, sid) } catch {}
    s.log.push({ do: 'wait', text: `dialog ${p.type}: ${p.message}`, urlAfter: s.url, took: 0, at: Date.now() })
  })
  c.on('Network.requestWillBeSent', (p, sid) => {
    const s = bySid(sid); if (!s) return
    if (p.type !== 'WebSocket' && p.type !== 'EventSource') s.inflight.set(p.requestId, Date.now())
    s.lastNetAt = Date.now()
    s.net.push({ id: p.requestId, url: p.request.url, method: p.request.method, type: p.type ?? '', at: Date.now() })
    if (s.net.length > 300) s.net.splice(0, s.net.length - 300)
  })
  c.on('Network.responseReceived', (p, sid) => {
    const s = bySid(sid); if (!s) return
    const n = s.net.findLast(n => n.id === p.requestId)
    if (n) {
      n.status = p.response.status; n.mime = p.response.mimeType; n.type = p.type ?? n.type
      // the backend's request id (x-request-id and friends): joins this request to its server log lines
      const h = p.response.headers ?? {}
      const k = Object.keys(h).find(k => /^x-(request|correlation)-id$/i.test(k))
      if (k) n.rid = String(h[k])
    }
  })
  const done = (p: any, sid?: string) => {
    const s = bySid(sid); if (!s) return
    s.inflight.delete(p.requestId); s.lastNetAt = Date.now()
    // How long each request took (and why it failed): the product overlay's live latency.
    const n = s.net.findLast(n => n.id === p.requestId)
    if (n && n.ms == null) { n.ms = Date.now() - n.at; if (p.errorText) n.failed = p.errorText }
  }
  c.on('Network.loadingFinished', done)
  c.on('Network.loadingFailed', done)
  c.on('Page.screencastFrame', async (p, sid) => {
    const s = bySid(sid); if (!s) return
    try { await c.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sid) } catch {}
    s.frames.forEach(f => { try { f(p.data, p.metadata) } catch {} })
  })
}

// ---------- sessions: one window per conversation ----------
function newRunDir(owner: string) {
  const d = join(REC_DIR, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${owner.slice(0, 8)}`)
  mkdirSync(d, { recursive: true })
  return d
}

async function attach(c: CDP, owner: string, targetId: string, runDir?: string): Promise<Session> {
  const { sessionId: sid } = await c.send('Target.attachToTarget', { targetId, flatten: true })
  const s: Session = { owner, targetId, sid, mainFrame: '', ctx: null, loaderId: '', url: '', title: '', created: Date.now(), lastUsed: Date.now(),
    inflight: new Map(), navigating: false, lastNetAt: 0, net: [], log: [], runDir: runDir ?? newRunDir(owner), paused: false, frames: new Set(), casting: false, crashed: false, shown: false }
  s.paused = !!get<{ paused: number }>('select paused from browser_sessions where owner = ?', owner)?.paused
  sessions.set(owner, s)
  // No Runtime.enable: it's a common bot-detection signal, and an isolated world per document is all we need.
  await Promise.all([
    c.send('Page.enable', {}, sid),
    c.send('Network.enable', { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 5_000_000 }, sid),
    c.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid).catch(() => {}),
    c.send('Page.setInterceptFileChooserDialog', { enabled: false }, sid).catch(() => {}),
  ])
  const tree = await c.send('Page.getFrameTree', {}, sid)
  s.mainFrame = tree.frameTree.frame.id; s.loaderId = tree.frameTree.frame.loaderId; s.url = tree.frameTree.frame.url
  run(`insert into browser_sessions (owner, target_id, created_at, updated_at, url, run_dir) values (?, ?, ?, ?, ?, ?)
       on conflict(owner) do update set target_id = excluded.target_id, updated_at = excluded.updated_at, run_dir = excluded.run_dir`, owner, targetId, Date.now(), Date.now(), s.url, s.runDir)
  hook({ type: 'open', session: s })
  changed()
  return s
}

function dropSession(s: Session, why: string) {
  if (sessions.get(s.owner) !== s) return
  sessions.delete(s.owner)
  hook({ type: 'close', session: s })
  if (why === 'window closed') run('delete from browser_sessions where owner = ?', s.owner)
  changed()
}

export async function session(owner: string, create = true): Promise<Session | null> {
  const c = await ensureBrowser()
  const have = sessions.get(owner)
  if (have && !have.crashed) { have.lastUsed = Date.now(); have.adopted = false; return have }
  const { targetInfos } = await c.send('Target.getTargets')
  const row = get<{ target_id: string; run_dir: string }>('select target_id, run_dir from browser_sessions where owner = ?', owner)
  if (row && targetInfos.some((t: any) => t.targetId === row.target_id && t.type === 'page')) return attach(c, owner, row.target_id, row.run_dir && existsSync(row.run_dir) ? row.run_dir : undefined)
  if (!create) return null
  // At the cap: close the least recently used window whose chat isn't mid-turn, never one the owner is
  // looking at, has taken over, or that waits on an approval. Windows re-adopted at start and unused
  // since don't count toward the cap, and go first.
  const all_ = [...sessions.values()]
  const inUse = all_.filter(s => !s.adopted)
  if (inUse.length >= settings.browser.maxSessions) {
    const waiting = new Set([...approvals.values()].filter(a => a.state === 'pending').map(a => a.owner))
    const victim = all_.filter(s => !s.shown && !s.paused && !waiting.has(s.owner) && !ownerBusy(s.owner))
      .sort((a, b) => Number(!!b.adopted) - Number(!!a.adopted) || a.lastUsed - b.lastUsed)[0]
    if (!victim) throw new Error(`${inUse.length} browser windows are in use by running chats (max ${settings.browser.maxSessions}). Close one with action=close.`)
    await closeSession(victim.owner)
  }
  // A new background window: doesn't steal focus from whatever you're doing.
  const { targetId } = await c.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true })
  return attach(c, owner, targetId)
}

export async function closeSession(owner: string) {
  const s = sessions.get(owner)
  const row = get<{ target_id: string }>('select target_id from browser_sessions where owner = ?', owner)
  const targetId = s?.targetId ?? row?.target_id
  if (s) dropSession(s, 'closed')
  run('delete from browser_sessions where owner = ?', owner)
  if (targetId && cdp && !cdp.closed) { try { await cdp.send('Target.closeTarget', { targetId }) } catch {} }
  changed()
}

// Agent windows nobody is using still render their pages: on 2026-11-16 the Agent Chrome held 21 agent
// windows (13 from chats quiet for two days) and ~34 pages using ~190% of a core, on a Mac at load 145,
// which is what turned perch's normal work into freezes. The cap above only closes a window when a new
// one opens, and after a restart idle chats' windows aren't re-adopted, so they stayed open untracked.
// Every few minutes, close agent windows unused for IDLE_CLOSE_MS. Never one whose chat is mid-turn,
// that is on screen, taken over, or waiting on an approval. Tabs perch didn't open are never touched.
export const IDLE_CLOSE_MS = 60 * 60_000
export function idleWindows(now = Date.now(), idleMs = IDLE_CLOSE_MS): string[] {
  const waiting = new Set([...approvals.values()].filter(a => a.state === 'pending').map(a => a.owner))
  const keep = (owner: string) => waiting.has(owner) || ownerBusy(owner)
  const out: string[] = []
  for (const s of sessions.values()) if (!s.shown && !s.paused && !keep(s.owner) && now - s.lastUsed > idleMs) out.push(s.owner)
  for (const r of all<{ owner: string; updated_at: number | null; paused: number | null }>('select owner, updated_at, paused from browser_sessions'))
    if (!sessions.has(r.owner) && !r.paused && !keep(r.owner) && now - (r.updated_at ?? 0) > idleMs) out.push(r.owner) // untracked since a restart
  return out
}
export async function closeIdleWindows(now = Date.now()) {
  const owners = idleWindows(now)
  for (const owner of owners) await closeSession(owner)
  if (owners.length) console.log(`[browser] closed ${owners.length} idle agent window(s): ${owners.map(o => o.slice(0, 8)).join(', ')}`)
  return owners
}

export function listSessions() {
  return [...sessions.values()].map(s => ({ owner: s.owner, url: s.url, title: s.title, created: s.created, lastUsed: s.lastUsed, paused: s.paused, shown: s.shown, adopted: !!s.adopted, goal: s.goal ?? null, steps: s.log.length, runDir: s.runDir }))
}

// ---------- the isolated world ----------
async function world(s: Session): Promise<number> {
  const c = await ensureBrowser()
  if (s.ctx != null) return s.ctx
  const { executionContextId } = await c.send('Page.createIsolatedWorld', { frameId: s.mainFrame, worldName: 'perch', grantUniveralAccess: true }, s.sid)
  await c.send('Runtime.evaluate', { expression: PAGE_SCRIPT, contextId: executionContextId }, s.sid)
  s.ctx = executionContextId
  return executionContextId
}

export async function evalIn(s: Session, expression: string, opts: { page?: boolean; awaitPromise?: boolean; timeoutMs?: number } = {}): Promise<any> {
  const c = await ensureBrowser()
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const params: any = { expression, returnByValue: true, awaitPromise: !!opts.awaitPromise }
      if (!opts.page) params.contextId = await world(s)
      const r = await c.send('Runtime.evaluate', params, s.sid, opts.timeoutMs ?? 30_000)
      if (r.exceptionDetails) {
        const msg = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
        if (/__perch is not defined|Cannot read properties of undefined \(reading '(snapshot|el|locate)'/.test(msg)) { s.ctx = null; continue }
        throw new Error(msg.split('\n')[0])
      }
      return r.result.value
    } catch (e: any) {
      // the document changed under us: new world, try again
      if (/Cannot find context|context with specified id|Execution context was destroyed|Inspected target navigated/.test(e.message)) { s.ctx = null; await sleep(100); continue }
      throw e
    }
  }
  throw new Error('page kept changing; try again')
}
const call = (s: Session, fn: string, ...args: any[]) => evalIn(s, `__perch.${fn}(${args.map(a => JSON.stringify(a)).join(',')})`)

// ---------- waiting ----------
// After an action: if it started a navigation, wait for the load; then wait for the network to go quiet.
export async function settle(s: Session, opts: { maxMs?: number; quietMs?: number; navGraceMs?: number } = {}) {
  const start = Date.now(), max = opts.maxMs ?? 8000, quiet = opts.quietMs ?? 350
  await sleep(60)
  // a click on a link or submit button can take a moment to start its navigation (slow machines, CI);
  // without this grace the network already looks quiet and we'd read the old page
  if (opts.navGraceMs) {
    const url = s.url
    while (Date.now() - start < opts.navGraceMs && !s.navigating && !s.inflight.size && s.lastNetAt < start && s.url === url) await sleep(30)
  }
  while (Date.now() - start < max) {
    if (s.navigating) { await sleep(80); continue }
    // requests open longer than 10s are long-polls or streams; don't wait on them
    const busy = [...s.inflight.values()].filter(t => Date.now() - t < 10_000).length
    if (!busy && Date.now() - s.lastNetAt >= quiet) break
    await sleep(60)
  }
  s.lastUsed = Date.now()
}

// ---------- policy and confirm gates ----------
export function policyFor(url: string): 'trusted' | 'allow' | 'read' | 'deny' {
  let host = ''
  try { host = new URL(url).hostname } catch { return settings.browser.defaultPolicy }
  if (!host) return 'allow' // about:blank, data:
  const sites = settings.browser.sites ?? {}
  let best: string | null = null
  for (const pat of Object.keys(sites)) {
    const p = pat.replace(/^\*\./, '')
    if ((host === p || host.endsWith('.' + p)) && (!best || p.length > best.replace(/^\*\./, '').length)) best = pat
  }
  return best ? sites[best] : settings.browser.defaultPolicy
}

const IRREVERSIBLE = /\b(send|post|publish|tweet|reply|comment|pay|buy|purchase|place (your )?order|order now|checkout|check out|transfer|withdraw|delete|remove|destroy|erase|merge|invite|share|deploy|approve|unsubscribe|cancel (my |your )?(subscription|plan|account)|close (my |your )?account|confirm|sign( and)? submit|submit (order|payment|application)|archive)\b/i
export function isIrreversible(info: { role: string; name: string; type?: string }) {
  if (!['button', 'link', 'menuitem', 'clickable', 'option'].includes(info.role) && info.type !== 'submit') return false
  return IRREVERSIBLE.test(info.name)
}

function hostOf(url: string) { try { return new URL(url).hostname } catch { return '' } }

// Held until you approve under the chat (or in the live view). The key ties an approval to that exact click.
function gate(s: Session, what: string, name: string): string | null {
  const policy = policyFor(s.url)
  if (policy === 'trusted' || !settings.browser.confirmIrreversible) return null
  if ((settings.browser.allowedActions ?? []).includes(`${hostOf(s.url)}|${what}`)) return null
  const key = `${s.owner}|${hostOf(s.url)}|${what}`
  const existing = [...approvals.values()].find(a => a.key === key)
  if (existing?.state === 'approved') { approvals.delete(existing.id); return null }
  if (existing?.state === 'denied') { approvals.delete(existing.id); return `${ownerName()} declined: ${what} on ${hostOf(s.url)}. Don't retry it; tell ${ownerName()} what you were trying to do.` }
  if (existing) return `Still waiting for ${ownerName()} to approve ${what} (approval ${existing.id}). Use action=wait for=approval approval_id=${existing.id}, or end your turn: perch wakes you when ${ownerName()} answers.`
  const a: Approval = { id: randomUUID().slice(0, 8), owner: s.owner, host: hostOf(s.url), what, url: s.url, key, at: Date.now(), state: 'pending' }
  approvals.set(a.id, a)
  try { run('insert into chat_notices (conversation_id, at, text) values (?, ?, ?)', s.owner, Date.now(), `Browser: approve ${what} on ${a.host}? (approval ${a.id})`) } catch {}
  emit(s.owner, 'browser_needs_user', `Waiting for ${ownerName()} to approve ${what} on ${a.host} (approval ${a.id}).`)
  changed()
  return `Held for ${possessive(ownerName())} OK: ${what} on ${a.host} looks irreversible (${name}). ${ownerName()} sees it under the chat (approval ${a.id}). Do the rest of the work; then use action=wait for=approval approval_id=${a.id}, or end your turn and perch wakes you when ${ownerName()} answers. After ${ownerName()} approves, run the same step again.`
}

// always: allow this exact action on this site from now on (e.g. "clicking button "Send"" on mail.google.com).
export function answerApproval(id: string, ok: boolean, always = false) {
  const a = approvals.get(id)
  if (!a) return { error: 'no such approval' }
  a.state = ok ? 'approved' : 'denied'
  if (ok && always) {
    const k = `${a.host}|${a.what}`
    const list = settings.browser.allowedActions ?? []
    if (!list.includes(k)) updateSettings({ browser: { ...settings.browser, allowedActions: [...list, k] } })
  }
  emit(a.owner, ok ? 'browser_approved' : 'browser_denied', `${ownerName()} ${ok ? 'approved' : 'declined'} ${a.what} on ${a.host} (approval ${a.id}).${ok ? ' Run that step again now.' : ''}`)
  changed()
  return { ok: true }
}

// ---------- input ----------
const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }, Tab: { key: 'Tab', code: 'Tab', keyCode: 9 }, Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 }, Delete: { key: 'Delete', code: 'Delete', keyCode: 46 }, Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 }, PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 }, Home: { key: 'Home', code: 'Home', keyCode: 36 }, End: { key: 'End', code: 'End', keyCode: 35 },
}
export async function pressKey(s: Session, name: string) {
  const c = await ensureBrowser()
  // "Meta+a", "Control+Enter", or a single character
  const parts = name.split('+'), base = parts.pop()!
  const MODS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 }
  const mods = parts.reduce((m, p) => m | (MODS[p] ?? 0), 0)
  const k = KEYS[base] ?? (base.length === 1 ? { key: base, code: `Key${base.toUpperCase()}`, keyCode: base.toUpperCase().charCodeAt(0), text: base } : null)
  if (!k) throw new Error(`unknown key ${name}`)
  const text = mods & ~8 ? undefined : k.text
  await c.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', modifiers: mods, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, text, unmodifiedText: text }, s.sid)
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode }, s.sid)
}

async function mouseClick(s: Session, x: number, y: number) {
  const c = await ensureBrowser()
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, s.sid)
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, s.sid)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, s.sid)
}

// ---------- navigation ----------
export async function navigate(s: Session, url: string, timeoutMs = 30_000) {
  if (!/^[a-z]+:/i.test(url)) url = 'https://' + url
  const policy = policyFor(url)
  if (policy === 'deny') throw new Error(`${hostOf(url)} is on the deny list (settings.browser.sites).`)
  const c = await ensureBrowser()
  s.navigating = true
  const r = await c.send('Page.navigate', { url }, s.sid, timeoutMs)
  if (r.errorText && r.errorText !== 'net::ERR_ABORTED') { s.navigating = false; throw new Error(`couldn't open ${url}: ${r.errorText}`) }
  if (!r.loaderId) s.navigating = false // same-document (hash) navigation
  const until = Date.now() + timeoutMs
  while (s.navigating && Date.now() < until) await sleep(50)
  await settle(s, { maxMs: 1500, quietMs: 250 })
}

// ---------- steps ----------
async function resolveRef(s: Session, step: Step, opts: { exactOnly?: boolean } = {}): Promise<{ ref: string; how: string; score: number; ambiguous?: boolean } | null> {
  if (step.ref) return { ref: step.ref, how: 'ref', score: 1 }
  if (step.name || step.role) {
    const loc: Locator = { role: step.role ?? '', name: step.name ?? '' }
    if (!loc.role) { // name only: try the common interactive roles
      for (const role of ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'tab', 'menuitem', 'option', 'searchbox', 'clickable']) {
        const r = await call(s, 'locate', { ...loc, role }, { exactOnly: true })
        if (r) return r
      }
      return null
    }
    return call(s, 'locate', loc, opts)
  }
  return null
}

function stepLabel(st: Step) {
  const target = st.ref ? st.ref : st.name ? `${st.role ?? ''} "${st.name}"`.trim() : ''
  return `${st.do}${target ? ' ' + target : ''}${st.value != null && st.do !== 'fill' && st.do !== 'type' ? ` = ${st.value}` : st.value != null ? ` "${String(st.value).slice(0, 40)}"` : ''}${st.key ? ' ' + st.key : ''}${st.url ? ' ' + st.url : ''}`
}

// Runs one step. Returns a line for the agent; throws on failure. The step is logged with a robust locator.
// a click that should load a new page: a real link, or a submit button in a form
function mayNavigate(info: { tag?: string; type?: string; form?: string; href?: string }) {
  if (info.href && !/^(#|javascript:)/i.test(info.href)) return true
  return !!info.form && (info.tag === 'button' ? (info.type || 'submit') === 'submit' : info.tag === 'input' && /^(submit|image)$/i.test(info.type ?? ''))
}

export async function runStep(s: Session, st: Step, opts: { replay?: boolean; locator?: Locator; healed?: string } = {}): Promise<string> {
  if (s.paused) throw new Error(`${ownerName()} has taken over this window. Wait (action=wait for=resume) or ask ${ownerName()}.`)
  const t0 = Date.now()
  const policy = policyFor(s.url)
  const logBase = { do: st.do, value: st.value, key: st.key, url: st.url, dy: st.dy, ms: st.ms, text: st.text, submit: st.submit }
  const record = (extra: Partial<LoggedStep>) => {
    const l: LoggedStep = { ...logBase, ...extra, urlAfter: s.url, took: Date.now() - t0, at: Date.now() }
    s.log.push(l)
    try { appendFileSync(join(s.runDir, 'actions.jsonl'), JSON.stringify({ ...l, value: l.secret ? '••••' : l.value }) + '\n') } catch {}
    hook({ type: 'step', session: s, step: l })
    changed()
  }
  switch (st.do) {
    case 'navigate': { if (!st.url) throw new Error('navigate needs url'); await navigate(s, st.url); record({}); return `opened ${s.url}` }
    case 'back': case 'forward': {
      const c = await ensureBrowser()
      const h = await c.send('Page.getNavigationHistory', {}, s.sid)
      const e = h.entries[h.currentIndex + (st.do === 'back' ? -1 : 1)]
      if (!e) throw new Error(`nothing to go ${st.do} to`)
      s.navigating = true
      await c.send('Page.navigateToHistoryEntry', { entryId: e.id }, s.sid)
      await settle(s); record({}); return `${st.do} → ${s.url}`
    }
    case 'reload': { const c = await ensureBrowser(); s.navigating = true; await c.send('Page.reload', {}, s.sid); await settle(s); record({}); return 'reloaded' }
    case 'wait': {
      if (st.text) { const until = Date.now() + Math.min(st.ms ?? 10_000, 60_000); while (Date.now() < until) { if (await call(s, 'hasText', st.text)) { record({}); return `saw "${st.text}"` } await sleep(150) } throw new Error(`"${st.text}" didn't appear`) }
      await sleep(Math.min(st.ms ?? 1000, 30_000)); record({}); return `waited ${st.ms ?? 1000}ms`
    }
    case 'scroll': {
      if (st.ref || st.name) { const r = await resolveRef(s, st); if (!r) throw new Error('target not found'); await call(s, 'point', r.ref) }
      else await evalIn(s, `scrollBy(0, ${Number(st.dy ?? 700)})`)
      await settle(s, { maxMs: 1500 }); record({}); return `scrolled`
    }
    case 'press': {
      if (policy === 'read') throw new Error(`${hostOf(s.url)} is read-only (settings.browser.sites).`)
      if (st.ref || st.name) { const r = await resolveRef(s, st); if (!r) throw new Error('target not found'); await call(s, 'focusForTyping', r.ref, false) }
      await pressKey(s, st.key ?? st.value ?? 'Enter')
      await settle(s); record({}); return `pressed ${st.key ?? st.value ?? 'Enter'}`
    }
  }
  // element steps
  if (policy === 'read' && st.do !== 'hover') throw new Error(`${hostOf(s.url)} is read-only (settings.browser.sites).`)
  const found = opts.locator ? await call(s, 'locate', opts.locator, { exactOnly: false }) : await resolveRef(s, st)
  if (!found) throw new Error(`couldn't find ${st.ref ?? `${st.role ?? ''} "${st.name ?? ''}"`.trim()} on the page${st.ref ? ' (refs change when the page does; take a new snapshot)' : ''}`)
  const info = await call(s, 'info', found.ref)
  if (!info) throw new Error(`${found.ref} is gone (the page changed); take a new snapshot`)
  const locator: Locator = await call(s, 'describe', found.ref)
  const irreversible = (st.do === 'click' || (st.submit && (st.do === 'fill' || st.do === 'type'))) && isIrreversible(info)
  if (irreversible) {
    const held = gate(s, `clicking ${info.role} "${info.name}"`, info.name)
    if (held) return `HELD: ${held}`
  }
  const secret = info.type === 'password'
  switch (st.do) {
    case 'click': case 'check': case 'uncheck': {
      if (st.do !== 'click') {
        const checked = await evalIn(s, `!!__perch.el(${JSON.stringify(found.ref)})?.checked`)
        if (checked === (st.do === 'check')) { record({ locator, irreversible }); return `${st.do}: already ${checked ? 'checked' : 'unchecked'}` }
      }
      const p = await call(s, 'point', found.ref)
      if (p.error) throw new Error(`${found.ref} is gone; take a new snapshot`)
      if (p.covered && !st.force) throw new Error(`${info.role} "${info.name}" is covered by ${p.covered} (close it first, or pass force:true)`)
      await mouseClick(s, p.x, p.y)
      break
    }
    case 'hover': { const p = await call(s, 'point', found.ref); const c = await ensureBrowser(); await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }, s.sid); break }
    case 'fill': case 'type': {
      const f = await call(s, 'focusForTyping', found.ref, st.do === 'fill')
      if (f.error) throw new Error(`${found.ref} is gone; take a new snapshot`)
      const c = await ensureBrowser()
      if (st.do === 'fill') {
        // clear what's selected (insertText of '' doesn't fire input on some frameworks), then type
        await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, s.sid)
        await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, s.sid)
      }
      if (st.value) await c.send('Input.insertText', { text: String(st.value) }, s.sid)
      if (st.submit) await pressKey(s, 'Enter')
      break
    }
    case 'select': {
      const r = await call(s, 'selectOption', found.ref, st.value ?? '')
      if (r.error) throw new Error(r.error)
      break
    }
    default: throw new Error(`unknown step ${st.do}`)
  }
  await settle(s, st.do === 'click' && mayNavigate(info) ? { navGraceMs: 1000 } : {})
  record({ locator, irreversible, secret })
  const how = opts.healed ? ` (healed: ${opts.healed})` : found.how !== 'ref' && found.how !== 'role+name' ? ` (found by ${found.how}${found.ambiguous ? ', ambiguous' : ''})` : ''
  return `${st.do} ${info.role} "${info.name}"${st.do === 'fill' || st.do === 'type' ? (secret ? ' = ••••' : ` = "${String(st.value ?? '').slice(0, 60)}"`) : st.do === 'select' ? ` = ${st.value}` : ''}${how}`
}

export async function runSteps(s: Session, steps: Step[]) {
  const lines: string[] = []
  const startUrl = s.url
  for (const [i, st] of steps.entries()) {
    try {
      const line = await runStep(s, st)
      lines.push(`${i + 1}. ${line}`)
      if (line.startsWith('HELD:')) return { lines, error: true, startUrl }
    } catch (e: any) {
      lines.push(`${i + 1}. FAILED ${stepLabel(st)}: ${e.message}`)
      if (steps.length > i + 1) lines.push(`(stopped; ${steps.length - i - 1} step(s) not run)`)
      return { lines, error: true, startUrl }
    }
  }
  return { lines, error: false, startUrl }
}

// ---------- reading ----------
export async function snapshot(s: Session, opts: { mode?: 'interactive' | 'full'; find?: string; max?: number; viewport?: boolean } = {}) {
  const r = await call(s, 'snapshot', { mode: opts.mode ?? 'interactive', find: opts.find, max: opts.max ?? 5000, viewport: opts.viewport })
  s.title = r.title
  return r as { text: string; count: number; skipped: number; scroll: string; url: string; title: string }
}
export async function pageText(s: Session, max = 8000) { return (await call(s, 'text', max)) as { text: string; url: string; title: string } }
// high: device pixels (2x on Retina), crisp text. low: CSS pixels at lower JPEG quality, about a quarter of the
// pixels, for when the agent only needs the gist of a layout and wants cheaper images.
export type Resolution = 'high' | 'low'
export async function screenshot(s: Session, opts: { full?: boolean; quality?: number; resolution?: Resolution } = {}) {
  const c = await ensureBrowser()
  const res = opts.resolution ?? s.resolution ?? 'high'
  const params: any = { format: 'jpeg', quality: opts.quality ?? (res === 'low' ? 50 : 80), captureBeyondViewport: !!opts.full, fromSurface: true }
  if (res === 'low') {
    const lm = await c.send('Page.getLayoutMetrics', {}, s.sid)
    const dpr = (lm.visualViewport?.clientWidth || 1) / (lm.cssVisualViewport?.clientWidth || lm.visualViewport?.clientWidth || 1)
    const v = lm.cssVisualViewport ?? lm.visualViewport, size = lm.cssContentSize ?? lm.contentSize
    params.clip = opts.full ? { x: 0, y: 0, width: size.width, height: size.height, scale: 1 / dpr }
      : { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: 1 / dpr }
  }
  const r = await c.send('Page.captureScreenshot', params, s.sid, 20_000)
  return r.data as string
}

// JSON/XHR the page called: the internal APIs a repeat task can call directly with your cookies.
export function networkLog(s: Session, filter?: string) {
  return s.net.filter(n => (n.type === 'XHR' || n.type === 'Fetch' || /json/.test(n.mime ?? '')) && (!filter || n.url.includes(filter)))
    .slice(-40).map(n => `${n.method} ${n.status ?? '…'} ${n.mime ?? ''} ${n.url.slice(0, 200)}`)
}
export async function responseBody(s: Session, urlPart: string, max = 8000) {
  const n = s.net.findLast(n => n.url.includes(urlPart) && n.status)
  if (!n) throw new Error(`no response matching ${urlPart}`)
  const c = await ensureBrowser()
  const r = await c.send('Network.getResponseBody', { requestId: n.id }, s.sid)
  const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body
  return `${n.method} ${n.status} ${n.url}\n${body.length > max ? body.slice(0, max) + `\n… (${body.length - max} more)` : body}`
}

// Mode 0: fetch with the Agent profile's cookies, from perch itself: no window, no page CSP or CORS in
// the way. Cookies come from the browser's store and are matched to the URL like Chrome would.
export function cookieHeader(cookies: { name: string; value: string; domain: string; path: string; secure: boolean; expires?: number }[], url: string) {
  const u = new URL(url)
  return cookies.filter(c => {
    const d = c.domain.replace(/^\./, '')
    const domainOk = c.domain.startsWith('.') ? (u.hostname === d || u.hostname.endsWith('.' + d)) : u.hostname === d
    return domainOk && u.pathname.startsWith(c.path || '/') && (!c.secure || u.protocol === 'https:' || u.hostname === '127.0.0.1' || u.hostname === 'localhost') && (!c.expires || c.expires < 0 || c.expires * 1000 > Date.now())
  }).sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0)).map(c => `${c.name}=${c.value}`).join('; ')
}
let userAgent = ''
// Django-style apps (PostHog included) reject cookie-authenticated writes without a CSRF token and a
// same-origin Referer, which a browser adds by itself. Add them the same way for non-GET requests.
export function csrfHeaders(method: string, url: string, cookie: string): Record<string, string> {
  if (method === 'GET' || method === 'HEAD' || !cookie) return {}
  const token = /(?:^|;\s*)(?:posthog_csrftoken|csrftoken|XSRF-TOKEN)=([^;]+)/.exec(cookie)?.[1]
  const origin = new URL(url).origin
  return { Referer: origin + '/', Origin: origin, ...(token ? { 'X-CSRFToken': decodeURIComponent(token) } : {}) }
}
// The Agent profile's cookies for a URL, plus the browser's user agent: for server-side calls (the product overlay).
export async function cookiesFor(url: string) {
  const c = await ensureBrowser()
  const { cookies } = await c.send('Storage.getCookies', {})
  if (!userAgent) userAgent = (await c.send('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome')
  return { cookie: cookieHeader(cookies, url), userAgent }
}
export async function fetchWithCookies(_owner: string, url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}, max = 12000) {
  if (!/^https?:/i.test(url)) url = 'https://' + url
  const policy = policyFor(url)
  if (policy === 'deny') throw new Error(`${hostOf(url)} is on the deny list.`)
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && policy === 'read') throw new Error(`${hostOf(url)} is read-only.`)
  const c = await ensureBrowser()
  const { cookies } = await c.send('Storage.getCookies', {})
  if (!userAgent) userAgent = (await c.send('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome')
  const cookie = cookieHeader(cookies, url)
  const t0 = Date.now()
  const r = await fetch(url, { method, body: init.body, redirect: 'follow', signal: AbortSignal.timeout(30_000),
    headers: { 'User-Agent': userAgent, Accept: 'application/json, text/html;q=0.9, */*;q=0.8', ...(cookie ? { Cookie: cookie } : {}), ...csrfHeaders(method, url, cookie), ...(init.headers ?? {}) } })
  const type = r.headers.get('content-type') ?? ''
  let text = await r.text()
  if (/json/.test(type)) { try { text = JSON.stringify(JSON.parse(text), null, 1) } catch {} }
  else if (/html/.test(type)) text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
  return `${r.status} ${type} (${Date.now() - t0}ms${cookie ? ', with your cookies' : ''})\n${text.length > max ? text.slice(0, max) + `\n… (${text.length - max} more chars)` : text}`
}

// ---------- live view: screencast and takeover ----------
export async function watchFrames(owner: string, f: (jpegB64: string, meta: any) => void) {
  const s = await session(owner, false)
  if (!s) throw new Error('no browser window for this conversation')
  s.frames.add(f)
  if (!s.casting) {
    s.casting = true
    const c = await ensureBrowser()
    await c.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 2560, maxHeight: 1800, everyNthFrame: 1 }, s.sid)
    // first frame right away even if nothing repaints
    // with the viewport in CSS px, so the live view maps clicks right on a Retina screen too
    Promise.all([screenshot(s, { quality: 80 }), c.send('Page.getLayoutMetrics', {}, s.sid)])
      .then(([d, lm]) => f(d, { offsetTop: 0, pageScaleFactor: 1, deviceWidth: lm.cssLayoutViewport.clientWidth, deviceHeight: lm.cssLayoutViewport.clientHeight, first: true })).catch(() => {})
  }
  return async () => {
    s.frames.delete(f)
    if (!s.frames.size && s.casting) { s.casting = false; try { const c = await ensureBrowser(); await c.send('Page.stopScreencast', {}, s.sid) } catch {} }
  }
}

// Input from the live view, in CSS pixels of the page viewport.
export async function userInput(owner: string, ev: { type: 'click' | 'move' | 'down' | 'up' | 'wheel' | 'key' | 'text'; x?: number; y?: number; dx?: number; dy?: number; key?: string; text?: string }) {
  const s = sessions.get(owner)
  if (!s) throw new Error('no browser window')
  const c = await ensureBrowser()
  const x = ev.x ?? 0, y = ev.y ?? 0
  if (ev.type === 'click') await mouseClick(s, x, y)
  else if (ev.type === 'move') await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, s.sid)
  else if (ev.type === 'down') await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, s.sid)
  else if (ev.type === 'up') await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, s.sid)
  else if (ev.type === 'wheel') await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: ev.dx ?? 0, deltaY: ev.dy ?? 0 }, s.sid)
  else if (ev.type === 'key' && ev.key) await pressKey(s, ev.key)
  else if (ev.type === 'text' && ev.text) await c.send('Input.insertText', { text: ev.text }, s.sid)
}

export function setPaused(owner: string, paused: boolean) {
  const s = sessions.get(owner)
  if (!s) return { error: 'no browser window' }
  s.paused = paused
  run('update browser_sessions set paused = ? where owner = ?', paused ? 1 : 0, owner)
  if (!paused) s.shown = false
  emit(owner, paused ? 'browser_taken_over' : 'browser_released', paused ? `${ownerName()} took over your browser window; your browser actions are paused until it is handed back.` : `${ownerName()} handed the browser window back. Take a fresh snapshot before acting (the page may have changed).`)
  changed()
  return { ok: true }
}

// Bring an app to the front by pid (no Automation permission needed: AppKit from osascript's own process).
export function activatePid(pid: number) {
  if (!pid) return
  const js = `ObjC.import('AppKit'); var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (a) a.activateWithOptions(3)`
  try { spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js], { stdio: 'ignore' }).unref() } catch {}
}

// The "back to perch" pill: a closed shadow root (invisible to snapshots), shown only while the owner has
// the window open in Chrome. Clicking opens about:blank#perch-back:<owner>, which perch sees as a new
// target, closes, and answers by bringing perch forward on that chat. No network, no page bindings.
const pillScript = (owner: string) => `(() => {
  if (window !== window.top || document.getElementById('__perch_pill')) return
  const host = document.createElement('div'); host.id = '__perch_pill'
  host.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;all:initial;position:fixed;right:14px;bottom:14px;z-index:2147483647'
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = '<button style="font:600 13px -apple-system,system-ui,sans-serif;background:#f5a623;color:#1a1a1a;border:0;border-radius:999px;padding:8px 14px;box-shadow:0 4px 14px rgba(0,0,0,.3);cursor:pointer">← Mothership</button>'
  root.querySelector('button').onclick = e => { e.preventDefault(); e.stopPropagation(); window.open('about:blank#perch-back:' + ${JSON.stringify(encodeURIComponent(owner))}, '_blank') }
  ;(document.body || document.documentElement).appendChild(host)
})()`
async function pill(s: Session) { if (s.shown && /^https?:|^file:|^data:/.test(s.url)) { try { await evalIn(s, pillScript(s.owner), { timeoutMs: 5000 }) } catch {} } }

// Open the chat's window in the real Agent Chrome, in front of everything, with the way back.
export async function showWindow(owner: string) {
  const s = await session(owner, false)
  if (!s) throw new Error('no browser window for this conversation')
  const c = await ensureBrowser()
  await c.send('Target.activateTarget', { targetId: s.targetId })
  try { const { windowId } = await c.send('Browser.getWindowForTarget', { targetId: s.targetId }); await c.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }) } catch {}
  activatePid(lockPid() ?? 0)
  s.shown = true
  await pill(s)
}

// Someone clicked "← perch" in the Agent Chrome: perch comes forward on that chat.
export let lastBack: { owner: string; at: number } | null = null
export function backToPerch(owner: string) {
  lastBack = { owner, at: Date.now() }
  const s = sessions.get(owner)
  if (s) s.shown = false
  activatePid(process.ppid) // the perch app (Electron runs the server as its child)
  changed()
}

// ---------- learning: site notes and cached paths ----------
export const notesFor = (host: string) => get<{ notes: string }>('select notes from site_memory where host = ?', host)?.notes ?? ''
export function remember(host: string, note: string) {
  const old = notesFor(host)
  const lines = old ? old.split('\n') : []
  for (const l of note.split('\n').map(l => l.trim()).filter(Boolean)) if (!lines.includes(`- ${l}`) && !lines.includes(l)) lines.push(l.startsWith('- ') ? l : `- ${l}`)
  const text = lines.slice(-60).join('\n')
  run('insert into site_memory (host, notes, updated_at) values (?, ?, ?) on conflict(host) do update set notes = excluded.notes, updated_at = excluded.updated_at', host, text, Date.now())
  return text
}
export type SitePath = { id: string; host: string; goal: string; steps: LoggedStep[]; expect: { url?: string; text?: string } | null; mode: string | null; ok_count: number; fail_count: number; heal_count: number; version: number; last_ok: number | null; last_ms: number | null }
const parsePath = (r: any): SitePath => ({ ...r, steps: JSON.parse(r.steps), expect: r.expect ? JSON.parse(r.expect) : null })
export const pathsFor = (host: string) => all<any>('select * from site_paths where host = ? order by ok_count desc, last_ok desc', host).map(parsePath)
export const getPath = (id: string) => { const r = get<any>('select * from site_paths where id = ?', id); return r ? parsePath(r) : null }

const words = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 2))
export function findPath(host: string, goal: string): SitePath | null {
  const g = words(goal)
  let best: SitePath | null = null, bestScore = 0
  for (const p of pathsFor(host)) {
    if (p.fail_count > p.ok_count + 2) continue
    const w = words(p.goal)
    let n = 0; for (const x of g) if (w.has(x)) n++
    const score = n / Math.max(g.size, w.size, 1)
    if (score > bestScore) { best = p; bestScore = score }
  }
  return bestScore >= 0.6 ? best : null
}

// Start a task: from here, steps are what a cached path for this goal would replay.
export function beginGoal(s: Session, goal: string) { s.goal = goal; s.goalStartUrl = s.url; s.log = []; changed() }

// Verify the outcome now, then save the steps since beginGoal as the path for this goal (a wrong path
// is worse than none, so nothing is cached without a check that passes).
export async function finishGoal(s: Session, opts: { ok: boolean; expect?: { url?: string; text?: string } }) {
  if (!s.goal) return 'No goal was started (pass goal on open, or action=begin).'
  const goal = s.goal
  s.goal = undefined
  hook({ type: 'finish', session: s, ok: opts.ok })
  if (!opts.ok) return `Noted: "${goal}" did not succeed; nothing cached.`
  const expect = opts.expect ?? { url: new URL(s.url).pathname }
  if (expect.text && !(await call(s, 'hasText', expect.text))) return `Not cached: the page doesn't show "${expect.text}", so the outcome isn't verified.`
  if (expect.url && !s.url.includes(expect.url)) return `Not cached: the page is at ${s.url}, not ${expect.url}.`
  const steps = s.log.filter(l => l.do !== 'wait' || l.text)
  if (!steps.length) return 'Nothing to cache (no steps since the goal started).'
  // a path starts with how to get there
  if (steps[0].do !== 'navigate' && s.goalStartUrl && !s.goalStartUrl.startsWith('about:')) steps.unshift({ do: 'navigate', url: s.goalStartUrl, urlAfter: s.goalStartUrl, took: 0, at: Date.now() })
  const host = hostOf(steps.find(st => st.do === 'navigate')?.url ?? s.url)
  const safe = steps.map(st => st.secret ? { ...st, value: undefined } : st) // never cache passwords
  const existing = pathsFor(host).find(p => p.goal.toLowerCase() === goal.toLowerCase())
  const ms = steps.reduce((t, st) => t + st.took, 0)
  if (existing) run('update site_paths set steps = ?, expect = ?, version = version + 1, ok_count = ok_count + 1, last_ok = ?, last_ms = ? where id = ?', JSON.stringify(safe), JSON.stringify(expect), Date.now(), ms, existing.id)
  else run('insert into site_paths (id, host, goal, steps, expect, mode, ok_count, created_at, last_ok, last_ms) values (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)', randomUUID().slice(0, 8), host, goal, JSON.stringify(safe), JSON.stringify(expect), null, Date.now(), Date.now(), ms)
  try { writeFileSync(join(s.runDir, 'path.json'), JSON.stringify({ goal, host, expect, steps: safe }, null, 1)) } catch {}
  changed()
  return `Cached "${goal}" for ${host}: ${steps.length} steps${steps.some(st => st.secret) ? ' (password values left out: replay stops there for you)' : ''}. Next time: action=replay goal="${goal}" (no model needed).`
}

// Replays a cached path without the model. Each step is found by its saved locator (exact first);
// a step that moved is healed by fuzzy match only when it's unambiguous and not irreversible, and
// the path is rewritten. Anything else stops and hands back to the agent with a snapshot.
export async function replay(s: Session, p: SitePath, values: Record<string, string> = {}) {
  const t0 = Date.now()
  const lines: string[] = []
  let healed = 0
  const newSteps: LoggedStep[] = []
  beginGoal(s, p.goal)
  for (const [i, st] of p.steps.entries()) {
    if (st.secret) { lines.push(`${i + 1}. stopped: this step types a password, which perch never caches`); return { ok: false, lines, at: i, ms: Date.now() - t0 } }
    const value = st.value != null && values[st.value] != null ? values[st.value] : st.value
    const step: Step = { do: st.do, value, key: st.key, url: st.url, dy: st.dy, ms: st.ms, text: st.text, submit: st.submit }
    try {
      if (st.locator) {
        // wait for the element: up to 3x how long it took to appear last time, at least 1.5s
        const until = Date.now() + Math.max(1500, Math.min(8000, st.took * 3))
        let found: any = null
        while (Date.now() < until && !(found = await call(s, 'locate', st.locator, { exactOnly: true }))) await sleep(100)
        let heal = ''
        if (!found) {
          const fuzzy = await call(s, 'locate', st.locator, { exactOnly: false })
          if (!fuzzy || fuzzy.ambiguous || fuzzy.score < 0.5 || st.irreversible) {
            lines.push(`${i + 1}. diverged: couldn't find ${st.locator.role} "${st.locator.name}"${fuzzy ? ` (closest match was ${fuzzy.ambiguous ? 'ambiguous' : `too weak, ${fuzzy.score.toFixed(2)}`}${st.irreversible ? ', and the step is irreversible' : ''})` : ''}`)
            run('update site_paths set fail_count = fail_count + 1 where id = ?', p.id)
            return { ok: false, lines, at: i, ms: Date.now() - t0 }
          }
          heal = `${fuzzy.how} ${fuzzy.score.toFixed(2)}`
          healed++
          found = fuzzy
        }
        const line = await runStep(s, { ...step, ref: found.ref }, { replay: true, healed: heal || undefined })
        if (line.startsWith('HELD:')) { lines.push(`${i + 1}. ${line}`); return { ok: false, lines, at: i, ms: Date.now() - t0, held: true } }
        lines.push(`${i + 1}. ${line}`)
      } else {
        lines.push(`${i + 1}. ${await runStep(s, step, { replay: true })}`)
      }
      newSteps.push(s.log[s.log.length - 1])
    } catch (e: any) {
      lines.push(`${i + 1}. diverged: ${e.message}`)
      run('update site_paths set fail_count = fail_count + 1 where id = ?', p.id)
      return { ok: false, lines, at: i, ms: Date.now() - t0 }
    }
  }
  // the outcome check that made this path worth caching
  const ex = p.expect ? { ...p.expect } : null
  if (ex?.text) for (const [from, to] of Object.entries(values)) ex.text = ex.text.split(from).join(to)
  if (ex?.text && !(await call(s, 'hasText', ex.text))) { lines.push(`outcome check failed: "${ex.text}" not on the page`); run('update site_paths set fail_count = fail_count + 1 where id = ?', p.id); return { ok: false, lines, at: p.steps.length, ms: Date.now() - t0 } }
  if (ex?.url && !s.url.includes(ex.url)) { lines.push(`outcome check failed: at ${s.url}, expected ${ex.url}`); run('update site_paths set fail_count = fail_count + 1 where id = ?', p.id); return { ok: false, lines, at: p.steps.length, ms: Date.now() - t0 } }
  const ms = Date.now() - t0
  if (healed) run('update site_paths set steps = ?, version = version + 1, heal_count = heal_count + ?, ok_count = ok_count + 1, last_ok = ?, last_ms = ? where id = ?', JSON.stringify(newSteps.map(st => st.secret ? { ...st, value: undefined } : st)), healed, Date.now(), ms, p.id)
  else run('update site_paths set ok_count = ok_count + 1, last_ok = ?, last_ms = ? where id = ?', Date.now(), ms, p.id)
  s.goal = undefined
  hook({ type: 'finish', session: s, ok: true })
  return { ok: true, lines, at: p.steps.length, ms, healed }
}

// Old recordings go after settings.browser.recordingDays, and the oldest go first past maxBytes
// (2 GB by default). A run's age is its newest file (appends don't touch the dir's mtime); windows
// still open are never pruned.
export const REC_MAX_BYTES = Number(process.env.PERCH_BROWSER_REC_MAX_MB ?? 2048) * 1_000_000
export function pruneRecordings(maxBytes = REC_MAX_BYTES) {
  try {
    if (!existsSync(REC_DIR)) return
    const cutoff = Date.now() - settings.browser.recordingDays * 86_400_000
    const live = new Set([...sessions.values()].map(s => s.runDir))
    const scan = (d: string): { size: number; newest: number } => {
      let size = 0, newest = statSync(d).mtimeMs
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, f.name)
        try { if (f.isDirectory()) { const r = scan(p); size += r.size; newest = Math.max(newest, r.newest) } else { const st = statSync(p); size += st.size; newest = Math.max(newest, st.mtimeMs) } } catch {}
      }
      return { size, newest }
    }
    const runs = readdirSync(REC_DIR).map(d => join(REC_DIR, d)).filter(p => { try { return statSync(p).isDirectory() } catch { return false } })
      .map(p => ({ p, ...scan(p) })).sort((a, b) => a.newest - b.newest)
    let total = runs.reduce((t, r) => t + r.size, 0)
    for (const r of runs) {
      if (live.has(r.p)) continue
      if (r.newest < cutoff || total > maxBytes) { rmSync(r.p, { recursive: true, force: true }); total -= r.size }
    }
  } catch (e) { console.error('pruneRecordings', e) }
}
