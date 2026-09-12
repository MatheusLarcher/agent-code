/**
 * Onde um comando de shell parece GRAVAR — o que falta ao `writeScopeGuard`
 * para o `Bash` deixar de ser a porta dos fundos do escopo de escrita.
 *
 * **O que isto é, e o que não é.** Interpretar shell por completo é
 * indecidível: `eval`, variável, substituição de comando e qualquer
 * interpretador (`python -c`, `node -e`) escrevem onde quiserem. Este scanner
 * não é um sandbox e não tenta ser — ele fecha o caminho que de fato acontece
 * no uso real: o executor redireciona para um arquivo, copia, move, apaga ou
 * roda `sed -i` fora da própria faixa, por descuido ou por deriva. Contra um
 * modelo determinado a contornar, quem vale é o contrato no `TASKS_HINT`.
 *
 * A regra de falha é deliberada: o que o scanner NÃO reconhece como escrita
 * passa. Recusar todo comando não reconhecido tornaria impossível rodar teste,
 * build ou `git status` sob uma tarefa com escopo — e uma trava que atrapalha o
 * trabalho legítimo é desligada no primeiro dia, o que não protege nada.
 */

export interface BashWriteScan {
  /** Caminhos (como escritos no comando) em que a gravação foi identificada. */
  targets: string[]
  /** Há escrita cujo destino este scanner não consegue fixar. */
  unbounded: boolean
  /** O que tornou indeterminado — entra no texto da recusa. */
  reason?: string
}

/** Comandos que gravam nos caminhos passados como operandos. */
const WRITES_ALL_OPERANDS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'mkdir',
  'touch',
  'truncate',
  'tee'
])

/**
 * Comandos cujo destino é o ÚLTIMO operando (origem → destino). `ln` entra aqui,
 * e não em `WRITES_ALL_OPERANDS`: `ln -s alvo link` cria só o `link` — tratar o
 * alvo como escrita recusaria um link legítimo para fora do escopo.
 */
const WRITES_LAST_OPERAND = new Set(['cp', 'mv', 'install', 'rsync', 'ln'])

/**
 * Subcomandos de `git` que mexem na árvore de trabalho inteira. O destino não
 * aparece no comando, então não há caminho a conferir: sob uma tarefa com
 * escopo, eles são escrita de alcance indeterminado.
 */
const GIT_WORKTREE_WIDE = new Set(['checkout', 'restore', 'apply', 'clean', 'stash', 'merge', 'rebase'])

/** Destinos de redirecionamento que não são arquivo do projeto. */
const NULL_SINKS = new Set(['/dev/null', 'nul', 'NUL', '/dev/stderr', '/dev/stdout'])

interface Token {
  text: string
  /** O texto depende de variável ou substituição — o valor real é desconhecido. */
  dynamic: boolean
  /** Veio colado num operador de redirecionamento (`>arquivo`). */
  redirect?: boolean
}

const SEGMENT_BREAKS = /^(?:&&|\|\||;;|;|\||&|\n)$/

/**
 * Tokeniza o suficiente para achar operandos e redirecionamentos: aspas simples
 * (literais), aspas duplas (expandem), escape com barra invertida, e os
 * operadores que separam comandos.
 */
export function tokenizeCommand(command: string): Token[][] {
  const segments: Token[][] = []
  let current: Token[] = []
  let buf = ''
  let dynamic = false
  let started = false

  const flush = (): void => {
    if (!started) return
    current.push({ text: buf, dynamic })
    buf = ''
    dynamic = false
    started = false
  }
  const breakSegment = (): void => {
    flush()
    if (current.length) segments.push(current)
    current = []
  }

  for (let i = 0; i < command.length; i++) {
    const c = command[i]

    if (c === '\\') {
      buf += command[++i] ?? ''
      started = true
      continue
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      buf += command.slice(i + 1, end === -1 ? command.length : end)
      started = true
      i = end === -1 ? command.length : end
      continue
    }
    if (c === '"') {
      let j = i + 1
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === '\\') {
          buf += command[++j] ?? ''
          continue
        }
        if (command[j] === '$' || command[j] === '`') dynamic = true
        buf += command[j]
      }
      started = true
      i = j
      continue
    }
    if (c === '$' || c === '`') {
      dynamic = true
      buf += c
      started = true
      continue
    }
    if (/\s/.test(c)) {
      if (c === '\n') breakSegment()
      else flush()
      continue
    }
    // Operadores de separação e de subshell.
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      breakSegment()
      i++
      continue
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '{' || c === '}') {
      // `2>&1` já foi consumido pelo ramo de redirecionamento abaixo.
      breakSegment()
      continue
    }
    if (c === '>' || c === '<') {
      // `2>` / `1>`: o descritor já foi acumulado em `buf`. Emiti-lo como token
      // o transformaria num OPERANDO do comando — e `rm -rf dist 2>&1` passaria
      // a conferir "2" como se fosse um caminho, recusando um comando legítimo.
      if (started && /^\d+$/.test(buf)) {
        buf = ''
        started = false
        dynamic = false
      } else {
        flush()
      }
      let op = c
      if (command[i + 1] === '>') op += command[i++ + 1]
      // `>&1` / `>&2`: duplicação de descritor, não arquivo.
      if (command[i + 1] === '&') {
        while (i + 1 < command.length && /[&\d-]/.test(command[i + 1])) i++
        continue
      }
      if (op.startsWith('<')) continue
      // O alvo pode vir colado (`>saida.txt`) ou separado.
      let j = i + 1
      while (j < command.length && /\s/.test(command[j]) && command[j] !== '\n') j++
      let target = ''
      let targetDynamic = false
      for (; j < command.length && !/[\s;|&<>()]/.test(command[j]); j++) {
        if (command[j] === '$' || command[j] === '`') targetDynamic = true
        if (command[j] === '"' || command[j] === "'") continue
        target += command[j]
      }
      if (target) current.push({ text: target, dynamic: targetDynamic, redirect: true })
      i = j - 1
      continue
    }
    buf += c
    started = true
  }
  breakSegment()
  return segments
}

