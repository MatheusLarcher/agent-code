import { describe, it, expect } from 'vitest'
import {
  contextLimitFor,
  modelSupportsFastMode,
  modelSupportsVision,
  CONTEXT_LIMITS,
  MODEL_EFFORT,
  DEFAULT_CONFIG,
  Channels,
  OPENAI_MODELS,
  CLAUDE_MODELS,
  RETIRED_MODEL_REPLACEMENTS,
  currentModelId,
  isOpenAIModel,
  boardItemAwaitingBadge,
  BOARD_TURN_END_REASON,
  boardTurnEndReason,
  parseBoardTurnEndReason,
  type BoardItem
} from './ipc'

describe('boardItemAwaitingBadge — selo do cartão rebaixado pelo fim de turno', () => {
  const item = (over: Partial<BoardItem> = {}): BoardItem => ({
    id: 'bi-1',
    projectId: 'p',
    projectCwd: 'C:/p',
    conversationId: 'c',
    origin: 'agent',
    sourceId: '1',
    sourceTitle: 't',
    sourceStatus: 'in_progress',
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: 'pending',
    poReason: BOARD_TURN_END_REASON.result,
    poAt: '2026-09-28T10:00:00Z',
    dismissedAt: null,
    revision: 1,
    createdAt: '',
    updatedAt: '',
    ...over
  })

  it('mostra "Aguardando você" (fim normal) e "Interrompido" (erro)', () => {
    expect(boardItemAwaitingBadge(item())).toEqual({ kind: 'result', label: 'Aguardando você' })
    expect(boardItemAwaitingBadge(item({ poReason: BOARD_TURN_END_REASON.error }))).toEqual({
      kind: 'error',
      label: 'Interrompido'
    })
  })

  it('a justificativa do PO (PENDENTE) mantém o selo — a frase fixa continua na frente', () => {
    const justified = boardTurnEndReason('result', 'falta commitar')
    expect(justified).toBe(`${BOARD_TURN_END_REASON.result} — falta commitar`)
    expect(boardItemAwaitingBadge(item({ poReason: justified }))?.label).toBe('Aguardando você')
    expect(parseBoardTurnEndReason(justified)).toEqual({ kind: 'result', justification: 'falta commitar' })
    expect(parseBoardTurnEndReason(BOARD_TURN_END_REASON.error)).toEqual({ kind: 'error', justification: null })
    expect(parseBoardTurnEndReason('o usuário retomou a conversa')).toBeNull()
    expect(boardTurnEndReason('error', '  ')).toBe(BOARD_TURN_END_REASON.error)
  })

  it('some quando o cartão é promovido', () => {
    expect(boardItemAwaitingBadge(item({ poStatus: 'in_progress', poReason: 'o usuário retomou a conversa' }))).toBeNull()
  })

  it('some quando é concluído, movido pelo usuário, dispensado ou o agente muda o status', () => {
    expect(boardItemAwaitingBadge(item({ poStatus: 'completed', poReason: 'o teste passou' }))).toBeNull()
    expect(
      boardItemAwaitingBadge(item({ poReason: 'o usuário moveu o cartão para "a fazer" pelo quadro' }))
    ).toBeNull()
    expect(boardItemAwaitingBadge(item({ dismissedAt: '2026-09-28T11:00:00Z' }))).toBeNull()
    // A ingestão limpa po_status/po_reason quando o agente muda o status.
    expect(boardItemAwaitingBadge(item({ poStatus: null, poReason: null, sourceStatus: 'pending' }))).toBeNull()
  })

  it('cartão "a fazer" que nunca começou não mostra selo', () => {
    expect(boardItemAwaitingBadge(item({ sourceStatus: 'pending', poStatus: null, poReason: null, poAt: null }))).toBeNull()
  })
})

