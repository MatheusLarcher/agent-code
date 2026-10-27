// @vitest-environment node
/**
 * Ao vivo (LIVE_KIMI=1): o CLI real do app, logado na conta Claude da máquina
 * (~/.claude), apontado para o roteador, com o modelo do Kimi. Turno curto
 * ("responda ok"). O registro do roteador prova o destino de cada pedido. A
 * chave do Kimi fica só no roteador: nada dela no ambiente do CLI.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { startKimiRouterServer } from './kimiRouter'

const credFile = join(process.env.KIMI_SONDA_DIR ?? join(process.env.LOCALAPPDATA ?? '', 'agent-code', 'kimi-sonda'), 'credencial.json')
const live = process.env.LIVE_KIMI === '1' && existsSync(credFile)

/** Ambiente do CLI sem nada herdado do app hospedeiro (variáveis CLAUDE_ e ANTHROPIC_). */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC)/i.test(k)) env[k] = v
  return env
}

describe.skipIf(!live)('Kimi ao vivo: roteador com o CLI real', () => {
  it('o turno principal vai ao Kimi e responde; nada do Kimi no ambiente do CLI', async () => {
    const { apiKey } = JSON.parse(readFileSync(credFile, 'utf8')) as { apiKey: string }
    const logDir = mkdtempSync(join(tmpdir(), 'kimi-router-live-'))
    const cwd = mkdtempSync(join(tmpdir(), 'kimi-router-cwd-'))
    const secret = 'live-' + Date.now()
    const handle = await startKimiRouterServer({
      credential: () => ({ apiKey, region: 'intl', contextWindow: 262_144, orgInstructions: '' }),
      secret,
      logDir,
      log: (l) => console.log(l)
    })
    try {
      const env = {
        ...cleanEnv(),
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${handle.port}/${secret}`,
        CLAUDE_CODE_SUBAGENT_MODEL: 'k3.1-pro',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '262144',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
        CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'padded-countdown',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000'
      }
      expect(JSON.stringify(env)).not.toContain(apiKey)
      const sdk = pathToFileURL(join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs')).href
      const { query } = (await import(sdk)) as { query: (a: unknown) => AsyncIterable<Record<string, unknown>> }
      let text = ''
      let resultSubtype = ''
      for await (const m of query({
        prompt: 'responda apenas: ok',
        options: {
          cwd,
          model: 'k3.1-pro',
          env,
          thinking: { type: 'adaptive', display: 'summarized' },
          permissionMode: 'default',
          maxTurns: 1,
          settingSources: ['user', 'project', 'local'],
          systemPrompt: { type: 'preset', preset: 'claude_code' }
        }
      })) {
        if (m.type === 'assistant') {
          const content = (m.message as { content?: Array<{ type: string; text?: string }> })?.content ?? []
          text += content.filter((c) => c.type === 'text').map((c) => c.text).join('')
        }
        if (m.type === 'result') resultSubtype = String(m.subtype)
      }
      const index = readFileSync(join(logDir, 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { route: string; model?: string; status: number })
      console.log('resposta:', JSON.stringify(text), 'resultado:', resultSubtype)
      console.log('registro:', JSON.stringify(index))
      expect(text.toLowerCase()).toContain('ok')
      expect(index.some((r) => r.route === 'kimi' && r.model === 'k3.1-pro' && r.status === 200)).toBe(true)
      expect(index.every((r) => r.route !== 'anthropic' || !String(r.model ?? '').startsWith('k3'))).toBe(true)
      const all = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('')
      expect(all).not.toContain(apiKey)
    } finally {
      await handle.close()
      if (process.env.KIMI_KEEP_LOG === '1') console.log('registro guardado em', logDir)
      else rmSync(logDir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 300_000)
})
