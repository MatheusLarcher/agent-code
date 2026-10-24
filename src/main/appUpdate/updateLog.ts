// Log da atualização automática: uma linha por evento, com data, em
// <userData>/logs/atualizacao.log — checagens, versão encontrada, download,
// conferência, erros e o disparo da instalação. É o que sobra para entender
// por que uma atualização não aconteceu depois que o app já fechou.
//
// Regras (as mesmas de sessionLog.ts): nunca lança, nunca bloqueia o main
// (escrita assíncrona em fila) e nunca grava segredo.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const UPDATE_LOG_FILENAME = 'atualizacao.log'
/** Acima disto o arquivo vira `atualizacao.1.log` (o anterior é sobrescrito). */
export const UPDATE_LOG_MAX_BYTES = 2 * 1024 * 1024

export interface UpdateLog {
  (line: string): void
  /** Espera as escritas em fila (testes e encerramento). */
  flush(): Promise<void>
}

/** Liga o log em `<userDataDir>/logs/atualizacao.log`. */
export function createUpdateLog(userDataDir: string, options: { maxBytes?: number } = {}): UpdateLog {
  const dir = join(userDataDir, 'logs')
  const file = join(dir, UPDATE_LOG_FILENAME)
  const rotated = join(dir, 'atualizacao.1.log')
  const maxBytes = options.maxBytes ?? UPDATE_LOG_MAX_BYTES
  let queue: Promise<void> = Promise.resolve()
  let warned = false

  const write = async (line: string): Promise<void> => {
    await mkdir(dir, { recursive: true })
    const size = await stat(file).then((info) => info.size, () => 0)
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) await rename(file, rotated)
    await appendFile(file, line, 'utf8')
  }

  const log = ((line: string): void => {
    try {
      const text = `[${new Date().toISOString()}] ${String(line).replace(/\r?\n/g, ' | ')}\n`
      queue = queue.then(() => write(text)).catch((error: unknown) => {
        if (warned) return
        warned = true
        console.warn('[atualizacao-log] falha ao gravar (as próximas falhas ficam caladas):', error)
      })
    } catch {
      /* nunca lança */
    }
  }) as UpdateLog
  log.flush = (): Promise<void> => queue
  return log
}
