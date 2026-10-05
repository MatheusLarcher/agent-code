// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { HandoffEnvioCreate } from '../persistence/types'
import {
  clampHandoffLimit,
  handoffContentHash,
  handoffEntregaFromRow,
  handoffEntregaPatchWrites,
  handoffEnvioPatchWrites,
  handoffEstimativaTotal,
  normalizeHandoffQuery,
  normalizeHandoffTimeAdd,
  prepareHandoffEnvio,
  type HandoffEntregaRow
} from './handoffModel'

function create(patch: Partial<HandoffEnvioCreate> = {}): HandoffEnvioCreate {
  return {
    planSlug: 'plano-1',
    planTitulo: 'Plano',
    projectId: 'proj-1',
    projectCwd: 'C:/GitHub/agent-code',
    conversationId: 'conv-1',
    conversationTitle: 'Implementação',
    arquivo: '01-banco.md',
    ordem: 1,
    loteId: 'lote-1',
    conteudo: 'Faça a etapa 1.',
    entregas: [
      { etapaId: 'etapa-1', etapaTitulo: 'Um', estimativaPlano: 30 },
      { etapaId: 'etapa-2', etapaTitulo: 'Dois', estimativaPlano: null },
      { etapaId: 'etapa-3', etapaTitulo: 'Três', estimativaPlano: 15 }
    ],
    ...patch
  }
}

describe('handoffContentHash', () => {
  it('é o sha256 do texto com CRLF→LF e sem espaço nas pontas', () => {
    const expected = createHash('sha256').update('linha 1\nlinha 2').digest('hex')
    expect(handoffContentHash('  linha 1\r\nlinha 2\r\n')).toBe(expected)
    expect(handoffContentHash('linha 1\nlinha 2')).toBe(expected)
    expect(handoffContentHash('linha 1\nlinha 3')).not.toBe(expected)
  })
})

describe('handoffEstimativaTotal', () => {
  it('soma só as estimativas presentes; null quando não há nenhuma', () => {
    expect(handoffEstimativaTotal([{ estimativaPlano: 30 }, { estimativaPlano: null }, { estimativaPlano: 15 }])).toBe(45)
    expect(handoffEstimativaTotal([{ estimativaPlano: null }])).toBeNull()
    expect(handoffEstimativaTotal([])).toBeNull()
  })
})

describe('prepareHandoffEnvio', () => {
  it('gera ids, hash, totais e a ordem das entregas', () => {
    const prepared = prepareHandoffEnvio(create({ conteudo: 'Faça a etapa 1.\r\n' }))
    expect(prepared.id).toMatch(/^he-[0-9a-f-]{36}$/)
    expect(prepared.entregas.map((entrega) => entrega.id)).toEqual([
      expect.stringMatching(/^hn-[0-9a-f-]{36}$/),
      expect.stringMatching(/^hn-/),
      expect.stringMatching(/^hn-/)
    ])
    expect(prepared.entregas.map((entrega) => entrega.ordem)).toEqual([1, 2, 3])
    expect(prepared.conteudoHash).toBe(handoffContentHash('Faça a etapa 1.'))
    expect(prepared.estimativaTotal).toBe(45)
    expect(prepared.prazoTotal).toBe(45)
  })

  it('aceita envio sem entregas (prompt antigo, sem sidecar): totais null', () => {
    const prepared = prepareHandoffEnvio(create({ entregas: [] }))
    expect(prepared.entregas).toEqual([])
    expect(prepared.estimativaTotal).toBeNull()
    expect(prepared.prazoTotal).toBeNull()
  })

  it.each([
    ['conteúdo vazio', { conteudo: '   ' }, /conteudo/],
    ['sem conversa', { conversationId: '' }, /conversationId/],
    ['ordem zero', { ordem: 0 }, /ordem/],
    ['ordem fracionária', { ordem: 1.5 }, /ordem/],
    ['etapa repetida', { entregas: [{ etapaId: 'a', etapaTitulo: 'A', estimativaPlano: null }, { etapaId: 'a', etapaTitulo: 'B', estimativaPlano: null }] }, /repetida/],
    ['estimativa zero', { entregas: [{ etapaId: 'a', etapaTitulo: 'A', estimativaPlano: 0 }] }, /estimativaPlano/],
    ['estimativa acima do teto', { entregas: [{ etapaId: 'a', etapaTitulo: 'A', estimativaPlano: 10_001 }] }, /estimativaPlano/],
    ['estimativa fracionária', { entregas: [{ etapaId: 'a', etapaTitulo: 'A', estimativaPlano: 2.5 }] }, /estimativaPlano/],
    ['entregas demais', { entregas: Array.from({ length: 101 }, (_, i) => ({ etapaId: `e${i}`, etapaTitulo: 'x', estimativaPlano: null })) }, /no máximo/]
  ] as const)('recusa %s', (_label, patch, message) => {
    expect(() => prepareHandoffEnvio(create(patch as Partial<HandoffEnvioCreate>))).toThrow(message)
  })
})

