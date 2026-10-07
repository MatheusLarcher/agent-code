// @vitest-environment node
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { markHandoffsSent } from './handoffSent'
import { discardStaleHandoffs, findStaleHandoffs, HANDOFF_DISCARD_DIR, planLastChange } from './handoffStale'
import type { PlanningChangeNotice } from './planningEvents'
import { createPlan, listHandoffs, writeHandoff } from './planningStore'
import { buildPlanningTools } from './planningTools'

/**
 * Prompts de handoff ANTIGOS: gravados antes da última mudança do plano. Saem
 * só com o usuário confirmando, e para _handoff/_descartados/ (nada é apagado);
 * prompt já enviado nunca sai. Contra o planningStore real, numa pasta temporária.
 */

const SLUG = 'checkout'
let cwd: string
let notify: Mock<(change: PlanningChangeNotice) => void>

const planDir = (): string => path.join(cwd, 'docs', 'spec', SLUG)
const handoffDir = (): string => path.join(planDir(), '_handoff')
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))

/** A mudança do plano: o roteiro regravado agora. */
async function touchPlan(): Promise<void> {
  const now = new Date()
  await fs.utimes(path.join(planDir(), '_roteiro.md'), now, now)
}

type Tool = ReturnType<typeof buildPlanningTools>[number]
async function call(name: string, args: unknown): Promise<string> {
  const tools: Tool[] = buildPlanningTools({ projectCwd: cwd, slug: SLUG, notify, now: () => new Date(2026, 9, 6, 10) })
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`tool ${name} não registrada`)
  const result = (await found.handler(args as never, undefined)) as { content: { text?: string }[] }
  return result.content.map((part) => part.text ?? '').join('\n')
}

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-handoff-stale-'))
  await createPlan(cwd, SLUG, 'Checkout novo')
  notify = vi.fn<(change: PlanningChangeNotice) => void>()
  await call('plan_roteiro_set', { etapas: [{ id: 'requisitos', titulo: 'Levantar requisitos' }] })
  await pause()
})

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true })
})

describe('prompt velho × novo pela data', () => {
  it('gravado antes da última mudança do roteiro (ou de um card) é velho; o gravado depois, não', async () => {
    const a = path.basename(await writeHandoff(cwd, SLUG, '# A\n', new Date(2026, 9, 6), ['requisitos']))
    await pause()
    await touchPlan()
    await pause()
    const b = path.basename(await writeHandoff(cwd, SLUG, '# B\n', new Date(2026, 9, 6), ['requisitos']))

    const { stale, planChangedAt } = await findStaleHandoffs(cwd, SLUG)
    expect(stale.map((h) => h.name)).toEqual([a])
    const [ha, hb] = await listHandoffs(cwd, SLUG)
    expect(ha.createdAt).toBeLessThan(planChangedAt)
    expect(hb.createdAt).toBeGreaterThanOrEqual(planChangedAt)
    expect(b).not.toBe(a)
  })

  it('a mudança num card conta como mudança do plano', async () => {
    await writeHandoff(cwd, SLUG, '# A\n', new Date(2026, 9, 6))
    await pause()
    const before = await planLastChange(cwd, SLUG)
    await call('plan_card_create', { tipo: 'nota', titulo: 'Nota nova', corpo: 'mudou' })
    expect(await planLastChange(cwd, SLUG)).toBeGreaterThan(before)
    expect((await findStaleHandoffs(cwd, SLUG)).stale).toHaveLength(1)
  })
})

