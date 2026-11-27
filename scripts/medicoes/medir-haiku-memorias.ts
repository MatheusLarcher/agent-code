// Mede quanto tempo a escolha de memórias pelo Haiku leva com as memórias reais do usuário.
// Só LÊ a pasta de memórias. Rodar:
//   npx esbuild scripts/medicoes/medir-haiku-memorias.ts --bundle --platform=node --format=esm --packages=external --outfile=scripts/medicoes/.medir.tmp.mjs
//   node scripts/medicoes/.medir.tmp.mjs [pasta]
import { homedir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { selectMemoriesWithHaiku } from '../../src/main/memorySelectionHaiku'
import { listMemoryFiles } from '../../src/main/memoryIndex'

const dir = process.argv[2] ?? join(homedir(), 'Documents', 'agent-code', 'memories')
const pedidos = ['oi', 'o painel do zabbix está com abas demais, enxuga', 'arruma o teste que está falhando no agent-code']
console.log(`memórias na pasta: ${listMemoryFiles(dir).length}`)
for (const pedido of pedidos) {
  const t0 = Date.now()
  const marcas: string[] = []
  const run = ((args: Parameters<typeof query>[0]) => {
    const it = query(args)
    return (async function* () {
      for await (const m of it) {
        const x = m as { type: string; subtype?: string; duration_api_ms?: number; mcp_servers?: unknown[] }
        marcas.push(`${x.type}${x.subtype ? '/' + x.subtype : ''} @${Date.now() - t0}ms${x.duration_api_ms ? ` (api ${x.duration_api_ms}ms)` : ''}${x.mcp_servers ? ` mcp=${x.mcp_servers.length}` : ''}`)
        yield m
      }
    })()
  }) as typeof query
  const r = await selectMemoriesWithHaiku(dir, pedido, { query: run })
  console.log(`\n"${pedido}": ${Date.now() - t0} ms, escolheu ${r?.relPaths.length ?? 'nada (falhou)'}`)
  console.log('  ' + marcas.join('\n  '))
}
