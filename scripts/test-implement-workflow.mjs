#!/usr/bin/env node
// Testet die Scheduler-Logik von workflows/implement.workflow.js (pickNext,
// Cap-Kohärenz, tote Blocker, Zyklus-Erkennung, WAIT-Signal, withMergeLock,
// per-Issue-Budget-Deckel, Lauf-Gesamtdeckel inkl. deferredByBudget,
// Learnings-Station, needs-human, Stop nach doppeltem technischem Fehler,
// PR-Check-Station gegen den Weltzustand, Fortschritts-Circuit-Breaker,
// Allowlist-taugliche Quotierung der Plugin-Script-Pfade) mit
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
  // Deckungsgleich mit dem build-Default: die PR-Nummer der Folgestationen kommt
  // seit 0.8.0 aus dem gh-Befund, nicht aus dem Builder-Return.
  if (/^pr-check /.test(label)) return { found: true, pr: 100 + n, branch: `feat/${n}-x`, state: 'OPEN' }
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
async function runWorkflow({ units, config, budget, respond, pluginRoot } = {}) {
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
  const report = await workflow({ config, units, pluginRoot }, (m) => logs.push(String(m)), agent, parallel, b, () => {})
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
// und gibt seine Abhängigen frei (doneOk, nicht unresolved). Seit 0.8.0 nur noch
// MIT gh-Beleg: der pr-check muss einen GEMERGTEN PR ausweisen.
test('skipped: bereits erledigter Blocker gibt Abhängige frei', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2, { blockedBy: [1] })],
    config: cfg(),
    respond: (c) => {
      if (c.label === 'build #1') return { pr: 0, branch: '', skipped: true, note: 'bereits gemergt' }
      if (c.label === 'pr-check #1') return { found: true, pr: 181, branch: 'feat/1-x', state: 'MERGED' }
      return undefined
    },
  })
  assert.equal(doneOf(report, 1).skipped, true)
  assert.equal(doneOf(report, 1).pr, 181, 'die Nummer des gemergten PR kommt aus dem gh-Befund')
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
// PR-Check-Station: der Weltzustand auf GitHub schlägt den Builder-Return
// (Issue #31, löst #33)
// ---------------------------------------------------------------------------

// 10. Der Builder meldet pr:0 (klassischer Befund bei ausgefallenem
//     Permission-Classifier) — gh kennt den PR trotzdem. Ab hier zählt nur gh:
//     Nummer UND Branch der Folgestationen kommen aus dem Befund.
test('pr-check: die PR-Nummer kommt von gh, ein Builder-pr:0 wird geheilt', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => {
      if (c.label === 'build #1') return { pr: 0, branch: '', skipped: false }
      if (c.label === 'pr-check #1') return { found: true, pr: 581, branch: 'feat/1-gh', state: 'OPEN' }
      return undefined
    },
  })
  const chk = only(calls, 'pr-check #1')
  assert.equal(chk.opts.model, 'haiku', 'die Station ist mechanisch — haiku genügt')
  assert.ok(only(calls, 'build #1').endSeq < chk.startSeq, 'der pr-check läuft NACH dem Builder')
  assert.ok(chk.prompt.includes('gh pr list -R acme/demo --search "Closes #1" --state all'),
    'der pr-check muss gh mit --state all befragen')
  assert.ok(!/\bpr:\s*0\b/.test(chk.prompt) && !chk.prompt.includes('581'),
    'die Behauptung des Builders darf NICHT im Prompt stehen (sonst ist Nachplappern nicht von Prüfen unterscheidbar)')
  assert.equal(doneOf(report, 1).pr, 581, 'die PR-Nummer stammt aus dem gh-Befund, nicht aus dem Builder-Return')
  const ac = only(calls, 'ac-verify #1')
  assert.ok(/gh pr view 581/.test(ac.prompt) && /gh pr diff 581/.test(ac.prompt),
    'der AC-Verifier muss auf den gh-verifizierten PR zeigen')
  assert.ok(only(calls, 'gate-wait #1').prompt.includes('feat/1-gh'),
    'der Branch der Gate-Stationen kommt aus dem gh-Befund (headRefName)')
  none(calls, /^needs-human /)
  assert.equal(report.stopped, null)
})

