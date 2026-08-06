#!/usr/bin/env node
// Testet die Scheduler-Logik von workflows/implement.workflow.js (pickNext,
// Cap-Kohärenz, tote Blocker, Zyklus-Erkennung, WAIT-Signal, withMergeLock,
// per-Issue-Budget-Deckel, Lauf-Gesamtdeckel inkl. deferredByBudget,
// Learnings-Station, Post-Merge-Dreiwertigkeit (green/red/unmeasured),
// needs-human, Stop nach doppeltem technischem Fehler,
// PR-Check-Station gegen den Weltzustand, Fortschritts-Circuit-Breaker,
// CI-Infrastruktur-Re-Run im Gate-Wait (Diagnose vor Fix-Runde),
// Allowlist-taugliche Quotierung der Plugin-Script-Pfade,
// Abbruchpfade ohne Draft (Label + Abbruchkommentar am PR statt
// gh pr ready --undo), der Merge-Guard gegen Abbruch-Labels sowie
// Merge-Diagnose und der Zustand merge-blocked) mit
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
  if (/^gate-merge /.test(label)) return { merged: true, postMerge: 'green' }
  // Bildet den realen Hauptfall aus Issue #37 ab (PR offen, grün und fertig, der
  // Merge lief nicht). Ohne diesen Default liefe ein Test, der nur gate-merge
  // manipuliert, mit einem leeren {} weiter und schriebe undefined in den
  // Zustandstext.
  if (/^merge-diag /.test(label)) return { prState: 'OPEN', merged: false, checksGreen: 1, checksRed: 0, checksPending: 0, mergeCheckState: 'SUCCESS', note: 'Merge nicht ausgeführt' }
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
// ---------------------------------------------------------------------------
// Reasoning Effort je Station (Issue #45)
// ---------------------------------------------------------------------------
// Bis 0.8.0 wählte der Workflow nur die MODELLSTUFE; opts.effort blieb überall
// ungesetzt, jede Station erbte also den Effort-Wert des aufrufenden Kontexts.
// Damit gab es keinerlei Trennung zwischen "welches Modell" und "wie viel
// Denkaufwand" — und der Wert, den eine Station bekam, hing davon ab, wie der
// Operator die Sitzung gestartet hatte.
//
// Quelle für die Belegung: platform.claude.com/docs/en/build-with-claude/effort
// (abgerufen 2026-08-06). Zwei Punkte daraus tragen die Tests unten:
//   - effort wird NICHT von jedem Modell unterstützt; Haiku 4.5 steht nicht auf
//     der Liste. Die mechanischen Haiku-Stationen dürfen deshalb keinen Wert
//     gesetzt bekommen (sie leisten ohnehin kein Reasoning über Code, sondern
//     lesen und schreiben Zustand).
//   - xhigh gibt es nur auf einem Teil der Modelle; ein ungültiger Wert darf
//     nicht still durchrutschen, sondern muss den Lauf am Config-Guard stoppen.
test('Effort: die reasoning-tragenden Stationen bekommen einen expliziten Wert (#45)', async () => {
  const { calls } = await runWorkflow({ units: [unit(1)], config: cfg() })
  assert.equal(only(calls, 'plan #1').opts.effort, 'medium', 'Planner ohne Effort oder mit falschem Default')
  assert.equal(only(calls, 'build #1').opts.effort, 'medium', 'Builder ohne Effort oder mit falschem Default')
  assert.equal(only(calls, 'ac-verify #1').opts.effort, 'high', 'AC-Verifier ohne Effort')
  // Der Security-Pass läuft nur für geschützte Bereiche — eigene Einheit dafür.
  const sec = await runWorkflow({
    units: [unit(2, { area: 'security' })],
    config: cfg({ protectedAreas: ['security'], areas: ['security'] }),
  })
  assert.equal(only(sec.calls, 'security #2').opts.effort, 'high', 'Security-Pass ohne Effort')
})

test('Effort: Größe L hebt Planner und Builder eine Stufe an (#45)', async () => {
  const { calls } = await runWorkflow({ units: [unit(1, { size: 'L' })], config: cfg() })
  assert.equal(only(calls, 'plan #1').opts.effort, 'high')
  assert.equal(only(calls, 'build #1').opts.effort, 'high')
})

// Die Station-Karte allein reicht als Kriterium NICHT: ob effort gesetzt werden
// darf, hängt am effektiv gewählten MODELL, nicht am Stationsnamen. Ein Repo,
// das planner oder verifier bewusst auf haiku stellt (kleine, mechanische
// Issues), bekäme sonst einen Parameter, den das Modell nicht kennt.
test('Effort: eine auf haiku KONFIGURIERTE Station bekommt ebenfalls keinen Wert (#45)', async () => {
  const { calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg({ models: { planner: { SM: 'haiku', L: 'haiku' }, builder: { SM: 'sonnet', L: 'opus' }, verifier: 'haiku' } }),
  })
  assert.equal(only(calls, 'plan #1').opts.model, 'haiku', 'Modellkarte greift nicht — der Test prüft ins Leere')
  assert.equal(only(calls, 'plan #1').opts.effort, undefined,
    'Planner läuft auf haiku, bekommt aber einen effort-Wert — das Kriterium hängt am Stationsnamen statt am Modell')
  assert.equal(only(calls, 'ac-verify #1').opts.effort, undefined,
    'AC-Verifier läuft auf haiku, bekommt aber einen effort-Wert')
  // Gegenprobe: der Builder steht weiter auf sonnet und behält seinen Wert.
  assert.equal(only(calls, 'build #1').opts.effort, 'medium')
})

// Das Security-Modell kam bisher aus einem zweiten, direkt an den Aufrufen
// eingebauten Ausdruck (M.verifier || 'sonnet') statt aus modelFor. Damit gab
// es zwei Quellen für dieselbe Entscheidung — und die Effort-Wahl konnte gegen
// die Modell-Wahl laufen.
test('Effort/Modell: der Security-Pass folgt derselben Karte wie der Verifier (#45)', async () => {
  const { calls } = await runWorkflow({
    units: [unit(2, { area: 'security' })],
    config: cfg({ protectedAreas: ['security'], areas: ['security'], models: { verifier: 'haiku' } }),
  })
  const sec = only(calls, 'security #2')
  assert.equal(sec.opts.model, 'haiku', 'Security-Pass folgt models.verifier nicht mehr')
  assert.equal(sec.opts.effort, undefined, 'Security-Pass läuft auf haiku, bekommt aber einen effort-Wert')
})

test('Effort: mechanische Haiku-Stationen bekommen KEINEN Wert (#45)', async () => {
  const { calls } = await runWorkflow({ units: [unit(1)], config: cfg() })
  // Haiku steht nicht auf der Liste der effort-fähigen Modelle; ein gesetzter
  // Wert wäre je nach Engine ein Fehler oder stiller Ballast.
  for (const c of calls.filter((x) => x.opts.model === 'haiku')) {
    assert.equal(c.opts.effort, undefined,
      `Station "${c.label}" läuft auf haiku und darf keinen effort-Wert bekommen (Modell unterstützt den Parameter nicht)`)
  }
  assert.ok(calls.some((c) => c.opts.model === 'haiku'), 'kein einziger haiku-Aufruf im Lauf — der Test prüft ins Leere')
})

// Die Eskalation hebt bisher NUR die Modellstufe (NEXT_TIER). Effort muss
// orthogonal dazu laufen: eine eskalierte Fix-Runde bekommt beides, und die
// Modell-Eskalation selbst bleibt unverändert — sonst wäre die eine Änderung
// eine stille Verschiebung der anderen.
test('Effort: Eskalation hebt Modell UND Effort, ohne die Modellkarte zu verändern (#45)', async () => {
  const { calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg({ maxFixRounds: 3 }),
    respond: (c) => (/^ac-verify(\+\d+)? #1$/.test(c.label) ? { pass: false, unmet: ['AC offen'] } : undefined),
  })
  const fix1 = only(calls, 'fix1 #1')
  assert.equal(fix1.opts.model, 'sonnet', 'Runde 1 eskaliert noch nicht — Modellkarte hat sich verändert')
  assert.equal(fix1.opts.effort, 'medium', 'Runde 1 ohne Eskalation fährt den Builder-Effort')
  const fix2 = only(calls, 'fix2 #1 esc')
  assert.equal(fix2.opts.model, 'opus', 'Modell-Eskalation (NEXT_TIER) ist nicht mehr wirksam')
  assert.equal(fix2.opts.effort, 'xhigh', 'Effort-Eskalation greift bei der eskalierten Runde nicht')
})

test('Effort: Repo-Config überschreibt die Voreinstellung (#45)', async () => {
  const { calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg({ effort: { planner: { SM: 'low', L: 'low' }, builder: { SM: 'max', L: 'max' }, verifier: 'low', security: 'medium', escalation: 'max' } }),
  })
  assert.equal(only(calls, 'plan #1').opts.effort, 'low')
  assert.equal(only(calls, 'build #1').opts.effort, 'max')
  assert.equal(only(calls, 'ac-verify #1').opts.effort, 'low')
  const sec = await runWorkflow({
    units: [unit(2, { area: 'security' })],
    config: cfg({ protectedAreas: ['security'], areas: ['security'], effort: { security: 'medium' } }),
  })
  assert.equal(only(sec.calls, 'security #2').opts.effort, 'medium')
})

test('Effort: ungültiger Wert stoppt den Lauf am Guard, statt still zu greifen (#45)', async () => {
  await assert.rejects(
    () => runWorkflow({ units: [unit(1)], config: cfg({ effort: { verifier: 'sehr hoch' } }) }),
    /effort/i,
    'ein Tippfehler im effort-Wert muss den Lauf stoppen — sonst schickt er still einen ungültigen Parameter an die Engine')
  // "adaptive" ist ein THINKING-Modus, kein Effort-Level; die Verwechslung ist
  // in der Anthropic-Doku eigens erwähnt und gehört deshalb festgeschrieben.
  await assert.rejects(
    () => runWorkflow({ units: [unit(1)], config: cfg({ effort: { builder: { SM: 'adaptive', L: 'high' } } }) }),
    /effort/i)
})

// Bestehende Repos bekommen neue Config-Keys NUR über
// templates/config-migrations.json — /flowkit:setup arbeitet die Liste beim
// Update ab. Ein Key, der nur im Template steht, erreicht sie nie: er greift
// zwar über die eingebaute Voreinstellung, taucht aber in ihrer Config nicht
// auf und ist für den Operator damit unsichtbar und nicht anpassbar. Genau das
// war beim ersten Anlauf von #45 passiert.
//
// CONFIG_BASELINE sind die Keys aus der Zeit vor dem Migrationsmechanismus
// (< 0.3.0). Alles, was danach dazukam, gehört in die Migrationsliste — ein
// neuer Key lässt diesen Test failen, bis er dort steht.
const CONFIG_BASELINE = new Set([
  'repoSlug', 'defaultBranch', 'pushCommand', 'commands', 'extraGates',
  'protectedAreas', 'areas', 'parallelism', 'caps', 'budgets', 'opusTurnWeight',
  'models', 'autoReady', 'maxFixRounds', 'mergeCheck', 'overrideLabel',
  'markers', 'milestoneExcludeRegex', 'excludeLabels', 'issueLimit',
  'browserProof', 'notify', 'onSmokeFailure',
])
test('Config-Migrationen: jeder Template-Key ist entweder Baseline oder migriert', async () => {
  const tpl = JSON.parse(readFileSync(new URL('../templates/workflow.config.json.template', import.meta.url), 'utf8'))
  const migrations = JSON.parse(readFileSync(new URL('../templates/config-migrations.json', import.meta.url), 'utf8'))
  // Migrationen adressieren teils verschachtelte Felder ("commands.setup") —
  // für den Abgleich zählt das Top-Level-Segment.
  const migrated = new Set(migrations.map((m) => String(m.field).split('.')[0]))
  for (const key of Object.keys(tpl)) {
    assert.ok(CONFIG_BASELINE.has(key) || migrated.has(key),
      `Config-Key "${key}" steht im Template, aber weder in CONFIG_BASELINE noch in config-migrations.json — bestehende Repos bekämen ihn beim Update nie zu sehen. Eintrag in templates/config-migrations.json ergänzen (version, field, default, note).`)
  }
  // Gegenrichtung: eine Migration, deren Feld es im Template gar nicht gibt,
  // schickt den Operator einem Key hinterher, den der Workflow nicht liest.
  for (const m of migrations) {
    const top = String(m.field).split('.')[0]
    assert.ok(Object.prototype.hasOwnProperty.call(tpl, top),
      `config-migrations.json migriert "${m.field}", aber das Template kennt "${top}" nicht (mehr) — Migration entfernen oder Template ergänzen.`)
    assert.ok(m.version && m.note, `Migration für "${m.field}" ohne version oder note`)
  }
})

test('Effort: Template und Schema liefern die Sektion aus (#45)', async () => {
  const tpl = JSON.parse(readFileSync(new URL('../templates/workflow.config.json.template', import.meta.url), 'utf8'))
  assert.ok(tpl.effort, 'workflow.config.json.template hat keine effort-Sektion — neue Repos bekämen sie nie zu sehen')
  assert.equal(tpl.effort.verifier, 'high')
  assert.ok(tpl.effort.planner && tpl.effort.builder, 'planner/builder fehlen in der Template-Sektion')
  const schema = JSON.parse(readFileSync(new URL('../templates/workflow.config.schema.json', import.meta.url), 'utf8'))
  assert.ok(schema.properties.effort, 'workflow.config.schema.json kennt effort nicht — eine gesetzte Sektion wäre schema-widrig')
})

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
  assert.equal(d1.postMerge, 'green')
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
        return { merged: true, postMerge: 'green' }
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

// 8b. Gate-Wait, Schritt 1: der Draft-Zustand wird geklärt, BEVOR gewartet wird.
//     Ein Draft-PR kann per Design keinen grünen Pflicht-Check liefern (der
//     prep-Job der Review-Pipeline ist auf draft == false gefiltert) — 45 Minuten
//     darauf zu warten war der teuerste Leerlauf des Vorfalls.
test('Gate-Wait: Draft-Check und gh pr ready stehen vor der Warteschleife', async () => {
  const { calls } = await runWorkflow({ units: [unit(1)], config: cfg({ mergeCheck: 'coordinator' }) })
  const p = only(calls, 'gate-wait #1').prompt
  assert.ok(p.includes('gh pr view 101 -R acme/demo --json isDraft'), 'der Draft-Zustand muss überhaupt abgefragt werden')
  assert.ok(/SKIPPED/.test(p), 'ein übersprungener Pflicht-Check darf nie als grün durchgehen')
  const iDraft = p.indexOf('isDraft')
  const iReady = p.indexOf('gh pr ready 101 -R acme/demo')
  const iWatch = p.indexOf('--watch')
  assert.ok(iWatch > -1, 'ohne die Warteschleife misst der Reihenfolge-Test nichts')
  assert.ok(iDraft > -1 && iDraft < iWatch, 'der Draft-Check steht VOR dem --watch, sonst wartet die Station wieder ins Leere')
  // Nicht nur "kommt vor": ein gh pr ready HINTER der Warteschleife käme 45
  // Minuten zu spät. Seit der Re-Trigger das BEHIND-Update ist (Schritt 3a), ist
  // Schritt 1 die einzige Stelle, die den PR überhaupt ready setzt — die
  // Reihenfolge ist damit alles, was diesen Aufruf wirksam macht.
  assert.ok(iReady > -1 && iReady < iWatch, 'ein Draft muss VOR dem Warten geheilt werden, nicht nur festgestellt')
})

