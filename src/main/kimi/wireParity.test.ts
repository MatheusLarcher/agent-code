// @vitest-environment node
/**
 * Paridade do prompt no fio (Claude × Kimi) com o claude.exe real. Roda no
 * `npm test`; pula com aviso se o motor não existir. Nível (a): pasta de
 * configuração temporária, sem login. Nível (b): PARIDADE_LOGADA=1 usa a pasta
 * da conta Claude real (~/.claude) — o token vai só ao gravador local, que não
 * encaminha nada. PARIDADE_CLI troca o exe (o instalador aponta para o empacotado).
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runWireParity } from './wireParityHarness'

const repoRoot = process.cwd()
const cli = process.env.PARIDADE_CLI || undefined
const bundled = join(repoRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe')
const engine = cli ?? bundled
const hasEngine = existsSync(engine)
const logged = process.env.PARIDADE_LOGADA === '1'
const sabotar = process.env.PARIDADE_SABOTAR === '1'

if (!hasEngine) console.warn(`[paridade] motor não encontrado em ${engine}: teste pulado`)

describe.skipIf(!hasEngine)('paridade do prompt no fio: Claude × Kimi', () => {
  it(`${logged ? 'nível (b), conta logada' : 'nível (a), sem login'}: só as linhas de identidade diferem`, async () => {
    const r = await runWireParity({ repoRoot, cli, configDir: logged ? join(homedir(), '.claude') : undefined, sabotar })
    if (r.diff.length) console.log(`[paridade] diferenças:\n${r.diff.join('\n')}`)
    expect(r.diff, 'o prompt do Kimi divergiu do Claude').toEqual([])
    // Nenhum pedido com modelo Claude ao upstream do Kimi; nenhum Kimi ao da Anthropic.
    expect(r.kimiUpstream.every((q) => !String(q.body?.model ?? '').startsWith('claude'))).toBe(true)
    expect(r.anthropicUpstream.every((q) => !String(q.body?.model ?? '').startsWith('k3'))).toBe(true)
    // A chave do Kimi chega ao upstream do Kimi; credencial da Anthropic nunca.
    expect(r.kimi?.headers.authorization).toBe('<redigido>')
  }, 240_000)
})
