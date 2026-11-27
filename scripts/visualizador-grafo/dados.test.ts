import { describe, expect, it } from 'vitest'
import {
  aleatorio,
  centralizar,
  dataDaMemoria,
  dataIso,
  datasNoTexto,
  escalar,
  media,
  nivelDe,
  palavras,
  palavrasCaracteristicas,
  percentil,
  temaDe,
  vizinhosMaisProximos
} from './dados'

const HOJE = Date.UTC(2026, 10, 26, 15, 30) // 26/11/2026 15h30 UTC
const dia = (iso: string): number => Date.parse(`${iso}T00:00:00Z`)

describe('temaDe', () => {
  it('usa a primeira pasta', () => {
    expect(temaDe(['financeiro', 'boletos'])).toBe('financeiro')
  })
  it('arquivo na raiz vai para geral', () => {
    expect(temaDe([])).toBe('geral')
    expect(temaDe(['  '])).toBe('geral')
  })
})

describe('datasNoTexto', () => {
  it('lê AAAA-MM-DD e D/M/AAAA, sem repetir e em ordem', () => {
    const t = 'criado em 2026-11-20; revisto 3/9/2026 e de novo 2026-11-20'
    expect(datasNoTexto(t).map(dataIso)).toEqual(['2026-09-03', '2026-11-20'])
  })
  it('ignora datas impossíveis e números grudados', () => {
    expect(datasNoTexto('2026-02-31 e 32/1/2026 e 12026-01-01 e v1/2/20261')).toEqual([])
  })
})

describe('dataDaMemoria', () => {
  it('pega a mais recente que não passa de hoje', () => {
    expect(dataIso(dataDaMemoria('feito 2026-10-01, prazo 2026-12-15, ajuste 2026-11-25', HOJE))).toBe('2026-11-25')
  })
  it('a data de hoje conta', () => {
    expect(dataIso(dataDaMemoria('hoje 26/11/2026', HOJE))).toBe('2026-11-26')
  })
  it('sem data → null', () => {
    expect(dataDaMemoria('nada aqui', HOJE)).toBeNull()
    expect(dataDaMemoria('só futuro 2027-01-01', HOJE)).toBeNull()
  })
})

describe('nivelDe', () => {
  it('segue os cortes de 1, 7 e 60 dias', () => {
    expect(nivelDe(dia('2026-11-26'), HOJE)).toBe('fast')
    expect(nivelDe(dia('2026-11-25'), HOJE)).toBe('fast')
    expect(nivelDe(dia('2026-11-24'), HOJE)).toBe('curto')
    expect(nivelDe(dia('2026-11-19'), HOJE)).toBe('curto')
    expect(nivelDe(dia('2026-11-18'), HOJE)).toBe('medio')
    expect(nivelDe(dia('2026-09-27'), HOJE)).toBe('medio')
    expect(nivelDe(dia('2026-09-26'), HOJE)).toBe('longo')
  })
  it('sem data → longo', () => {
    expect(nivelDe(null, HOJE)).toBe('longo')
  })
})

describe('vetores', () => {
  it('media e centralizar', () => {
    expect(media([[1, 2], [3, 6]])).toEqual([2, 4])
    expect(media([])).toEqual([])
    expect(centralizar([[1, 2], [3, 6]])).toEqual([[-1, -2], [1, 2]])
  })

  it('vizinhosMaisProximos liga os k mais parecidos acima do limiar, sem repetir', () => {
    const v = [
      [1, 0],
      [0.9, 0.1],
      [0, 1],
      [0.1, 0.9]
    ]
    const lig = vizinhosMaisProximos(v, 1, 0.5)
    expect(lig.map((l) => [l.a, l.b])).toEqual([
      [0, 1],
      [2, 3]
    ])
    expect(lig[0].cosseno).toBeGreaterThan(0.9)
  })

  it('vizinhosMaisProximos respeita o limiar', () => {
    expect(vizinhosMaisProximos([[1, 0], [0, 1]], 3, 0.1)).toEqual([])
  })
})

describe('auxiliares', () => {
  it('escalar leva a 0–1', () => {
    expect(escalar([2, 4, 6])).toEqual([0, 0.5, 1])
    expect(escalar([3, 3])).toEqual([1, 1])
    expect(escalar([])).toEqual([])
  })

  it('percentil interpola', () => {
    expect(percentil([1, 2, 3, 4, 5], 50)).toBe(3)
    expect(percentil([0, 10], 25)).toBe(2.5)
    expect(percentil([], 50)).toBeNaN()
  })

  it('palavras tira palavras vazias e números', () => {
    expect(palavras('O boleto do cliente e 2026 vencido')).toEqual(['boleto', 'cliente', 'vencido'])
  })

  it('palavrasCaracteristicas prefere o que é próprio do grupo', () => {
    const grupos = new Map([
      ['fin', ['boleto vencido cliente', 'boleto pago cliente']],
      ['tec', ['servidor caiu cliente', 'servidor reiniciado']]
    ])
    const r = palavrasCaracteristicas(grupos, 1)
    expect(r.get('fin')).toEqual(['boleto'])
    expect(r.get('tec')).toEqual(['servidor'])
  })

  it('aleatorio é determinístico pela semente', () => {
    const a = aleatorio(7)
    const b = aleatorio(7)
    const xs = [a(), a(), a()]
    expect([b(), b(), b()]).toEqual(xs)
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(0)
    for (const x of xs) expect(x).toBeLessThan(1)
  })
})
