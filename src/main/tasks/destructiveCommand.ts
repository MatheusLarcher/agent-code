import path from 'node:path'
import { GIT_WORKTREE_WIDE, tokenizeCommand, type Token } from './bashWriteScan'

/**
 * Comando de shell DESTRUTIVO — o que não se desfaz (história do git, arquivos
 * fora do projeto, publicação, banco, máquina). É o que o gate de permissões
 * leva à UI mesmo com "Permitir tudo", em toda sessão.
 *
 * A lista mora aqui, fixa, sem configuração. Mesma regra de falha do
 * `bashWriteScan`: o que o detector NÃO reconhece passa — uma trava que
 * atrapalha o trabalho legítimo é desligada no primeiro dia. E nunca lança: o
 * gate roda em TODA chamada de ferramenta.
 */

/** Ferramentas cujo `input.command` é um comando de shell. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

/** Prefixos que só repassam o resto da linha a outro comando. */
const PASS_THROUGH = new Set(['sudo', 'env', 'nohup', 'time', 'command', 'exec'])

/** Executores de pacote: `npx prisma …` é o `prisma …`. */
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx'])

/** Clientes SQL: neles, `TRUNCATE x` é a instrução, não texto solto. */
const SQL_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlcmd', 'duckdb', 'clickhouse-client', 'cockroach'])

/** Comandos em que SQL no texto é só texto (mensagem de commit, busca, eco). */
const NOT_SQL = new Set(['git', 'echo', 'printf', 'grep', 'egrep', 'rg', 'findstr', 'select-string', 'write-output', 'write-host', 'gh'])

const SQL_DROP = /\bdrop\s+(?:table|database|schema|view|materialized\s+view|index|type|function|extension|owned|role|user|column)\b/i
const SQL_TRUNCATE_TABLE = /\btruncate\s+table\b/i
const SQL_TRUNCATE_ANY = /\btruncate\s+(?:only\s+)?["`]?[a-z_]/i
const SQL_DELETE_FROM = /\bdelete\s+from\s+[^;]*/gi

const lower = (s: string): string => s.toLowerCase()
const isFlag = (t: string): boolean => t.startsWith('-') && t !== '-'

/** Caminho do Git Bash (`/c/GitHub/x`) no formato do Windows (`C:/GitHub/x`). */
function nativePath(p: string): string {
  if (process.platform !== 'win32') return p
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p)
  return m ? `${m[1].toUpperCase()}:${m[2] ?? '/'}` : p
}

/**
 * Um `rm -rf <alvo>` é destrutivo quando o alvo sai do projeto ou É a raiz dele
 * (`.`, `*`, `./*`). Sem projeto conhecido, só o absoluto, o `~` e o `..` contam.
 * Alvo dinâmico (variável) não é reconhecido — passa.
 */
function removalOutsideProject(token: Token, ctx: Ctx): boolean {
  if (token.dynamic) return false
  let text = token.text.trim()
  if (!text) return false
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) return true
  // `dist/*` apaga o conteúdo de dist; `*` e `./*` apagam o da raiz.
  text = text.replace(/[\\/]?\*+$/u, '') || '.'
  const target = nativePath(text)
  const absolute = path.isAbsolute(target)
  // Relativo depois de um `cd` para destino desconhecido: não reconhecido, passa.
  if (!absolute && ctx.lost) return false
  // Sem projeto (texto de pergunta): a "raiz" é uma pasta fictícia; `.`/`..` contam.
  const root = path.resolve(ctx.cwd ?? path.join(path.sep, '__projeto__'))
  if (absolute && !ctx.cwd) return true
  const resolved = path.resolve(ctx.base ?? root, target)
  const rel = path.relative(root, resolved)
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel)
}

interface Ctx {
  cwd?: string
  /** Pasta efetiva depois de um `cd` com destino conhecido. */
  base?: string
  /** Houve `cd` para um destino desconhecido: caminho relativo deixa de ser conferível. */
  lost: boolean
}

