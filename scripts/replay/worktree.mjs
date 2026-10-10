// Cópias de trabalho do replay: uma por tarefa, fora do checkout do usuário, no commit pai.
// reset/clean só nelas. O diff da rodada é tirado antes de voltar ao pai.
//
// Não são `git worktree`: uma worktree divide os objetos e as refs com o repositório do
// usuário, e o agente da rodada acharia a solução com `git show <referência>` ou
// `git log --all`. Cada cópia é um repositório próprio com o histórico SÓ até o commit
// pai (init + fetch daquele commit), sem remote — `push` nem tem para onde ir.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function git(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts })
}

/** Arquivos do arnês que nunca entram no diff (ignorados só neste repositório). */
const LOCAL_EXCLUDES = ['.claude/settings.local.json', '.replay-vitest.json']

/**
 * Recria em `dir` um repositório próprio no `commit` (histórico até ele, sem remote).
 * Feito a CADA execução: reflog, stash, branches e worktrees de uma rodada não chegam à
 * seguinte (git show HEAD@{n} mostraria o trabalho do outro lado). O node_modules fica.
 */
export function ensureStandaloneRepo(repo, dir, commit) {
  const dotGit = path.join(dir, '.git')
  mkdirSync(dir, { recursive: true })
  if (existsSync(dotGit)) {
    if (statSync(dotGit).isDirectory()) assertReplayWorktree(dir)
    rmSync(dotGit, { recursive: true, force: true })
  }
  git(dir, ['init', '-q'])
  git(dir, ['fetch', '-q', '--no-tags', repo, commit])
  git(dir, ['reset', '-q', '--hard', commit])
  // Tudo que não é versionado sai (inclusive ignorados: out/, .claude/worktrees), menos o node_modules.
  git(dir, ['clean', '-fdxq', '-e', 'node_modules'])
  const exclude = path.join(dotGit, 'info', 'exclude')
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  for (const line of LOCAL_EXCLUDES) if (!current.includes(line)) appendFileSync(exclude, `\n${line}`)
  if (git(dir, ['remote']).trim()) throw new Error(`cópia do replay não pode ter remote: ${dir}`)
  if (git(dir, ['cat-file', '-t', commit]).trim() !== 'commit') throw new Error(`commit pai ausente em ${dir}`)
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

/** O commit de referência NÃO pode existir na cópia (senão a solução está a um `git show`). */
export function assertNoReference(dir, reference) {
  try {
    git(dir, ['cat-file', '-e', `${reference}^{commit}`], { stdio: 'ignore' })
  } catch {
    return
  }
  throw new Error(`a cópia ${dir} contém o commit de referência ${reference}`)
}

/** Volta a worktree ao commit pai. `clean -fd` sem `-x`: node_modules e out/ ficam. */
export function resetWorktree(dir, commit) {
  assertReplayWorktree(dir)
  git(dir, ['reset', '--hard', '-q', commit])
  git(dir, ['clean', '-fdq'])
}

/** Recusa operar fora das worktrees do replay (proteção do checkout do usuário). */
export function assertReplayWorktree(dir) {
  const top = git(dir, ['rev-parse', '--show-toplevel']).trim().replace(/\//g, '\\').toLowerCase()
  if (!/\\agent-code-replay\\/.test(top)) throw new Error(`não é worktree do replay: ${top}`)
}

/**
 * Diff da rodada contra o commit pai (inclui arquivos novos e o que o agente
 * tenha commitado na worktree). Grava `<out>.patch` e devolve as estatísticas.
 */
export function collectDiff(dir, parent, outFile) {
  assertReplayWorktree(dir)
  git(dir, ['add', '-A'])
  const patch = git(dir, ['diff', '--cached', '--binary', parent])
  const numstat = git(dir, ['diff', '--cached', '--numstat', parent])
  git(dir, ['reset', '-q'])
  mkdirSync(path.dirname(outFile), { recursive: true })
  writeFileSync(outFile, patch)
  // Trabalho que ficaria FORA do diff: stash, outras worktrees, outros branches.
  const outside = {
    stash: git(dir, ['stash', 'list']).split('\n').filter(Boolean).length,
    worktrees: git(dir, ['worktree', 'list']).split('\n').filter(Boolean).length - 1,
    branches: git(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads']).split('\n').filter(Boolean).length
  }
  return { ...diffStats(numstat), outside }
}

/** Linhas do `--numstat` → arquivos, linhas adicionadas/removidas e arquivos de teste. */
export function diffStats(numstat) {
  const files = String(numstat)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [add, del, file] = line.split('\t')
      return { file, add: Number(add) || 0, del: Number(del) || 0 }
    })
  return {
    files: files.length,
    add: files.reduce((s, f) => s + f.add, 0),
    del: files.reduce((s, f) => s + f.del, 0),
    tests: files.filter((f) => isTestFile(f.file)).map((f) => f.file)
  }
}

export const isTestFile = (file) => /\.test\.(ts|tsx|mjs|js)$/.test(file) || /(^|\/)src\/main\/testing\//.test(file)

/**
 * Grava na cópia `dir` os arquivos `files` como estão no commit `ref` do repositório
 * do usuário (lidos com `git show`, só leitura). Sem `files`: todos os que o commit
 * mudou — o pai + isso é exatamente a árvore da referência. Apagados no commit somem.
 */
export function applyCommitFiles(repo, dir, ref, files = null) {
  assertReplayWorktree(dir)
  const changes = git(repo, ['show', '--name-status', '--format=', ref])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .map(([status, a, b]) => ({ status: status[0], file: b ?? a, old: status[0] === 'R' ? a : null }))
    .filter((c) => !files || files.includes(c.file))
  for (const c of changes) {
    const target = path.join(dir, c.file)
    if (c.old) rmSync(path.join(dir, c.old), { force: true })
    if (c.status === 'D') {
      rmSync(target, { force: true })
      continue
    }
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, execFileSync('git', ['-C', repo, 'show', `${ref}:${c.file}`], { maxBuffer: 512 * 1024 * 1024 }))
  }
  return changes.length
}

/** Arquivos de teste (e apoio de teste) do commit de referência. */
export function referenceTestFiles(repo, hash) {
  return git(repo, ['show', '--name-only', '--format=', hash])
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f && isTestFile(f))
}