// 11. Kernbefund des Issues: der Builder BEHAUPTET einen PR, gh kennt keinen.
//     Das ist ein technischer Fehler (Requeue, dann Stop) — kein stiller Erfolg
//     und kein inhaltliches needs-human.
test('pr-check: kein PR auf GitHub = technischer Fehler, kein stiller Erfolg', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => (/^pr-check /.test(c.label)
      ? { found: false, pr: 0, branch: '', state: 'NONE', note: 'gh nicht ausführbar: classifier unavailable' }
      : undefined),
  })
  none(calls, /^ac-verify/)
  none(calls, /^gate-(wait|merge) /)
  none(calls, /^needs-human /)
  assert.equal(find(calls, 'build #1').length, 2, 'ein Requeue, dann Stop')
  assert.equal(find(calls, 'cleanup #1').length, 2, 'Cleanup gehört zu jedem Fehlversuch')
  assert.deepEqual(report.failed, [1])
  assert.ok(/Kein PR zu Issue #1/.test(report.stopped.reason), `Stop-Grund war: ${report.stopped.reason}`)
  assert.ok(/classifier unavailable/.test(report.stopped.reason), 'der gh-Befund gehört wörtlich in den Bericht')
  assert.ok(!report.done.some((d) => d.issue === 1), 'eine Einheit ohne PR darf nie in done landen')
})

// 12. Ein behauptetes "skipped" ist die teuerste Falschmeldung: die Einheit gilt
//     als erledigt UND gibt Abhängige frei. Ohne gemergten PR bei gh: Fehler.
test('pr-check: "skipped" ohne gemergten PR wird nicht als Erledigung verbucht', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2, { blockedBy: [1] })],
    config: cfg(),
    respond: (c) => {
      if (c.label === 'build #1') return { pr: 0, branch: '', skipped: true, note: 'sieht erledigt aus' }
      if (c.label === 'pr-check #1') return { found: false, pr: 0, branch: '', state: 'NONE', note: 'kein Treffer' }
      return undefined
    },
  })
  assert.ok(!report.done.some((d) => d.issue === 1 && d.skipped), 'unbelegtes skipped darf keine Erledigung sein')
  assert.deepEqual(report.failed, [1])
  assert.ok(/keinen gemergten PR/.test(report.stopped.reason), `Stop-Grund war: ${report.stopped.reason}`)
  none(calls, /#2\b/)
  assert.deepEqual(report.remaining, [2], '#2 darf nicht durch ein unbelegtes skipped freigegeben werden')
})

// 13. Belegtes skipped bei skipped=false: der Builder hat gebaut, gh sagt
//     "schon gemergt" (fremder Merge dazwischen). Kein zweiter Merge-Versuch,
//     aber eine echte Erledigung — Abhängige werden frei.
test('pr-check: gh meldet MERGED — Einheit endet als Erledigung ohne Merge-Versuch', async () => {
  const { report, calls, logs } = await runWorkflow({
    units: [unit(1), unit(2, { blockedBy: [1] })],
    config: cfg(),
    respond: (c) => (c.label === 'pr-check #1'
      ? { found: true, pr: 191, branch: 'feat/1-x', state: 'MERGED', note: 'war schon gemergt' }
      : undefined),
  })
  const d1 = doneOf(report, 1)
  assert.equal(d1.skipped, true)
  assert.equal(d1.pr, 191)
  none(calls, /^(ac-verify|gate-wait|gate-merge)(\+\d+)? #1$/)
  assert.equal(doneOf(report, 2).pr, 102, 'eine gh-belegte Erledigung gibt Abhängige frei')
  assert.ok(logs.some((l) => /bereits gemergt/.test(l)), 'LOG zum bereits gemergten PR fehlt')
  assert.equal(report.stopped, null)
})

// 14. Existenz ist nicht Verwertbarkeit: ein CLOSED-PR und ein Befund ohne
//     Branchnamen dürfen die Folgestationen nicht erreichen (sonst liefe
//     `git worktree add <tmp>` mit leerem Argument bzw. auf totem PR).
test('pr-check: CLOSED und leerer Branch sind kein verwertbarer Befund', async () => {
  const closed = await runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => (/^pr-check /.test(c.label) ? { found: true, pr: 77, branch: 'feat/1-x', state: 'CLOSED' } : undefined),
  })
  none(closed.calls, /^ac-verify/)
  assert.deepEqual(closed.report.failed, [1])
  assert.ok(/ist CLOSED, nicht OPEN/.test(closed.report.stopped.reason), `Stop-Grund war: ${closed.report.stopped.reason}`)

  const noBranch = await runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => (/^pr-check /.test(c.label) ? { found: true, pr: 77, branch: '', state: 'OPEN' } : undefined),
  })
  none(noBranch.calls, /^ac-verify/)
  assert.deepEqual(noBranch.report.failed, [1])
  assert.ok(/Kein PR zu Issue #1/.test(noBranch.report.stopped.reason), `Stop-Grund war: ${noBranch.report.stopped.reason}`)
})

