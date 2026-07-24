export const meta = {
  name: 'flowkit-engine-spike',
  description: 'Verify engine primitives for flowkit: parallel(), budget.spent(), schema enforcement — cheap dummy agents only',
  phases: [{ title: 'Spike' }],
}

const befund = {
  parallelTyp: typeof parallel,
  budgetTyp: (typeof budget !== 'undefined' && budget) ? typeof budget.spent : 'undefined',
  parallelOk: false,
  budgetDelta: null,
  schemaOk: false,
}

const t0 = befund.budgetTyp === 'function' ? budget.spent() : null

if (befund.parallelTyp === 'function') {
  const r = await parallel([
    () => agent('Antworte mit genau einem Wort: EINS', { label: 'spike-1', phase: 'Spike', model: 'haiku' }),
    () => agent('Antworte mit genau einem Wort: ZWEI', { label: 'spike-2', phase: 'Spike', model: 'haiku' }),
  ])
  befund.parallelOk = Array.isArray(r) && r.filter(Boolean).length === 2
}

const s = await agent('Gib als strukturiertes Ergebnis ok=true zurück.', {
  label: 'spike-schema', phase: 'Spike', model: 'haiku',
  schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
})
befund.schemaOk = !!(s && s.ok === true)

if (t0 !== null) befund.budgetDelta = budget.spent() - t0
return befund
