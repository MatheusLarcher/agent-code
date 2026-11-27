// @vitest-environment node
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { normalizarTermo } from './catalogo'
import { buscarComRetaguarda, lerEscolhaIA, montarPerguntaIA, type PerguntarIA } from './degraus'
import { prepararBusca } from './preparar'

const ACERVO = path.resolve(__dirname, '../../../../scripts/medicoes/ambiente-memorias/memorias-ficticias')
const HOJE = Date.parse('2026-11-26T12:00:00Z')
async function embedFalso(textos: string[]): Promise<number[][]> {
  return textos.map((t) => {
    const v = new Array<number>(256).fill(0)
    for (const w of normalizarTermo(t).split(/[^a-z0-9]+/).filter((x) => x.length > 3)) {
      let h = 0
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0
      v[h % 256] += 1
    }
    const n = Math.hypot(...v) || 1
    return v.map((x) => x / n)
  })
}

describe('IA de retaguarda', () => {
  it('lê só caminhos que estavam entre as candidatas', () => {
    expect(lerEscolhaIA('ok: ["a.md","x.md","a.md"]', new Set(['a.md', 'b.md']))).toEqual(['a.md'])
    expect(lerEscolhaIA('nenhuma: []', new Set(['a.md']))).toEqual([])
    expect(lerEscolhaIA('sem json', new Set(['a.md']))).toEqual([])
  })

  it('a pergunta leva só as candidatas, o contexto e o pedido', () => {
    const p = montarPerguntaIA('só o de domingo', 'horário da padaria', [{ id: 'e.md', titulo: 'Horário', gancho: 'quando falar de horário', texto: 'abre às 7h no domingo' }])
    expect(p).toContain('e.md: Horário')
    expect(p).toContain('horário da padaria')
    expect(p).toContain('só o de domingo')
  })

  it('zonas: confiante decide sozinha; nada parecido não chama a IA; dúvida chama com ≤ 20 candidatas', async () => {
    const { ctx } = await prepararBusca(ACERVO, { hoje: HOJE, embed: embedFalso })
    const chamadas: string[] = []
    const ia: PerguntarIA = async (prompt) => {
      chamadas.push(prompt)
      return { texto: '["horta-notificacoes-rega.md"]', tokens: 1234 }
    }
    const confiante = await buscarComRetaguarda('aviso de rega do Horta Fácil', ctx, { tema: null }, ia, { confiante: -1 })
    expect(confiante.decidiu).toBe('busca')
    const nada = await buscarComRetaguarda('aviso de rega', ctx, { tema: null }, ia, { confiante: 2, nadaParecido: 2 })
    expect(nada.decidiu).toBe('nada')
    expect(chamadas).toHaveLength(0)
    const duvida = await buscarComRetaguarda('aviso de rega do Horta Fácil', ctx, { tema: null }, ia, { confiante: 2, nadaParecido: -1 })
    expect(duvida.decidiu).toBe('ia')
    expect(duvida.tokensIA).toBe(1234)
    expect(duvida.escolhidas).toContain('horta-notificacoes-rega.md')
    expect(duvida.escolhidas).toContain('regras/responder-curto.md') // `sempre` continua
    expect(chamadas[0].match(/^- /gm)!.length).toBeLessThanOrEqual(20)
  })

  it('IA fora do ar: fica com o que a busca achou, sem travar', async () => {
    const { ctx } = await prepararBusca(ACERVO, { hoje: HOJE, embed: embedFalso })
    const r = await buscarComRetaguarda('aviso de rega do Horta Fácil', ctx, { tema: null }, async () => { throw new Error('fora') }, { confiante: 2, nadaParecido: -1 })
    expect(r.decidiu).toBe('busca')
    expect(r.tokensIA).toBe(0)
  })
})