// 15. Reihenfolge: der Budgetcheck läuft VOR der Station. Ein Builder, der sein
//     Budget sprengt, hat typischerweise noch keinen PR — liefe der pr-check
//     zuerst, würde aus einem sauberen budgetExceeded ein technischer Fehler.
test('pr-check: Budget-Abbruch nach dem Build spart die Station und nennt keine PR-Nummer', async () => {
  const state = { tokens: 0 }
  const { report, calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg({ budgets: { S: { turns: 20, tokens: 1000 }, M: { turns: 40, tokens: 1000 }, L: { turns: 60, tokens: 1000 } } }),
    budget: { spent: () => state.tokens },
    respond: (c) => { if (c.label === 'build #1') state.tokens += 5000 },
  })
  assert.equal(doneOf(report, 1).budgetExceeded, true)
  none(calls, /^pr-check /)
  const abort = only(calls, 'budget-abort #1')
  assert.ok(/Stand: nach Build\./.test(abort.prompt), 'der Stand-Text lautet schlicht "nach Build"')
  assert.ok(!/PR #\d+ offen/.test(abort.prompt),
    'die (unverifizierte) PR-Nummer des Builders gehört nicht in den Abbruchkommentar — der Prompt ermittelt sie selbst per gh')
  assert.equal(report.stopped, null)
})

// ---------------------------------------------------------------------------
// Fortschritts-Circuit-Breaker (Issue #31)
// ---------------------------------------------------------------------------

// 16. needs-human stoppt einzeln nie den Lauf — eine SERIE schon.
test('Circuit-Breaker: drei Einheiten in Folge ohne Merge halten den Lauf an', async () => {
  const { report, calls, logs } = await runWorkflow({
    units: [unit(1), unit(2), unit(3), unit(4)],
    config: cfg(),
    respond: (c) => (/^ac-verify/.test(c.label) ? { pass: false, unmet: ['AC offen'] } : undefined),
  })
  assert.ok(report.stopped, 'der Lauf muss anhalten')
  assert.equal(report.stopped.issue, 3)
  assert.ok(/Fortschritts-Circuit-Breaker/.test(report.stopped.reason), `Stop-Grund war: ${report.stopped.reason}`)
  assert.deepEqual(report.remaining, [4])
  none(calls, /#4\b/)
  assert.equal(report.done.length, 3)
  assert.ok(logs.some((l) => /ohne Fortschritt/.test(l)), 'LOG zum Breaker fehlt')
})

// 17. Reset-Semantik: ein Merge dazwischen setzt den Zähler zurück — dass #4 und
//     #5 überhaupt noch anlaufen, ist nur damit erklärbar.
test('Circuit-Breaker: ein Merge setzt den Zähler zurück', async () => {
  const fails = new Set([1, 2, 4, 5, 6])
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2), unit(3), unit(4), unit(5), unit(6), unit(7)],
    config: cfg(),
    respond: (c) => {
      const m = /^ac-verify(\+\d+)? #(\d+)$/.exec(c.label)
      if (m && fails.has(Number(m[2]))) return { pass: false, unmet: ['AC offen'] }
      return undefined
    },
  })
  assert.equal(doneOf(report, 3).pr, 103, 'der Merge dazwischen')
  assert.equal(doneOf(report, 4).needsHuman, true, 'ohne Reset hätte der Breaker schon bei #4 gefeuert')
  assert.equal(doneOf(report, 5).needsHuman, true)
  assert.equal(report.stopped.issue, 6)
  assert.ok(/Fortschritts-Circuit-Breaker/.test(report.stopped.reason), `Stop-Grund war: ${report.stopped.reason}`)
  assert.deepEqual(report.remaining, [7])
  none(calls, /#7\b/)
})

// 18. Der auslösende Vorfall: technische Fehler hängen die Einheit ans
//     QUEUE-ENDE, die alte Doppelfehler-Regel greift bei langen Queues also erst
//     nach einem kompletten Durchlauf. Der Breaker fängt das vorher ab.
test('Circuit-Breaker: reihenweise technische Fehler stoppen, statt die Queue leerzubrennen', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2), unit(3), unit(4)],
    config: cfg(),
    respond: (c) => { if (/^build /.test(c.label)) throw new Error('Bash-Classifier nicht verfügbar') },
  })
  assert.equal(find(calls, 'build #1').length, 1, 'kein zweiter Anlauf mehr — der Breaker greift vorher')
  none(calls, /#4\b/)
  assert.equal(report.stopped.issue, 3)
  assert.ok(/Fortschritts-Circuit-Breaker/.test(report.stopped.reason), `Stop-Grund war: ${report.stopped.reason}`)
  assert.deepEqual(report.failed, [], 'kein zweiter Fehler derselben Einheit — nichts ist endgültig gescheitert')
  assert.deepEqual(report.remaining, [4, 1, 2, 3], 'die requeuten Einheiten stehen hinten in der Queue')
})

