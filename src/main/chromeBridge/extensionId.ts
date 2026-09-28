import { createHash } from 'node:crypto'

/**
 * ID de uma extensão Chrome a partir da `key` do manifest (base64 do DER SPKI):
 * sha256(DER), primeiros 32 dígitos hex, cada um mapeado 0-f → a-p.
 */
export function extensionIdFromKey(keyBase64: string): string {
  const der = Buffer.from(keyBase64, 'base64')
  if (der.length === 0) throw new Error('key vazia')
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32)
  return [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('')
}

/** ID fixo da extensão local — derivado da `key` de src/chromeExtension/manifest.json. */
export const CHROME_EXTENSION_ID = 'mianhmemonokgnfadllmjamjgckbclpa'