// 8c. Schritt 3: "keine Checks" wird belegt statt vermutet — gezählt werden nur
//     Läufe des PR-HEAD-SHA, und der Re-Trigger bleibt auf genau einen gedeckelt.
//     Dazu der Schema-Vertrag: ohne die Felder in properties verwirft
//     additionalProperties: false jede Diagnose, required bleibt trotzdem eng.
test('Gate-Wait: zählt Läufe am HEAD-SHA, triggert genau einmal neu, Schema trägt die Diagnose', async () => {
  const { calls } = await runWorkflow({ units: [unit(1)], config: cfg() })
  const c = only(calls, 'gate-wait #1')
  assert.ok(/gh run list -R acme\/demo --branch feat\/1-x/.test(c.prompt), 'ohne Lauf-Zählung bleibt "keine Checks" unbelegt')
  assert.ok(c.prompt.includes('headSha == <headRefOid'),
    'ungefiltert zählt jeder fremde Lauf desselben Branch mit — runsFound wäre in Multi-Workflow-Repos immer > 0 und der Re-Trigger tot')
  assert.ok(/GENAU EINEN Re-Trigger/.test(c.prompt), 'eine externe Ursache heilt auch der zweite nicht')
  const s = c.opts.schema
  assert.deepEqual(s.required, ['green'], 'Diagnosefelder dürfen NICHT required werden — eine Antwort ohne sie bleibt gültig')
  assert.equal(s.additionalProperties, false, 'der Agent darf keine freien Felder erfinden')
  for (const f of ['draftAtEntry', 'runsFound', 'retriggered']) {
    assert.ok(s.properties[f], `WAIT_SCHEMA.properties.${f} fehlt — additionalProperties: false verwürfe das Feld stillschweigend`)
  }
})

// 8c2. Welcher Re-Trigger — das offene Akzeptanzkriterium von Issue #34. Der
//      Operator hat die drei Kandidaten am 2026-08-01 live an PR #576/#580
//      durchgemessen: `gh pr ready` (Draft aufheben) — keine Actions-Läufe; ein
//      leerer Commit plus Push — keine Läufe; `git merge origin/main` plus Push —
//      Läufe binnen Sekunden. Umgesetzt war bis hierher genau der als wirkungslos
//      belegte Draft-Toggle, während das BEHIND-Update nur im gateMergePrompt
//      stand — also erst NACH grünem Gate-Wait im Merge-Lock und damit strukturell
//      zu spät für ein "no checks reported".
//      Zweite Hälfte des Tests: das Update läuft OHNE Merge-Lock, pusht aber
//      dasselbe Merge-Ergebnis wie die Merge-Station. Seine Konflikt-Regel darf
//      deshalb nicht weicher sein als deren — sonst landet über den ungelockten
//      Weg ein geratener Konflikt auf dem Branch, den der gelockte Weg bewusst
//      abbricht.
test('Gate-Wait: Re-Trigger ist das BEHIND-Update, nicht Draft-Toggle oder leerer Commit', async () => {
  const { calls } = await runWorkflow({ units: [unit(1)], config: cfg() })
  const p = only(calls, 'gate-wait #1').prompt
  assert.ok(/git merge origin\/main/.test(p), 'ohne das BEHIND-Update hat die Station keinen wirksamen Re-Trigger')
  assert.ok(/git worktree add <tmp> feat\/1-x/.test(p), 'das Update gehört in einen eigenen Worktree, nie in den Haupt-Tree')
  assert.ok(/git push/.test(p), 'ohne Push erreicht das Update GitHub nie und triggert nichts')
  assert.ok(!/--undo/.test(p), 'der Draft-Toggle ist als Re-Trigger live widerlegt — er darf hier nicht zurückkommen')
  assert.ok(/KEIN leerer Commit/.test(p), 'der leere Commit ist gemessen wirkungslos und muss ausdrücklich ausgeschlossen bleiben')
  // Ein Merge, der nichts zu mergen hat, pusht nichts und triggert nichts — die
  // Station meldete sonst retriggered: true für einen No-op.
  assert.ok(/git merge-base --is-ancestor origin\/main origin\/feat\/1-x/.test(p),
    'ohne die Vorprüfung meldet die Station einen Re-Trigger, der als No-op gar nichts gepusht hat')
  // Der HEAD-SHA ist nach dem Update ein anderer; ohne Neubestimmung zählt die
  // Station runsFound weiter gegen den alten SHA und sähe die neuen Läufe nie.
  assert.ok(/--json headRefOid neu/.test(p), 'nach dem Update muss der HEAD-SHA neu bestimmt werden')
  const gm = only(calls, 'gate-merge #1').prompt
  for (const rule of ['--diff-filter=U', 'git merge --abort', 'HINZUGEFÜGT']) {
    assert.ok(gm.includes(rule), `Aufbau gepinnt: die Merge-Station kennt "${rule}" nicht mehr`)
    assert.ok(p.includes(rule), `der ungelockte Gate-Wait pusht dasselbe Merge-Ergebnis, kennt aber "${rule}" nicht — er wäre weniger vorsichtig als der Lock`)
  }
  // Schema und Prompt gehören in denselben Commit: die Beschreibung ist das
  // Einzige, was der Station sagt, wofür retriggered steht.
  assert.ok(/BEHIND-Update/.test(only(calls, 'gate-wait #1').opts.schema.properties.retriggered.description),
    'WAIT_SCHEMA beschreibt retriggered noch als Draft-Toggle')
})

// 8d. Der Nutzen der Felder entsteht erst in der Meldung: sie ist der einzige
//     Draht zum Operator (Issue-Kommentar über needs-human, done[].note im
//     Bericht). Deshalb beides prüfen, nicht nur den Report.
test('Gate-Wait ohne Grün: die GATE-Meldung nennt Draft-Zustand, Lauf-Zahl und Re-Trigger', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => (/^gate-wait /.test(c.label)
      ? { green: false, draftAtEntry: true, runsFound: 0, retriggered: true, note: 'keine Checks nach 45 Minuten' }
      : undefined),
  })
  const d1 = doneOf(report, 1)
  assert.equal(d1.needsHuman, true)
  assert.ok(/keine Checks nach 45 Minuten/.test(d1.note), 'die note der Station bleibt erhalten')
  assert.ok(/Draft beim Eintritt: ja/.test(d1.note))
  assert.ok(/Workflow-Läufe auf dem Branch: 0/.test(d1.note))
  // Nicht nur "ausgeführt": WELCHER Re-Trigger lief, entscheidet, was der
  // Operator als Nächstes tut — ein BEHIND-Update hat den Branch verändert.
  assert.ok(/Re-Trigger \(BEHIND-Update\): ausgeführt/.test(d1.note))
  const nh = only(calls, 'needs-human #1').prompt
  assert.ok(/Workflow-Läufe auf dem Branch: 0/.test(nh), 'der Befund muss im Issue-Kommentar landen, nicht nur im Report')
  assert.ok(/WÖRTLICH/.test(nh), 'ohne die Wörtlich-Regel paraphrasiert der Haiku-Agent die Diagnose weg')
  assert.equal(report.stopped, null)
})

// 8e. Absicherung gegen die naive Umsetzung `${wait.draftAtEntry}`: ein fehlendes
//     Feld (alter oder abgewürgter Agent) muss "unbekannt" ergeben — "undefined"
//     im Issue-Kommentar ist schlimmer als keine Angabe.
test('Gate-Wait ohne Diagnosefelder: die Meldung sagt "unbekannt", nie undefined', async () => {
  const { report } = await runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => (/^gate-wait /.test(c.label) ? { green: false, note: 'rot' } : undefined),
  })
  const note = doneOf(report, 1).note
  assert.ok(/Draft beim Eintritt: unbekannt/.test(note))
  assert.ok(/Workflow-Läufe auf dem Branch: unbekannt/.test(note))
  assert.ok(/Re-Trigger \(BEHIND-Update\): unbekannt/.test(note))
  assert.ok(!/undefined/.test(note), 'ein fehlendes Feld darf nie als "undefined" beim Operator landen')
})

// 8f. Ehrliche Dokumentation des degradierten Pfads: wirft die Station, statt
//     { green: false, … } zurückzugeben, wird die Diagnose gar nicht erst
//     gebildet — die Meldung hat dann KEINEN Diagnose-Block. Die Einheit landet
//     trotzdem wie bisher als needs-human, der Lauf fährt fort. Dieser Fall ist
//     auch ohne die Änderung grün: er dokumentiert die Grenze der Diagnose,
//     statt sie zu beweisen (das tun 8b-8e und 8g).
test('Gate-Wait wirft: needs-human wie bisher, aber ohne Diagnose-Block', async () => {
  const { report } = await runWorkflow({
    units: [unit(1), unit(2)],
    config: cfg(),
    respond: (c) => { if (c.label === 'gate-wait #1') throw new Error('GATE: Checks nicht grün: Timeout') },
  })
  const d1 = doneOf(report, 1)
  assert.equal(d1.needsHuman, true)
  assert.ok(d1.note.startsWith('GATE:'))
  assert.ok(!/Draft beim Eintritt/.test(d1.note),
    'ein geworfener Fehler transportiert nur einen String — wer den Prompt kürzt, degradiert hierhin zurück')
  assert.equal(doneOf(report, 2).pr, 102, 'der Lauf fährt nach needs-human fort')
})

// 8g. Erfolgspfad: ein Draft, den die Station stillschweigend geheilt hat, ist der
//     häufigste Fall — ohne gateDiag im Return hinterlässt genau er keine Spur.
test('Gate-Wait grün: gateDiag steht auch im Erfolgsfall im Bericht', async () => {
  const { report } = await runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => (/^gate-wait /.test(c.label)
      ? { green: true, draftAtEntry: true, runsFound: 2, retriggered: false }
      : undefined),
  })
  assert.deepEqual(doneOf(report, 1).gateDiag, { draftAtEntry: true, runsFound: 2, retriggered: false, infraRerun: null })
  // Gegenprobe: fehlende Felder werden null (auswertbar), nicht undefined (fällt
  // beim Serialisieren des Berichts ersatzlos weg).
  const plain = await runWorkflow({ units: [unit(1)], config: cfg() })
  assert.deepEqual(doneOf(plain.report, 1).gateDiag, { draftAtEntry: null, runsFound: null, retriggered: null, infraRerun: null })
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

// Zusatz: die Area gilt so lange als belegt, wie noch EINE Einheit daraus läuft.
// #1 und #2 teilen sich area api (der Fallback lässt das zu, wenn nichts anderes
// lauffähig ist); wenn #1 fertig ist, baut #2 noch. Ein Set hätte die Area schon
// mit #1 freigegeben und danach #3 (api) vor #4 (web) gezogen — also genau die
// Kollision erzeugt, die die Präferenz verhindern soll. #4 hängt an #1, damit es
// beim ersten Zug noch nicht lauffähig ist und der Fallback überhaupt greift.
test('Area-Zähler: die Area bleibt belegt, solange ein Geschwister noch läuft', async () => {
  const { report, calls } = await runWorkflow({
    units: [
      unit(1, { area: 'api' }),
      unit(2, { area: 'api' }),
      unit(3, { area: 'api' }),
      unit(4, { area: 'web', blockedBy: [1] }),
    ],
    config: cfg({ parallelism: 2 }),
    respond: async (c) => { if (c.label === 'build #2') await sleep(60) },
  })
  assert.equal(report.done.length, 4)
  assert.deepEqual(report.blocked, [])
  assert.ok(only(calls, 'plan #2').startSeq < only(calls, 'plan #1').endSeq,
    'Voraussetzung: #1 und #2 (beide area api) laufen wirklich gleichzeitig')
  assert.ok(only(calls, 'plan #4').startSeq < only(calls, 'plan #3').startSeq,
    'nach dem Ende von #1 muss #4 (freie area web) vor #3 (area api, noch belegt durch #2) kommen')
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

// 10. Der Builder BEHAUPTET einen anderen, TRUTHY PR (klassischer Befund bei
//     ausgefallenem Permission-Classifier wäre pr:0 — das deckt aber nur die
//     falsy-Hälfte einer Mutation `built.pr || seen.pr` ab, siehe F-10, Review
//     0.8.0: mit pr:0/branch:'' bleibt `0 || 581 === 581` unbemerkt gleich).
//     Hier behauptet der Builder stattdessen PR #999 auf einem FREMDEN Branch —
//     gh kennt nur #581. Ab hier zählt nur gh: Nummer UND Branch JEDER
//     Folgestation (ac-verify, gate-wait, gate-merge) müssen den gh-Wert tragen,
//     nie den truthy, aber falschen Builder-Wert (sonst mergte der Runner unter
//     der Mutation einen fremden PR).
test('pr-check: die PR-Nummer kommt von gh, auch wenn der Builder einen anderen (truthy) PR behauptet', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => {
      if (c.label === 'build #1') return { pr: 999, branch: 'feat/999-fremd', skipped: false }
      if (c.label === 'pr-check #1') return { found: true, pr: 581, branch: 'feat/1-gh', state: 'OPEN' }
      return undefined
    },
  })
  const chk = only(calls, 'pr-check #1')
  assert.equal(chk.opts.model, 'haiku', 'die Station ist mechanisch — haiku genügt')
  assert.ok(only(calls, 'build #1').endSeq < chk.startSeq, 'der pr-check läuft NACH dem Builder')
  assert.ok(chk.prompt.includes('gh pr list -R acme/demo --search "Closes #1" --state all'),
    'der pr-check muss gh mit --state all befragen')
  assert.ok(!chk.prompt.includes('999') && !chk.prompt.includes('feat/999-fremd'),
    'die Behauptung des Builders darf NICHT im Prompt stehen (sonst ist Nachplappern nicht von Prüfen unterscheidbar)')
  assert.equal(doneOf(report, 1).pr, 581, 'die PR-Nummer stammt aus dem gh-Befund, nicht aus dem (truthy!) Builder-Return')
  const ac = only(calls, 'ac-verify #1')
  assert.ok(/gh pr view 581/.test(ac.prompt) && /gh pr diff 581/.test(ac.prompt),
    'der AC-Verifier muss auf den gh-verifizierten PR zeigen')
  const wait = only(calls, 'gate-wait #1')
  assert.ok(wait.prompt.includes('feat/1-gh') && !wait.prompt.includes('feat/999-fremd'),
    'der Branch der Gate-Stationen kommt aus dem gh-Befund (headRefName), nie aus dem Builder')
  const merge = only(calls, 'gate-merge #1')
  assert.ok(/PR #581\b/.test(merge.prompt) && !merge.prompt.includes('999'),
    'auch die Merge-Station arbeitet mit der gh-verifizierten PR-Nummer, nicht der vom Builder behaupteten')
  none(calls, /^needs-human /)
  assert.equal(report.stopped, null)
})