describe('controle do Windows — contrato compartilhado', () => {
  it('começa desligado e usa canais IPC independentes de permitir tudo', () => {
    expect(DEFAULT_CONFIG.windowsControlEnabled).toBe(false)
    expect(Channels.windowsControlSetEnabled).not.toBe(Channels.configSet)
    expect(Channels.windowsControlChanged).toBe('windows-control:changed')
  })
})

describe('contextLimitFor — janelas de contexto reais dos modelos', () => {
  it('Claude: Opus/Sonnet/Fable = 1M', () => {
    expect(contextLimitFor('claude-opus-4-8')).toBe(1_000_000)
    expect(contextLimitFor('claude-sonnet-5-5')).toBe(1_000_000)
    expect(contextLimitFor('claude-fable-5-1')).toBe(1_000_000)
    expect(contextLimitFor('claude-fable-5')).toBe(1_000_000)
  })

  it('Ollama Cloud: GLM-5.3 (e Flash) e Kimi K3 são 1M nativos (não 128K/200K)', () => {
    expect(contextLimitFor('glm-5.3:cloud')).toBe(1_000_000)
    expect(contextLimitFor('glm-5.3-flash:cloud')).toBe(1_000_000)
    expect(contextLimitFor('kimi-k3:cloud')).toBe(1_000_000)
  })

  it('Ollama Cloud: Nemotron/Gemma 256K, gpt-oss e Muse Glimmer 128K', () => {
    expect(contextLimitFor('nemotron-3-ultra:cloud')).toBe(256_000)
    expect(contextLimitFor('gpt-oss:120b-cloud')).toBe(128_000)
    expect(contextLimitFor('gpt-oss:20b-cloud')).toBe(128_000)
    expect(contextLimitFor('gemma4:cloud')).toBe(256_000)
    expect(contextLimitFor('nemotron-3-super:cloud')).toBe(256_000)
    expect(contextLimitFor('muse-glimmer:cloud')).toBe(128_000)
  })

  it('GPT-6 Luna/Sol/Astra usam a janela padrão do catálogo do Codex (272k)', () => {
    expect(contextLimitFor('gpt-6-luna')).toBe(272_000)
    expect(contextLimitFor('gpt-6-sol')).toBe(272_000)
    expect(contextLimitFor('gpt-6-astra')).toBe(272_000)
  })

  it('GPT-5.6 saiu do seletor; conversa/config salvas com ele viram GPT-6 e seguem no GPT', () => {
    expect(OPENAI_MODELS.map((m) => m.id)).toEqual(['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra'])
    expect(currentModelId('gpt-5.6-luna')).toBe('gpt-6-luna')
    expect(currentModelId('gpt-5.6-terra')).toBe('gpt-6-sol')
    expect(currentModelId('gpt-5.6-sol')).toBe('gpt-6-sol')
    expect(currentModelId('claude-opus-5-5')).toBe('claude-opus-5-5')
    for (const old of Object.keys(RETIRED_MODEL_REPLACEMENTS).filter((id) => id.startsWith('gpt-'))) {
      expect(isOpenAIModel(old)).toBe(false)
      expect(isOpenAIModel(currentModelId(old))).toBe(true)
    }
  })

  it('Sonnet 5 saiu do seletor; conversa/config salvas com ele viram Sonnet 5.5', () => {
    expect(currentModelId('claude-sonnet-5')).toBe('claude-sonnet-5-5')
    expect(CLAUDE_MODELS.some((m) => m.id === 'claude-sonnet-5-5')).toBe(true)
  })

  it('modelo desconhecido cai no fallback padrão', () => {
    expect(contextLimitFor('modelo-inexistente')).toBe(200_000)
    expect(contextLimitFor(undefined)).toBe(200_000)
  })

  it('todo modelo do CONTEXT_LIMITS tem um valor positivo', () => {
    for (const [model, limit] of Object.entries(CONTEXT_LIMITS)) {
      expect(limit, model).toBeGreaterThan(0)
    }
  })
})

