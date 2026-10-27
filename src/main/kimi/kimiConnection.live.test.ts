/**
 * Testar conexão contra o Kimi de verdade. Só roda com LIVE_KIMI=1 e lê a chave
 * de %LOCALAPPDATA%\agent-code\kimi-sonda\credencial.json (ou KIMI_SONDA_DIR),
 * fora do repo. Gasta um pedido mínimo por modelo liberado.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { testKimiConnection } from './kimiConnection'

const dir = process.env.KIMI_SONDA_DIR ?? join(process.env.LOCALAPPDATA ?? '', 'agent-code', 'kimi-sonda')
const file = join(dir, 'credencial.json')
const live = process.env.LIVE_KIMI === '1' && existsSync(file)

describe.skipIf(!live)('Kimi ao vivo: Testar conexão', () => {
  it('detecta região, janela e modelos do plano com a chave real', async () => {
    const { apiKey } = JSON.parse(readFileSync(file, 'utf8')) as { apiKey: string }
    const r = await testKimiConnection(apiKey, { appVersion: 'live-test' })
    console.log('resultado:', JSON.stringify(r))
    expect(r.ok).toBe(true)
    expect(r.models).toContain('k3.1-pro')
    expect([262_144, 1_048_576]).toContain(r.contextWindow)
    expect(JSON.stringify(r)).not.toContain(apiKey)
  }, 90_000)
})
