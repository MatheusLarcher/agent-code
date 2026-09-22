// @vitest-environment node
// O _sandbox do Agent Manager conferido pelo caminho REAL, com junction e
// symlink de verdade numa pasta temporária. No Windows, `fs.symlink(..., 'junction')`
// não exige privilégio; nos outros sistemas o tipo é ignorado e sai um symlink
// de pasta — o mesmo ataque.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { planningPreToolDecision } from './planningPolicy'
import { realpathDeepest, sandboxRealPathDenial } from './planningSandboxReal'

let root = ''
let cwd = ''
let fora = ''
const slug = 'checkout'
const sandbox = (...parts: string[]): string => path.join(cwd, 'docs', 'spec', slug, '_sandbox', ...parts)
const forBash = (p: string): string => p.split(path.sep).join('/')
const manager = (): { cwd: string; planning: { slug: string } } => ({ cwd, planning: { slug } })

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-real-'))
  cwd = path.join(root, 'projeto')
  fora = path.join(root, 'fora')
  await fs.mkdir(sandbox('poc'), { recursive: true })
  await fs.mkdir(path.join(cwd, 'src'), { recursive: true })
  await fs.mkdir(fora, { recursive: true })
  // _sandbox/x → pasta fora do projeto; _sandbox/src → o src do próprio projeto.
  await fs.symlink(fora, sandbox('x'), 'junction')
  await fs.symlink(path.join(cwd, 'src'), sandbox('src'), 'junction')
  // Link quebrado: aponta para uma pasta que (ainda) não existe.
  await fs.symlink(path.join(root, 'nao-existe'), sandbox('quebrado'), 'junction')
  // Outro planejamento cujo próprio _sandbox é um link para fora.
  await fs.mkdir(path.join(cwd, 'docs', 'spec', 'outro'), { recursive: true })
  await fs.symlink(fora, path.join(cwd, 'docs', 'spec', 'outro', '_sandbox'), 'junction')
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('planningPreToolDecision com junction/symlink no _sandbox', () => {
  it('Write em _sandbox/x/a.ts (x → fora do projeto) é negado', async () => {
    const out = await planningPreToolDecision(manager(), 'Write', { file_path: sandbox('x', 'a.ts'), content: 'x' })
    expect(out?.decision).toBe('deny')
    expect(out?.reason).toMatch(/Write recusado no Agent Manager/)
    expect(out?.reason).toMatch(/fora do _sandbox/)
  })

  it('Edit/MultiEdit por junction para src/ do próprio projeto também são negados', async () => {
    for (const tool of ['Edit', 'MultiEdit']) {
      const out = await planningPreToolDecision(manager(), tool, { file_path: sandbox('src', 'index.ts') })
      expect(out?.decision, tool).toBe('deny')
    }
  })

  it('Bash gravando através da junction é negado; gravando no _sandbox real pergunta', async () => {
    const through = await planningPreToolDecision(manager(), 'Bash', { command: `echo x > ${forBash(sandbox('x', 'a.txt'))}` })
    expect(through?.decision).toBe('deny')
    expect(through?.reason).toMatch(/Bash recusado no Agent Manager/)
    const real = await planningPreToolDecision(manager(), 'Bash', { command: `echo x > ${forBash(sandbox('poc', 'a.txt'))}` })
    expect(real?.decision).toBe('ask')
  })

  it('link quebrado é negado (gravar nele criaria o arquivo onde ele aponta)', async () => {
    const out = await planningPreToolDecision(manager(), 'Write', { file_path: sandbox('quebrado', 'a.ts'), content: 'x' })
    expect(out?.decision).toBe('deny')
    expect(out?.reason).toMatch(/link quebrado/)
  })

  it('_sandbox que é, ele mesmo, um link para fora: nada dentro dele vale', async () => {
    const role = { cwd, planning: { slug: 'outro' } }
    const target = path.join(cwd, 'docs', 'spec', 'outro', '_sandbox', 'a.ts')
    const out = await planningPreToolDecision(role, 'Write', { file_path: target, content: 'x' })
    expect(out?.decision).toBe('deny')
    expect(out?.reason).toMatch(/o próprio _sandbox resolve para/)
  })

  it('controle: escrita no _sandbox real (existente ou ainda por criar) segue livre', async () => {
    expect(await planningPreToolDecision(manager(), 'Write', { file_path: sandbox('a.ts'), content: 'x' })).toBeNull()
    expect(await planningPreToolDecision(manager(), 'Write', { file_path: sandbox('poc', 'b.ts'), content: 'x' })).toBeNull()
    expect(
      await planningPreToolDecision(manager(), 'Write', { file_path: sandbox('novo', 'fundo', 'c.ts'), content: 'x' })
    ).toBeNull()
  })
})

describe('realpathDeepest e sandboxRealPathDenial', () => {
  it('resolve pelo ancestral existente e reanexa o que não existe', async () => {
    const real = await realpathDeepest(sandbox('x', 'novo', 'a.ts'))
    expect(real.toLowerCase()).toBe(path.join(await fs.realpath(fora), 'novo', 'a.ts').toLowerCase())
    const inexistente = path.join(root, 'nada', 'aqui.ts')
    expect((await realpathDeepest(inexistente)).toLowerCase()).toBe(
      path.join(await fs.realpath(root), 'nada', 'aqui.ts').toLowerCase()
    )
  })

  it('sem destinos, nada a conferir; destino relativo resolve contra o projeto', async () => {
    expect(await sandboxRealPathDenial(cwd, slug, 'Write', [])).toBeNull()
    expect(await sandboxRealPathDenial(cwd, slug, 'Write', ['docs/spec/checkout/_sandbox/a.ts'])).toBeNull()
    expect(await sandboxRealPathDenial(cwd, slug, 'Write', ['docs/spec/checkout/_sandbox/x/a.ts'])).toMatch(/fora do _sandbox/)
  })
})