function isFlag(token: Token): boolean {
  return token.text.startsWith('-') && token.text !== '-'
}

/** Nome do comando, pulando prefixos de ambiente (`VAR=1 cmd`). */
function commandName(tokens: Token[]): { name: string; rest: Token[] } {
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i].text) && !tokens[i].redirect) i++
  const raw = tokens[i]?.text ?? ''
  const name = raw.split(/[\\/]/).pop() ?? raw
  return { name, rest: tokens.slice(i + 1) }
}

function isRelative(path: string): boolean {
  return !/^([A-Za-z]:[\\/]|[\\/]|~)/.test(path)
}

/**
 * `sed -i` grava nos arquivos; sem `-i` só imprime. O primeiro operando é o
 * script (a menos que venha por `-e`/`-f`).
 */
function sedTargets(rest: Token[]): Token[] {
  const inPlace = rest.some((t) => t.text === '-i' || t.text.startsWith('-i'))
  if (!inPlace) return []
  const operands = rest.filter((t) => !isFlag(t) && !t.redirect)
  const hasScriptFlag = rest.some((t) => t.text === '-e' || t.text === '-f')
  return hasScriptFlag ? operands : operands.slice(1)
}

export function scanBashWrites(command: string): BashWriteScan {
  const targets: string[] = []
  let unbounded = false
  let reason: string | undefined
  // `cd` muda a base de resolução: a partir dele, caminho RELATIVO não pode
  // mais ser conferido contra o projeto. Caminho absoluto segue conferível.
  let baseUnknown = false

  const mark = (why: string): void => {
    if (unbounded) return
    unbounded = true
    reason = why
  }

  for (const segment of tokenizeCommand(command)) {
    if (!segment.length) continue
    if (segment.every((t) => SEGMENT_BREAKS.test(t.text))) continue

    const { name, rest } = commandName(segment)
    const operands = rest.filter((t) => !isFlag(t) && !t.redirect)

    const take = (tokens: Token[]): void => {
      for (const token of tokens) {
        if (token.dynamic) {
          mark(`o destino "${token.text}" depende de variável ou substituição`)
          continue
        }
        if (baseUnknown && isRelative(token.text)) {
          mark(`"${token.text}" é relativo depois de um "cd" — use caminho absoluto`)
          continue
        }
        if (NULL_SINKS.has(token.text)) continue
        targets.push(token.text)
      }
    }

    // Redirecionamentos valem para qualquer comando do segmento.
    take(segment.filter((t) => t.redirect))

    if (name === 'cd' || name === 'pushd') {
      baseUnknown = true
      continue
    }
    if (WRITES_ALL_OPERANDS.has(name)) {
      take(operands)
      continue
    }
    if (WRITES_LAST_OPERAND.has(name)) {
      if (operands.length) take([operands[operands.length - 1]])
      continue
    }
    if (name === 'sed') {
      take(sedTargets(rest))
      continue
    }
    if (name === 'dd') {
      take(rest.filter((t) => t.text.startsWith('of=')).map((t) => ({ ...t, text: t.text.slice(3) })))
      continue
    }
    if (name === 'git' && operands.length && GIT_WORKTREE_WIDE.has(operands[0].text)) {
      mark(`"git ${operands[0].text}" altera a árvore de trabalho inteira`)
      continue
    }
    if (name === 'eval' || name === 'source' || name === '.') {
      mark(`"${name}" executa um comando que este gate não consegue inspecionar`)
      continue
    }
  }

  return { targets, unbounded, ...(reason ? { reason } : {}) }
}
