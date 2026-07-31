#!/usr/bin/env node
// Testet die Scheduler-Logik von workflows/implement.workflow.js (pickNext,
// Cap-Kohärenz, tote Blocker, Zyklus-Erkennung, WAIT-Signal, withMergeLock,
// per-Issue-Budget-Deckel, Lauf-Gesamtdeckel inkl. deferredByBudget,
// Learnings-Station, needs-human, Stop nach doppeltem technischem Fehler) mit
// gemocktem agent(). Nur Node-Stdlib. Aufruf: node scripts/test-implement-workflow.mjs
//
// Harness: die Engine stellt dem Workflow-Script Globals bereit (args, log,
// agent, parallel, budget, phase) und erlaubt top-level await/return. Das wird
// hier nachgebaut: Datei lesen, den `export const meta`-Block strippen (die
// Engine liest meta selbst, AsyncFunction kennt kein export), den Rest als
// AsyncFunction mit Stub-Parametern ausführen. Der Mock-agent() entscheidet
// über opts.label und protokolliert jeden Aufruf als Sequenz für Assertions.

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const SELF = fileURLToPath(import.meta.url)
const src = readFileSync(new URL('../workflows/implement.workflow.js', import.meta.url), 'utf8')
const body = src.replace(/^export const meta[\s\S]*?\n\}\n/, '')
if (/^export /m.test(body)) throw new Error('meta-Strip fehlgeschlagen — Workflow-Kopf hat sich strukturell geändert')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const workflow = new AsyncFunction('args', 'log', 'agent', 'parallel', 'budget', 'phase', body)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Mock-Engine
// ---------------------------------------------------------------------------

// Schema-konforme Default-Antworten je Station (Happy path). Ein Test kann per
// respond(call) abweichen: Rückgabewert !== undefined ersetzt den Default,
// throw simuliert einen Agent-/Stations-Fehler.
const defaultResponse = (label) => {
  const m = label.match(/#(\d+)/)
  const n = m ? Number(m[1]) : 0
  if (label === 'preflight') return { clean: true }
  if (/^build /.test(label)) return { pr: 100 + n, branch: `feat/${n}-x`, skipped: false }
  if (/^ac-verify/.test(label)) return { pass: true, unmet: [] }
  if (/^security/.test(label)) return { blockers: [] }
  if (/^gate-wait /.test(label)) return { green: true }
  if (/^gate-merge /.test(label)) return { merged: true, postMergeGreen: true }
  return {} // plan, fix*, cleanup, needs-human, budget-abort: Ergebnis ungenutzt
}

// Führt den Workflow mit Stubs aus. Liefert Report + Aufrufprotokoll: jeder
// agent()-Aufruf bekommt startSeq (vor dem Handler) und endSeq (nach dem
// Handler) aus einem gemeinsamen Zähler — damit sind Reihenfolge UND
// Überlappung von Stationen assertierbar.
async function runWorkflow({ units, config, budget, respond } = {}) {
  const calls = []
  const logs = []
  let seq = 0
  const agent = async (prompt, opts = {}) => {
    const label = (opts && opts.label) || ''
    const call = { label, prompt, opts, startSeq: seq++, endSeq: -1 }
    calls.push(call)
    let res = respond ? await respond(call) : undefined
    if (res === undefined) res = defaultResponse(label)
    call.endSeq = seq++
    return res
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => t()))
  const b = budget !== undefined ? budget : { spent: () => 0 }
  const report = await workflow({ config, units }, (m) => logs.push(String(m)), agent, parallel, b, () => {})
  return { report, calls, logs }
}

// Minimal-CONFIG mit allen Pflichtfeldern aus den Guards am Dateianfang
// (repoSlug, commands.test/lint, budgets S/M/L mit tokens).
const cfg = (over = {}) => ({
  repoSlug: 'acme/demo',
  defaultBranch: 'main',
  commands: { test: 'npm test', lint: 'npm run lint' },
  budgets: { S: { turns: 20, tokens: 1000000 }, M: { turns: 40, tokens: 1000000 }, L: { turns: 60, tokens: 2000000 } },
  parallelism: 1,
  caps: { issuesPerRun: 10, maxParallel: 4 },
  ...over,
})

const unit = (n, extra = {}) => ({ n, lane: 'feature', size: 'S', ...extra })

// ---------------------------------------------------------------------------
// Assertion-Helfer
// ---------------------------------------------------------------------------

