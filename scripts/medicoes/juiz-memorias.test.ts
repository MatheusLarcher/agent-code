import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CacheDoJuiz, chaveDoJuiz, JUIZ_MAX_CARACTERES, JUIZ_MODELO, julgarExtra, lerVeredito, promptDoJuiz, type JuizQuery } from './juiz-memorias'

const pastas: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'juiz-teste-'))
  pastas.push(d)
  return d
}
afterEach(() => {
  for (const d of pastas.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Dublê do SDK: responde `texto` e anota as chamadas. */
function dubleSdk(texto: string, custo = 0.003): { run: JuizQuery; chamadas: Array<{ options: Record<string, unknown>; prompt: string }> } {
  const chamadas: Array<{ options: Record<string, unknown>; prompt: string }> = []
  const run: JuizQuery = ({ prompt, options }) =>
    (async function* () {
      let p = ''
      for await (const m of prompt) p += (m as { message: { content: Array<{ text: string }> } }).message.content[0].text
      chamadas.push({ options, prompt: p })
      yield { type: 'assistant', message: { content: [{ type: 'text', text: texto }] } }
      yield { type: 'result', total_cost_usd: custo }
    })()
  return { run, chamadas }
}

describe('lerVeredito', () => {
  it('lê o JSON mesmo com texto em volta, acento e maiúscula', () => {
    expect(lerVeredito('claro: {"veredito": "útil", "motivo": "  traz a regra\\n do deploy "}')).toEqual({ veredito: 'util', motivo: 'traz a regra do deploy' })
    expect(lerVeredito('{"veredito":"Neutro"}')).toEqual({ veredito: 'neutra', motivo: '' })
    expect(lerVeredito('{"veredito":"atrapalha","motivo":"outro projeto"}')?.veredito).toBe('atrapalha')
  })

  it('recusa sem JSON, JSON quebrado ou veredito desconhecido', () => {
    expect(lerVeredito('útil')).toBeNull()
    expect(lerVeredito('{"veredito": util}')).toBeNull()
    expect(lerVeredito('{"veredito":"talvez"}')).toBeNull()
    expect(lerVeredito('{"motivo":"x"}')).toBeNull()
  })
})

describe('chave e prompt', () => {
  it('a chave muda com pedido, caminho ou conteúdo', () => {
    const k = chaveDoJuiz('p', 'a.md', 'texto')
    expect(k).toMatch(/^[0-9a-f]{64}$/)
    expect(chaveDoJuiz('p', 'a.md', 'texto')).toBe(k)
    expect(chaveDoJuiz('p2', 'a.md', 'texto')).not.toBe(k)
    expect(chaveDoJuiz('p', 'b.md', 'texto')).not.toBe(k)
    expect(chaveDoJuiz('p', 'a.md', 'texto2')).not.toBe(k)
  })

  it('o prompt leva pedido, caminho e o texto cortado no teto', () => {
    const p = promptDoJuiz('faz o deploy', 'regras/x.md', 'y'.repeat(JUIZ_MAX_CARACTERES + 500))
    expect(p).toContain('faz o deploy')
    expect(p).toContain('regras/x.md')
    expect(p).toContain('y'.repeat(JUIZ_MAX_CARACTERES))
    expect(p).not.toContain('y'.repeat(JUIZ_MAX_CARACTERES + 1))
  })
})

describe('CacheDoJuiz', () => {
  it('grava e relê do disco', () => {
    const arq = join(tmp(), 'sub', 'juiz-cache.json')
    const c = new CacheDoJuiz(arq)
    c.set('k1', { veredito: 'util', motivo: 'ajuda' }, JUIZ_MODELO)
    c.salvar()
    const de_novo = new CacheDoJuiz(arq)
    expect(de_novo.tamanho).toBe(1)
    expect(de_novo.get('k1')).toEqual({ veredito: 'util', motivo: 'ajuda' })
    expect(JSON.parse(readFileSync(arq, 'utf8')).itens.k1.modelo).toBe(JUIZ_MODELO)
  })

  it('arquivo ilegível vira cache vazio e item inválido é ignorado', () => {
    const d = tmp()
    writeFileSync(join(d, 'ruim.json'), '{ quebrado', 'utf8')
    expect(new CacheDoJuiz(join(d, 'ruim.json')).tamanho).toBe(0)
    writeFileSync(join(d, 'misto.json'), JSON.stringify({ itens: { ok: { veredito: 'neutra', motivo: '' }, ruim: { veredito: 'sei la' } } }), 'utf8')
    const c = new CacheDoJuiz(join(d, 'misto.json'))
    expect(c.tamanho).toBe(1)
    expect(c.get('ruim')).toBeNull()
  })
})

describe('julgarExtra', () => {
  it('chama o Sonnet como o seletor do app (sem settings, sem ferramentas, sem thinking) e guarda no cache', async () => {
    const cache = new CacheDoJuiz(join(tmp(), 'c.json'))
    const sdk = dubleSdk('{"veredito":"util","motivo":"regra do deploy"}')
    const r = await julgarExtra('faz o deploy', 'regras/d.md', 'sempre rodar testes', { run: sdk.run, cache, timeoutMs: 5000 })
    expect(r).toEqual({ julgamento: { veredito: 'util', motivo: 'regra do deploy' }, doCache: false, custoUsd: 0.003 })
    expect(sdk.chamadas).toHaveLength(1)
    const o = sdk.chamadas[0].options
    expect(o).toMatchObject({ model: 'claude-sonnet-5-5', settingSources: [], tools: [], thinking: { type: 'disabled' }, maxTurns: 1, persistSession: false })
    expect(sdk.chamadas[0].prompt).toContain('sempre rodar testes')
    expect(cache.tamanho).toBe(1)
  })

  it('repetir o mesmo pedido + memória vem do cache, sem chamar o modelo nem custar', async () => {
    const cache = new CacheDoJuiz(join(tmp(), 'c.json'))
    const sdk = dubleSdk('{"veredito":"neutra","motivo":"vizinha"}')
    await julgarExtra('p', 'a.md', 'texto', { run: sdk.run, cache, timeoutMs: 5000 })
    const r = await julgarExtra('p', 'a.md', 'texto', { run: sdk.run, cache, timeoutMs: 5000 })
    expect(r).toEqual({ julgamento: { veredito: 'neutra', motivo: 'vizinha' }, doCache: true, custoUsd: 0 })
    expect(sdk.chamadas).toHaveLength(1)
    // Conteúdo mudou: julga de novo.
    await julgarExtra('p', 'a.md', 'texto novo', { run: sdk.run, cache, timeoutMs: 5000 })
    expect(sdk.chamadas).toHaveLength(2)
  })

  it('resposta sem veredito ou erro do SDK: sem julgamento e nada no cache', async () => {
    const cache = new CacheDoJuiz(join(tmp(), 'c.json'))
    const semJson = await julgarExtra('p', 'a.md', 't', { run: dubleSdk('não sei').run, cache, timeoutMs: 5000 })
    expect(semJson).toMatchObject({ julgamento: null, doCache: false, erro: 'resposta sem JSON de veredito' })
    const quebra: JuizQuery = () =>
      (async function* () {
        yield* []
        throw new Error('rede caiu')
      })()
    const r = await julgarExtra('p', 'a.md', 't', { run: quebra, cache, timeoutMs: 5000 })
    expect(r).toMatchObject({ julgamento: null, erro: 'rede caiu' })
    expect(cache.tamanho).toBe(0)
  })
})