// 19. Fehlkonfiguration darf den Breaker nicht STILL abschalten (ein String wie
//     "3" ergäbe in noProgress >= "3" ein anderes Verhalten).
test('progressStopAfter: unbrauchbarer Wert bricht ab statt still zu deaktivieren', async () => {
  await assert.rejects(
    () => runWorkflow({ units: [unit(1)], config: cfg({ progressStopAfter: 'drei' }) }),
    /progressStopAfter muss eine ganze Zahl/,
  )
})

// 20. Zusage "0 schaltet den Breaker ab" — geprüft als PAAR gegen denselben
//     Ablauf mit Default 3. Ohne die Gegenprobe wäre der 0-Fall vakuum-grün
//     (ein Runner ganz ohne Breaker stoppt auch nie).
test('progressStopAfter: 0 schaltet den Breaker ab (Paarprobe gegen Default 3)', async () => {
  const scenario = (over) => runWorkflow({
    units: [unit(1), unit(2), unit(3), unit(4)],
    config: cfg(over),
    respond: (c) => (/^ac-verify/.test(c.label) ? { pass: false, unmet: ['AC offen'] } : undefined),
  })
  const off = await scenario({ progressStopAfter: 0 })
  assert.equal(off.report.stopped, null, 'progressStopAfter: 0 darf nie stoppen')
  assert.equal(off.report.done.length, 4)
  assert.ok(off.report.done.every((d) => d.needsHuman === true))
  assert.deepEqual(off.report.remaining, [])
  assert.equal(find(off.calls, 'needs-human #4').length, 1, 'auch die vierte Einheit muss noch anlaufen')

  const on = await scenario({})
  assert.ok(on.report.stopped && /Fortschritts-Circuit-Breaker/.test(on.report.stopped.reason),
    'derselbe Ablauf MUSS mit dem Default 3 stoppen — sonst beweist der 0-Fall nichts')
  assert.deepEqual(on.report.remaining, [4])
})

// ---------------------------------------------------------------------------
// Allowlist-taugliche Quotierung der Plugin-Script-Pfade (Issue #31)
// ---------------------------------------------------------------------------

// 21. Bash-Permission-Regeln sind PRÄFIX-Muster: ein Kommando, das mit `bash "`
//     beginnt, passt auf kein `Bash(bash <pluginRoot>/scripts/*)`. Normale Pfade
//     gehen deshalb unquoted raus — Pfade mit Leerzeichen weiterhin quoted.
test('Cleanup-Aufruf passt auf das Allowlist-Präfix (unquoted normal, quoted nur mit Leerzeichen)', async () => {
  const { calls } = await runWorkflow({
    units: [unit(1), unit(2)],
    config: cfg(),
    pluginRoot: '/opt/plugins/flowkit',
    respond: (c) => (/^ac-verify(\+\d+)? #2$/.test(c.label) ? { pass: false, unmet: ['AC offen'] } : undefined),
  })
  const post = only(calls, 'cleanup #1').prompt
  const nh = only(calls, 'needs-human #2').prompt
  assert.ok(post.includes('bash /opt/plugins/flowkit/scripts/cleanup-worktrees.sh --branch feat/1-x'),
    'der Post-Merge-Cleanup muss das Script unquoted aufrufen')
  assert.ok(nh.includes('bash /opt/plugins/flowkit/scripts/cleanup-worktrees.sh --issue 2'),
    'der needs-human-Cleanup muss das Script unquoted aufrufen')
  assert.ok(!/bash "\/opt\/plugins/.test(post) && !/bash "\/opt\/plugins/.test(nh),
    'ein führendes Anführungszeichen macht jede Präfix-Regel wirkungslos')

  // Gegenprobe: die naive Umsetzung (Quotes einfach entfernen) zerlegte einen
  // Pfad mit Leerzeichen in zwei Argumente.
  const spaced = await runWorkflow({ units: [unit(1)], config: cfg(), pluginRoot: '/opt/my plugins/flowkit' })
  assert.ok(only(spaced.calls, 'cleanup #1').prompt.includes('bash "/opt/my plugins/flowkit/scripts/cleanup-worktrees.sh" --branch'),
    'Pfade mit Leerzeichen müssen weiterhin gequotet werden')
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