// 10b. F-21 (Review 0.8.0): Test 10 prüfte bisher zusätzlich, dass die Zeichen-
//      folge des gh-Befunds NICHT im pr-check-Prompt steht — aber dieser Befund
//      kann strukturell nie dort stehen (er ist die ANTWORT der Station, kein
//      Eingabewert; `prCheckPrompt(n)` hängt nur an der Issue-Nummer). Diese
//      Assertion konnte nie rot werden. Die dokumentierte Invariante ("die
//      Station bekommt bewusst KEINE Behauptung der Bau-Station übergeben")
//      lässt sich nur nachweisen, indem derselbe Ablauf zweimal mit
//      unterschiedlichen Builder-Werten läuft und die pr-check-Prompts auf
//      Zeichengleichheit geprüft werden.
test('pr-check-Prompt ist unabhängig vom Builder-Return (Zeichengleichheit über zwei Läufe)', async () => {
  const runOnce = (built) => runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => {
      if (c.label === 'build #1') return built
      if (c.label === 'pr-check #1') return { found: true, pr: 581, branch: 'feat/1-gh', state: 'OPEN' }
      return undefined
    },
  })
  const a = await runOnce({ pr: 0, branch: '', skipped: false })
  const b = await runOnce({ pr: 999, branch: 'feat/999-fremd', skipped: false, note: 'völlig andere Behauptung des Builders' })
  const chkA = only(a.calls, 'pr-check #1')
  const chkB = only(b.calls, 'pr-check #1')
  assert.equal(chkA.prompt, chkB.prompt,
    'prCheckPrompt(n) darf nicht vom Builder-Return abhängen — sonst plappert die Station dessen Behauptung nur nach, statt den Weltzustand selbst zu prüfen')
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

// 12b. F-11 (Review 0.8.0): der Guard `!prOk || seen.state !== 'MERGED'` hat
//      neben "kein Treffer" (Test 12, deckt nur die !prOk-Hälfte) eine zweite
//      Bedingung, die von keinem Test berührt wurde. gh weist hier einen
//      VERIFIZIERTEN, aber GESCHLOSSENEN PR aus (prOk ist true, state ist
//      CLOSED) — die skipped+OPEN-Übernahme (Test 15g) prüft einen ganz
//      anderen Zweig (den vorgelagerten `prOk && state === 'OPEN'`-Fall) und
//      lässt diese Bedingung unangetastet. Mutationstest: Kürzt man den Guard
//      auf `if (!prOk)`, läuft ein geschlossener, aber verifizierter PR hier
//      unbemerkt als `return { skipped: true, ... }` durch — die teuerste
//      Falschmeldung, die der Produktivcode-Kommentar an dieser Stelle selbst
//      benennt.
test('pr-check: "skipped" bei einem geschlossenen, aber verifizierten PR ist keine Erledigung', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2, { blockedBy: [1] })],
    config: cfg(),
    respond: (c) => {
      if (c.label === 'build #1') return { pr: 0, branch: '', skipped: true, note: 'sieht erledigt aus' }
      if (c.label === 'pr-check #1') return { found: true, pr: 205, branch: 'feat/1-x', state: 'CLOSED', note: 'PR wurde geschlossen, nie gemergt' }
      return undefined
    },
  })
  assert.ok(!report.done.some((d) => d.issue === 1 && d.skipped),
    'ein geschlossener PR ist keine Erledigung, auch wenn Nummer und Branch von gh verifiziert sind (prOk)')
  assert.deepEqual(report.failed, [1])
  assert.ok(/keinen gemergten PR/.test(report.stopped.reason), `Stop-Grund war: ${report.stopped.reason}`)
  none(calls, /#2\b/)
  assert.deepEqual(report.remaining, [2], '#2 darf nicht durch eine vermeintliche CLOSED-Erledigung freigegeben werden')
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

// 15b. Härtung an der Quelle (Issue #33): die PR-Check-Station fängt ein
//      geratenes/verlorenes pr:0 zwar ab, aber Schema-Beschreibung und
//      Return-Zeile sollen den Builder erst gar nicht dazu einladen, 0 zu
//      melden, wenn tatsächlich ein PR existiert.
test('buildPrompt: Schema-Beschreibung und Return-Zeile verbieten geratenes pr:0', async () => {
  const { calls } = await runWorkflow({ units: [unit(1)], config: cfg() })
  const build = only(calls, 'build #1')
  assert.equal(build.opts.schema.properties.pr.description, 'PR-Nummer, wie gh sie ausgegeben hat; 0 ausschließlich bei skipped=true',
    'die Schema-Beschreibung muss 0 explizit an skipped=true koppeln, nicht als beliebigen Default lesbar sein')
  assert.ok(/pr: 0 ist ausschließlich für skipped=true zulässig/.test(build.prompt),
    'die Return-Zeile muss 0 explizit auf skipped=true beschränken')
  assert.ok(/Nie raten, nie 0 melden/.test(build.prompt),
    'die Return-Zeile muss dem Builder verbieten, die PR-Nummer zu raten')
})

// 15c. Ein MEHRDEUTIGER Befund (zwei verifizierte offene PRs) ist kein
//      technischer Fehler: die Station erkennt ihn bewusst, aber ohne eigenes
//      Feld war er in runUnit von "gar kein PR" nicht unterscheidbar — voller
//      Requeue inklusive zweitem Builder-Lauf, beim identischen zweiten Befund
//      Stop des GANZEN Laufs, und am Issue stand weder Label noch Kommentar.
//      Auflösen kann das nur ein Mensch; also braucht es die GitHub-sichtbare
//      Klasse, die der strukturgleiche merge-blocked schon hat.
test('pr-check: mehrdeutiger Befund wird needs-human, nicht requeued', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2, { blockedBy: [1] })],
    config: cfg(),
    respond: (c) => (c.label === 'pr-check #1'
      ? { found: false, pr: 0, branch: '', state: 'NONE', ambiguous: true, note: 'mehrdeutig: #101, #109' }
      : undefined),
  })
  const d1 = doneOf(report, 1)
  assert.equal(d1.needsHuman, true, 'ein mehrdeutiger Befund ist ein inhaltlicher Stopp, kein technischer Fehler')
  assert.ok(/^GATE: Mehrdeutiger PR-Befund/.test(d1.note), `note war: ${d1.note}`)
  assert.ok(d1.note.includes('mehrdeutig: #101, #109'), 'die Nummern der Kandidaten müssen im Issue-Kommentar stehen')
  only(calls, 'needs-human #1')
  assert.equal(find(calls, 'build #1').length, 1, 'kein zweiter Builder-Lauf auf einen Befund, den nur ein Mensch auflöst')
  assert.equal(report.stopped, null, 'ein einzelner mehrdeutiger Befund hält den Lauf nicht an')
  assert.deepEqual(report.failed, [])
  assert.deepEqual(report.blocked, [{ n: 2, by: [1] }], 'ohne gemergten Code bleibt der Abhängige blockiert')
})

// 15d. Gegenprobe: ohne das Feld bleibt alles wie bisher. `ambiguous` ist
//      optional (wie die Diagnosefelder des WAIT_SCHEMA) — eine Station, die es
//      nicht füllt, darf nicht plötzlich anders behandelt werden.
test('pr-check: ohne ambiguous bleibt "kein PR" ein technischer Fehler', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => (c.label === 'pr-check #1' ? { found: false, pr: 0, branch: '', state: 'NONE', note: 'kein Treffer' } : undefined),
  })
  assert.equal(find(calls, 'build #1').length, 2, 'der Erstfehler bleibt transient und wird requeued')
  assert.deepEqual(report.failed, [1])
  none(calls, /^needs-human /)
})

// 15e. Prompt- und Schema-Kopplung zum Fall aus 15c: verlangt der Prompt das
//      Feld, muss additionalProperties: false es auch durchlassen — sonst
//      verwirft die Engine jede Antwort damit und die Station fällt technisch
//      aus. Zugleich der erste Formtest des PRCHECK_SCHEMA überhaupt: enum,
//      required und additionalProperties waren ungeprüft (vier Mutationen,
//      alle vakuum-grün), und ohne `schema` am Aufruf gälte das ganze Literal
//      nicht.
test('PRCHECK_SCHEMA: Form des Literals, ambiguous erlaubt aber nicht erzwungen', async () => {
  const { calls } = await runWorkflow({ units: [unit(1)], config: cfg() })
  const c = only(calls, 'pr-check #1')
  const s = c.opts.schema
  assert.ok(s, 'ohne schema am Aufruf ist das Literal wirkungslos — der Agent antwortet in Prosa')
  assert.equal(s.type, 'object')
  assert.deepEqual(s.required, ['found', 'pr', 'branch', 'state'],
    'genau diese vier tragen den Befund; ein gekürztes required macht "kein PR" von "keine Antwort" ununterscheidbar')
  assert.equal(s.additionalProperties, false, 'der Agent darf den Weltzustand nicht an den Feldern vorbei melden')
  assert.deepEqual(s.properties.state.enum, ['OPEN', 'MERGED', 'CLOSED', 'NONE'],
    'ohne enum wäre jeder Freitext ein Zustand — die MERGED- und OPEN-Zweige in runUnit hängen wörtlich daran')
  assert.equal(s.properties.state.type, 'string', 'type NEBEN enum: bares enum nutzt kein Schema dieser Datei')
  assert.equal(s.properties.found.type, 'boolean')
  assert.equal(s.properties.pr.type, 'integer')
  assert.equal(s.properties.ambiguous.type, 'boolean')
  assert.ok(!s.required.includes('ambiguous'), 'ambiguous bleibt optional — eine Antwort ohne das Feld ist weiter gültig')
  assert.ok(/ambiguous=true/.test(c.prompt), 'der Prompt muss das Feld für den Mehrdeutigkeitsfall auch verlangen')
  // Dieselbe Treffer-Regel wie im Builder und in den beiden Abbruch-Stationen —
  // eine Zeichenfolgen-Prüfung ohne rechte Begrenzung nimmt #1XX mit, und ein
  // Body, der auf "Closes #1" endet, hat rechts gar kein Zeichen mehr.
  assert.ok(/rechts durch eine Nicht-Ziffer oder das Zeilenende begrenzt/.test(c.prompt),
    'die Station ist die Referenz für alle vier Treffer-Verifikationen — sie muss selbst vollständig sein')
})

// 15f. Der Ausfall der Station selbst: der Wrapper normalisiert JEDEN Wurf auf
//      einen Text OHNE GATE:-Präfix. Ohne ihn (nacktes `throw e`) würde ein
//      zufällig so beginnender Fehlertext die Einheit als inhaltliches
//      needs-human stilllegen, statt sie zu requeuen — deshalb wirft der Mock
//      hier bewusst mit GATE:-Präfix.
test('pr-check: Ausfall der Station bleibt technischer Fehler, auch bei GATE:-Text', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => { if (/^pr-check /.test(c.label)) throw new Error('GATE: Station nach innen durchgereicht') },
  })
  none(calls, /^needs-human /)
  assert.equal(find(calls, 'build #1').length, 2, 'ein Stationsausfall ist transient — die Einheit wird requeued')
  assert.equal(find(calls, 'cleanup #1').length, 2, 'Cleanup gehört in JEDE Abbruch-Routine')
  assert.deepEqual(report.failed, [1])
  assert.ok(/^PR-Check-Station ausgefallen: /.test(report.stopped.reason),
    `der Stop-Grund muss die Station benennen und darf NICHT mit GATE: beginnen — war: ${report.stopped.reason}`)
})

