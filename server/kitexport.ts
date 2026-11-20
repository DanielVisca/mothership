// Kits (docs/kits.md): package someone's skills, routines and CLAUDE.md snippet so another person can
// import them. Export swaps the exporter's personal values for {{placeholders}}, then refuses to write
// anything if a personal value is still left (the scrub gate). Kept free of db.ts: it reads the source
// database read-only, so exporting never touches the exporter's live Mothership.
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

export const KIT_VERSION = 1
export const SAFE_NAME = /^[\w.-]{1,80}$/
// Every placeholder a kit may use. Import fills them from the importer's own settings.
export const VARS = ['owner.name', 'home', 'codeDir', 'github.org', 'posthog.projectId'] as const
export type Var = typeof VARS[number]

export type KitRoutine = { name: string; cron: string | null; mode: 'resume' | 'fresh'; prompt: string }
export type KitManifest = {
  kit: number; name: string; version: string; description: string; author?: string
  skills: string[]; routines: string[]; instructions: boolean
}
export type Hit = { file: string; line: number; match: string }

// Literal -> placeholder. Longest literal first, so ~/Development becomes {{codeDir}} before ~ becomes {{home}}.
export function templater(subs: [string, Var][]) {
  const ordered = subs.filter(([lit]) => lit && lit.length >= 2).sort((a, b) => b[0].length - a[0].length)
  return (text: string) => {
    let out = text
    for (const [lit, v] of ordered) {
      // "--owner=[[Acme]]": only the bracketed part is swapped, and only where the whole text appears.
      const part = lit.match(/^(.*)\[\[(.+)\]\](.*)$/)
      if (part) { out = out.split(part[1] + part[2] + part[3]).join(`${part[1]}{{${v}}}${part[3]}`); continue }
      // Names match as whole words (Daniel, Daniel's) so "Danielle" or a substring isn't mangled.
      const word = /^[\p{L}]+$/u.test(lit)
      const re = new RegExp(word ? `(?<![\\p{L}])${esc(lit)}(?![\\p{L}])` : esc(lit), word ? 'gu' : 'g')
      out = out.replace(re, `{{${v}}}`)
    }
    return out
  }
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Emails, plus whatever the exporter forbids (names, usernames, Slack ids, internal hosts, ids).
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g
const OK_EMAIL = /^(noreply@|no-reply@|.*@example\.(com|org)$|.*@users\.noreply\.github\.com$|git@github\.com$)/i
export function scrubHits(files: { path: string; content: string }[], forbid: RegExp[]): Hit[] {
  const hits: Hit[] = []
  for (const f of files) {
    f.content.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(EMAIL)) if (!OK_EMAIL.test(m[0])) hits.push({ file: f.path, line: i + 1, match: m[0] })
      for (const re of forbid) {
        const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
        for (const m of line.matchAll(g)) hits.push({ file: f.path, line: i + 1, match: m[0] })
      }
    })
  }
  return hits
}

// One pattern per line; blank lines and # comments skipped. Plain words match case-insensitively as whole words.
// /regex/flags is a regex only when the flags are real ones, so a literal path like /Users/zed stays a literal.
export function readForbid(text: string): RegExp[] {
  return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
    const m = l.match(/^\/(.+)\/([dgimsuvy]*)$/)
    if (m) try { return new RegExp(m[1], m[2]) } catch {}
    return new RegExp(`(?<![\\w])${esc(l)}(?![\\w])`, 'i')
  })
}

function readDir(dir: string, base = dir, out: { path: string; content: string }[] = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (!['node_modules', '.git', '__pycache__'].includes(e.name)) readDir(p, base, out) }
    else if (e.isFile() && statSync(p).size < 2e6) out.push({ path: relative(base, p), content: readFileSync(p, 'utf8') })
  }
  return out
}

export type ExportOpts = {
  name: string; out: string; description?: string; author?: string; version?: string
  skills?: string[]; skillsDir?: string
  routines?: string[]; db?: string                 // routine names, read from this perch.db (read-only)
  instructions?: string                            // path to a markdown snippet for CLAUDE.md
  subs: [string, Var][]                            // the exporter's personal values -> placeholders
  forbid?: RegExp[]
}