const find = (calls, label) => calls.filter((c) => c.label === label)
const only = (calls, label) => {
  const f = find(calls, label)
  assert.equal(f.length, 1, `erwartet genau 1x "${label}", war ${f.length}x`)
  return f[0]
}
const none = (calls, re) => {
  const hit = calls.find((c) => re.test(c.label))
  assert.ok(!hit, `unerwarteter Aufruf: "${hit && hit.label}" (verboten: ${re})`)
}
const doneOf = (report, n) => {
  const d = report.done.find((x) => x.issue === n)
  assert.ok(d, `done-Eintrag für #${n} fehlt (done=${JSON.stringify(report.done)})`)
  return d
}

// ---------------------------------------------------------------------------
// Zyklus-Szenario läuft in einem Kind-Prozess: nur ein Prozess-Kill fängt auch
// eine synchrone Endlosschleife in pickNext ab — ein In-Process-Timeout käme
// bei blockiertem Event-Loop nie zum Zug.
// ---------------------------------------------------------------------------

const cycleScenario = () =>
  runWorkflow({ units: [unit(1, { blockedBy: [2] }), unit(2, { blockedBy: [1] })], config: cfg() })

if (process.argv[2] === '--child-cycle') {
  const { report } = await cycleScenario()
  process.stdout.write(JSON.stringify(report))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Testfälle
// ---------------------------------------------------------------------------

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// 1. Happy path: zwei Einheiten seriell, beide merged, Report konsistent.
test('Happy path: 2 Einheiten, parallelism 1 — beide merged, done korrekt', async () => {
  const { report, calls } = await runWorkflow({ units: [unit(1), unit(2)], config: cfg() })
  assert.equal(report.stopped, null)
  assert.deepEqual(report.failed, [])
  assert.deepEqual(report.blocked, [])
  assert.deepEqual(report.remaining, [])
  assert.equal(report.parallelism, 1)
  assert.equal(report.tokenMode, 'delta')
  assert.equal(report.done.length, 2)
  const d1 = doneOf(report, 1)
  const d2 = doneOf(report, 2)
  assert.equal(d1.pr, 101)
  assert.equal(d2.pr, 102)
  assert.equal(d1.fixRounds, 0)
  assert.equal(d1.postMergeRed, false)
  only(calls, 'preflight')
  // parallelism 1: Einheit 2 startet erst nach dem Merge von Einheit 1
  assert.ok(only(calls, 'gate-merge #1').endSeq < only(calls, 'plan #2').startSeq,
    'Einheit 2 lief vor Abschluss von Einheit 1 an')
})

// 2. Cap-Kohärenz: der Cap schneidet Blocker #3 weg — sein Abhängiger #2 wird
//    mit zurückgestellt (weder gestartet noch als blocked gemeldet).
test('Cap-Kohärenz: Abhängiger eines weggeschnittenen Blockers wird mit zurückgestellt', async () => {
  const { report, calls, logs } = await runWorkflow({
    units: [unit(1), unit(2, { blockedBy: [3] }), unit(3)],
    config: cfg({ caps: { issuesPerRun: 2, maxParallel: 4 } }),
  })
  assert.deepEqual(report.done.map((d) => d.issue), [1])
  assert.deepEqual(report.blocked, [], '#2 ist nur vertagt, nicht blocked')
  assert.deepEqual(report.remaining, [])
  assert.equal(report.stopped, null)
  none(calls, /#(2|3)\b/)
  assert.ok(logs.some((l) => /zurückgestellt/.test(l)), 'LOG über zurückgestellte Einheiten fehlt')
})

// 3. Gescheiterter Blocker tötet Abhängige: #1 verfehlt die ACs dauerhaft
//    (GATE-Fehler nach maxFixRounds), #2 landet in blocked — ohne Requeue.
test('Gescheiterter Blocker: Abhängiger landet in blocked, kein Requeue', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2, { blockedBy: [1] })],
    config: cfg(),
    respond: (c) => (/^ac-verify(\+\d+)? #1$/.test(c.label) ? { pass: false, unmet: ['AC nie erfüllt'] } : undefined),
  })
  const d1 = doneOf(report, 1)
  assert.equal(d1.needsHuman, true)
  assert.ok(d1.note.startsWith('GATE:'))
  only(calls, 'needs-human #1')
  assert.equal(find(calls, 'build #1').length, 1, 'GATE-Fehler darf kein Requeue auslösen')
  assert.deepEqual(report.blocked, [{ n: 2, by: [1] }])
  none(calls, /#2\b/)
  assert.equal(report.stopped, null, 'ein needs-human stoppt den Lauf nicht')
  assert.deepEqual(report.failed, [])
})

