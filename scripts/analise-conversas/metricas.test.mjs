// node scripts/analise-conversas/metricas.test.mjs
import assert from 'node:assert/strict'
import { analisarConversa, classificarRetrabalho, lerSessaoObservador, mediana, observadoresDoApp } from './metricas.mjs'

assert.equal(classificarRetrabalho('nao entendi, vc nao me responpondeu'), 'nao entendeu')
assert.equal(classificarRetrabalho('Não pedi isso'), 'nao pedi isso')
assert.equal(classificarRetrabalho('os travamentos ainda continuam'), 'repetiu pedido')
assert.equal(classificarRetrabalho('esse para começar ta ruim'), 'reclamou do resultado')
assert.equal(classificarRetrabalho('Faça um estudo do uso da memória'), null)
assert.equal(classificarRetrabalho('essa função não existe, você inventou'), 'delirio')
assert.equal(classificarRetrabalho('de onde vc tirou esse número?'), 'delirio')
assert.equal(mediana([5, 1, 3]), 3)
assert.equal(mediana([]), 0)

const r = analisarConversa({
  id: 'c', titulo: 't', msgs: [
    { kind: 'user', text: 'arruma', ts: 1000, turnIds: ['a'] },
    { kind: 'tool-use', name: 'Bash', result: { isError: true, text: 'Exit code 1\nfoo' } },
    { kind: 'tool-use', name: 'Bash', result: { isError: true, text: 'Exit code 1\nbar' } },
    { kind: 'tool-use', name: 'Edit', result: { isError: true, text: 'The user doesn\'t want to proceed' } },
    { kind: 'tool-use', name: 'Bash', result: { isError: false, text: 'log: request was blocked by proxy' } },
    { kind: 'assistant-text', text: 'Posso apagar?' },
    { kind: 'user', text: 'pode', ts: 5000, turnIds: ['b'] },
    { kind: 'user', text: 'PS C:\\WINDOWS\\system32> foo', ts: 9000, turnIds: [] }
  ]
}, [
  { entry: { type: 'assistant', timestamp: new Date(2000).toISOString(), message: { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } } } },
  { entry: { type: 'assistant', timestamp: new Date(2000).toISOString(), message: { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } } } }
], [{ turn_id: 'a', duration_ms: 3000 }])

assert.equal(r.pedidos, 3)
assert.equal(r.errosFerramenta.length, 3)
assert.equal(r.falhasRepetidas.length, 1)
assert.equal(r.recusas.length, 1)
assert.equal(r.confirmacoes.length, 1)
assert.equal(r.colouTerminal.length, 1)
assert.equal(r.chamadasModelo, 1, 'mesma resposta não conta duas vezes')
assert.equal(r.turnos[0].tokensEntrada, 100)
assert.equal(r.turnos[0].segundos, 3)
// Ações por pedido: cada chamada de ferramenta conta no pedido que veio antes dela.
assert.equal(r.turnos[0].acoes, 4)
assert.deepEqual(r.turnos[0].acoesPorTipo, { Bash: 3, Edit: 1 })
assert.equal(r.turnos[1].acoes, 0)
// Observador: reconhecido pelo prompt de abertura e atribuído pelo horário do pedido.
const obs = lerSessaoObservador([
  JSON.stringify({ type: 'user', entrypoint: 'sdk-ts', timestamp: new Date(60_000).toISOString(), message: { content: 'Você é o memorista: um observador' } }),
  JSON.stringify({ type: 'assistant', message: { id: 'a', model: 'claude-opus-5-5', usage: { input_tokens: 7, cache_read_input_tokens: 3 } } }),
  JSON.stringify({ type: 'assistant', message: { id: 'a', model: 'claude-opus-5-5', usage: { input_tokens: 7, cache_read_input_tokens: 3 } } })
].join('\n'))
assert.equal(obs.tipo, 'memorista')
assert.equal(obs.tokensEntrada, 10)
assert.equal(lerSessaoObservador(JSON.stringify({ type: 'user', entrypoint: 'cli', message: { content: 'Você é o PO' } })), null)
assert.equal(observadoresDoApp([obs], [30_000]).memorista.sessoes, 1)
assert.deepEqual(observadoresDoApp([obs], [60_000 + 20 * 60_000]), {}, 'pedido depois do observador não conta')
console.log('ok')