// 15g. Builder und pr-check priorisierten OPEN/MERGED gegensätzlich: der Builder
//      prüfte MERGED zuerst, die Station verlangt OPEN vor MERGED. Koexistieren
//      beide Zustände (Issue nach dem Merge wiedereröffnet, dazu ein offener PR
//      aus einem needs-human-Lauf), arbeiten beide prompt-konform — und die
//      Einheit warf trotzdem, ohne GATE:, also mit Requeue und Lauf-Stop beim
//      identischen zweiten Anlauf. Der Weltzustand schlägt die Behauptung.
test('Builder meldet skipped, gh sagt OPEN: der offene PR wird übernommen', async () => {
  const { report, calls, logs } = await runWorkflow({
    units: [unit(1), unit(2, { blockedBy: [1] })],
    config: cfg(),
    respond: (c) => {
      if (c.label === 'build #1') return { pr: 0, branch: '', skipped: true, note: 'gemergter PR #90 gefunden' }
      if (c.label === 'pr-check #1') return { found: true, pr: 101, branch: 'feat/1-x', state: 'OPEN', note: 'offener PR schlägt gemergten' }
      return undefined
    },
  })
  const d1 = doneOf(report, 1)
  assert.equal(d1.pr, 101, 'die Einheit läuft mit dem offenen PR weiter')
  assert.equal(d1.skipped, undefined, 'ein offener PR ist keine Erledigung')
  assert.equal(d1.needsHuman, undefined)
  assert.equal(d1.postMerge, 'green')
  only(calls, 'ac-verify #1')
  only(calls, 'gate-merge #1')
  assert.equal(find(calls, 'build #1').length, 1, 'kein Requeue: die Konstellation reproduziert sich beim zweiten Anlauf')
  assert.equal(report.stopped, null)
  assert.equal(doneOf(report, 2).pr, 102, 'der Abhängige läuft nach dem Merge normal an')
  assert.ok(logs.some((l) => /gh weist aber PR #101 als OPEN aus/.test(l)), 'LOG zur übernommenen Fehlmeldung fehlt')
})

// 15h. Dieselbe Prioritätsregel gehört in den Builder-Prompt, sonst repariert
//      der Runner nur das Symptom: die Station prüft OPEN vor MERGED, der
//      Builder prüfte MERGED zuerst.
test('buildPrompt: offener PR schlägt gemergten, Treffer rechts begrenzt', async () => {
  const p = only((await runWorkflow({ units: [unit(41)], config: cfg() })).calls, 'build #41').prompt
  assert.ok(p.indexOf('Existiert ein OFFENER PR') < p.indexOf('Existiert NUR ein gemergter PR'),
    'OFFEN muss vor GEMERGT geprüft werden — sonst widersprechen sich Bau- und Prüf-Station')
  assert.ok(/rechts durch eine Nicht-Ziffer oder das Zeilenende begrenzt/.test(p),
    'die Idempotenz-Suche muss dieselbe Treffer-Regel benutzen wie die pr-check-Station')
  assert.ok(p.includes('"Closes #4123" ist KEIN Treffer'), 'der Kollisionsfall gehört wörtlich in den Prompt')
})

// 15i. Der Budgetcheck steht bewusst VOR der pr-check-Station (Test 15) — aber
//      er darf den skipped-Zweig nicht mit überholen: ein bereits erledigtes
//      Issue bekäme sonst budget-exceeded, verlöre agent-ready und machte seine
//      Abhängigen über deadBlockers dauerhaft blockiert. Für ein Issue, das
//      fertig ist.
test('Budget-Abbruch überholt den skipped-Pfad nicht', async () => {
  const state = { tokens: 0 }
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2, { blockedBy: [1] })],
    config: cfg({ budgets: { S: { turns: 20, tokens: 1000 }, M: { turns: 40, tokens: 1000 }, L: { turns: 60, tokens: 1000 } } }),
    budget: { spent: () => state.tokens },
    respond: (c) => {
      // Der Deckel misst je Einheit ab ihrem eigenen Start — #2 muss deshalb
      // selbst verbrauchen, sonst wäre die Gegenprobe unten vakuum-grün.
      if (/^build /.test(c.label)) state.tokens += 5000
      if (c.label === 'build #1') return { pr: 0, branch: '', skipped: true, note: 'war schon erledigt' }
      if (c.label === 'pr-check #1') return { found: true, pr: 91, branch: 'feat/1-x', state: 'MERGED' }
      return undefined
    },
  })
  const d1 = doneOf(report, 1)
  assert.equal(d1.skipped, true, 'die gh-belegte Erledigung zählt, nicht der Tokenstand des Builders')
  assert.equal(d1.budgetExceeded, undefined, 'ein erledigtes Issue hat nichts zu bezahlen, was ein Abbruch retten könnte')
  none(calls, /^budget-abort #1$/)
  assert.deepEqual(report.blocked, [], 'der Abhängige darf nicht an einem fertigen Blocker sterben')
  assert.equal(doneOf(report, 2).issue, 2, 'der Abhängige läuft an')
  // Gegenprobe: der reguläre Pfad bleibt gedeckelt (Test 15 prüft ihn im
  // Detail) — hier nur, dass #2 seinerseits sauber abbricht statt durchzulaufen.
  assert.equal(doneOf(report, 2).budgetExceeded, true, 'ohne skipped greift der Deckel unverändert')
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

// 18. Der Breaker zählt ABGESCHLOSSENE Einheiten. Ein requeueter technischer
//     Erstfehler ist keiner: derselbe Runner stuft ihn als transient ein und baut
//     die Einheit neu. Zählte er mit, schlüge der Breaker den eigenen Retry tot —
//     drei Einheiten, die je EINMAL an einer Netz-/Classifier-Zuckung scheitern,
//     hielten einen Lauf an, den 0.7.0 vollständig durchgemergt hat.
test('Circuit-Breaker: drei transiente Erstfehler halten einen gesunden Lauf nicht an', async () => {
  const tries = {}
  const { report, calls } = await runWorkflow({
    units: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => unit(n)),
    config: cfg(),
    respond: (c) => {
      const m = /^build #(\d+)$/.exec(c.label)
      if (!m) return undefined
      const n = Number(m[1])
      tries[n] = (tries[n] || 0) + 1
      if (n <= 3 && tries[n] === 1) throw new Error('gh: server error (transient)')
      return undefined
    },
  })
  assert.equal(report.stopped, null, 'drei einmalige technische Fehler sind kein Grund, den Lauf anzuhalten')
  assert.equal(report.done.length, 8, 'nach dem Retry muss jede Einheit durchlaufen')
  assert.deepEqual(report.failed, [])
  assert.deepEqual(report.remaining, [])
  assert.equal(doneOf(report, 1).pr, 101, 'die requeuete Einheit merged im zweiten Anlauf')
  assert.equal(find(calls, 'build #1').length, 2, 'genau ein Retry je transientem Fehler')
})

// 18b. Gegenprobe zum Retry: eine Serie technischer Fehler brennt die Queue
//      trotzdem nicht leer — der zweite Fehlversuch DERSELBEN Einheit stoppt den
//      Lauf, und zwar mit dem konkreten Fehlertext statt mit dem Breaker-Text.
test('Technische Serie: Stop am zweiten Fehlversuch derselben Einheit, nicht am Breaker', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2), unit(3), unit(4)],
    config: cfg(),
    respond: (c) => { if (/^build /.test(c.label)) throw new Error('Bash-Classifier nicht verfügbar') },
  })
  assert.equal(find(calls, 'build #1').length, 2, 'jede Einheit bekommt ihren einen Retry')
  assert.ok(report.stopped && report.stopped.issue === 1)
  assert.ok(/Bash-Classifier/.test(report.stopped.reason), `Stop-Grund war: ${report.stopped.reason}`)
  assert.ok(!/Fortschritts-Circuit-Breaker/.test(report.stopped.reason),
    'der konkrete Fehler ist der bessere Stop-Grund als der Breaker-Text')
  assert.deepEqual(report.failed, [1])
  assert.deepEqual(report.remaining, [2, 3, 4], 'der Rest bleibt für den nächsten Lauf in der Queue')
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

// 20b. Der Zähler muss zum Zeitpunkt des feststehenden Ausgangs laufen, nicht
//      nach der GitHub-Nachbereitung. Der Erfolgspfad meldet synchron, die
//      Misserfolgspfade lagen hinter `await needsHumanStop(...)` — bei
//      parallelism > 1 sortierte das Misserfolge HINTER Erfolge. Hier ist die
//      echte Ausgangsfolge F(#1), F(#2), S(#3), F(#4): der Merge dazwischen setzt
//      den Zähler zurück, der Lauf ist gesund. Mit aufgeschobenem Increment
//      kommt beim Breaker S, F, F, F an — und er hält denselben Lauf an.
//      Die Verzögerungen sind Wanduhr, nicht Aufrufreihenfolge: nur so ist die
//      Reihenfolge der Ausgänge unabhängig von der Zahl der Stationen je Pfad.
test('Circuit-Breaker: Misserfolge zählen sofort, nicht erst nach dem Admin-Agenten', async () => {
  const { report } = await runWorkflow({
    units: [unit(1), unit(2), unit(3), unit(4)],
    config: cfg({ parallelism: 4 }),
    respond: async (c) => {
      if (/^build #[12]$/.test(c.label)) await sleep(10)
      if (c.label === 'build #3') await sleep(40)
      if (c.label === 'build #4') await sleep(90)
      // Der Admin-Agent der beiden ersten Misserfolge ist langsam — genau das
      // Fenster, in dem der aufgeschobene Increment hinter #3 und #4 rutscht.
      if (/^needs-human #[12]$/.test(c.label)) await sleep(120)
      if (/^ac-verify(\+\d+)? #(1|2|4)$/.test(c.label)) return { pass: false, unmet: ['AC offen'] }
      return undefined
    },
  })
  assert.equal(report.done.length, 4, 'alle vier Einheiten laufen bei parallelism 4 gleichzeitig an')
  assert.equal(doneOf(report, 3).pr, 103, 'der Merge liegt zwischen dem zweiten und dem dritten Misserfolg')
  assert.equal(report.stopped, null,
    'zwei Misserfolge, ein Merge, ein Misserfolg: der Merge setzt zurück — dieser Lauf darf nicht anhalten')
})

// 20c. Der Budget-Arm des Breakers: ein Budget-Abbruch verbrennt Tokens, ohne zu
//      mergen. Ohne diesen Test bleibt `!res.budgetExceeded &&` ungeprüft — der
//      Lauf brennt dann bei falsch kalibrierten Budgets die ganze Queue leer.
test('Circuit-Breaker: drei Budget-Abbrüche in Folge halten den Lauf an', async () => {
  const state = { tokens: 0 }
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2), unit(3), unit(4)],
    config: cfg({ budgets: { S: { turns: 20, tokens: 1000 }, M: { turns: 40, tokens: 1000 }, L: { turns: 60, tokens: 1000 } } }),
    budget: { spent: () => state.tokens },
    respond: (c) => { if (/^build #[123]$/.test(c.label)) state.tokens += 5000 },
  })
  assert.equal(report.tokenMode, 'delta')
  assert.equal(find(calls, 'budget-abort #3').length, 1)
  assert.ok(report.stopped, 'drei gesprengte Budgets in Folge heißen: die Budgets sind falsch kalibriert')
  assert.equal(report.stopped.issue, 3)
  assert.ok(/Fortschritts-Circuit-Breaker/.test(report.stopped.reason), `Stop-Grund war: ${report.stopped.reason}`)
  assert.ok(/Budget-Abbruch ohne Merge/.test(report.stopped.reason),
    'der Stop-Grund muss den auslösenden Zustand benennen, nicht nur die Zahl')
  assert.deepEqual(report.remaining, [4])
  none(calls, /#4\b/)
})

// 20d. Gegenstück: eine gh-BELEGTE Alt-Erledigung ist Fortschritt. Ein
//      Resume-Lauf, dessen erste Einheiten längst gemergt sind, darf nicht am
//      Breaker sterben — sonst kommt niemand mehr an die restliche Queue.
test('Circuit-Breaker: gh-belegte Alt-Erledigungen zählen als Fortschritt', async () => {
  const { report } = await runWorkflow({
    units: [unit(1), unit(2), unit(3), unit(4)],
    config: cfg(),
    respond: (c) => {
      const m = /^(build|pr-check) #(\d+)$/.exec(c.label)
      if (!m || Number(m[2]) > 3) return undefined
      return m[1] === 'build'
        ? { pr: 0, branch: '', skipped: true, note: 'war schon erledigt' }
        : { found: true, pr: 700 + Number(m[2]), branch: `feat/${m[2]}-x`, state: 'MERGED' }
    },
  })
  assert.equal(report.stopped, null, 'drei belegte Erledigungen sind Fortschritt, kein Stillstand')
  assert.equal(report.done.length, 4)
  assert.equal(doneOf(report, 3).skipped, true)
  assert.equal(doneOf(report, 4).pr, 104, 'die vierte Einheit muss noch anlaufen und mergen')
})

// 20e. Der !stopped-Guard: ein schon gesetzter Stop-Grund gewinnt. Ohne ihn
//      überschreibt der Breaker bei parallelism 3–4 den Post-Merge-rot-Grund —
//      /flowkit:status rendert nur stopped.reason, der Revert-Hinweis
//      verschwände aus dem Tagesüberblick.
test('Circuit-Breaker: der Post-Merge-rot-Grund gewinnt gegen den Breaker-Text', async () => {
  const { report } = await runWorkflow({
    units: [unit(1), unit(2), unit(3), unit(4)],
    config: cfg({ parallelism: 4, maxFixRounds: 1, onSmokeFailure: 'revert' }),
    respond: async (c) => {
      if (c.label === 'gate-merge #1') return { merged: true, postMerge: 'red', note: 'run 42 conclusion failure' }
      // Die drei Misserfolge fallen NACH dem roten Post-Merge an (Wanduhr), sonst
      // stünde der Breaker-Grund zu Recht dort.
      if (/^ac-verify(\+\d+)? #(2|3|4)$/.test(c.label)) { await sleep(30); return { pass: false, unmet: ['AC offen'] } }
      return undefined
    },
  })
  assert.equal(report.done.filter((d) => d.needsHuman).length, 3,
    'ohne drei tatsächliche Misserfolge wäre der Test vakuum-grün')
  assert.ok(report.stopped)
  assert.equal(report.stopped.issue, 1)
  assert.ok(/Post-Merge rot/.test(report.stopped.reason), `Stop-Grund war: ${report.stopped.reason}`)
  assert.ok(!/Fortschritts-Circuit-Breaker/.test(report.stopped.reason),
    'der Breaker darf einen bereits gesetzten Stop-Grund nicht überschreiben')
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
// Post-Merge-Dreiwertigkeit (Issue #32)
// ---------------------------------------------------------------------------

// 22. Ein abgebrochener Post-Merge-Lauf ist keine Messung: keine Policy, kein
//     Stop, die Queue läuft weiter. Bis 0.7.0 stoppte genau das den ganzen Lauf.
test('Post-Merge unmeasured: kein Revert-Signal, kein Stop, Lauf fährt fort', async () => {
  const { report, logs } = await runWorkflow({
    units: [unit(1), unit(2)],
    config: cfg(),
    respond: (c) => (c.label === 'gate-merge #1'
      ? { merged: true, postMerge: 'unmeasured', note: 'run 30697078974 cancelled, keine Neubestimmung im Cap' }
      : undefined),
  })
  assert.equal(doneOf(report, 1).postMerge, 'unmeasured')
  assert.equal(report.stopped, null, 'eine fehlende Messung darf den Lauf nicht anhalten')
  assert.equal(doneOf(report, 2).pr, 102, 'die zweite Einheit muss regulär durchlaufen und mergen')
  assert.deepEqual(report.failed, [])
  assert.ok(logs.some((l) => /ohne verwertbares Urteil/.test(l)), 'der unmeasured-Zweig muss im Log stehen')
  assert.ok(logs.some((l) => /run 30697078974 cancelled/.test(l)), 'die note der Station gehört in den Log-Eintrag')
})

// 23. Gegenstück: das Sicherheitsnetz bleibt scharf. Ein BELEGT roter Lauf stoppt
//     weiterhin sofort — die Dreiwertigkeit weicht es nicht auf.
test('Post-Merge red: Policy-Stop bleibt erhalten, keine weiteren Merges', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2)],
    // onSmokeFailure explizit gesetzt: sonst prüfte die Assertion den hartkodierten
    // Fallback 'revert' statt der CONFIG.
    config: cfg({ onSmokeFailure: 'p0-issue' }),
    respond: (c) => (c.label === 'gate-merge #1'
      ? { merged: true, postMerge: 'red', note: 'run 42 conclusion failure' }
      : undefined),
  })
  assert.ok(report.stopped && report.stopped.issue === 1, 'ein belegt roter Post-Merge-Lauf muss den Lauf stoppen')
  assert.ok(/Post-Merge rot/.test(report.stopped.reason), report.stopped.reason)
  assert.ok(/p0-issue/.test(report.stopped.reason), 'der Policy-Name aus der CONFIG gehört in den Stop-Grund')
  assert.equal(doneOf(report, 1).postMerge, 'red')
  none(calls, /^gate-merge #2/)
})

// 23b. Dieselbe Zusage bei parallelism > 1, wo sie erst etwas kostet: #2 hängt
//      beim roten Befund von #1 schon IN der Merge-Kette. `stopped` bremst nur
//      den Start neuer Einheiten — die geparkte Einheit mergte weiter, während
//      der Revert-PR offenstand. Der Post-Merge-Beweis wartet bis zu zehn
//      Minuten im Lock; genau dort laufen die fertigen Einheiten auf.
test('Post-Merge red: die in der Merge-Kette geparkte Einheit merged nicht mehr', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2), unit(3)],
    config: cfg({ parallelism: 2 }),
    respond: async (c) => {
      if (c.label === 'gate-merge #1') {
        // Der Beweis läuft IM Lock — in dieser Zeit reiht sich #2 ein.
        await sleep(30)
        return { merged: true, postMerge: 'red', note: 'run 42 conclusion failure' }
      }
      return undefined
    },
  })
  assert.equal(calls.filter((c) => /^gate-merge /.test(c.label)).length, 1,
    'genau ein Merge — und zwar der von #1')
  only(calls, 'gate-merge #1')
  none(calls, /^gate-merge #2/)
  none(calls, /^merge-diag #2/)
  assert.equal(doneOf(report, 1).postMerge, 'red')
  const d2 = doneOf(report, 2)
  assert.equal(d2.needsHuman, true, 'die geparkte Einheit endet als needs-human, nicht als Merge')
  assert.ok(/Merge nicht ausgeführt/.test(d2.note), `note war: ${d2.note}`)
  assert.ok(/Post-Merge-Beweis für #1/.test(d2.note), 'der Grund muss die auslösende Einheit benennen')
  assert.ok(report.stopped && /Post-Merge rot/.test(report.stopped.reason), `Stop-Grund war: ${report.stopped && report.stopped.reason}`)
  assert.deepEqual(report.remaining, [3], 'nach dem Stop startet keine weitere Einheit')
})

// 24. Ein unbekannter Wert (Schema-Ausrutscher der Engine) fällt in die NICHT
//     destruktive Richtung — nicht nach 'red', also kein Revert ohne Beleg. Und
//     ein stummes 'unmeasured' bekommt einen Ersatztext, sonst steht im Bericht
//     ein Zustand ohne jede Evidenz.
test('Post-Merge: unbekannter Wert wird zu unmeasured normalisiert, note nie leer', async () => {
  const { report, logs } = await runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => (c.label === 'gate-merge #1' ? { merged: true, postMerge: 'grün' } : undefined),
  })
  const d1 = doneOf(report, 1)
  assert.equal(d1.postMerge, 'unmeasured')
  assert.equal(d1.note, 'unmeasured ohne Begründung der Merge-Station')
  assert.equal(report.stopped, null)
  assert.ok(logs.some((l) => /als "unmeasured" gewertet/.test(l)), 'die Normalisierung muss im Log auftauchen')
})

