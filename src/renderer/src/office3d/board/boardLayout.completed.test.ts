import { describe, expect, it } from 'vitest'
import { BOARD_COMPLETED_VISIBLE, recentCompleted } from '@shared/boardView'
import { BOARD_ROWS, boardColumns } from './boardLayout'
import { boardCard } from './boardModel'
import { at, item } from './boardTestKit'

/**
 * O quadro 3D: a coluna Concluído mostra só os 4 concluídos mais recentes e
 * sem pilha "+K"; o contador do cabeçalho segue com o total. É só visual — os
 * outros continuam no banco (quem apaga é o prazo de 2 dias).
 */

describe('boardColumns — Concluído: só os 4 últimos', () => {
  it('6 concluídos → 4 papéis (os mais recentes), sem pilha, contador 6', () => {
    const cards = Array.from({ length: 6 }, (_, i) => boardCard(item(`c${i}`, { sourceStatus: 'completed', updatedAt: at(i) })))
    const done = boardColumns(cards)[2]
    expect(done).toMatchObject({ status: 'completed', count: 6, pile: 0, hidden: [] })
    expect(done.cards.map((c) => c.id)).toEqual(['c5', 'c4', 'c3', 'c2'])
    expect(BOARD_COMPLETED_VISIBLE).toBeLessThan(BOARD_ROWS)
  })

  it('"A fazer" e "Fazendo" não mudam: a pilha "+K" continua lá', () => {
    const cards = Array.from({ length: 9 }, (_, i) => boardCard(item(`p${i}`, { updatedAt: at(i) })))
    expect(boardColumns(cards)[0]).toMatchObject({ count: 9, pile: 9 - (BOARD_ROWS - 1) })
  })

  it('recentCompleted: os mais recentes primeiro, data inválida por último', () => {
    const list = [{ id: 'a', updatedAt: at(1) }, { id: 'b', updatedAt: 'nunca' }, { id: 'c', updatedAt: at(3) }]
    expect(recentCompleted(list, 2).map((x) => x.id)).toEqual(['c', 'a'])
  })
})