describe('descartar', () => {
  it('move o .md e o .meta.json para _handoff/_descartados/, que não aparece em listHandoffs; o arquivo continua no disco', async () => {
    const a = path.basename(await writeHandoff(cwd, SLUG, '# A\n', new Date(2026, 9, 6), ['requisitos']))
    await pause()
    await touchPlan()

    expect(await discardStaleHandoffs(cwd, SLUG)).toEqual([a])
    expect(await listHandoffs(cwd, SLUG)).toEqual([])
    const discarded = path.join(handoffDir(), HANDOFF_DISCARD_DIR)
    expect((await fs.readdir(discarded)).sort()).toEqual([a, a.replace(/\.md$/, '.meta.json')].sort())
    expect(await fs.readFile(path.join(discarded, a), 'utf8')).toBe('# A\n')
  })

  it('prompt já enviado nunca sai, mesmo velho', async () => {
    const a = path.basename(await writeHandoff(cwd, SLUG, '# A\n', new Date(2026, 9, 6)))
    const b = path.basename(await writeHandoff(cwd, SLUG, '# B\n', new Date(2026, 9, 6)))
    await markHandoffsSent(cwd, SLUG, [{ nome: a, conversaId: 'conv-1', conversaTitulo: 'Implementação: Checkout' }])
    await pause()
    await touchPlan()

    expect((await findStaleHandoffs(cwd, SLUG)).stale.map((h) => h.name)).toEqual([b])
    expect(await discardStaleHandoffs(cwd, SLUG)).toEqual([b])
    expect((await listHandoffs(cwd, SLUG)).map((h) => h.name)).toEqual([a])
  })

  it('só os nomes pedidos, e nome repetido em _descartados/ não sobrescreve o anterior', async () => {
    const a = path.basename(await writeHandoff(cwd, SLUG, '# A\n', new Date(2026, 9, 6)))
    const b = path.basename(await writeHandoff(cwd, SLUG, '# B\n', new Date(2026, 9, 6)))
    await fs.mkdir(path.join(handoffDir(), HANDOFF_DISCARD_DIR), { recursive: true })
    await fs.writeFile(path.join(handoffDir(), HANDOFF_DISCARD_DIR, a), '# A de antes\n')
    await pause()
    await touchPlan()

    expect(await discardStaleHandoffs(cwd, SLUG, [a], 123)).toEqual([a])
    const names = await fs.readdir(path.join(handoffDir(), HANDOFF_DISCARD_DIR))
    expect(names.sort()).toEqual([a, a.replace(/\.md$/, '.123.md')].sort())
    expect((await listHandoffs(cwd, SLUG)).map((h) => h.name)).toEqual([b])
  })
})

describe('Agent Manager — plan_handoff_write confere antes; plan_handoff_limpar descarta', () => {
  it('recusa com a lista dos antigos e manda perguntar; manter: true grava; limpar move e libera', async () => {
    const a = path.basename(await writeHandoff(cwd, SLUG, '# A\n', new Date(2026, 9, 6), ['requisitos']))
    await pause()
    await touchPlan()
    notify.mockClear()

    const refused = await call('plan_handoff_write', { conteudo: '# Novo\n', etapas: ['requisitos'] })
    expect(refused).toContain('Handoff não gravado: há 1 prompt antigo não enviado(s) em _handoff/')
    expect(refused).toContain(`- _handoff/${a}`)
    expect(refused).toContain('Pergunte ao usuário antes de seguir')
    expect(refused).toContain('plan_handoff_limpar')
    expect(refused).toContain('manter: true')
    expect((await listHandoffs(cwd, SLUG)).map((h) => h.name)).toEqual([a])
    expect(notify).not.toHaveBeenCalled()

    expect(await call('plan_handoff_write', { conteudo: '# Novo\n', etapas: ['requisitos'], manter: true })).toMatch(/^Handoff gravado em /)
    expect(await listHandoffs(cwd, SLUG)).toHaveLength(2)

    expect(await call('plan_handoff_limpar', {})).toBe(
      `Movidos para _handoff/${HANDOFF_DISCARD_DIR}/ (1): ${a}. Agora grave os prompts novos com plan_handoff_write.`
    )
    expect((await listHandoffs(cwd, SLUG)).map((h) => h.name)).not.toContain(a)
    expect(await call('plan_handoff_write', { conteudo: '# Outro\n', etapas: ['requisitos'] })).toMatch(/^Handoff gravado em /)
    expect(await call('plan_handoff_limpar', {})).toBe('Nenhum prompt antigo não enviado em _handoff/: nada foi movido.')
  })

  it('sem prompt antigo, plan_handoff_write grava como sempre', async () => {
    expect(await call('plan_handoff_write', { conteudo: '# Novo\n', etapas: ['requisitos'] })).toMatch(/^Handoff gravado em /)
  })
})