// 25. Die eigentliche Logik lebt im Prompt-String — nur eine Assertion darauf
//     merkt, wenn er später stillschweigend zurückgedreht wird.
test('Merge-Prompt: wartet auf completed, wertet cancelled nicht als Fehlschlag, Obermenge nur grün', async () => {
  const { calls } = await runWorkflow({ units: [unit(1)], config: cfg() })
  const p = only(calls, 'gate-merge #1').prompt
  assert.ok(p.includes('mergeCommit'), 'Anker fehlt: der Beweis hängt am eigenen Merge-Commit')
  assert.ok(p.includes('status == "completed"'), 'der conclusion-Wert darf erst nach Abschluss gelesen werden')
  assert.ok(p.includes('failure oder timed_out = ROT'), 'die rote Menge muss abschließend benannt sein')
  assert.ok(/cancelled/.test(p) && /keine Messung/.test(p), 'cancelled muss ausdrücklich KEIN Fehlschlag sein')
  assert.ok(p.includes('merge-base --is-ancestor'), 'die Neubestimmung über den Obermengen-Lauf fehlt')
  assert.ok(/OBERMENGEN-Lauf/.test(p) && /NIE rot, NIE Revert/.test(p),
    'ein Obermengen-Lauf darf nur grün bestätigen — sein Rot kann von einem fremden Commit stammen')
  assert.ok(p.includes('postMerge: "unmeasured"'), 'der dritte Zustand muss eingefordert werden')
  assert.ok(p.includes('Ausnahme: der Post-Merge-Beweis in Schritt 5'),
    'ohne die Präambel-Ausnahme gewinnt "zügig, keine Nebenaufgaben" und das Warten wird abgekürzt')
  assert.ok(!p.includes('--limit 3'), 'der alte, unverankerte gh-run-list-Aufruf darf nicht stehenbleiben')
})

// 26. Smoke-Zweig des Prompts: der einzige Ort, an dem "roter Smoke = echter
//     roter Befund" steht — cfg() setzt commands.smoke sonst nie.
test('Merge-Prompt: konfigurierter Smoke ist ein echter roter Befund', async () => {
  const { calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg({ commands: { test: 'npm test', lint: 'npm run lint', smoke: 'npm run smoke' } }),
  })
  const p = only(calls, 'gate-merge #1').prompt
  assert.ok(p.includes('UND Smoke grün (npm run smoke'), 'der konfigurierte Smoke muss Teil der Grün-Bedingung sein')
  assert.ok(p.includes('ist das ein echter roter Befund'), 'ein roter Smoke ist ein Beleg, keine fehlende Messung')
  // Gegenprobe: ohne commands.smoke darf der Zweig gar nicht auftauchen.
  const plain = await runWorkflow({ units: [unit(1)], config: cfg() })
  assert.ok(!only(plain.calls, 'gate-merge #1').prompt.includes('UND Smoke grün'),
    'ohne konfigurierten Smoke entfällt der Zweig ersatzlos')
})

// 27. Vertrag zum Schema-Literal (die Mock-Engine validiert NICHT — der Test
//     sichert die Form des Literals, nicht die Akzeptanz durch die echte Engine).
test('GATE_SCHEMA: dreiwertiges postMerge statt boolean postMergeGreen', async () => {
  const { calls } = await runWorkflow({ units: [unit(1)], config: cfg() })
  const s = only(calls, 'gate-merge #1').opts.schema
  assert.ok(s.required.includes('postMerge'), 'postMerge muss Pflichtfeld sein')
  assert.ok(!s.required.includes('postMergeGreen'), 'postMergeGreen entfällt ersatzlos')
  assert.equal(s.properties.postMergeGreen, undefined)
  assert.deepEqual(s.properties.postMerge.enum, ['green', 'red', 'unmeasured'])
  // type NEBEN enum: kein anderes Schema der Datei nutzt bares enum, die
  // Engine-Toleranz dafür ist unverifiziert.
  assert.equal(s.properties.postMerge.type, 'string')
  assert.equal(s.additionalProperties, false, 'der Agent darf den Zustand nicht an der Enum vorbei melden')
})

// 28. Kern von Issue #36: die Diagnose steht VOR der Fix-Runde. Hinge der
//     Re-Run hinter dem Fix-Teil, wäre er wirkungslos — die Fix-Runde ist dann
//     schon verbrannt. Der mergeCheck-Qualifier gehört mit in Schritt 4, sonst
//     löst auch ein rein informativer Check die Diagnose (und den Re-Run) aus.
test('Gate-Wait: Infra-Diagnose und Re-Run stehen vor der Fix-Runde', async () => {
  const { calls } = await runWorkflow({ units: [unit(1)], config: cfg({ mergeCheck: 'coordinator' }) })
  const p = only(calls, 'gate-wait #1').prompt
  assert.ok(/gh run rerun <RUN_ID> --failed -R acme\/demo/.test(p), 'ohne den Re-Run bleibt nur die Fix-Runde')
  assert.ok(/--log-failed \| tail -n 300/.test(p), 'ohne Logauszug ist die Klassifikation Raten')
  for (const s of ['operation timed out', 'Failed to download', 'error sending request for url', 'Could not resolve host', 'The runner has received a shutdown signal']) {
    assert.ok(p.includes(s), `Standard-Signatur fehlt im Prompt: ${s}`)
  }
  assert.ok(p.indexOf('gh run rerun') < p.indexOf('Review-Sticky-Comment'),
    'Diagnose muss VOR der Fix-Runde stehen — dahinter ist die Runde schon verbraucht')
  assert.ok(p.includes('EIN Re-Run JE ROTEM LAUF und HÖCHSTENS ZWEI'),
    '--failed wirkt pro Lauf; ohne den Deckel wiederholt die Station einen reproduzierbaren Setup-Fehler endlos')
  assert.ok(/Bei FAILURE des Checks "coordinator" ZUERST diagnostizieren/.test(p),
    'ohne Qualifier löst jeder informative Check Diagnose und Re-Run aus')
})

// 28b. Die Signaturen sind generische Strings, und `--log-failed` enthält die
//      Ausgabe des gescheiterten Steps im Volltext: als bloßer Teilstring matcht
//      "operation timed out" auch den Testnamen eines legitim fehlschlagenden
//      Timeout-Tests. Der Treffer muss deshalb am Step hängen (der Schritt-4-
//      Befund), nicht am Logauszug — sonst löst ein roter Test einen Re-Run aus
//      und die Station misst denselben roten Test noch einmal.
test('Gate-Wait: die Infra-Signatur zählt nur im vorgelagerten Step, nicht in der Testausgabe', async () => {
  const p = only((await runWorkflow({ units: [unit(1)], config: cfg() })).calls, 'gate-wait #1').prompt
  assert.ok(/hängt am gescheiterten STEP aus Schritt 4, nie am Volltext des Logs/.test(p),
    'ohne Step-Kopplung ist der Signaturtreffer allein hinreichend — genau der Fehlalarm')
  assert.ok(!/ODER der Logauszug enthält eine dieser Signaturen/.test(p),
    'die ODER-Verknüpfung macht den Signaturtreffer wieder allein hinreichend')
  assert.ok(/Eine Signatur ALLEIN reicht nie/.test(p), 'die Regel muss explizit dastehen, nicht implizit aus der Reihenfolge folgen')
  assert.ok(/steht die Signatur in der Ausgabe des Test-\/Lint-\/Review-Aufrufs selbst, ist der Fall INHALTLICH/.test(p),
    'der Fehlalarm-Fall gehört wörtlich in den Prompt — er ist der einzige, den ein Agent sonst falsch klassifiziert')
  assert.ok(/Einzige Ausnahme: der Runner bricht mitten im Step weg/.test(p),
    'ein weggebrochener Runner bleibt Infrastruktur, auch wenn er den Test-Step trifft — sonst kostet er eine Fix-Runde')
  // Die Signaturen selbst bleiben im Prompt (Test 28 prüft die Liste), sie sind
  // jetzt nur Beleg FÜR einen Step statt eigenständiger Auslöser.
  assert.ok(p.includes('ein zusätzlicher Beleg'), 'die Signatur ist Beleg, nicht Auslöser')
})

// 29. Schema-Kopplung: der Prompt darf infraRerun nur verlangen, wenn das Schema
//     es auch durchlässt — additionalProperties: false verwürfe es sonst still,
//     und die Station fiele bei jeder Antwort mit dem Feld technisch aus.
test('Gate-Wait: WAIT_SCHEMA erlaubt infraRerun, ohne es zu erzwingen', async () => {
  const { calls } = await runWorkflow({ units: [unit(1)], config: cfg() })
  const s = only(calls, 'gate-wait #1').opts.schema
  assert.equal(s.properties.infraRerun.type, 'boolean')
  assert.deepEqual(s.required, ['green'], 'infraRerun bleibt optional — ohne Re-Run antwortet die Station weiter gültig')
  assert.equal(s.additionalProperties, false, 'genau deshalb muss das Feld deklariert sein')
})

// 30. Der Re-Run muss im Bericht und im Protokoll ankommen, ohne eine Fix-Runde
//     zu kosten — sonst hätte die Ausnahme vom maxFixRounds-Automaten keine Spur.
test('Gate-Wait: infraRerun landet in gateDiag und im LOG, ohne eine Fix-Runde zu verbrauchen', async () => {
  const { report, calls, logs } = await runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => (/^gate-wait /.test(c.label) ? { green: true, infraRerun: true } : undefined),
  })
  assert.equal(doneOf(report, 1).gateDiag.infraRerun, true)
  assert.equal(doneOf(report, 1).fixRounds, 0, 'ein Infra-Re-Run darf keine Fix-Runde kosten')
  assert.ok(logs.some((l) => /CI-Infrastruktur-Re-Run/.test(l)), 'LOG zum Re-Run fehlt')
  assert.ok(!logs.some((l) => /Infrastruktur-Re-Run.*von \d+ verbraucht/.test(l)),
    'die Station meldet keine Runden zurück — eine Runden-Buchführung im LOG wäre erfunden')
  none(calls, /^fix\d+ #1/)
  assert.equal(report.stopped, null)
})

// 31. Der Schadensfall, für den das Feld gebaut wurde: Re-Run passiert, die
//     Checks bleiben trotzdem rot. Genau hier ging die Information in der
//     ursprünglichen Fassung verloren (Auswertung erst NACH dem Wurf) — der
//     Operator sähe die flakige CI dann nur im Erfolgsfall.
test('Gate-Wait: infraRerun überlebt den GATE-Pfad bis in den needs-human-Kommentar', async () => {
  const { report, calls, logs } = await runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => (/^gate-wait /.test(c.label)
      ? { green: false, draftAtEntry: false, runsFound: 3, retriggered: false, infraRerun: true, note: 'nach dem Re-Run erneut rot' }
      : undefined),
  })
  const d1 = doneOf(report, 1)
  assert.equal(d1.needsHuman, true)
  assert.ok(/CI-Infrastruktur-Re-Run: ausgeführt/.test(d1.note), 'der Re-Run fehlt in der GATE-Meldung')
  assert.ok(/CI-Infrastruktur-Re-Run: ausgeführt/.test(only(calls, 'needs-human #1').prompt),
    'der Operator liest den Issue-Kommentar, nicht den JSON-Bericht')
  assert.ok(logs.some((l) => /CI-Infrastruktur-Re-Run/.test(l)), 'auch im Schadensfall gehört der Re-Run ins Protokoll')
})

// 32. Die Operator-Zusage "der Re-Run zählt nicht auf maxFixRounds" ist erst dann
//     etwas wert, wenn sie bei ERSCHÖPFTEM Fix-Budget noch gilt: genau dort ging
//     die Einheit bisher wegen eines Paketdownloads auf needs-human.
test('Gate-Wait: Infra-Re-Run bleibt bei erschöpftem Fix-Budget erlaubt (rounds = 0)', async () => {
  let acCalls = 0
  const { report, calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg({ maxFixRounds: 1 }),
    respond: (c) => (/^ac-verify/.test(c.label) ? (acCalls++ === 0 ? { pass: false, unmet: ['AC offen'] } : { pass: true, unmet: [] }) : undefined),
  })
  assert.equal(doneOf(report, 1).fixRounds, 1, 'Aufbau gepinnt: genau eine Fix-Runde verbraucht')
  const p = only(calls, 'gate-wait #1').prompt
  assert.ok(p.includes('Maximal 0 Runde(n)'), 'Aufbau gepinnt: das Fix-Budget ist erschöpft')
  assert.ok(/gh run rerun/.test(p), 'der Infra-Re-Run muss auch ohne Fix-Runden verfügbar bleiben')
  assert.ok(p.includes('auch bei 0 verbleibenden Fix-Runden erlaubt'))
})

