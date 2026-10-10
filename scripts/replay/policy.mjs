// Política de permissão das rodadas do replay: o arnês responde sozinho aos pedidos
// de permissão da instância isolada. Regra: o agente faz o que quiser DENTRO da cópia
// da rodada; nada que toque o checkout do usuário, o app em uso, outra cópia, a rede
// (o repositório é público no GitHub: daria para baixar a solução) ou o PC dele.
// Função pura — testada em replay.test.mjs. Read/Glob/Grep/WebFetch/WebSearch/navegador
// não passam por aqui (o app aprova sozinho): esses vão na cerca do CLI (fence.mjs).

/** Ferramentas que nunca rodam no replay. */
const DENY_TOOLS = /^(mcp__windows__|mcp__chrome__|mcp__android__|mcp__browser__|mcp__app__app_restart$|mcp__app__app_postgres_nuvem$|EnterWorktree$|ExitWorktree$|WebFetch$|WebSearch$)/

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

/** Comandos de shell que saem da rodada. */
const SHELL_DENY = [
  [/\bgit\b[^\n|;&]*\b(push|clone|fetch|pull|ls-remote|submodule|worktree)\b/i, 'git com rede ou outra árvore sai da rodada (o repositório é público: traria a solução)'],
  [/\bgit\b[^\n|;&]*\bremote\s+(add|set-url|remove)\b/i, 'git remote mexe na origem'],
  [/\bgh\s/i, 'gh fala com o GitHub'],
  [/\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|Start-BitsTransfer|certutil)\b/i, 'download/rede fora da rodada'],
  [/\bnpm\s+publish\b/i, 'npm publish'],
  [/\b(npm|pnpm|yarn)\s+(run\s+)?(dev|start|preview)\b|\belectron-vite\s+(dev|preview)\b/i, 'abrir o app em modo dev usaria os dados reais do usuário'],
  // Qualquer execução do Electron (npx, .bin, caminho, Start-Process): o app dos commits
  // antigos não tem pasta de dados isolada e abriria sobre o %APPDATA% real.
  [/(^|[;&|(]\s*|\bnpx\s+|\bexec\s+)["']?([^\s;&|"']*[\\/])?electron(\.exe|\.cmd)?["']?(\s|$)|Start-Process[^\n]*electron/i, 'abrir outro Electron disputaria os dados do app em uso'],
  [/\b(taskkill|Stop-Process|pkill|killall|tskill)\b|\.Kill\(\)|\bwmic\b[^\n]*\b(delete|terminate)\b|(^|[\s;&|])kill\s+-?\d/i, 'encerrar processos pode derrubar o app em uso'],
  [/\b(shutdown|Restart-Computer|Stop-Computer|format(\.com)?\s+[a-z]:|reg(\.exe)?\s+(add|delete)|Set-ItemProperty\s+-Path\s+HK)/i, 'comando de sistema'],
  [/\bGetFolderPath\b|\bSpecialFolder\b|\[Environment\]::/i, 'pastas especiais do Windows apontam para os dados reais do usuário'],
  [/\b(npm|pnpm|yarn)\s+(i|install|add|uninstall|remove|update|ci)\b(?![^\n]*--dry-run)/i, 'instalar/remover dependência muda o lockfile e baixa pacotes (fora do escopo das tarefas)']
]