function gitReason(rest: Token[]): string | null {
  const texts = rest.map((t) => t.text)
  // Opções globais antes do subcomando (`git -C dir push`).
  let i = 0
  while (i < texts.length && isFlag(texts[i])) {
    if (texts[i] === '-C' || texts[i] === '-c') i++
    i++
  }
  const sub = texts[i]
  if (!sub) return null
  const args = texts.slice(i + 1)
  const shortFlags = (letter: string): boolean => args.some((a) => /^-[a-zA-Z]+$/u.test(a) && a.includes(letter))
  // Os de árvore de trabalho inteira (os mesmos do bashWriteScan) que descartam trabalho.
  if (GIT_WORKTREE_WIDE.has(sub)) {
    if (sub === 'checkout' && (args.includes('--') || args.includes('.'))) return 'git checkout -- / . descarta alterações locais'
    if (sub === 'restore' && (args.includes('.') || args.includes(':/'))) return 'git restore . descarta alterações locais'
    if (sub === 'clean' && (args.includes('--force') || shortFlags('f'))) return 'git clean -f apaga arquivos não versionados'
    if (sub === 'stash' && (args[0] === 'drop' || args[0] === 'clear')) return `git stash ${args[0]} apaga o stash`
    if (sub === 'rebase') return 'git rebase reescreve a história'
    return null
  }
  if (sub === 'reset' && args.includes('--hard')) return 'git reset --hard descarta alterações locais'
  if (sub === 'push') {
    const forced =
      args.some((a) => a === '--force' || a.startsWith('--force-with-lease') || a.startsWith('--force-if-includes')) ||
      shortFlags('f') ||
      args.some((a) => a.startsWith('+') && a.length > 1)
    if (forced) return 'git push --force reescreve a história do remoto'
  }
  if (sub === 'branch' && (shortFlags('D') || (args.includes('--delete') && args.includes('--force')))) {
    return 'git branch -D apaga um branch sem conferir o merge'
  }
  if (sub === 'filter-branch' || sub === 'filter-repo') return `git ${sub} reescreve a história`
  return null
}

/** Valor de `-D x`, `-Dx` ou `--pgdata=x`. */
function pgData(texts: string[]): string | null {
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i]
    if (t === '-D' || t === '--pgdata') return texts[i + 1] ?? null
    if (t.startsWith('--pgdata=')) return t.slice('--pgdata='.length)
    if (t.startsWith('-D') && t.length > 2) return t.slice(2)
  }
  return null
}

/** Os alvos do `Remove-Item` (posicionais, `-Path`, `-LiteralPath`). */
function removeItemTargets(rest: Token[]): Token[] {
  const takesValue = new Set(['-filter', '-include', '-exclude', '-credential', '-stream'])
  const pathParams = new Set(['-path', '-literalpath', '-lp', '-pspath'])
  const out: Token[] = []
  for (let i = 0; i < rest.length; i++) {
    const t = lower(rest[i].text)
    if (pathParams.has(t)) {
      if (rest[i + 1]) out.push(rest[++i])
      continue
    }
    if (takesValue.has(t)) {
      i++
      continue
    }
    if (isFlag(t) || rest[i].redirect) continue
    out.push(rest[i])
  }
  return out.flatMap((t) => t.text.split(',').filter(Boolean).map((text) => ({ ...t, text })))
}

const psFlag = (t: string, full: string): boolean => t.length >= 2 && full.startsWith(t)

