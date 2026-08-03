import { describe, it, expect } from 'vitest'
import { reconcile } from '@shared/reconcile'

/** Testes de aceitação do desafio de função — não são vistos por quem implementa. */

interface R {
  id: string
  updatedAt: number
  messages?: unknown[]
}

const r = (id: string, updatedAt: number, n?: number): R => ({
  id,
  updatedAt,
  ...(n === undefined ? {} : { messages: Array.from({ length: n }, (_, i) => i) })
})

describe('reconcile — básico', () => {
  it('junta listas sem id repetido', () => {
    expect(reconcile([r('a', 1)], [r('b', 1)]).map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('duas listas vazias devolvem lista vazia', () => {
    expect(reconcile([] as R[], [] as R[])).toEqual([])
  })

  it('lado vazio devolve o outro lado', () => {
    expect(reconcile([r('a', 1)], [] as R[]).map((x) => x.id)).toEqual(['a'])
    expect(reconcile([] as R[], [r('b', 1)]).map((x) => x.id)).toEqual(['b'])
  })
})

describe('reconcile — quem vence o conflito', () => {
  it('vence o updatedAt maior, venha de onde vier', () => {
    expect(reconcile([r('a', 1)], [r('a', 9)])[0].updatedAt).toBe(9)
    expect(reconcile([r('a', 9)], [r('a', 1)])[0].updatedAt).toBe(9)
  })

  it('updatedAt empatado: vence quem tem mais mensagens', () => {
    expect(reconcile([r('a', 5, 2)], [r('a', 5, 7)])[0].messages).toHaveLength(7)
    expect(reconcile([r('a', 5, 7)], [r('a', 5, 2)])[0].messages).toHaveLength(7)
  })

  it('messages ausente conta como zero', () => {
    expect(reconcile([r('a', 5)], [r('a', 5, 1)])[0].messages).toHaveLength(1)
    expect(reconcile([r('a', 5, 1)], [r('a', 5)])[0].messages).toHaveLength(1)
  })

  it('empate total: vence o local', () => {
    const local = r('a', 5, 3)
    const escolhido = reconcile([local], [r('a', 5, 3)])[0]
    expect(escolhido).toBe(local)
  })

  it('updatedAt maior vence mesmo com menos mensagens', () => {
    expect(reconcile([r('a', 1, 50)], [r('a', 2, 0)])[0].updatedAt).toBe(2)
  })
})

describe('reconcile — ordem', () => {
  it('segue a primeira aparição: local inteiro, depois remoto', () => {
    const local = [r('a', 1), r('b', 1)]
    const remoto = [r('c', 1), r('b', 9), r('d', 1)]
    expect(reconcile(local, remoto).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('conflito não muda a posição, só o conteúdo', () => {
    const resultado = reconcile([r('a', 1), r('b', 1)], [r('b', 9)])
    expect(resultado.map((x) => x.id)).toEqual(['a', 'b'])
    expect(resultado[1].updatedAt).toBe(9)
  })

  it('id repetido dentro da MESMA lista também é resolvido', () => {
    const resultado = reconcile([r('a', 1), r('a', 7)], [] as R[])
    expect(resultado).toHaveLength(1)
    expect(resultado[0].updatedAt).toBe(7)
  })
})

describe('reconcile — descarte e imutabilidade', () => {
  it('descarta registro com id vazio dos dois lados', () => {
    expect(reconcile([r('', 1), r('a', 1)], [r('', 9)]).map((x) => x.id)).toEqual(['a'])
  })

  it('não modifica as listas recebidas', () => {
    const local = [r('a', 1)]
    const remoto = [r('a', 9), r('b', 2)]
    const antes = JSON.stringify([local, remoto])
    reconcile(local, remoto)
    expect(JSON.stringify([local, remoto])).toBe(antes)
  })

  it('não modifica os objetos, devolve os originais', () => {
    const vencedor = r('a', 9)
    const resultado = reconcile([r('a', 1)], [vencedor])
    expect(resultado[0]).toBe(vencedor)
  })

  it('devolve um array novo, não uma das entradas', () => {
    const local = [r('a', 1)]
    expect(reconcile(local, [] as R[])).not.toBe(local)
  })
})

describe('reconcile — casos que costumam passar batido', () => {
  it('updatedAt zero é valor válido, não "vazio"', () => {
    expect(reconcile([r('a', 0, 5)], [r('a', 0, 1)])[0].messages).toHaveLength(5)
  })

  it('updatedAt negativo compara normalmente', () => {
    expect(reconcile([r('a', -5)], [r('a', -1)])[0].updatedAt).toBe(-1)
  })

  it('muitos conflitos encadeados resolvem todos', () => {
    const local = [r('a', 1), r('b', 5), r('c', 3)]
    const remoto = [r('c', 9), r('a', 2), r('b', 1)]
    const resultado = reconcile(local, remoto)
    expect(resultado.map((x) => `${x.id}:${x.updatedAt}`)).toEqual(['a:2', 'b:5', 'c:9'])
  })
})
