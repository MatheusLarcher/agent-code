import { describe, expect, it } from 'vitest'
import { STAGE_COMPACT_MAX_CEILING, StageCompaction, stageCompactCeiling } from './stageCompaction'

describe('stageCompactCeiling', () => {
  it('modelo de 1M: teto de 400k', () => {
    expect(stageCompactCeiling('claude-opus-5-5')).toBe(STAGE_COMPACT_MAX_CEILING)
  })

  it('modelo desconhecido (200k) ou de 272k: sem folga acima da janela, null', () => {
    expect(stageCompactCeiling(undefined)).toBeNull()
    expect(stageCompactCeiling('modelo-novo')).toBeNull()
    expect(stageCompactCeiling('gpt-6-sol')).toBeNull()
  })
})

describe('StageCompaction', () => {
  it('TaskUpdate de id desconhecido (sessão retomada) conta como etapa fechada', () => {
    const st = new StageCompaction()
    expect(st.decide('auto', 250_000, 400_000)).toBe('block')
    st.observeTool('TaskUpdate', { taskId: '9', status: 'completed' }, {})
    expect(st.decide('auto', 250_000, 400_000)).toBe('allow')
  })

  it('TaskUpdate que renomeia para [id] passa a contar como etapa', () => {
    const st = new StageCompaction()
    st.observeTool('TaskCreate', { subject: 'ler' }, { task: { id: '1', subject: 'ler' } })
    st.observeTool('TaskUpdate', { taskId: '1', subject: '[ler] Ler', status: 'completed' }, {})
    expect(st.decide('auto', 250_000, 400_000)).toBe('allow')
  })

  it('teto null (modelo sem folga): passa sempre', () => {
    expect(new StageCompaction().decide('auto', 250_000, null)).toBe('allow')
  })

  it('entrada malformada não lança nem fecha etapa', () => {
    const st = new StageCompaction()
    st.observeTool('TodoWrite', { todos: [null, { status: 'completed' }, { content: 3, status: 'completed' }] }, null)
    st.observeTool('TaskCreate', null, null)
    st.observeTool('TodoWrite', null, undefined)
    expect(st.decide('auto', 250_000, 400_000)).toBe('block')
  })
})