// 4. Dependency-Zyklus: A blockedBy B, B blockedBy A — beide blocked, Lauf
//    endet sauber. Kind-Prozess mit Kill-Timeout sichert gegen Hängen ab.
test('Dependency-Zyklus: beide Einheiten blocked, kein Hängen', async () => {
  const out = execFileSync(process.execPath, [SELF, '--child-cycle'], { timeout: 15000, encoding: 'utf8' })
  const report = JSON.parse(out)
  assert.deepEqual(report.done, [])
  assert.deepEqual(report.blocked.map((b) => b.n).sort(), [1, 2])
  assert.deepEqual(report.blocked.find((b) => b.n === 1).by, [2])
  assert.deepEqual(report.blocked.find((b) => b.n === 2).by, [1])
  assert.equal(report.stopped, null)
  assert.deepEqual(report.remaining, [])
})

// 5. WAIT-Signal: parallelism 2, #2 und #3 blockedBy #1 — der zweite Worker
//    schläft bis zur Fertigmeldung von #1 (kein Busy-Loop, kein Selbst-Beenden)
//    und startet danach parallel zum ersten: die Builds von #2 und #3 müssen
//    überlappen. Ein Worker, der statt WAIT einfach ausstiege, ließe #2/#3
//    seriell laufen — genau das deckt die Overlap-Assertion auf.
test('WAIT-Signal: Abhängige starten erst nach dem Blocker, dann wieder parallel', async () => {
  let buildActive = 0, buildMax = 0
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2, { blockedBy: [1] }), unit(3, { blockedBy: [1] })],
    config: cfg({ parallelism: 2 }),
    respond: async (c) => {
      if (c.label === 'build #2' || c.label === 'build #3') {
        buildActive += 1; buildMax = Math.max(buildMax, buildActive)
        await sleep(30)
        buildActive -= 1
      }
      return undefined
    },
  })
  assert.equal(report.done.length, 3)
  assert.deepEqual(report.blocked, [])
  assert.equal(find(calls, 'plan #2').length, 1, 'Einheit 2 darf nur einmal anlaufen (kein Busy-Loop-Mehrfachstart)')
  const mergedAt = only(calls, 'gate-merge #1').endSeq
  assert.ok(mergedAt < only(calls, 'plan #2').startSeq, 'Einheit 2 lief an, bevor Blocker 1 gemergt war')
  assert.ok(mergedAt < only(calls, 'plan #3').startSeq, 'Einheit 3 lief an, bevor Blocker 1 gemergt war')
  assert.equal(buildMax, 2, 'nach dem Aufwachen muss der wartende Worker wieder mitarbeiten (Builds von #2/#3 überlappen)')
})

// 6. Merge-Lock serialisiert NUR den Merge: gate-wait zweier Einheiten darf
//    überlappen (Gate-Split, Issue #9), gate-merge nie.
test('Merge-Lock: gate-merge nie überlappend, gate-wait parallel', async () => {
  let waitActive = 0, waitMax = 0, mergeActive = 0, mergeMax = 0
  const { report } = await runWorkflow({
    units: [unit(1), unit(2)],
    config: cfg({ parallelism: 2 }),
    respond: async (c) => {
      if (/^gate-wait /.test(c.label)) {
        waitActive += 1; waitMax = Math.max(waitMax, waitActive)
        await sleep(40)
        waitActive -= 1
        return { green: true }
      }
      if (/^gate-merge /.test(c.label)) {
        mergeActive += 1; mergeMax = Math.max(mergeMax, mergeActive)
        await sleep(30)
        mergeActive -= 1
        return { merged: true, postMergeGreen: true }
      }
      return undefined
    },
  })
  assert.equal(report.done.length, 2)
  assert.equal(mergeMax, 1, 'gate-merge lief überlappend — Merge-Lock wirkungslos')
  assert.equal(waitMax, 2, 'gate-wait lief nicht parallel — der Gate-Split (Wait außerhalb des Locks) wirkt nicht')
  // parallelism > 1: kein per-Einheit-Deckel (globales Delta ist nicht attribuierbar),
  // stattdessen der Lauf-Gesamtdeckel — 'off' gilt nur noch ohne budget-API.
  assert.equal(report.tokenMode, 'run', 'bei parallelism 2 muss der Lauf-Gesamtdeckel greifen')
  assert.equal(report.runCap, Math.round((1000000 + 1000000) * 1.2), 'runCap = Σ Einheiten-Budgets × runBudgetFactor')
})

