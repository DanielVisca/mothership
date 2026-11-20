import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { exportKit, readForbid, templater } from './kitexport.ts'
import * as kits from './kits.ts'
import { get } from './db.ts'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))

// The exporter's machine: two skills, a routine, a CLAUDE.md snippet, all written in their own name.
function source() {
  const home = '/Users/zed', skills = tmp('kit-src-skills-'), db = join(tmp('kit-src-db-'), 'perch.db')
  mkdirSync(join(skills, 'standup')); mkdirSync(join(skills, 'standup/refs'))
  writeFileSync(join(skills, 'standup/SKILL.md'), '---\nname: standup\n---\nWrite Zed\'s standup from repos in /Users/zed/Development.\n')
  writeFileSync(join(skills, 'standup/refs/voice.md'), 'Zed writes short lines.\n')
  mkdirSync(join(skills, 'leaky'))
  writeFileSync(join(skills, 'leaky/SKILL.md'), 'Ping zed@corp.example.net or channel C0SECRET1 when done.\n')
  const d = new DatabaseSync(db)
  d.exec('create table routines (id text primary key, name text, prompt text, cwd text, cron text, webhook_secret text, conversation_id text, mode text, enabled integer, last_run_at integer, last_status text, created_at integer)')
  d.prepare('insert into routines (id, name, prompt, cron, mode, enabled) values (?, ?, ?, ?, ?, 1)').run('r1', 'Zed standup', 'Use the standup skill for Zed. Save to /Users/zed/notes.', '15 9 * * 1-5', 'fresh')
  d.close()
  const instr = join(tmp('kit-src-i-'), 'snippet.md'); writeFileSync(instr, '# Working with Zed\nSign comments as Zed\'s agent.\n')
  const subs: [string, any][] = [['Zed', 'owner.name'], ['/Users/zed/Development', 'codeDir'], [home, 'home']]
  return { skills, db, instr, subs }
}

test('templater can swap part of a longer match', () => {
  const t = templater([['--owner=[[Acme]]', 'github.org']])
  assert.equal(t('gh search prs --owner=Acme; Acme desktop'), 'gh search prs --owner={{github.org}}; Acme desktop')
})

test('templater swaps whole words and longest paths first', () => {
  const t = templater([['Dan', 'owner.name'], ['/Users/dan', 'home'], ['/Users/dan/Development', 'codeDir']])
  assert.equal(t("Dan's PRs in /Users/dan/Development/x, notes in /Users/dan/n. Danny stays."),
    "{{owner.name}}'s PRs in {{codeDir}}/x, notes in {{home}}/n. Danny stays.")
})

test('the scrub gate writes nothing while a personal value is left', () => {
  const s = source(), out = join(tmp('kit-out-'), 'k')
  const r = exportKit({ name: 'zed', out, skills: ['standup', 'leaky'], skillsDir: s.skills, subs: s.subs, forbid: readForbid('/\\bC0[A-Z0-9]{6,}\\b/') })
  const found = new Set(r.hits.map(h => h.match))
  assert.ok(found.has('C0SECRET1') && found.has('zed@corp.example.net'), JSON.stringify(r.hits))
  assert.equal(existsSync(out), false)
})

test('export, import with your values, update, keep your edits, remove', () => {
  const s = source(), out = join(tmp('kit-out-'), 'k')
  const r = exportKit({ name: 'zed', out, skills: ['standup'], skillsDir: s.skills, routines: ['Zed standup'], db: s.db, instructions: s.instr, subs: s.subs, description: 'Zed\'s daily kit' })
  assert.deepEqual(r.hits, [])
  const md = readFileSync(join(out, 'skills/standup/SKILL.md'), 'utf8')
  assert.match(md, /\{\{owner\.name\}\}'s standup from repos in \{\{codeDir\}\}/)
  assert.doesNotMatch(readFileSync(join(out, 'routines.json'), 'utf8'), /Zed|\/Users\/zed/)

  const home = tmp('kit-home-'), paths = { skillsDir: join(home, '.claude/skills'), claudeMd: join(home, '.claude/CLAUDE.md'), codeDir: join(home, 'code') }
  mkdirSync(paths.skillsDir, { recursive: true }); writeFileSync(paths.claudeMd, '# Mine\nKeep this.\n')
  const values = { 'owner.name': 'Ana', home, codeDir: paths.codeDir }
  const k = kits.openKit(out)
  assert.deepEqual(kits.plan(k, values, paths).map(i => `${i.action} ${i.kind}:${i.name}`),
    ['add skill:standup', 'add routine:{{owner.name}} standup', 'add instructions:CLAUDE.md'])
  kits.apply(k, values, paths)
  assert.match(readFileSync(join(paths.skillsDir, 'standup/SKILL.md'), 'utf8'), new RegExp(`Write Ana's standup from repos in ${paths.codeDir}\\.`))
  assert.ok(existsSync(join(paths.skillsDir, 'standup/refs/voice.md')))
  const rt = get<any>("select * from routines where name = 'Ana standup'")
  assert.equal(rt.enabled, 0, 'imported routines arrive switched off')
  assert.equal(rt.cron, '15 9 * * 1-5')
  assert.match(rt.prompt, new RegExp(`for Ana\\. Save to ${home}/notes`))
  const claude = readFileSync(paths.claudeMd, 'utf8')
  assert.match(claude, /^# Mine\nKeep this\.\n\n<!-- mothership-kit:zed -->\n# Working with Ana/)
  assert.deepEqual(kits.plan(k, values, paths).map(i => i.action), ['unchanged', 'unchanged', 'unchanged'])

  // You edit the skill; a new kit version must not overwrite it, but untouched items update.
  writeFileSync(join(paths.skillsDir, 'standup/SKILL.md'), 'my own version\n')
  writeFileSync(join(out, 'routines.json'), readFileSync(join(out, 'routines.json'), 'utf8').replace('15 9', '30 9'))
  const items = kits.apply(kits.openKit(out), values, paths)
  assert.deepEqual(items.map(i => i.action), ['keep-yours', 'update', 'unchanged'])
  assert.equal(readFileSync(join(paths.skillsDir, 'standup/SKILL.md'), 'utf8'), 'my own version\n')
  assert.equal(get<any>('select cron from routines where id = ?', rt.id).cron, '30 9 * * 1-5')

  const gone = kits.remove('zed', paths)
  assert.deepEqual(gone.kept, ['skill:standup'])
  assert.equal(get('select 1 from routines where id = ?', rt.id), undefined)
  assert.equal(readFileSync(paths.claudeMd, 'utf8').trim(), '# Mine\nKeep this.')
  assert.equal(kits.installed().length, 0)
})

test('a kit can’t write outside its skill folder', () => {
  const dir = tmp('kit-bad-')
  writeFileSync(join(dir, 'kit.json'), JSON.stringify({ kit: 1, name: 'bad', version: '1', description: '', skills: ['../x'], routines: [], instructions: false }))
  assert.throws(() => kits.openKit(dir), /missing or badly named/)
})

test('a forbid line that is a plain path stays a literal, not a regex', () => {
  const [path, rx] = readForbid('/Users/zed\n/\\bC0[A-Z0-9]{6,}\\b/')
  assert.ok(path.test('see /Users/zed/code'))
  assert.ok(!path.test('see /Users/zedd/code'))
  assert.ok(rx.test('channel C0ABCDEF12'))
})
