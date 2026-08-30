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
    remoteToken: z.string().optional(),
    remoteEnabled: z.boolean().optional()
  })
  .strict()

export function defaultAppConfig(): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    openai: { ...DEFAULT_CONFIG.openai },
    localSpeech: { ...DEFAULT_CONFIG.localSpeech },
    ollama: { ...DEFAULT_CONFIG.ollama }
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
    ollama: { ...current.ollama, ...(parsed.data.ollama ?? {}) }
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