// 7. Budget-Abbruch: budget.spent() springt nach dem Build über den Deckel —
//    Einheit endet budgetExceeded, zählt als unresolved (Abhängiger stirbt),
//    der Lauf fährt mit unabhängigen Einheiten fort.
test('Budget-Abbruch: budgetExceeded, Abhängiger stirbt, Lauf geht weiter', async () => {
  const state = { tokens: 0 }
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2, { blockedBy: [1] }), unit(3)],
    config: cfg({ budgets: { S: { turns: 20, tokens: 1000 }, M: { turns: 40, tokens: 1000 }, L: { turns: 60, tokens: 1000 } } }),
    budget: { spent: () => state.tokens },
    respond: (c) => { if (c.label === 'build #1') state.tokens += 5000 },
  })
  assert.equal(report.tokenMode, 'delta')
  const d1 = doneOf(report, 1)
  assert.equal(d1.budgetExceeded, true)
  assert.equal(d1.tokens, 5000)
  only(calls, 'budget-abort #1')
  none(calls, /^ac-verify(\+\d+)? #1$/) // Abbruch direkt nach dem Build, vor dem Verifier
  assert.deepEqual(report.blocked, [{ n: 2, by: [1] }], 'budgetExceeded ist keine Erledigung — #2 muss sterben')
  assert.equal(doneOf(report, 3).pr, 103, 'unabhängige Einheit #3 muss trotzdem durchlaufen')
  assert.equal(report.stopped, null)
})

