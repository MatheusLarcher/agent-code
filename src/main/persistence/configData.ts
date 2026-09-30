import { z } from 'zod'
import {
  currentModelId,
  DEFAULT_CONFIG,
  DEFAULT_VOICE,
  EFFORT_LEVELS,
  isAutoEffort,
  isVoiceId,
  normalizeVoiceSpeed,
  PLANNING_MODELS,
  type AppConfig,
  type EffortChoice,
  type EffortLevel,
  type PlanningConfig,
  type TranscribeEngine,
  type VoiceId
} from '../../shared/ipc'
import { StorageError } from './types'

/**
 * O bloco `planning` normalizado: modelo fora de PLANNING_MODELS ou esforço fora
 * de EFFORT_LEVELS + AUTO_EFFORT (incluindo tipo errado ou ausente) volta ao padrão, campo a
 * campo. Normaliza em vez de rejeitar, ao contrário dos outros grupos: um id de
 * modelo que saiu da lista (troca de catálogo) não é corrupção, e cada campo é
 * aplicado sozinho no boot — rejeitar ali derrubaria a abertura do app.
 */
export function normalizePlanningConfig(value: { model?: unknown; effort?: unknown } | undefined): PlanningConfig {
  const model = typeof value?.model === 'string' ? currentModelId(value.model) : value?.model
  const effort = value?.effort
  return {
    model:
      typeof model === 'string' && PLANNING_MODELS.some((option) => option.id === model)
        ? model
        : DEFAULT_CONFIG.planning.model,
    effort:
      typeof effort === 'string' && (EFFORT_LEVELS.includes(effort as EffortLevel) || isAutoEffort(effort))
        ? (effort as EffortChoice)
        : DEFAULT_CONFIG.planning.effort
  }
}

/**
 * A lista de modelos do Automático (`typesafe.allowedAutoModels`) lida do banco.
 * Não-array ou qualquer item que não seja texto não vazio → `[]` (o padrão: sem
 * restrição), em vez de lançar: cada campo é aplicado sozinho no boot, e lançar
 * ali derrubaria a abertura do app. Repetidos saem; a ordem fica.
 */
export function normalizeAllowedAutoModels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  if (!value.every((item): item is string => typeof item === 'string' && item.trim().length > 0)) return []
  // Modelo aposentado na lista vira o substituto (GPT-5.6 → GPT-6).
  return [...new Set(value.map(currentModelId))]
}

const partialConfigSchema = z
  .object({
    voice: z
      .object({
        // Voz fora da lista (ex.: uma voz antiga da OpenAI) volta ao padrão em
        // vez de derrubar o boot; velocidade é presa ao intervalo do Kokoro.
        voice: z.string().transform((v): VoiceId => (isVoiceId(v) ? v : DEFAULT_VOICE)).optional(),
        speed: z.number().finite().positive().transform(normalizeVoiceSpeed).optional()
      })
      .strict()
      .optional(),
    // 'cloud' (OpenAI, removido) é aceito só para migrar: vira o Whisper local.
    transcribeEngine: z
      .enum(['whisper', 'local', 'cloud'])
      .transform((v): TranscribeEngine => (v === 'cloud' ? 'whisper' : v))
      .optional(),
    localSpeech: z.object({ model: z.string().min(1).optional() }).strict().optional(),
    ollama: z.object({ enabled: z.boolean().optional(), apiKey: z.string().optional() }).strict().optional(),
    skipPermissions: z.boolean().optional(),
    windowsControlEnabled: z.boolean().optional(),
    chromeControlEnabled: z.boolean().optional(),
    chromeBridgeToken: z.string().optional(),
    secretVaultEnabled: z.boolean().optional(),
    remoteToken: z.string().optional(),
    remoteEnabled: z.boolean().optional(),
    preventSleepWhileBusy: z.boolean().optional(),
    vigia: z.object({ enabled: z.boolean().optional(), model: z.string().min(1).optional() }).strict().optional(),
    memorista: z.object({ enabled: z.boolean().optional(), model: z.string().min(1).optional() }).strict().optional(),
    // Valores soltos de propósito: quem valida é `normalizePlanningConfig`, que
    // devolve o padrão em vez de lançar (ver o comentário dela).
    planning: z.object({ model: z.unknown().optional(), effort: z.unknown().optional() }).strict().optional(),
    board: z
      .object({
        requirePlan: z.boolean().optional(),
        po: z.object({ enabled: z.boolean().optional(), model: z.string().min(1).optional() }).strict().optional()
      })
      .strict()
      .optional(),
    typesafe: z
      .object({
        enabled: z.boolean().optional(),
        apiKey: z.string().optional(),
        // Fora de 0..1 o limiar não significa nada: ou cala o serviço para
        // sempre, ou deixa passar decisão que ele próprio diz ser um chute.
        minConfidence: z.number().min(0).max(1).optional(),
        allowedAutoModels: z.array(z.string().min(1)).optional()
      })
      .strict()
      .optional()
  })
  .strict()