/** Verbos que escrevem/apagam: com eles, um caminho fora da rodada é recusado. */
const SHELL_WRITE_VERBS = /\b(rm|rmdir|del|erase|mv|move|cp|copy|Remove-Item|Move-Item|Copy-Item|Set-Content|Add-Content|Out-File|New-Item|Rename-Item|Clear-Content|mkdir|md|touch|tee)\b|>{1,2}\s*["']?[a-z]:/i

const norm = (p) => String(p ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** `child` está dentro de algum dos `roots` (caminhos absolutos do Windows). */
export function insideAny(child, roots) {
  const c = norm(child)
  return roots.some((r) => {
    const root = norm(r)
    return root !== '' && (c === root || c.startsWith(root + '\\'))
  })
}

/** Caminhos absolutos do Windows citados num comando (C:\..., C:/..., /c/...). */
export function absolutePaths(command) {
  const out = []
  const text = String(command ?? '')
  for (const m of text.matchAll(/(?<![\w-])([a-zA-Z]):[\\/][^\s"'|;&<>`]*/g)) out.push(`${m[1]}:\\${m[0].replace(/^[a-zA-Z]:[\\/]/, '')}`)
  for (const m of text.matchAll(/(?<![\w-])([a-zA-Z]):(?=["'\s]|$)/g)) out.push(`${m[1]}:\\`)
  for (const m of text.matchAll(/(?:^|[\s"'=])\/([a-zA-Z])\/([^\s"'|;&<>`]*)/g)) out.push(`${m[1]}:\\${m[2]}`)
  return out.map((p) => p.replace(/\//g, '\\'))
}

/** Duas ou mais subidas de pasta (`..`) num comando saem da cópia. */
const climbsTwice = (command) => (String(command).match(/(^|[\s;&|"'\\/=])\.\.(?=[\\/\s;&|"']|$)/g) ?? []).length >= 2

/**
 * Decide um pedido de permissão. `ctx`:
 *  - worktree: pasta da rodada (onde o agente trabalha);
 *  - writable: outras pastas em que pode escrever (dados da instância isolada);
 *  - forbidden: pastas que nem para ler (fence.mjs);
 *  - protectedPaths: o que nunca pode ser alvo de escrita (checkout e dados reais do usuário).
 * Devolve `{ behavior: 'allow' | 'deny', reason }`.
 */
export function decidePermission(req, ctx) {
  const tool = String(req?.toolName ?? '')
  const input = req?.input ?? {}
  const writable = [ctx.worktree, ...(ctx.writable ?? [])]
  const fence = ctx.worktree ? [`${ctx.worktree}\\.claude`, `${ctx.worktree}/.claude`] : []
  const allow = (reason = 'liberado') => ({ behavior: 'allow', reason })
  const deny = (reason) => ({ behavior: 'deny', reason })
  // Proibido: dentro de uma pasta proibida, ou ACIMA dela (listar o pai mostra as irmãs).
  const forbidden = (p) => !insideAny(p, writable) && ((ctx.forbidden ?? []).some((f) => insideAny(p, [f]) || insideAny(f, [p])))

  if (DENY_TOOLS.test(tool)) return deny(`${tool} não roda no replay`)
  if ((tool === 'Agent' || tool === 'Task') && input.isolation === 'worktree') return deny('subagente em worktree separada fica fora do diff da rodada')

  if (WRITE_TOOLS.has(tool)) {
    const file = input.file_path ?? input.notebook_path
    if (typeof file !== 'string' || !file) return deny('escrita sem caminho')
    if (insideAny(file, fence)) return deny('a pasta .claude da cópia é do arnês')
    return insideAny(file, writable) ? allow('escrita dentro da rodada') : deny(`escrita fora da pasta do projeto: ${file}`)
  }

  const target = input.file_path ?? input.notebook_path ?? input.path
  if (!SHELL_TOOLS.has(tool) && typeof target === 'string' && forbidden(target)) return deny(`fora do projeto desta rodada: ${target}`)

  if (SHELL_TOOLS.has(tool)) {
    const command = String(input.command ?? '')
    for (const [re, why] of SHELL_DENY) if (re.test(command)) return deny(why)
    if (climbsTwice(command)) return deny('subir dois níveis sai da pasta do projeto desta rodada')
    const paths = absolutePaths(command)
    const off = paths.find(forbidden)
    if (off) return deny(`fora do projeto desta rodada: ${off}`)
    const outside = paths.filter((p) => !insideAny(p, writable))
    if (/\bgit\s+-C\s/i.test(command) && outside.length) return deny('git -C fora da cópia da rodada')
    if (SHELL_WRITE_VERBS.test(command) && outside.length) return deny(`comando que escreve fora da rodada: ${outside[0]}`)
    if (SHELL_WRITE_VERBS.test(command) && (/(^|[\s"'=\\/])\.claude([\\/"'\s]|$)/.test(command) || paths.some((p) => insideAny(p, fence)))) {
      return deny('a pasta .claude da cópia é do arnês')
    }
    if (paths.some((p) => insideAny(p, ctx.protectedPaths ?? []))) return deny('comando no checkout/dados do usuário')
    return allow('comando de shell dentro da rodada')
  }

  return allow()
}

/**
 * Resposta a um AskUserQuestion pela política combinada: a opção cujo RÓTULO diz
 * "(Recomendado)"; sem marca, a primeira. Mesma regra nos dois lados.
 */
export function recommendedAnswers(questions) {
  return (questions ?? []).map((q) => {
    const options = q.options ?? []
    const rec = options.find((o) => /\((recomendad[oa]|recommended)\)/i.test(o.label) && !/n[ãa]o recomendad|not recommended/i.test(o.label)) ?? options[0]
    return { header: q.header, question: q.question, selected: rec ? [rec.label] : [] }
  })
}
