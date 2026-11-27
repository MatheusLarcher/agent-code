import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

/**
 * Frase-senha do cofre (D18, docs/orquestracao/REGISTRO.md).
 *
 * O arquivo do cofre guarda a chave junto dos segredos. No banco LOCAL isso é
 * aceitável (é o mesmo disco); na NUVEM, quem acessa o Neon abriria tudo. Então,
 * com a nuvem, o espelho do cofre vai para o banco EMBRULHADO por uma chave que
 * sai da frase-senha do usuário — essa chave nunca vai para o banco.
 *
 * KDF: scrypt do próprio Node (memória-dura, como o Argon2id proposto no D21),
 * sem dependência nativa nova. AES-256-GCM, como o resto do cofre.
 */

export const WRAPPED_FORMAT = 'cofre-frase-v1'
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }
export const MIN_PASSPHRASE_CHARS = 12

export interface PassphraseKey {
  salt: string // base64
  key: Buffer
}

export function deriveKey(passphrase: string, saltB64?: string): PassphraseKey {
  const salt = saltB64 ? Buffer.from(saltB64, 'base64') : randomBytes(16)
  return { salt: salt.toString('base64'), key: scryptSync(passphrase.normalize('NFC'), salt, 32, SCRYPT) }
}

/** O envelope do cofre (chave + segredos) cifrado pela chave da frase-senha. */
export function wrapEnvelope(envelope: string, k: PassphraseKey): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', k.key, iv)
  const ct = Buffer.concat([cipher.update(envelope, 'utf8'), cipher.final()])
  return JSON.stringify({
    format: WRAPPED_FORMAT,
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: k.salt },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64')
  })
}

/** `null` = não é embrulhado, ou a chave não abre (frase errada / adulterado). */
export function unwrapEnvelope(wrapped: string, key: Buffer): string | null {
  const w = parseWrapped(wrapped)
  if (!w) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(w.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(w.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(w.ct, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export function isWrapped(text: string | null | undefined): boolean {
  return !!text && parseWrapped(text) !== null
}

/** O sal gravado no espelho: outro PC precisa dele para chegar à MESMA chave. */
export function wrappedSalt(text: string): string | null {
  return parseWrapped(text)?.kdf.salt ?? null
}

function parseWrapped(text: string): { iv: string; tag: string; ct: string; kdf: { salt: string } } | null {
  try {
    const w = JSON.parse(text) as { format?: unknown; iv?: unknown; tag?: unknown; ct?: unknown; kdf?: { salt?: unknown } }
    if (w?.format !== WRAPPED_FORMAT || typeof w.iv !== 'string' || typeof w.tag !== 'string' || typeof w.ct !== 'string') return null
    if (typeof w.kdf?.salt !== 'string') return null
    return w as { iv: string; tag: string; ct: string; kdf: { salt: string } }
  } catch {
    return null
  }
}

/** Selo do sistema (Chaveiro/DPAPI via `safeStorage`), injetado pelo main. */
export interface LocalSeal {
  seal(text: string): string | null
  open(text: string): string | null
}

/** A chave derivada guardada NESTE PC, selada pelo sistema: não pede a frase a cada abertura. */
export function saveLocalKey(file: string, k: PassphraseKey, seal: LocalSeal): boolean {
  const sealed = seal.seal(JSON.stringify({ salt: k.salt, key: k.key.toString('base64') }))
  if (!sealed) return false
  writeFileSync(file, sealed, { encoding: 'utf8', mode: 0o600 })
  return true
}

export function loadLocalKey(file: string, seal: LocalSeal): PassphraseKey | null {
  try {
    if (!existsSync(file)) return null
    const opened = seal.open(readFileSync(file, 'utf8'))
    if (!opened) return null
    const d = JSON.parse(opened) as { salt?: unknown; key?: unknown }
    if (typeof d.salt !== 'string' || typeof d.key !== 'string') return null
    const key = Buffer.from(d.key, 'base64')
    return key.length === 32 ? { salt: d.salt, key } : null
  } catch {
    return null
  }
}

export function forgetLocalKey(file: string): void {
  rmSync(file, { force: true })
}