describe('modelSupportsVision — quais modelos aceitam imagem direto', () => {
  it('Claude sempre suporta (mesmo modelo desconhecido/futuro)', () => {
    expect(modelSupportsVision('claude-opus-4-8')).toBe(true)
    expect(modelSupportsVision('claude-sonnet-5-5')).toBe(true)
    expect(modelSupportsVision(undefined)).toBe(true)
  })

  it('GPT-6 mantém imagem nativa pelo tradutor Responses', () => {
    expect(modelSupportsVision('gpt-6-luna')).toBe(true)
    expect(modelSupportsVision('gpt-6-sol')).toBe(true)
    expect(modelSupportsVision('gpt-6-astra')).toBe(true)
  })

  it('Kimi K3 aceita imagem direto (multimodal nativo, herdou o slot do K2.7)', () => {
    expect(modelSupportsVision('kimi-k3:cloud')).toBe(true)
  })

  it('demais modelos Ollama são texto-only (400 real da API) — precisam do vision relay', () => {
    expect(modelSupportsVision('nemotron-3-ultra:cloud')).toBe(false)
    expect(modelSupportsVision('gpt-oss:120b-cloud')).toBe(false)
    expect(modelSupportsVision('gpt-oss:20b-cloud')).toBe(false)
    expect(modelSupportsVision('gemma4:cloud')).toBe(false)
    expect(modelSupportsVision('nemotron-3-super:cloud')).toBe(false)
    expect(modelSupportsVision('muse-glimmer:cloud')).toBe(false)
    expect(modelSupportsVision('glm-5.3:cloud')).toBe(false)
    // Flash anuncia "Text, Image" no card do Ollama, mas sem probe ao vivo
    // continua no relay — promover só depois de verificar contra a API.
    expect(modelSupportsVision('glm-5.3-flash:cloud')).toBe(false)
  })
})

describe('modelSupportsFastMode — quais modelos aceitam o modo rápido', () => {
  it('só os Opus suportados pela Anthropic (Opus 5.5 e 4.8)', () => {
    expect(modelSupportsFastMode('claude-opus-5-5')).toBe(true)
    expect(modelSupportsFastMode('claude-opus-4-8')).toBe(true)
  })

  it('Opus 4.7 NÃO entra — o modo rápido dele foi removido em 24/07/2026 e a API rejeita', () => {
    expect(modelSupportsFastMode('claude-opus-4-7')).toBe(false)
  })

  it('Sonnet/Fable, Ollama e desconhecidos ficam de fora (a API rejeitaria)', () => {
    expect(modelSupportsFastMode('claude-sonnet-5-5')).toBe(false)
    expect(modelSupportsFastMode('claude-fable-5-1')).toBe(false)
    expect(modelSupportsFastMode('claude-fable-5')).toBe(false)
    expect(modelSupportsFastMode('nemotron-3-ultra:cloud')).toBe(false)
    expect(modelSupportsFastMode('muse-glimmer:cloud')).toBe(false)
    expect(modelSupportsFastMode('modelo-inexistente')).toBe(false)
    expect(modelSupportsFastMode(undefined)).toBe(false)
  })
})

describe('MODEL_EFFORT — esforço máximo do SDK', () => {
  it('expõe max para Opus/Sonnet/Fable e mantém Haiku limitado a high', () => {
    expect(MODEL_EFFORT['claude-opus-4-8']).toContain('max')
    expect(MODEL_EFFORT['claude-sonnet-5-5']).toContain('max')
    expect(MODEL_EFFORT['claude-fable-5-1']).toContain('max')
    expect(MODEL_EFFORT['claude-fable-5']).toContain('max')
  })

  it('oferece low até max para toda a família GPT-6', () => {
    const expected = ['low', 'medium', 'high', 'xhigh', 'max']
    expect(MODEL_EFFORT['gpt-6-luna']).toEqual(expected)
    expect(MODEL_EFFORT['gpt-6-sol']).toEqual(expected)
    expect(MODEL_EFFORT['gpt-6-astra']).toEqual(expected)
  })
})
