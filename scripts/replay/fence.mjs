// Cerca de leitura de uma rodada. Na fumaça, o agente listou as pastas vizinhas da dele
// e leu um extrato do banco do usuário — dava para achar a solução do mesmo jeito: no
// checkout do usuário (tem o código final), nas cópias das outras tarefas (commits
// posteriores), nos logs do app em uso (de builds posteriores), nos transcripts reais
// e no GitHub (o repositório é público).
// Read/Glob/Grep/WebFetch/WebSearch/navegador são aprovados pelo próprio app sem passar
// pela ponte, então a cerca vai como regra `deny` do CLI no .claude/settings.local.json
// da cópia (o app carrega settingSources 'project' e 'local'); o shell é cercado pela
// política (policy.mjs) e pelo ambiente isolado da instância (instance.mjs).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { insideAny } from './policy.mjs'

/**
 * Pastas proibidas (ler e escrever) para a rodada: tudo de `root` que não seja a cópia
 * nem a pasta de dados dela, o checkout do usuário, os dados reais do app (Roaming e
 * Local), o ~/.claude inteiro (transcripts e credenciais) e o OneDrive.
 */
export function forbiddenRoots({ worktree, runData, root, repo, appData, localAppData, home, oneDrive }) {
  const own = [worktree, runData]
  const out = [repo, path.join(appData, 'agent-code-desktop'), path.join(localAppData, 'agent-code'), path.join(home, '.claude'), oneDrive]
  const walk = (dir, depth) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (insideAny(p, own)) continue
      // Pasta que CONTÉM a cópia ou os dados da rodada: desce para proibir só as irmãs.
      if (e.isDirectory() && depth < 2 && own.some((o) => insideAny(o, [p]))) walk(p, depth + 1)
      else out.push(p)
    }
  }
  walk(root, 0)
  return out
}

/** Caminho do Windows → forma POSIX das regras do CLI (C:\x\y → //c/x/y). */
export const ruleCase = (p) => `//${p.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (_, d) => d.toLowerCase())}`

/** Ferramentas negadas por inteiro no replay (rede, navegador, worktree fora do diff). */
export const DENIED_TOOLS = ['WebFetch', 'WebSearch', 'mcp__browser', 'EnterWorktree']

/** Grava a cerca como regras `deny` do CLI na cópia (ignorado pelo git da cópia). */
export function writeFence(worktree, roots) {
  const deny = [...DENIED_TOOLS, ...roots.flatMap((r) => [`Read(${ruleCase(r)}/**)`, `Read(${ruleCase(r)})`])]
  const dir = path.join(worktree, '.claude')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'settings.local.json'), JSON.stringify({ permissions: { deny } }, null, 2))
  return deny
}