/** Motivo do segmento (um comando), ou null. Recursivo nos repassadores. */
function segmentReason(tokens: Token[], ctx: Ctx, depth: number): string | null {
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[i].text) && !tokens[i].redirect) i++
  const raw = tokens[i]?.text ?? ''
  if (!raw) return null
  const name = lower(raw.split(/[\\/]/u).pop() ?? raw).replace(/\.exe$/u, '')
  const rest = tokens.slice(i + 1).filter((t) => !t.redirect)
  const texts = rest.map((t) => t.text)
  const operands = texts.filter((t) => !isFlag(t))
  const again = (inner: Token[]): string | null => (depth > 4 ? null : segmentReason(inner, ctx, depth + 1))
  const reparse = (command: string): string | null => (depth > 4 ? null : commandReason(command, ctx, depth + 1))

  if (PASS_THROUGH.has(name)) return again(rest)
  if (PACKAGE_RUNNERS.has(name)) {
    let j = 0
    while (j < rest.length && isFlag(rest[j].text)) j += rest[j].text === '-p' || rest[j].text === '--package' ? 2 : 1
    return again(rest.slice(j))
  }
  // Interpretadores com o comando numa string: `bash -c "…"`, `powershell -Command …`, `cmd /c …`.
  if (['bash', 'sh', 'zsh'].includes(name)) {
    const c = texts.indexOf('-c')
    return c >= 0 && texts[c + 1] ? reparse(texts[c + 1]) : null
  }
  if (name === 'powershell' || name === 'pwsh') {
    const c = texts.findIndex((t) => psFlag(lower(t), '-command'))
    return c >= 0 ? reparse(texts.slice(c + 1).join(' ').replace(/\\/gu, '/')) : null
  }
  if (name === 'cmd') {
    const c = texts.findIndex((t) => /^\/[ck]$/iu.test(t))
    return c >= 0 ? reparse(texts.slice(c + 1).join(' ').replace(/\\/gu, '/')) : null
  }

  if (name === 'cd' || name === 'pushd' || name === 'set-location' || name === 'sl') {
    const dest = rest.find((t) => !isFlag(t.text))
    const target = dest && !dest.dynamic && dest.text !== '-' && !dest.text.startsWith('~') ? nativePath(dest.text) : null
    const from = ctx.base ?? ctx.cwd
    if (target && (path.isAbsolute(target) || (from && !ctx.lost))) {
      ctx.base = path.resolve(from ?? '', target)
      ctx.lost = false
    } else {
      ctx.lost = true
    }
    return null
  }

  if (name === 'git') return gitReason(rest)

  // Remoção recursiva: PowerShell (Remove-Item e os apelidos com -Recurse), cmd (rd /s), unix (rm -rf).
  const outside = (targets: Token[]): boolean => targets.some((t) => removalOutsideProject(t, ctx))
  const psRemoval =
    name === 'remove-item' || name === 'ri' || (['rm', 'del', 'rmdir', 'rd', 'erase'].includes(name) && texts.some((t) => lower(t).startsWith('-rec')))
  if (psRemoval) {
    const flags = texts.map(lower).filter(isFlag)
    const recurse = flags.some((f) => psFlag(f, '-recurse') && f.length > 2)
    const force = flags.some((f) => psFlag(f, '-force'))
    if (recurse && force && outside(removeItemTargets(rest))) return 'Remove-Item -Recurse -Force fora do projeto (ou na raiz dele)'
    return null
  }
  if ((name === 'rd' || name === 'rmdir') && texts.some((t) => /^\/s$/iu.test(t))) {
    const targets = rest.filter((t) => !/^\/[a-z]$/iu.test(t.text) && !isFlag(t.text))
    return outside(targets) ? 'rd /s fora do projeto (ou na raiz dele)' : null
  }
  if (name === 'rm') {
    const recursive = texts.some((t) => t === '--recursive' || /^-[a-zA-Z]*[rR][a-zA-Z]*$/u.test(t))
    const force = texts.some((t) => t === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/u.test(t))
    if (recursive && force && outside(rest.filter((t) => !isFlag(t.text)))) return 'rm -rf fora do projeto (ou na raiz dele)'
    return null
  }

  // Publicação e deploy.
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    if (operands[0] === 'publish' || operands[0] === 'unpublish') return `${name} ${operands[0]} publica no registro`
    if (operands[0] === 'exec' || operands[0] === 'dlx' || operands[0] === 'x') {
      const at = rest.findIndex((t) => t.text === operands[0])
      return again(rest.slice(at + 1).filter((t) => t.text !== '--'))
    }
    if (name === 'yarn' && operands[0] && !['install', 'add', 'run', 'test', 'build', 'remove'].includes(operands[0])) {
      return again(rest.slice(rest.findIndex((t) => t.text === operands[0])))
    }
    return null
  }
  if (name === 'vercel' && texts.some((t) => t === '--prod' || t === '--production')) return 'vercel --prod publica em produção'
  if (name === 'gh' && operands[0] === 'release' && !['list', 'view', 'download'].includes(operands[1] ?? '')) return 'gh release publica uma versão'
  if (name === 'docker' && (operands[0] === 'push' || (operands[0] === 'image' && operands[1] === 'push'))) return 'docker push publica a imagem'
  if (name === 'kubectl' && operands.slice(0, 3).some((o) => o === 'apply' || o === 'delete')) return 'kubectl apply/delete altera o cluster'
  if (name === 'terraform' && operands.slice(0, 2).some((o) => o === 'apply' || o === 'destroy')) return 'terraform apply/destroy altera a infraestrutura'

  // Banco.
  if (name === 'prisma' && operands[0] === 'migrate' && (operands[1] === 'deploy' || operands[1] === 'reset')) {
    return `prisma migrate ${operands[1]} altera o banco`
  }
  if (name.startsWith('typeorm') && operands.some((o) => o === 'migration:run' || o === 'migration:revert' || o === 'schema:drop')) {
    return 'typeorm migration:run altera o banco'
  }
  if (name === 'pg_ctl' && operands.includes('stop')) {
    const data = pgData(texts)
    if (!data || !data.replace(/\\/gu, '/').includes('out/postgres')) return 'pg_ctl stop fora do out/postgres do app'
    return null
  }

  // Sistema.
  if (name === 'shutdown' || name === 'restart-computer' || name === 'stop-computer') return `${raw} desliga/reinicia a máquina`
  if (name === 'taskkill') {
    const norm = texts.map((t) => lower(t).replace(/^\/\//u, '/'))
    if ((norm.includes('/f') || norm.includes('-f')) && (norm.includes('/im') || norm.includes('-im'))) {
      return 'taskkill /F /IM mata processos por nome (inclusive os que não são do projeto)'
    }
    return null
  }

  // SQL destrutivo dentro do comando (psql -c, node -e, sqlcmd -Q…).
  if (!NOT_SQL.has(name)) return sqlReason(texts.join(' '), SQL_CLIENTS.has(name))
  return null
}

function sqlReason(text: string, sqlClient: boolean): string | null {
  if (SQL_DROP.test(text)) return 'DROP no banco'
  if (SQL_TRUNCATE_TABLE.test(text) || (sqlClient && SQL_TRUNCATE_ANY.test(text))) return 'TRUNCATE no banco'
  for (const m of text.matchAll(SQL_DELETE_FROM)) {
    if (!/\bwhere\b/i.test(m[0])) return 'DELETE FROM sem WHERE no banco'
  }
  return null
}

function commandReason(command: string, ctx: Ctx, depth: number): string | null {
  for (const segment of tokenizeCommand(command)) {
    if (!segment.length) continue
    const reason = segmentReason(segment, ctx, depth)
    if (reason) return reason
  }
  return null
}

/**
 * Motivo para o comando desta ferramenta ser destrutivo, ou `null`. Só
 * Bash/PowerShell têm comando; `cwd` (o projeto) decide o que é "fora" num
 * `rm -rf`. Nunca lança: erro de leitura = não reconhecido = passa.
 */
export function destructiveCommandReason(toolName: string, input: Record<string, unknown>, cwd?: string): string | null {
  try {
    if (!SHELL_TOOLS.has(toolName)) return null
    const command = typeof input.command === 'string' ? input.command : ''
    if (!command.trim()) return null
    // No PowerShell a barra invertida é separador de caminho, não escape.
    const text = toolName === 'PowerShell' ? command.replace(/\\/gu, '/') : command
    return commandReason(text, { cwd, lost: false }, 0)
  } catch {
    return null
  }
}

/** Nomes que, citados num texto, abrem um comando a conferir. */
const COMMAND_WORDS =
  /(?:^|[\s`"'(])(git|rm|remove-item|rd|rmdir|npm|pnpm|yarn|bun|npx|vercel|gh|docker|kubectl|terraform|prisma|typeorm|pg_ctl|shutdown|restart-computer|stop-computer|taskkill)(?=\s)/giu

/** Frases que pedem ação destrutiva sem citar o comando. */
const DESTRUCTIVE_PHRASES: ReadonlyArray<[RegExp, string]> = [
  [/\bforce[- ]push\b/iu, 'force push'],
  [/\b(?:apagar|deletar|excluir|dropar|zerar|resetar)\s+(?:o\s+|a\s+|todo\s+o\s+)?(?:banco|database|tabela)\b/iu, 'apagar dados do banco'],
  [/\b(?:deploy|publicar)\b[^.\n]*\bprodu[cç][aã]o\b/iu, 'deploy em produção']
]

/**
 * O texto (pergunta, opção) pede uma ação da lista destrutiva? Usado para a
 * AskUserQuestion: pergunta sobre ação destrutiva continua indo ao usuário.
 */
export function destructiveTextReason(text: string): string | null {
  try {
    if (!text.trim()) return null
    for (const [re, why] of DESTRUCTIVE_PHRASES) if (re.test(text)) return why
    const sql = sqlReason(text, false)
    if (sql) return sql
    for (const m of text.matchAll(COMMAND_WORDS)) {
      const start = (m.index ?? 0) + m[0].length - m[1].length
      const tail = text.slice(start).split(/[`\n]/u)[0].replace(/[?!]+\s*$/u, '')
      const reason = commandReason(tail, { lost: false }, 0)
      if (reason) return reason
    }
    return null
  } catch {
    return null
  }
}