// 33. ciInfraSignatures ERGÄNZT die eingebauten Signaturen. Die zweite Assertion
//     ist der Wächter gegen `INFRA_SIG = C.ciInfraSignatures || DEFAULT`, das
//     eine gesetzte Config die Standards still abschalten ließe.
test('ciInfraSignatures: eigene Signaturen ergänzen die Standards, statt sie zu ersetzen', async () => {
  const { calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg({ ciInfraSignatures: ['self-hosted runner lost communication'] }),
  })
  const p = only(calls, 'gate-wait #1').prompt
  assert.ok(p.includes('self-hosted runner lost communication'), 'eigene Signatur fehlt im Prompt')
  assert.ok(p.includes('Could not resolve host'), 'eigene Signaturen dürfen die Standards nicht ersetzen')
})

// 34. Fehlkonfiguration kehrt die Schutzwirkung um: ein Leerstring ist Teilstring
//     JEDES Logs und würde jeden roten Check als Infrastruktur werten — die
//     inhaltliche Prüfung des Gates wäre ausgehebelt. Muss laut abbrechen.
test('ciInfraSignatures: unbrauchbarer Wert bricht ab statt still zu wirken', async () => {
  await assert.rejects(
    () => runWorkflow({ units: [unit(1)], config: cfg({ ciInfraSignatures: 'operation timed out' }) }),
    /ciInfraSignatures muss ein Array nicht-leerer Strings sein/,
  )
  await assert.rejects(
    () => runWorkflow({ units: [unit(1)], config: cfg({ ciInfraSignatures: ['ok', '  '] }) }),
    /ciInfraSignatures muss ein Array nicht-leerer Strings sein/,
  )
})

// 35. Prompt und Allowlist werden getrennt gepflegt; ihr Auseinanderlaufen
//     erzeugt den Fehlermodus, den kein anderer Test sieht: ein Fix, der im
//     beaufsichtigten Test funktioniert und nachts am Permission-Prompt steht.
test('Allowlist-Kohärenz: gh run rerun und tail sind im settings-Template erlaubt', async () => {
  const tpl = readFileSync(new URL('../templates/settings.json.template', import.meta.url), 'utf8')
  const p = only((await runWorkflow({ units: [unit(1)], config: cfg() })).calls, 'gate-wait #1').prompt
  assert.ok(/gh run rerun/.test(p), 'Gate-Wait ruft kein gh run rerun auf')
  assert.ok(/"Bash\(gh run rerun\*?\)"/.test(tpl), 'settings.json.template erlaubt kein gh run rerun')
  // Die Permission-Prüfung zerlegt Pipelines: `| tail` prompted genauso wie das
  // gh-Kommando davor.
  assert.ok(/\| tail -n/.test(p), 'der Logauszug läuft über eine tail-Pipe')
  assert.ok(/"Bash\(tail \*\)"/.test(tpl), 'settings.json.template erlaubt kein tail')
})

