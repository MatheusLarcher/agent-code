import { z } from 'zod'
import {
  DEFAULT_CONFIG,
  EFFORT_LEVELS,
  PLANNING_MODELS,
  type AppConfig,
  type EffortLevel,
  type PlanningConfig
} from '../../shared/ipc'
import { StorageError } from './types'

/**
 * O bloco `planning` normalizado: modelo fora de PLANNING_MODELS ou esforço fora
 * de EFFORT_LEVELS (incluindo tipo errado ou ausente) volta ao padrão, campo a
 * campo. Normaliza em vez de rejeitar, ao contrário dos outros grupos: um id de
 * modelo que saiu da lista (troca de catálogo) não é corrupção, e cada campo é
 * aplicado sozinho no boot — rejeitar ali derrubaria a abertura do app.
 */
export function normalizePlanningConfig(value: { model?: unknown; effort?: unknown } | undefined): PlanningConfig {
  const model = value?.model
  const effort = value?.effort
  return {
    model:
      typeof model === 'string' && PLANNING_MODELS.some((option) => option.id === model)
        ? model
        : DEFAULT_CONFIG.planning.model,
    effort:
      typeof effort === 'string' && EFFORT_LEVELS.includes(effort as EffortLevel)
        ? (effort as EffortLevel)
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
  return [...new Set(value)]
}

const partialConfigSchema = z
  .object({
    openai: z
      .object({
        apiKey: z.string().optional(),
        voice: z.string().optional(),
        speed: z.number().finite().positive().optional()
      })
      .strict()
      .optional(),
    transcribeEngine: z.enum(['cloud', 'local']).optional(),
    localSpeech: z.object({ model: z.string().min(1).optional() }).strict().optional(),
    ollama: z.object({ enabled: z.boolean().optional(), apiKey: z.string().optional() }).strict().optional(),
    skipPermissions: z.boolean().optional(),
    windowsControlEnabled: z.boolean().optional(),
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
    openai: { ...DEFAULT_CONFIG.openai },
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
    openai: { ...current.openai, ...(parsed.data.openai ?? {}) },
    localSpeech: { ...current.localSpeech, ...(parsed.data.localSpeech ?? {}) },
    ollama: { ...current.ollama, ...(parsed.data.ollama ?? {}) },
    vigia: { ...current.vigia, ...(parsed.data.vigia ?? {}) },
    memorista: { ...current.memorista, ...(parsed.data.memorista ?? {}) },
    planning: normalizePlanningConfig({ ...current.planning, ...(parsed.data.planning ?? {}) }),
    // `po` é aninhado: o spread raso do `board` apagaria o modelo ao gravar só
    // o interruptor (mesma armadilha do merge aninhado do `openai`).
    board: {
      ...current.board,
      ...(parsed.data.board ?? {}),
      po: { ...current.board.po, ...(parsed.data.board?.po ?? {}) }
    },
    typesafe: { ...current.typesafe, ...(parsed.data.typesafe ?? {}) }
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
  return mergeAppConfig(defaultAppConfig(), parsed)
}