// Builds the kit in memory, runs the scrub gate, and writes nothing unless it passes.
export function exportKit(o: ExportOpts): { manifest: KitManifest; files: number; hits: Hit[] } {
  if (!SAFE_NAME.test(o.name)) throw new Error(`Kit name "${o.name}" can only use letters, digits, . _ -`)
  const t = templater(o.subs)
  const files: { path: string; content: string }[] = []
  const skillsDir = o.skillsDir ?? join(homedir(), '.claude/skills')
  for (const s of o.skills ?? []) {
    if (!SAFE_NAME.test(s)) throw new Error(`Not a skill name: ${s}`)
    const dir = join(skillsDir, s)
    if (!existsSync(join(dir, 'SKILL.md'))) throw new Error(`No skill at ${dir}`)
    for (const f of readDir(dir)) files.push({ path: `skills/${s}/${f.path}`, content: t(f.content) })
  }
  const routines: KitRoutine[] = []
  if (o.routines?.length) {
    if (!o.db) throw new Error('Exporting routines needs the database path (--db)')
    const db = new DatabaseSync(o.db, { readOnly: true })
    try {
      for (const name of o.routines) {
        const r = db.prepare('select name, cron, mode, prompt from routines where name = ?').get(name) as any
        if (!r) throw new Error(`No routine named "${name}"`)
        routines.push({ name: t(r.name), cron: r.cron ?? null, mode: r.mode === 'fresh' ? 'fresh' : 'resume', prompt: t(r.prompt ?? '') })
      }
    } finally { db.close() }
    files.push({ path: 'routines.json', content: JSON.stringify(routines, null, 2) + '\n' })
  }
  if (o.instructions) files.push({ path: 'instructions.md', content: t(readFileSync(o.instructions, 'utf8')) })
  const manifest: KitManifest = {
    kit: KIT_VERSION, name: o.name, version: o.version ?? new Date().toISOString().slice(0, 10),
    description: o.description ?? '', // the author describing their own kit: not templated ...(o.author ? { author: o.author } : {}),
    skills: o.skills ?? [], routines: routines.map(r => r.name), instructions: !!o.instructions,
  }
  files.push({ path: 'kit.json', content: JSON.stringify(manifest, null, 2) + '\n' })
  // The exporter's literal values are always forbidden, on top of their own list: a value the
  // templater missed (a different spelling, inside a URL) still stops the export.
  // Partial swaps (--owner=[[Acme]]) are scoped on purpose, so the word alone may stay elsewhere.
  const literal = o.subs.map(([lit]) => lit).filter(l => !l.includes('[[')).filter(l => l && l.length >= 3).map(l => new RegExp(esc(l), 'i'))
  // The kit's name, author and description are deliberate attribution, so they're the only fields not scanned for
  // the author's own name. Emails and the forbid list still apply to the description.
  const scanned = files.map(f => f.path === 'kit.json' ? { ...f, content: JSON.stringify({ ...manifest, name: '', author: '', description: '' }, null, 2) } : f)
  const hits = [...scrubHits(scanned, [...literal, ...(o.forbid ?? [])]), ...scrubHits([{ path: 'kit.json (description)', content: manifest.description }], o.forbid ?? [])]
  if (hits.length) return { manifest, files: 0, hits }
  mkdirSync(o.out, { recursive: true })
  for (const f of files) { mkdirSync(join(o.out, f.path, '..'), { recursive: true }); writeFileSync(join(o.out, f.path), f.content) }
  if (!existsSync(join(o.out, 'README.md'))) writeFileSync(join(o.out, 'README.md'), readme(manifest))
  return { manifest, files: files.length, hits: [] }
}

function readme(m: KitManifest) {
  return `# ${m.name}\n\n${m.description}\n\nA Mothership kit. Import it from Settings → Kits, or:\n\n    node server/kitcli.ts import <this repo's git URL>\n\n` +
    `Routines arrive switched off. Placeholders such as {{owner.name}} are filled in from your own settings.\n\n` +
    (m.skills.length ? `## Skills\n\n${m.skills.map(s => `- ${s}`).join('\n')}\n\n` : '') +
    (m.routines.length ? `## Routines\n\n${m.routines.map(s => `- ${s}`).join('\n')}\n` : '')
}