// 35b. Gegenrichtung zu 35: eine Allow-Regel darf nicht MEHR erlauben als der
//      Prompt braucht. Allow-Regeln sind Präfix-Matches je Teilbefehl — ohne
//      Leerzeichen vor dem `*` fehlt die Wortgrenze (`Bash(tail*)` deckt auch
//      `tailscale …` ab), und bei einem Interpreter mit freiem Argument fällt
//      die Allowlist als Ganzes: `awk 'BEGIN{system("…")}'` führt jeden Befehl
//      aus. Der einzige reale awk-Bedarf ist der malformed-tree-Check, deshalb
//      steht awk nur wörtlich in der Liste.
test('Allowlist-Härte: keine Präfix-Regel ohne Wortgrenze, awk nur wörtlich', async () => {
  const tpl = readFileSync(new URL('../templates/settings.json.template', import.meta.url), 'utf8')
  // {{STACK_ALLOW}} steht als nackter Platzhalter im Template (deshalb ist es
  // selbst kein valides JSON); mit einem Beispieleintrag dafür muss der Rest
  // parsebar sein — sonst installiert setup.md ein kaputtes settings.json.
  const parsed = JSON.parse(tpl.replace('{{STACK_ALLOW}}', '"Bash(uv run *)"'))
  const rules = parsed.permissions.allow
    .filter((r) => r.startsWith('Bash(')).map((r) => r.slice(5, -1))
  assert.ok(rules.length > 20, `Allow-Regeln nicht gefunden (${rules.length})`)
  for (const r of rules) {
    assert.ok(!/^[^\s]*[^\s*]\*/.test(r),
      `Allow-Regel "Bash(${r})" klebt das * an den Befehlsnamen: ohne Leerzeichen davor fehlt die Wortgrenze und ein fremder Befehl mit demselben Präfix ist mit erlaubt (tail* → tailscale)`)
  }
  for (const r of rules) {
    // Programmtext-Interpreter: das erste Argument IST der Code, jedes `*` darin
    // ist gleichbedeutend mit `Bash(*)`. Nur wörtliche Regeln zulässig.
    assert.ok(!/^(awk|gawk|mawk|sed)([\s'"]|$)/.test(r) || !r.includes('*'),
      `Allow-Regel "Bash(${r})" gibt einen Programmtext-Interpreter mit Platzhalter frei — awk 'BEGIN{system("…")}' führt damit jeden Befehl aus`)
    // Skript-Interpreter: ein Pfadpräfix grenzt ein, ein `*` direkt hinter dem
    // Interpreter nicht.
    assert.ok(!/^(sh|bash|zsh|ksh|dash|python[0-9.]*|perl|ruby|node|env|xargs)[\s]+\*/.test(r),
      `Allow-Regel "Bash(${r})" gibt einen Interpreter mit freiem ersten Argument frei — damit ist jeder Befehl erlaubt`)
  }
  const p = only((await runWorkflow({ units: [unit(1)], config: cfg() })).calls, 'gate-merge #1').prompt
  const awkCall = (p.match(/awk '[^']*'/) || [])[0]
  assert.ok(awkCall, 'der malformed-tree-Check im gate-merge-Prompt ruft kein awk mehr auf')
  assert.ok(tpl.includes(`"Bash(${awkCall})"`),
    `settings.json.template deckt den einzigen awk-Aufruf des Prompts (${awkCall}) nicht wörtlich ab`)
})

// 35c. Die Härte-Prüfung aus 35b greift nur beim ERSTEN Wort einer Regel: in
//      `Bash(git merge*)` steht vor dem `*` ein Leerzeichen-getrenntes zweites
//      Wort, der Regex `^[^\s]*[^\s*]\*` findet dort nichts. Genau dort saß
//      Issue #42: der Stern klebt am UNTERBEFEHL statt hinter einer Wortgrenze,
//      und `git merge*` deckt damit auch `git mergetool` ab — ein Kommando, das
//      über `mergetool.<tool>.cmd` eine frei wählbare Kommandozeile startet, die
//      aus einer `.git/config` stammen kann, die der Runner nicht geschrieben
//      hat. `git difftool` (aus `git diff*`) ist derselbe Fall.
//
//      Geprüft wird deshalb je Regel der Form `<prog> [<topic> ]<sub>*`, wie
//      viele ECHTE Unterbefehle mit `<sub>` beginnen. Mehr als einer heißt: die
//      Regel gibt mehr frei als ihr Name sagt, und sie muss ausdrücklich als
//      bewusst weit markiert sein (WIDE_SUBCOMMAND_PREFIXES, mit Begründung).
//
//      Das Register ist bewusst statisch statt aus `git --list-cmds` / `gh --help`
//      erhoben: der Test soll auf jedem Runner dasselbe Ergebnis liefern und
//      nicht davon abhängen, welche git-Version oder welche gh-Extensions dort
//      zufällig installiert sind. Preis dafür ist Pflege — deshalb lässt eine
//      Regel für einen Namensraum OHNE Registereintrag den Test failen, statt
//      still durchzulaufen.
const SUBCOMMAND_REGISTRY = {
  // git 2.51 (`git --list-cmds=main,others,nohelpers`), erhoben 2026-08-06.
  git: 'add am annotate apply archimport archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree config count-objects credential credential-cache credential-netrc credential-osxkeychain credential-store cvsexportcommit cvsimport cvsserver daemon describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects gc get-tar-commit-id grep hash-object help hook http-backend http-fetch http-push imap-send index-pack init init-db instaweb interpret-trailers jump last-modified log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-octopus merge-one-file merge-ours merge-recursive merge-recursive-ours merge-recursive-theirs merge-resolve merge-subtree merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes p4 pack-objects pack-redundant pack-refs patch-id pickaxe prune prune-packed pull push quiltimport range-diff read-tree rebase receive-pack reflog refs remote remote-ext remote-fd remote-ftp remote-ftps remote-http remote-https repack replace replay repo request-pull rerere reset restore rev-list rev-parse revert rm send-email send-pack shell shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule subtree switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree',
  // gh 2.96.0 (`gh --help`), erhoben 2026-08-06, plus die beiden Extensions,
  // die das Template selbst freigibt (gh-milestone, gh-sub-issue) — ohne sie
  // stünden deren Regeln ohne Registereintrag da.
  gh: 'accessibility actions alias api attestation auth browse cache codespace completion config extension gist gpg-key issue label milestone org pr preview project release repo ruleset run search secret ssh-key status sub-issue variable workflow',
  // gh 2.96.0, je `gh <topic> --help`, erhoben 2026-08-06.
  'gh issue': 'close comment create delete develop edit list lock pin reopen status transfer unlock unpin view',
  'gh pr': 'checkout checks close comment create diff edit list lock merge ready reopen revert review status unlock update-branch view',
  'gh run': 'cancel delete download list rerun view watch',
  'gh label': 'clone create delete edit list',
  // gh-milestone v2.2.0 / gh-sub-issue v0.5.1, je `--help`, erhoben 2026-08-06.
  'gh milestone': 'completion create delete edit help list view',
  'gh sub-issue': 'add completion create help list remove',
}
// Regel → Begründung, warum die Präfix-Kollision hier tragbar ist. Ein Eintrag
// ohne passende Regel im Template ist ebenfalls ein FAIL: eine Ausnahmeliste,
// die alte Zusagen konserviert, verliert ihre Aussagekraft.
const WIDE_SUBCOMMAND_PREFIXES = {
  'git commit': 'zusätzlich getroffen: commit-graph, commit-tree — beide Plumbing, die nur Objekte in .git schreiben und kein externes Programm starten; `git commit --no-verify` fängt zusätzlich der PreToolUse-Hook',
  'git fetch': 'zusätzlich getroffen: fetch-pack — read-only Transport-Plumbing ohne Schreibzugriff auf das Arbeitsverzeichnis',
}
test('Allowlist-Härte: Unterbefehls-Präfixe treffen genau einen Unterbefehl (#42)', async () => {
  const tpl = readFileSync(new URL('../templates/settings.json.template', import.meta.url), 'utf8')
  const parsed = JSON.parse(tpl.replace('{{STACK_ALLOW}}', '"Bash(uv run *)"'))
  const rules = parsed.permissions.allow
    .filter((r) => r.startsWith('Bash(')).map((r) => r.slice(5, -1))
  const seenWide = new Set()
  for (const r of rules) {
    // Nur Regeln, deren LETZTES Wort ein reiner Bezeichner mit anklebendem `*`
    // ist — `Bash(gh api repos/*/branches/*/protection)` endet auf einen
    // Pfadausdruck ohne Stern und fällt nicht in diese Klasse.
    const m = r.match(/^([a-z][a-z0-9-]*)(?: ([a-z][a-z0-9-]*))? ([a-z][a-z0-9-]*)\*$/)
    if (!m) continue
    const [, prog, topic, sub] = m
    if (prog !== 'git' && prog !== 'gh') continue
    const ns = topic ? `${prog} ${topic}` : prog
    const known = SUBCOMMAND_REGISTRY[ns]
    assert.ok(known,
      `Allow-Regel "Bash(${r})" betrifft den Namensraum "${ns}", für den SUBCOMMAND_REGISTRY keine Unterbefehlsliste hat — ohne Liste prüft diese Assertion ins Leere. Liste ergänzen (Quelle und Erhebungsdatum im Kommentar vermerken).`)
    const hits = known.split(' ').filter((c) => c.startsWith(sub))
    const key = `${ns} ${sub}`
    if (hits.length > 1) seenWide.add(key)
    assert.ok(hits.length === 1 || key in WIDE_SUBCOMMAND_PREFIXES,
      `Allow-Regel "Bash(${r})" ist ein Präfix-Match und trifft ${hits.length} Unterbefehle statt einen: ${hits.join(', ')}. Entweder die Regel auf den gemeinten Aufruf eingrenzen (z. B. "${ns} ${sub} <argumentpräfix>*" oder die wörtliche Form) oder sie in WIDE_SUBCOMMAND_PREFIXES mit Begründung eintragen.`)
  }
  for (const key of Object.keys(WIDE_SUBCOMMAND_PREFIXES)) {
    assert.ok(seenWide.has(key),
      `WIDE_SUBCOMMAND_PREFIXES führt "${key}" als bewusst weit, aber im Template gibt es keine kollidierende Regel dieser Form mehr — Eintrag entfernen, sonst deckt die Ausnahmeliste Regeln ab, die es nicht gibt.`)
  }
})

// 35d. Gegenrichtung zu 35c: die Eingrenzung darf dem Runner nicht die
//      Kommandos wegnehmen, die er wirklich fährt. Die Liste unten stammt aus
//      workflows/implement.workflow.js (BEHIND-Update in Gate-Wait und
//      Merge-Station, Konfliktabbruch) — ohne diese Gegenprobe wäre "Loch
//      geschlossen" mit "Runner gebrochen" verwechselbar.
test('Allowlist deckt die git-merge-Aufrufe des Runners weiterhin ab (#42)', async () => {
  const tpl = readFileSync(new URL('../templates/settings.json.template', import.meta.url), 'utf8')
  const parsed = JSON.parse(tpl.replace('{{STACK_ALLOW}}', '"Bash(uv run *)"'))
  const rules = parsed.permissions.allow
    .filter((r) => r.startsWith('Bash(')).map((r) => r.slice(5, -1))
  // Präfix-Semantik der Permission-Ebene nachgebaut: eine Regel mit `*` am Ende
  // deckt jeden Befehl ab, der mit dem Text davor beginnt; eine Regel ohne `*`
  // nur den wörtlich gleichen Befehl.
  const covered = (cmd) => rules.some((r) => (r.endsWith('*') ? cmd.startsWith(r.slice(0, -1)) : cmd === r))
  for (const cmd of ['git merge origin/main', 'git merge origin/develop', 'git merge --abort']) {
    assert.ok(covered(cmd), `Allowlist deckt "${cmd}" nicht mehr ab — der Runner braucht diesen Aufruf`)
  }
  for (const cmd of ['git mergetool', 'git mergetool --tool=vimdiff', 'git merge-file a b c', 'git merge-tree x y', 'git difftool', 'git difftool --extcmd=id']) {
    assert.ok(!covered(cmd), `Allowlist deckt "${cmd}" ab — dieser Unterbefehl startet ein frei konfigurierbares externes Programm und darf nicht mit freigegeben sein`)
  }
  assert.ok(covered('git diff --name-only --diff-filter=U'), 'Allowlist deckt den Konfliktdatei-Aufruf des Runners nicht mehr ab')
})

// ---------------------------------------------------------------------------
// Abbruchpfade ohne Draft, Merge-Guard (Issue #35)
// ---------------------------------------------------------------------------

// 36. Der frühere Draft-Zustand nahm dem PR die Deep-Review-Pipeline (ihr
//     prep-Job ist auf draft == false gefiltert) — genau das Urteil, das der
//     Mensch beim Übernehmen braucht. Das Signal "nicht mergen" wandert deshalb
//     auf ein Label plus einen Abbruchkommentar, der PR bleibt ready.
//     Die Einheit trägt bewusst die Kollisionsnummer #41: an dieser Station wird
//     an einen FREMDEN PR geschrieben, wenn die Treffer-Verifikation zu weich ist
//     ("Closes #4123" enthält "Closes #41").
test('needs-human: Label + Abbruchkommentar am PR statt Draft-Rücksetzung', async () => {
  const { calls } = await runWorkflow({
    units: [unit(41)],
    config: cfg(),
    respond: (c) => (/^ac-verify(\+\d+)? #41$/.test(c.label) ? { pass: false, unmet: ['AC offen'] } : undefined),
  })
  const p = only(calls, 'needs-human #41').prompt
  assert.ok(/gh pr edit <N> -R acme\/demo --add-label needs-human/.test(p), 'Label am PR fehlt')
  assert.ok(/gh pr comment <N> -R acme\/demo/.test(p), 'Abbruchkommentar am PR fehlt')
  assert.ok(/<!-- flowkit-abort:v1 -->/.test(p), 'Abbruch-Marker fehlt')
  // Die Verifikationsregel muss dieselbe sein wie in der pr-check-Station:
  // "Body enthält Closes #41" allein ist für "Closes #4123" erfüllt, und dann
  // landen Label und Abbruchkommentar auf dem PR einer unbeteiligten Einheit.
  assert.ok(/rechts durch eine Nicht-Ziffer oder das Zeilenende begrenzt/.test(p),
    'ohne die rechte Begrenzung trifft die Verifikation auch #41XX — hier wird an einen FREMDEN PR geschrieben')
  assert.ok(p.includes('"Closes #4123" ist KEIN Treffer'),
    'der Kollisionsfall gehört wörtlich in den Prompt, nicht in eine abstrakte Regel')
  assert.ok(/MEHR ALS EIN verifizierter Treffer[\s\S]{0,120}NICHTS ändern/.test(p),
    'bei zwei verifizierten Treffern darf am PR nichts mutiert werden — welcher gemeint ist, ist nicht zu raten')
  assert.ok(/gh issue comment 41 -R acme\/demo die Mehrdeutigkeit/.test(p),
    'die Mehrdeutigkeit muss trotzdem irgendwo landen: am Issue, dem einzigen eindeutigen Träger')
  // Regressionsnetz gegen ein Wiedereinführen des Draft-Setzens an dieser
  // Station. Seit der Gate-Wait-Re-Trigger das BEHIND-Update ist (Issue #34,
  // live gemessen), hat kein Prompt des Workflows mehr ein `--undo`; Test 8c2
  // hält die Gate-Wait-Seite derselben Regel.
  assert.ok(!/--undo/.test(p), 'der needs-human-Prompt darf den PR nicht mehr per --undo auf Draft setzen')
})

// 37. Gegenstück für den Budget-Pfad. (e) ist zugleich der TDZ-Guard: budgetStop
//     läuft auch VOR dem Build (Zeile ~435, "nach Planner") — `const pr` liegt
//     dort in der Temporal Dead Zone, die PR-Nummer muss also aus dem
//     gh-Aufruf im Prompt kommen, nie interpoliert werden.
test('Budget-Abbruch: Label + Abbruchkommentar am PR statt Draft-Rücksetzung', async () => {
  const state = { tokens: 0 }
  const { calls } = await runWorkflow({
    units: [unit(41)],
    config: cfg({ budgets: { S: { turns: 20, tokens: 1000 }, M: { turns: 40, tokens: 1000 }, L: { turns: 60, tokens: 1000 } } }),
    budget: { spent: () => state.tokens },
    respond: (c) => { if (c.label === 'build #41') state.tokens += 5000 },
  })
  const p = only(calls, 'budget-abort #41').prompt
  assert.ok(/gh pr edit <N> -R acme\/demo --add-label budget-exceeded/.test(p), 'Label am PR fehlt')
  assert.ok(/gh pr comment <N> -R acme\/demo/.test(p), 'Abbruchkommentar am PR fehlt')
  assert.ok(/<!-- flowkit-abort:v1 -->/.test(p), 'Abbruch-Marker fehlt')
  assert.ok(!/--undo/.test(p), 'der Budget-Abbruch darf den PR nicht mehr per --undo auf Draft setzen')
  assert.ok(/gh pr list -R acme\/demo --search "Closes #41" --state open/.test(p),
    'die PR-Nummer muss weiterhin über gh gesucht werden, nicht aus ${pr} interpoliert')
  // Identische Regel wie im needs-human-Pfad: beide mutieren einen per
  // Volltextsuche gefundenen PR, beide laufen auf haiku ohne Schema.
  assert.ok(/rechts durch eine Nicht-Ziffer oder das Zeilenende begrenzt/.test(p),
    'ohne die rechte Begrenzung trifft die Verifikation auch #41XX — Label und Kommentar landen auf einem fremden PR')
  assert.ok(p.includes('"Closes #4123" ist KEIN Treffer'),
    'der Kollisionsfall gehört wörtlich in den Prompt, nicht in eine abstrakte Regel')
  assert.ok(/MEHR ALS EIN verifizierter Treffer[\s\S]{0,120}NICHTS ändern/.test(p),
    'bei zwei verifizierten Treffern darf am PR nichts mutiert werden')
  assert.ok(/gh issue comment 41 -R acme\/demo die Mehrdeutigkeit/.test(p),
    'die Mehrdeutigkeit muss am Issue gemeldet werden, dem einzigen eindeutigen Träger')
})

// 38. Bisher löschte `gh pr ready` beim Übernehmen das Abbruch-Signal implizit
//     mit. Wandert es auf ein Label, muss der Builder es jetzt selbst entfernen
//     — sonst trägt ein per resume fortgeführter, gemergter PR das Label ewig.
test('Builder-Idempotenz: übernommener PR verliert die Abbruch-Labels', async () => {
  const { calls } = await runWorkflow({ units: [unit(1)], config: cfg() })
  const p = only(calls, 'build #1').prompt
  assert.ok(/gh pr edit <NUMMER> -R acme\/demo --remove-label needs-human --remove-label budget-exceeded/.test(p),
    'der Idempotenz-Schritt muss die Abbruch-Labels beim Übernehmen entfernen')
  assert.ok(/ist der PR Draft: gh pr ready <NUMMER> -R acme\/demo/.test(p),
    'das ready-Setzen übernommener Drafts (frühere flowkit-Versionen, Menschen) darf nicht mit entfernt werden')
})

// 39. Der Draft-Zustand war ein HARTES Merge-Hindernis (gh pr merge verweigert
//     Drafts), ein Label ist es nicht — ohne diesen Guard würde ein PR, dessen
//     Abbruch-Label beim Übernehmen nicht entfernt wurde, stumm durchgemergt.
test('Merge-Station: Abbruch-Labels am PR blocken den Merge', async () => {
  const { calls } = await runWorkflow({ units: [unit(1)], config: cfg() })
  const p = only(calls, 'gate-merge #1').prompt
  assert.ok(/kein needs-human- und kein budget-exceeded-Label auf dem PR/.test(p), 'Merge-Guard fehlt')
  assert.ok(/gh pr view 101 -R acme\/demo --json labels/.test(p), 'die Prüfung muss den Live-Zustand des PR lesen, nicht Prosa glauben')
  assert.ok(/Abbruch-Signal[\s\S]{0,240}blocked: "abort-label"/.test(p),
    'ein gefundenes Abbruch-Label braucht einen schema-gültigen Ausgang — sonst bleibt dem Agenten nur merged: false')
  assert.ok(/blocked: "conflict"/.test(p), 'derselbe Ausgang fehlt dem semantischen Merge-Konflikt')
  const s = only(calls, 'gate-merge #1').opts.schema
  assert.deepEqual(s.properties.blocked.enum, ['none', 'abort-label', 'conflict'],
    'Prompt und Schema gehören in denselben Commit: additionalProperties: false verwürfe das Feld sonst still')
  assert.equal(s.properties.blocked.type, 'string')
  assert.ok(!s.required.includes('blocked'),
    'blocked bleibt optional — ein Agent, der stattdessen wie bisher wirft, antwortet weiter gültig')
})

// 39b. Der Prompt verlangte einen GATE:-Wurf für einen Ausgang, den das
//      GATE_SCHEMA (additionalProperties: false) gar nicht kannte — schema-gültig
//      blieb nur merged:false, und das routet seit 0.8.0 in die Merge-Diagnose.
//      Die liest weder Labels noch Mergebarkeit: sie sieht OPEN/grün/fertig und
//      lässt den Operator "PR ist grün und fertig, es fehlt nur die
//      Merge-Freigabe" lesen — die Aufforderung, genau den PR von Hand zu
//      mergen, den ein früherer Lauf gesperrt hat. main war hier robuster.
test('Merge bewusst nicht ausgeführt: blocked führt zu needs-human, nie zu merge-blocked', async () => {
  for (const [blocked, wort] of [['abort-label', 'Abbruch-Label'], ['conflict', 'semantischer Merge-Konflikt']]) {
    const { report, calls } = await runWorkflow({
      units: [unit(1)],
      config: cfg(),
      respond: (c) => (/^gate-merge /.test(c.label)
        ? { merged: false, blocked, postMerge: 'unmeasured', note: 'Beleg der Station' }
        : undefined),
    })
    const d1 = doneOf(report, 1)
    assert.equal(d1.needsHuman, true, `blocked=${blocked} muss needs-human sein`)
    assert.equal(d1.mergeBlocked, undefined, 'ein bewusster Nicht-Merge ist NICHT der extern blockierte Merge')
    assert.ok(d1.note.startsWith('GATE:'), 'ohne GATE:-Präfix wäre es ein technischer Fehler mit Requeue')
    assert.ok(d1.note.includes(wort), `der Grund muss im Issue-Kommentar stehen: ${wort}`)
    assert.ok(d1.note.includes('Beleg der Station'), 'die note der Merge-Station geht nicht verloren')
    none(calls, /^merge-diag /) // die Diagnose kennt den Grund nicht und würde ihn übermalen
    none(calls, /^merge-blocked /)
    only(calls, 'needs-human #1')
    assert.equal(report.stopped, null, 'ein needs-human hält den Lauf nicht an')
  }
})

// 39c. Gegenprobe: blocked ist NICHT die neue Klassifikation für jeden
//      Nicht-Merge. Der Hauptfall aus #37 (Harness hält die Station an, kein
//      blocked) muss weiterhin über die Diagnose laufen — sonst hätte der Fix
//      den merge-blocked-Zustand mit erschlagen.
test('blocked: "none" ändert nichts — der angehaltene Merge bleibt merge-blocked', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => (/^gate-merge /.test(c.label) ? { merged: false, blocked: 'none', postMerge: 'unmeasured' } : undefined),
  })
  assert.equal(doneOf(report, 1).mergeBlocked, true)
  only(calls, 'merge-diag #1')
})

// ---------------------------------------------------------------------------
// Merge-Diagnose und der Zustand merge-blocked (Issue #37)
// ---------------------------------------------------------------------------

// 40. Der Hauptfall des Issues: die Harness hält die Merge-Station an, agent()
//     liefert null. Bis 0.7.0 stand daraufhin "kein Ergebnis" im Issue — ohne
//     jede Aussage darüber, ob der PR grün und fertig oder rot ist.
test('Merge extern blockiert: gate-merge ohne Ergebnis + grüner PR → merge-blocked', async () => {
  const { report, calls, logs } = await runWorkflow({
    units: [unit(1), unit(2)],
    config: cfg({ mergeCheck: 'coordinator' }),
    respond: (c) => {
      if (c.label === 'gate-merge #1') return null
      if (c.label === 'merge-diag #1') {
        return { prState: 'OPEN', merged: false, checksGreen: 19, checksRed: 0, checksPending: 0, mergeCheckState: 'SUCCESS', note: 'coordinator SUCCESS, Merge nicht ausgeführt' }
      }
      return undefined
    },
  })
  const diag = only(calls, 'merge-diag #1')
  assert.equal(diag.opts.model, 'haiku', 'die Diagnose ist eine Lese-Station — sie gehört auf das billigste Modell')
  assert.ok(/KEIN gh pr merge/.test(diag.prompt), 'die Read-only-Eigenschaft muss im Prompt stehen, sonst löst die Diagnose denselben Block erneut aus')
  assert.ok(!/gh pr merge 101/.test(diag.prompt), 'die Diagnose darf keinen Merge-Befehl mit PR-Nummer enthalten')
  assert.ok(/gh pr view 101 -R acme\/demo --json number,state,mergedAt/.test(diag.prompt), 'mergedAt ist der einzige Beleg für "gemergt"')
  assert.ok(/gh pr checks 101/.test(diag.prompt), 'die Check-Zählung fehlt')
  const stop = only(calls, 'merge-blocked #1')
  assert.ok(/--add-label merge-blocked/.test(stop.prompt), 'das Label ist das einzige Signal auf GitHub')
  assert.ok(!/--undo/.test(stop.prompt), 'der PR darf auch hier nicht auf Draft zurückgesetzt werden')
  assert.ok(!/gh pr merge 101/.test(stop.prompt), 'dieser Pfad mergt NICHTS — auch nicht als zitierter Befehl im Kommentartext')
  none(calls, /^needs-human /)
  none(calls, /^cleanup #1$/)
  none(calls, /^learnings #1$/)
  const d1 = doneOf(report, 1)
  assert.equal(d1.mergeBlocked, true)
  assert.equal(d1.pr, 101)
  assert.ok(!d1.needsHuman, 'ein blockierter Merge ist kein inhaltliches Scheitern')
  assert.ok(/rot 0/.test(d1.note) && /coordinator/.test(d1.note), `der gelesene Zustand gehört in die note: ${d1.note}`)
  assert.ok(!/kein Ergebnis/.test(d1.note), 'genau dieser Text war der Befund des Issues')
  assert.equal(report.stopped, null, 'der LAUF fährt fort')
  assert.deepEqual(report.failed, [])
  assert.equal(doneOf(report, 2).pr, 102, 'die zweite Einheit muss regulär durchlaufen')
  assert.ok(logs.some((l) => /extern merge-blockiert/.test(l)), 'der Bericht muss "extern blockiert" von "gescheitert" unterscheiden')
})

// 40b. Formtest des MERGE_STATE_SCHEMA — bis hierher hatte es keinen (vier
//      Mutationen: required gekürzt, additionalProperties: true, schema am
//      Aufruf gestrichen, Feld entfernt — alle vakuum-grün). Die Verzweigung in
//      runUnit liest jedes dieser Felder wörtlich; fehlt eines still, kippt sie
//      auf die falsche Seite: ohne checksPending gilt ein PR mit drei laufenden
//      Checks als "grün und fertig" und der Operator mergt ungeprüft von Hand.
test('MERGE_STATE_SCHEMA: Form des Literals trägt die Verzweigung', async () => {
  const { calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg({ mergeCheck: 'coordinator' }),
    respond: (c) => (c.label === 'gate-merge #1' ? null : undefined),
  })
  const s = only(calls, 'merge-diag #1').opts.schema
  assert.ok(s, 'ohne schema am Aufruf antwortet die Diagnose in Prosa — genau das sollte sie ersetzen')
  assert.equal(s.type, 'object')
  assert.deepEqual(s.required, ['prState', 'merged', 'checksGreen', 'checksRed', 'checksPending', 'mergeCheckState'],
    'jedes dieser Felder steht in der merge-blocked-Bedingung; ein fehlendes wäre undefined und die Bedingung falsch')
  assert.equal(s.additionalProperties, false, 'der Agent darf den PR-Zustand nicht an den Feldern vorbei melden')
  assert.equal(s.properties.merged.type, 'boolean')
  for (const f of ['checksGreen', 'checksRed', 'checksPending']) {
    assert.equal(s.properties[f].type, 'integer', `${f} muss zählbar sein — ein String verglich sich gegen 0 falsch`)
  }
  assert.ok(!s.required.includes('note'), 'note bleibt optional; erzwingen ließe sich nur das Feld, nicht sein Inhalt')
  assert.ok(s.properties.note, 'note muss deklariert sein, sonst verwirft additionalProperties: false den Klartext')
})

// 41. Ein merge-blockierter PR liegt NICHT auf dem Default-Branch — ein
//     Abhängiger baute gegen Code, den es dort nicht gibt. Diskriminiert
//     zugleich die Implementierung: wer den Zustand in doneOk statt unresolved
//     bucht, gibt #2 frei und `blocked` bliebe leer.
test('Merge extern blockiert: Abhängiger läuft nicht an', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2, { blockedBy: [1] })],
    config: cfg({ mergeCheck: 'coordinator' }),
    respond: (c) => (c.label === 'gate-merge #1' ? null : undefined),
  })
  assert.equal(doneOf(report, 1).mergeBlocked, true)
  assert.deepEqual(report.blocked, [{ n: 2, by: [1] }])
  none(calls, / #2$/)
  assert.equal(report.stopped, null)
})