describe('normalizeHandoffQuery', () => {
  it('aplica o limite padrão e o teto', () => {
    expect(clampHandoffLimit(undefined)).toBe(200)
    expect(clampHandoffLimit(5_000)).toBe(1000)
    expect(clampHandoffLimit(0)).toBe(1)
    expect(clampHandoffLimit(Number.NaN)).toBe(200)
    expect(normalizeHandoffQuery({}).limit).toBe(200)
  })

  it('lista vazia num filtro = nenhum resultado; status inválido é erro', () => {
    expect(normalizeHandoffQuery({ ids: [] }).empty).toBe(true)
    expect(normalizeHandoffQuery({ projectIds: [] }).empty).toBe(true)
    expect(normalizeHandoffQuery({ statuses: [] }).empty).toBe(true)
    expect(normalizeHandoffQuery({ statuses: ['na_fila'] }).empty).toBe(false)
    expect(() => normalizeHandoffQuery({ statuses: ['pronto' as never] })).toThrow(/inválido/)
  })
})

describe('patches', () => {
  it('mapeia chave→coluna, normaliza data ISO e marca o texto livre', () => {
    expect(
      handoffEnvioPatchWrites({
        status: 'enviado',
        enviadoEm: '2026-10-05T10:00:00-03:00',
        motivo: '  ',
        conversationTitle: 'Nova',
        atrasado: true
      })
    ).toEqual([
      { column: 'status', value: 'enviado', text: false },
      { column: 'enviado_em', value: '2026-10-05T13:00:00.000Z', text: false },
      { column: 'motivo', value: null, text: true },
      { column: 'conversation_title', value: 'Nova', text: true },
      { column: 'atrasado', value: true, text: false }
    ])
  })

  it('null limpa campo anulável; undefined não mexe', () => {
    expect(handoffEntregaPatchWrites({ concluidaEm: null, auditada: null, boardItemId: undefined })).toEqual([
      { column: 'concluida_em', value: null, text: false },
      { column: 'auditada', value: null, text: false }
    ])
  })

  it.each([
    [{ status: 'feito' }],
    [{ atrasada: null }],
    [{ corrigidoPor: 'po' }],
    [{ tempoCorridoMs: -1 }],
    [{ estimativaAgente: 0 }],
    [{ iniciadaEm: 'ontem' }],
    [{ boardItemId: '' }],
    [{ tempoAtivoMs: 10 }]
  ])('recusa %j na entrega', (patch) => {
    expect(() => handoffEntregaPatchWrites(patch as never)).toThrow(TypeError)
  })

  it('recusa campo de envio desconhecido ou nulo onde não cabe', () => {
    expect(() => handoffEnvioPatchWrites({ status: null } as never)).toThrow(/inválido/)
    expect(() => handoffEnvioPatchWrites({ conversationTitle: null } as never)).toThrow(/texto/)
    expect(() => handoffEnvioPatchWrites({ id: 'outro' } as never)).toThrow(/não editável/)
  })
})

describe('normalizeHandoffTimeAdd', () => {
  it('descarta entregas zeradas e devolve null quando não há nada a somar', () => {
    expect(normalizeHandoffTimeAdd({ envioId: 'he-1' })).toBeNull()
    expect(normalizeHandoffTimeAdd({ envioId: 'he-1', ativoMs: 0, entregas: [{ id: 'hn-1' }] })).toBeNull()
    expect(
      normalizeHandoffTimeAdd({ envioId: 'he-1', ativoMs: 500, entregas: [{ id: 'hn-1', retrabalhoMs: 0 }, { id: 'hn-2', ativoMs: 500 }] })
    ).toEqual({ envioId: 'he-1', ativoMs: 500, retrabalhoMs: 0, entregas: [{ id: 'hn-2', ativoMs: 500, retrabalhoMs: 0 }] })
  })

  it.each([{ ativoMs: -1 }, { ativoMs: 1.5 }, { retrabalhoMs: Number.NaN }])('recusa %j', (patch) => {
    expect(() => normalizeHandoffTimeAdd({ envioId: 'he-1', ...patch })).toThrow(/inteiro/)
  })
})

describe('handoffEntregaFromRow', () => {
  it('lê 0/1 do SQLite e boolean/texto do PostgreSQL na mesma forma', () => {
    const base: HandoffEntregaRow = {
      id: 'hn-1', envio_id: 'he-1', etapa_id: 'etapa-1', etapa_titulo: 'Um', ordem: 1, estimativa_plano: 30,
      estimativa_agente: null, estimativa_agente_motivo: null, estimativa_agente_em: null, status: 'concluida',
      atrasada: 1, motivo: null, board_item_id: null, auditada: 0, corrigido_por: null, corrigido_em: null,
      iniciada_em: null, concluida_em: null, tempo_ativo_ms: 1500, tempo_corrido_ms: null, retrabalho_ms: 0,
      aviso_80_em: null, aviso_100_em: null, updated_at: '2026-10-05T13:00:00.000Z'
    }
    const sqlite = handoffEntregaFromRow(base)
    const postgres = handoffEntregaFromRow({ ...base, atrasada: true, auditada: false, tempo_ativo_ms: '1500' })
    expect(postgres).toEqual(sqlite)
    expect(sqlite).toMatchObject({ atrasada: true, auditada: false, tempoAtivoMs: 1500, tempoCorridoMs: null })
    expect(handoffEntregaFromRow({ ...base, auditada: null }).auditada).toBeNull()
  })
})
