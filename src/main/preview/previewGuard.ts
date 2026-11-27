/**
 * Barreira de caminho do preview — a MESMA para a leitura (readPreviewFile) e
 * para o protocolo agent-preview:// (o <webview> não pode pedir o que a
 * leitura recusaria): caminho absoluto, existe, é arquivo e não é sensível
 * (.env, chaves, credenciais… — regra do shared/pathGuard). Um link simbólico
 * é conferido também pelo destino real.
 */
import { promises as fs } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isSensitivePath } from '../../shared/pathGuard'

export type PreviewGuardFail = { ok: false; reason: 'not-found' | 'blocked' | 'unsupported' | 'error'; message: string }
export type PreviewGuardResult = { ok: true; real: string; size: number } | PreviewGuardFail

const SENSITIVE_MESSAGE = 'Arquivo sensível (chaves, senhas ou credenciais): o preview não abre por segurança.'
const NETWORK_MESSAGE = 'Caminho de rede (\\\\servidor\\pasta): o preview só abre arquivos deste computador.'

/** Começa com duas barras (\\ ou //, em qualquer mistura): UNC, \\?\UNC\, \\.\ ou //?/. */
export function isNetworkOrDevicePath(path: string): boolean {
  return /^[\\/]{2}/.test(path)
}

/** Confere o caminho antes de ler ou servir. Nunca lança. */
export async function checkPreviewPath(path: string): Promise<PreviewGuardResult> {
  if (typeof path !== 'string' || !path.trim()) return { ok: false, reason: 'error', message: 'Nenhum arquivo informado.' }
  if (!isAbsolute(path)) return { ok: false, reason: 'error', message: 'O caminho do arquivo precisa ser completo (absoluto).' }
  if (path.includes('\0')) return { ok: false, reason: 'blocked', message: 'Caminho inválido.' }
  // Caminho de rede/dispositivo (\\host\share, \\?\UNC\…, //?/…): o realpath abriria
  // uma conexão SMB e o Windows mandaria o hash NTLM do usuário para o host.
  if (isNetworkOrDevicePath(path)) return { ok: false, reason: 'blocked', message: NETWORK_MESSAGE }
  if (isSensitivePath(path)) return { ok: false, reason: 'blocked', message: SENSITIVE_MESSAGE }
  let real: string
  try {
    real = await fs.realpath(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'not-found', message: 'Arquivo não encontrado.' }
    return { ok: false, reason: 'error', message: 'Não foi possível abrir o arquivo.' }
  }
  // Link local que aponta para a rede: não serve (o realpath já passou por ele).
  if (isNetworkOrDevicePath(real)) return { ok: false, reason: 'blocked', message: NETWORK_MESSAGE }
  if (isSensitivePath(real)) return { ok: false, reason: 'blocked', message: SENSITIVE_MESSAGE }
  try {
    const st = await fs.stat(real)
    if (!st.isFile()) return { ok: false, reason: 'unsupported', message: 'Isto é uma pasta, não um arquivo.' }
    return { ok: true, real, size: st.size }
  } catch {
    return { ok: false, reason: 'error', message: 'Não foi possível abrir o arquivo.' }
  }
}