// 7b. Lauf-Gesamtdeckel (parallelism > 1): nach der ersten Einheit ist die Summe
//     der Einheiten-Budgets × runBudgetFactor überschritten — die zweite Einheit
//     darf gar nicht mehr anlaufen und landet in deferredByBudget. #2 hängt
//     bewusst an #1 (blockedBy), sonst hätte der zweite Worker sie schon vor dem
//     ersten verbrauchten Token gezogen.
test('Lauf-Gesamtdeckel: zweite Einheit wird nie gestartet, landet in deferredByBudget', async () => {
  const state = { tokens: 0 }
  const { report, calls, logs } = await runWorkflow({
    units: [unit(1), unit(2, { blockedBy: [1] })],
    config: cfg({
      parallelism: 2,
      runBudgetFactor: 1.2,
      budgets: { S: { turns: 20, tokens: 1000 }, M: { turns: 40, tokens: 1000 }, L: { turns: 60, tokens: 1000 } },
    }),
    budget: { spent: () => state.tokens },
    respond: (c) => { if (c.label === 'build #1') state.tokens += 5000 },
  })
  assert.equal(report.tokenMode, 'run')
  assert.equal(report.runCap, 2400, 'runCap = (1000 + 1000) × 1.2')
  // #1 läuft trotz 5000 verbrauchter Tokens regulär durch: bei parallelism > 1 gibt
  // es KEINEN per-Einheit-Deckel, und der Lauf-Deckel bricht nichts Laufendes ab.
  assert.equal(doneOf(report, 1).pr, 101)
  none(calls, /^budget-abort /)
  assert.deepEqual(report.deferredByBudget, [2])
  none(calls, /#2\b/)
  assert.deepEqual(report.remaining, [], 'zurückgestellte Einheiten stehen in deferredByBudget, nicht in remaining')
  assert.deepEqual(report.blocked, [], 'Budget-Zurückstellung ist keine Blockade')
  assert.deepEqual(report.failed, [])
  assert.equal(report.stopped, null, 'der Lauf endet regulär, nicht als Stop')
  assert.ok(logs.some((l) => /Lauf-Gesamtdeckel überschritten/.test(l)), 'LOG-Meldung zum Lauf-Deckel fehlt')
})

// 7c. Gegenprobe: unterhalb des Lauf-Deckels läuft alles wie bisher durch.
test('Lauf-Gesamtdeckel: unterhalb des Deckels wird nichts zurückgestellt', async () => {
  const state = { tokens: 0 }
  const { report } = await runWorkflow({
    units: [unit(1), unit(2, { blockedBy: [1] })],
    config: cfg({ parallelism: 2, budgets: { S: { turns: 20, tokens: 100000 }, M: { turns: 40, tokens: 100000 }, L: { turns: 60, tokens: 100000 } } }),
    budget: { spent: () => state.tokens },
    respond: (c) => { if (c.label === 'build #1') state.tokens += 5000 },
  })
  assert.deepEqual(report.deferredByBudget, [])
  assert.equal(report.done.length, 2)
  assert.equal(report.stopped, null)
})

// 7d. Fehlkonfiguration darf den Lauf-Deckel nicht STILL abschalten (ein
//     NaN-Vergleich wäre immer false) — sie muss sofort und laut abbrechen.
test('runBudgetFactor: unbrauchbarer Wert bricht ab statt still zu deaktivieren', async () => {
  await assert.rejects(
    () => runWorkflow({ units: [unit(1)], config: cfg({ runBudgetFactor: 'viel' }) }),
    /runBudgetFactor muss eine positive Zahl sein/,
  )
})

// 8. needs-human-Pfad: GATE-Fehler → needs-human-Agent, Einheit in done mit
//    needsHuman:true, der Lauf fährt mit der nächsten Einheit fort.
test('needs-human: GATE-Fehler stoppt die Einheit, nicht den Lauf', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2)],
    config: cfg(),
    respond: (c) => (/^ac-verify(\+\d+)? #1$/.test(c.label) ? { pass: false, unmet: ['AC offen'] } : undefined),
  })
  only(calls, 'needs-human #1')
  const d1 = doneOf(report, 1)
  assert.equal(d1.needsHuman, true)
  assert.ok(d1.note.startsWith('GATE:'))
  // maxFixRounds=3: 3 Fix-Runden (ab Runde 2 eskaliert), 4 Verifier-Läufe
  assert.equal(calls.filter((c) => /^fix\d+ #1/.test(c.label)).length, 3)
  assert.equal(calls.filter((c) => /^ac-verify(\+\d+)? #1$/.test(c.label)).length, 4)
  assert.equal(doneOf(report, 2).pr, 102, 'der Lauf muss nach needs-human weiterfahren')
  assert.equal(report.stopped, null)
})

// 9. Technischer Doppel-Fehler stoppt den Lauf: build wirft zweimal ohne
//    GATE-Präfix → ein Requeue-Versuch, dann stopped + failed.
test('Technischer Doppel-Fehler: ein Requeue, dann Stop mit failed', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2)],
    config: cfg(),
    respond: (c) => { if (c.label === 'build #1') throw new Error('kaboom: Netz weg') },
  })
  assert.equal(find(calls, 'build #1').length, 2, 'genau ein Requeue-Versuch erwartet')
  assert.equal(find(calls, 'cleanup #1').length, 2, 'Cleanup gehört zu jedem Fehlversuch')
  assert.ok(report.stopped && report.stopped.issue === 1)
  assert.ok(/kaboom/.test(report.stopped.reason))
  assert.deepEqual(report.failed, [1])
  assert.ok(!report.done.some((d) => d.issue === 1))
  assert.equal(doneOf(report, 2).pr, 102, 'zwischen den Versuchen lief #2 regulär durch')
  none(calls, /^needs-human /)
})

// Zusatz: skipped-Pfad — ein bereits erledigtes Issue zählt als Erledigung
// und gibt seine Abhängigen frei (doneOk, nicht unresolved).
test('skipped: bereits erledigter Blocker gibt Abhängige frei', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2, { blockedBy: [1] })],
    config: cfg(),
    respond: (c) => (c.label === 'build #1' ? { pr: 0, branch: '', skipped: true, note: 'bereits gemergt' } : undefined),
  })
  assert.equal(doneOf(report, 1).skipped, true)
  none(calls, /^(ac-verify|gate-wait|gate-merge)(\+\d+)? #1$/)
  assert.equal(doneOf(report, 2).pr, 102, 'skip des Blockers muss #2 freigeben')
  assert.deepEqual(report.blocked, [])
})

