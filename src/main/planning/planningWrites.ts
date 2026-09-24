import { createHash } from 'node:crypto'
import path from 'node:path'

/**
 * Registro das gravações que o PRÓPRIO app fez nos arquivos de planejamento.
 *
 * O planningStore anota aqui o hash do conteúdo que acabou de gravar (ou a
 * remoção do arquivo), por caminho absoluto; o planningWatcher consulta antes
 * de avisar a tela. Um evento do fs cujo arquivo tem exatamente o conteúdo que
 * o app gravou por último é eco da nossa própria escrita, não mudança externa.
 *
 * Ficar no store (e não na tela) é o ponto: toda gravação feita pelo app —
 * a tela hoje, as ferramentas do agente depois — passa por ele.
 */

/** Conteúdo "arquivo não existe": o que o app deixa depois de remover. */
const ABSENT = 'absent'

/** Teto de caminhos lembrados; acima dele o mais antigo sai. */
const MAX_ENTRIES = 2000

const lastOwn = new Map<string, string>()

function keyOf(file: string): string {
  const abs = path.resolve(file)
  // NTFS não diferencia caixa: C:\Proj e c:\proj são o mesmo arquivo.
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

export function contentHash(content: string | Uint8Array | null): string {
  if (content === null) return ABSENT
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  return createHash('sha256').update(bytes).digest('hex')
}

/** Anota que o app gravou `content` em `file` (null = o app removeu o arquivo). */
export function recordOwnWrite(file: string, content: string | Uint8Array | null): void {
  recordOwnWriteHash(file, contentHash(content))
}

/**
 * Como recordOwnWrite, mas com o hash já calculado (sha256 hex dos bytes):
 * para arquivo grande copiado sem passar pela memória (mídia do plano).
 */
export function recordOwnWriteHash(file: string, hash: string): void {
  const key = keyOf(file)
  lastOwn.delete(key)
  lastOwn.set(key, hash)
  if (lastOwn.size > MAX_ENTRIES) {
    const oldest = lastOwn.keys().next().value
    if (oldest !== undefined) lastOwn.delete(oldest)
  }
}

/** Esquece o registro de `file` (gravação que falhou no meio). */
export function forgetOwnWrite(file: string): void {
  lastOwn.delete(keyOf(file))
}

/**
 * O conteúdo atual de `file` (null = não existe) é o que o app gravou por
 * último? Quando NÃO é, o registro é descartado: o arquivo já divergiu da
 * nossa gravação, e uma volta posterior ao mesmo conteúdo (edição externa
 * desfeita) precisa ser vista como mudança, não como eco.
 */
export function isOwnWrite(file: string, current: string | Uint8Array | null): boolean {
  const key = keyOf(file)
  const recorded = lastOwn.get(key)
  if (recorded === undefined) return false
  if (recorded === contentHash(current)) return true
  lastOwn.delete(key)
  return false
}

/** Só para testes: zera o registro. */
export function resetOwnWrites(): void {
  lastOwn.clear()
}