// 42. Gegenprobe zur Fail-Safe-Richtung: rote Checks bleiben needs-human. Der
//     neue Zustand darf ein inhaltliches Scheitern NICHT umdeuten.
test('Merge-Diagnose: rote Checks → needs-human mit dem echten Zustand', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg({ mergeCheck: 'coordinator' }),
    respond: (c) => {
      if (c.label === 'gate-merge #1') return { merged: false, postMerge: 'unmeasured', note: '' }
      if (c.label === 'merge-diag #1') {
        return { prState: 'OPEN', merged: false, checksGreen: 12, checksRed: 3, checksPending: 0, mergeCheckState: 'FAILURE', note: 'rot: build, e2e, lint' }
      }
      return undefined
    },
  })
  only(calls, 'merge-diag #1')
  only(calls, 'needs-human #1')
  none(calls, /^merge-blocked /)
  const d1 = doneOf(report, 1)
  assert.equal(d1.needsHuman, true)
  assert.ok(!d1.mergeBlocked)
  assert.ok(/rot 3/.test(d1.note) && /build, e2e, lint/.test(d1.note), `die note muss den gelesenen Zustand tragen: ${d1.note}`)
  assert.ok(!/kein Ergebnis/.test(d1.note))
})

// 43. Der teuerste Altfall: die Harness hält den Agenten NACH dem `gh pr merge`
//     an. Der PR ist gemergt, gate ist null — bis 0.7.0 galt die Einheit als
//     gescheitert und riss ihre Abhängigen mit. Grün behauptet der Zweig
//     trotzdem nicht: die Diagnose liest den PR, nicht den Post-Merge-Lauf.
test('Merge-Diagnose: gh weist den Merge aus → gemergt, aber Post-Merge unbewiesen', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1), unit(2, { blockedBy: [1] })],
    config: cfg({ mergeCheck: 'coordinator' }),
    respond: (c) => {
      if (c.label === 'gate-merge #1') return null
      if (c.label === 'merge-diag #1') {
        return { prState: 'MERGED', merged: true, checksGreen: 20, checksRed: 0, checksPending: 0, mergeCheckState: 'SUCCESS', note: 'mergedAt gesetzt' }
      }
      return undefined
    },
  })
  const d1 = doneOf(report, 1)
  assert.equal(d1.pr, 101)
  assert.ok(!d1.needsHuman, 'ein per gh belegter Merge ist kein Fehlschlag')
  assert.ok(!d1.mergeBlocked)
  assert.equal(d1.postMergeUnverified, true, 'der Bericht muss ausweisen, dass der Post-Merge-Beweis nicht gelaufen ist')
  assert.equal(d1.postMerge, 'unmeasured', 'niemand hat den Default-Branch gelesen — "green" wäre eine erfundene Messung')
  none(calls, /^needs-human /)
  none(calls, /^merge-blocked /)
  only(calls, 'cleanup #1')
  only(calls, 'learnings #1')
  assert.equal(doneOf(report, 2).pr, 102, 'der Blocker ist erledigt — der Abhängige muss anlaufen')
  assert.equal(report.stopped, null)
})

// 44. Variante mit non-null gate: die Station meldet merged:false MIT note (und
//     sogar postMerge 'red'), gh widerspricht. Der belegte Merge gewinnt — aber
//     das unbelegte Rot darf keine onSmokeFailure-Policy auslösen.
test('Merge-Diagnose: belegter Merge überschreibt die Meldung der Merge-Station', async () => {
  const { report } = await runWorkflow({
    units: [unit(1)],
    config: cfg({ mergeCheck: 'coordinator', onSmokeFailure: 'p0-issue' }),
    respond: (c) => {
      if (c.label === 'gate-merge #1') return { merged: false, postMerge: 'red', note: 'gh pr merge meldete einen Fehler' }
      if (c.label === 'merge-diag #1') {
        return { prState: 'MERGED', merged: true, checksGreen: 20, checksRed: 0, checksPending: 0, mergeCheckState: 'SUCCESS', note: 'mergedAt gesetzt' }
      }
      return undefined
    },
  })
  const d1 = doneOf(report, 1)
  assert.equal(d1.postMerge, 'unmeasured', 'ein Rot ohne gelaufenen Post-Merge-Beweis darf nicht als Rot durchgereicht werden')
  assert.equal(d1.postMergeUnverified, true)
  assert.equal(report.stopped, null, 'kein Policy-Stop auf einem unbelegten Rot')
  assert.ok(/Merge nachträglich per gh verifiziert/.test(d1.note), d1.note)
  assert.ok(/gh pr merge meldete einen Fehler/.test(d1.note), 'die Meldung der Merge-Station geht nicht verloren')
})

// 45. Ohne Befund wird NIE merge-blocked angenommen: fällt die Diagnose selbst
//     aus, bleibt es beim konservativen needs-human.
test('Merge-Diagnose ohne Ergebnis → needs-human, nie merge-blocked', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg({ mergeCheck: 'coordinator' }),
    respond: (c) => ((c.label === 'gate-merge #1' || c.label === 'merge-diag #1') ? null : undefined),
  })
  only(calls, 'merge-diag #1')
  only(calls, 'needs-human #1')
  none(calls, /^merge-blocked /)
  const d1 = doneOf(report, 1)
  assert.equal(d1.needsHuman, true)
  assert.ok(/Diagnose/.test(d1.note) && /101/.test(d1.note), `die note muss den Ausfall benennen: ${d1.note}`)
})

// 46. Laufende Checks sind NICHT "fertig". Ohne checksPending in der Bedingung
//     behauptete der Kommentar am PR "grün und fertig", während drei Checks noch
//     liefen — der Operator mergte einen ungeprüften PR von Hand.
test('Merge-blockiert nur bei fertigem PR: laufende Checks führen zu needs-human', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg({ mergeCheck: 'coordinator' }),
    respond: (c) => {
      if (c.label === 'gate-merge #1') return null
      if (c.label === 'merge-diag #1') {
        return { prState: 'OPEN', merged: false, checksGreen: 1, checksRed: 0, checksPending: 3, mergeCheckState: 'SUCCESS', note: '3 Checks laufen noch' }
      }
      return undefined
    },
  })
  none(calls, /^merge-blocked /)
  only(calls, 'needs-human #1')
  const d1 = doneOf(report, 1)
  assert.equal(d1.needsHuman, true)
  assert.ok(/laufend 3/.test(d1.note), `die Zahl der laufenden Checks gehört in den Zustandstext: ${d1.note}`)
})

// 47. Ohne konfiguriertes mergeCheck greift der schwächere Fallback "mindestens
//     ein grüner, kein roter, kein laufender Check". Ein Repo ganz ohne Checks
//     landet konservativ in needs-human — ohne Check lässt sich über "grün"
//     nichts behaupten.
test('Merge-blockiert ohne mergeCheck: ein grüner Check reicht, gar keiner nicht', async () => {
  const mk = (checksGreen) => runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => {
      if (c.label === 'gate-merge #1') return null
      if (c.label === 'merge-diag #1') {
        return { prState: 'OPEN', merged: false, checksGreen, checksRed: 0, checksPending: 0, mergeCheckState: 'ABSENT', note: `${checksGreen} grün` }
      }
      return undefined
    },
  })
  const withCheck = await mk(1)
  assert.equal(doneOf(withCheck.report, 1).mergeBlocked, true)
  assert.ok(/\(keiner\)=ABSENT/.test(doneOf(withCheck.report, 1).note), 'der Zustandstext muss "kein Pflicht-Check konfiguriert" ausweisen')
  const noCheck = await mk(0)
  assert.ok(!doneOf(noCheck.report, 1).mergeBlocked, 'ohne einen einzigen grünen Check darf nichts als "fertig" gelten')
  assert.equal(doneOf(noCheck.report, 1).needsHuman, true)
  none(noCheck.calls, /^merge-blocked /)
})

// 48. Der Admin-Agent ist wie budgetStop abgesichert: sein Ausfall darf den
//     festgestellten Zustand nicht in einen technischen Fehler umdeuten — sonst
//     wird ein fertiger PR requeued und komplett neu gebaut.
test('Merge-blockiert-Agent fällt aus: Zustand bleibt, kein Requeue, kein Stop', async () => {
  const { report, calls, logs } = await runWorkflow({
    units: [unit(1)],
    config: cfg({ mergeCheck: 'coordinator' }),
    respond: (c) => {
      if (c.label === 'gate-merge #1') return null
      if (c.label === 'merge-blocked #1') throw new Error('classifier stopped this too')
      return undefined
    },
  })
  assert.equal(doneOf(report, 1).mergeBlocked, true)
  only(calls, 'build #1')
  assert.equal(report.stopped, null)
  assert.deepEqual(report.failed, [])
  assert.ok(logs.some((l) => /Merge-blockiert-Agent fehlgeschlagen/.test(l)), 'der Ausfall muss im Log stehen — das Label fehlt dann auf GitHub')
})

// 49. Verzahnung mit dem Fortschritts-Circuit-Breaker (#31): eine
//     Harness-seitige Merge-Blockade ist systemisch, nicht PR-spezifisch. Sitzt
//     sie einmal, endet JEDE Einheit so — jede nach vollem Build und Gate.
//     merge-blocked zählt deshalb als KEIN Fortschritt.
test('Merge extern blockiert: drei blockierte Einheiten halten den Lauf an', async () => {
  const { report } = await runWorkflow({
    units: [unit(1), unit(2), unit(3), unit(4)],
    config: cfg({ mergeCheck: 'coordinator' }),
    respond: (c) => (/^gate-merge /.test(c.label) ? null : undefined),
  })
  assert.ok(report.stopped, 'ein Lauf, in dem kein einziger Merge durchgeht, darf nicht bis zum Ende brennen')
  assert.equal(report.stopped.issue, 3)
  assert.ok(/Fortschritts-Circuit-Breaker/.test(report.stopped.reason), report.stopped.reason)
  assert.ok(/Merge extern blockiert/.test(report.stopped.reason), 'der Stop-Grund muss den auslösenden Zustand benennen')
  assert.deepEqual(report.remaining, [4], 'die vierte Einheit bleibt unangetastet in der Queue')
})

// 50. Gegenprobe zum Umbau: der NORMALE Merge behält seine Berichtsform. Ohne
//     diesen Test könnte der neue Pfad die note oder postMergeUnverified des
//     Erfolgsfalls still verändern, ohne dass ein Test es merkt.
test('Regulärer Merge: keine Diagnose, note aus der Merge-Station, unverified false', async () => {
  const { report, calls } = await runWorkflow({
    units: [unit(1)],
    config: cfg(),
    respond: (c) => (c.label === 'gate-merge #1'
      ? { merged: true, postMerge: 'green', note: 'squash-merged, Lauf 42 grün' }
      : undefined),
  })
  none(calls, /^merge-diag /)
  none(calls, /^merge-blocked /)
  const d1 = doneOf(report, 1)
  assert.equal(d1.postMerge, 'green')
  assert.equal(d1.note, 'squash-merged, Lauf 42 grün')
  assert.equal(d1.postMergeUnverified, false)
  assert.ok(!d1.mergeBlocked)
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