// Zusatz: Area-Serialisierung als Optimierung — bei parallelism 2 bevorzugt
// der zweite Worker eine fremde Area gegenüber der bereits laufenden.
test('Area-Präferenz: zweiter Worker weicht auf fremde Area aus', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1, { area: 'api' }), unit(2, { area: 'api' }), unit(3, { area: 'web' })],
    config: cfg({ parallelism: 2 }),
  })
  assert.equal(report.done.length, 3)
  assert.ok(only(calls, 'plan #3').startSeq < only(calls, 'plan #2').startSeq,
    'Worker 2 hätte #3 (area web) vor #2 (area api, in flight) ziehen müssen')
})

// Zusatz: Learnings-Station läuft NACH dem Post-Merge-Cleanup und ist
// best-effort — ihr Wurf darf einen gemergten, gh-verifizierten Erfolg nicht in
// einen Fehler umdeuten (sonst würde die Einheit requeued und alles ein zweites
// Mal gebaut).
test('Learnings: Station nach Merge/Cleanup, ihr Fehler kippt den Einheit-Erfolg nicht', async () => {
  const { report, calls, logs } = await runWorkflow({
    units: [unit(1, { area: 'api' }), unit(2)],
    config: cfg(),
    respond: (c) => { if (c.label === 'learnings #1') throw new Error('haiku weg') },
  })
  const l1 = only(calls, 'learnings #1')
  assert.equal(l1.opts.model, 'haiku')
  assert.ok(only(calls, 'gate-merge #1').endSeq < l1.startSeq, 'Learnings dürfen erst nach dem Merge laufen')
  assert.ok(only(calls, 'cleanup #1').endSeq < l1.startSeq, 'Learnings laufen NACH dem Post-Merge-Cleanup')
  assert.ok(/\.flowkit\/learnings\//.test(l1.prompt), 'Zielpfad fehlt im Learnings-Prompt')
  // Erfolg trotz geworfener Station: kein Requeue, kein needs-human, kein Stop.
  const d1 = doneOf(report, 1)
  assert.equal(d1.pr, 101)
  assert.ok(!d1.needsHuman)
  assert.equal(find(calls, 'build #1').length, 1, 'ein Wurf der Learnings-Station darf kein Requeue auslösen')
  assert.equal(report.stopped, null)
  assert.deepEqual(report.failed, [])
  assert.equal(doneOf(report, 2).pr, 102)
  assert.ok(logs.some((l) => /Learnings-Destillat übersprungen/.test(l)), 'LOG zum übersprungenen Destillat fehlt')
  // Gegenstück: Planner und Builder lesen die jüngsten Destillate, Area zuerst.
  const p1 = only(calls, 'plan #1')
  assert.ok(/ls -t \.flowkit\/learnings/.test(p1.prompt), 'Planner liest die Learnings nicht')
  assert.ok(/area: api/.test(p1.prompt), 'Area-Präferenz fehlt im Planner-Prompt')
  assert.ok(/ls -t \.flowkit\/learnings/.test(only(calls, 'build #1').prompt), 'Builder liest die Learnings nicht')
})

// Zusatz: learnings=false schaltet Station UND Lese-Schritt ab (kein halber Zustand).
test('Learnings: learnings=false schaltet Station und Lese-Schritt ab', async () => {
  const { report, calls } = await runWorkflow({ units: [unit(1)], config: cfg({ learnings: false }) })
  assert.equal(doneOf(report, 1).pr, 101)
  none(calls, /^learnings /)
  assert.ok(!/\.flowkit\/learnings/.test(only(calls, 'plan #1').prompt))
  assert.ok(!/\.flowkit\/learnings/.test(only(calls, 'build #1').prompt))
})

// ---------------------------------------------------------------------------
// Runner (Ausgabemuster wie scripts/test-cleanup-worktrees.sh)
// ---------------------------------------------------------------------------

const withTimeout = (p, ms) => {
  let t
  return Promise.race([
    p,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`Timeout nach ${ms}ms — Scheduler hängt`)), ms) }),
  ]).finally(() => clearTimeout(t))
}

let fails = 0
for (const { name, fn } of tests) {
  try {
    await withTimeout(fn(), 20000)
    console.log(`ok:   ${name}`)
  } catch (e) {
    fails += 1
    console.log(`FAIL: ${name}`)
    console.log(`      ${(e && e.message ? e.message : String(e)).split('\n').join('\n      ')}`)
  }
}

console.log('')
if (fails === 0) {
  console.log(`ALLE TESTS GRÜN (${tests.length})`)
} else {
  console.log(`${fails} TEST(S) ROT`)
  process.exit(1)
}