export function defaultAppConfig(): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    voice: { ...DEFAULT_CONFIG.voice },
    localSpeech: { ...DEFAULT_CONFIG.localSpeech },
    ollama: { ...DEFAULT_CONFIG.ollama },
    vigia: { ...DEFAULT_CONFIG.vigia },
    memorista: { ...DEFAULT_CONFIG.memorista },
    planning: { ...DEFAULT_CONFIG.planning },
    board: { ...DEFAULT_CONFIG.board, po: { ...DEFAULT_CONFIG.board.po } },
    // A lista é copiada: o spread raso dividiria o array com DEFAULT_CONFIG.
    typesafe: { ...DEFAULT_CONFIG.typesafe, allowedAutoModels: [...DEFAULT_CONFIG.typesafe.allowedAutoModels] }
  }
}

export function mergeAppConfig(current: AppConfig, patch: unknown): AppConfig {
  const parsed = partialConfigSchema.safeParse(patch)
  if (!parsed.success) {
    throw new StorageError('INVALID_PERSISTED_DATA', 'Configuração do Agent Code inválida.', false, {
      cause: parsed.error
    })
  }
  return {
    ...current,
    ...parsed.data,
    voice: { ...current.voice, ...(parsed.data.voice ?? {}) },
    localSpeech: { ...current.localSpeech, ...(parsed.data.localSpeech ?? {}) },
    ollama: { ...current.ollama, ...(parsed.data.ollama ?? {}) },
    vigia: { ...current.vigia, ...(parsed.data.vigia ?? {}) },
    memorista: { ...current.memorista, ...(parsed.data.memorista ?? {}) },
    planning: normalizePlanningConfig({ ...current.planning, ...(parsed.data.planning ?? {}) }),
    // `po` é aninhado: o spread raso do `board` apagaria o modelo ao gravar só
    // o interruptor (mesma armadilha do merge aninhado do `voice`).
    board: {
      ...current.board,
      ...(parsed.data.board ?? {}),
      po: { ...current.board.po, ...(parsed.data.board?.po ?? {}) }
    },
    typesafe: (() => {
      const typesafe = { ...current.typesafe, ...(parsed.data.typesafe ?? {}) }
      return { ...typesafe, allowedAutoModels: normalizeAllowedAutoModels(typesafe.allowedAutoModels) }
    })()
  }
}

export function parseStoredAppConfig(raw: string | null): AppConfig {
  if (!raw) return defaultAppConfig()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new StorageError('INVALID_PERSISTED_DATA', 'Configuração persistida não é um JSON válido.', false, {
      cause
    })
  }
  return mergeAppConfig(defaultAppConfig(), migrateLegacyVoice(parsed))
}

/**
 * O blob antigo trazia `openai: { apiKey, voice, speed }` (voz via OpenAI, já
 * removida). A chave e a voz da OpenAI são descartadas — nenhuma delas existe no
 * motor local; a velocidade continua valendo. Sem isso o schema estrito
 * rejeitaria o blob e a config inteira cairia.
 */
export function migrateLegacyVoice(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('openai' in parsed)) return parsed
  const { openai, ...rest } = parsed as Record<string, unknown>
  const speed = typeof openai === 'object' && openai !== null ? (openai as { speed?: unknown }).speed : undefined
  if (rest.voice !== undefined || typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) return rest
  return { ...rest, voice: { speed } }
}
