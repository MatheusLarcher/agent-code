import { z } from 'zod'
import { DEFAULT_CONFIG, type AppConfig } from '../../shared/ipc'
import { StorageError } from './types'

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
        minConfidence: z.number().min(0).max(1).optional()
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
    board: { ...DEFAULT_CONFIG.board, po: { ...DEFAULT_CONFIG.board.po } },
    typesafe: { ...DEFAULT_CONFIG.typesafe }
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
