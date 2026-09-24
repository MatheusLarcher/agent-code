// @vitest-environment node
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PlanningChangeNotice } from './planningEvents'
import * as realMedia from './planningMedia'
import { MAX_IMAGE_BLOCK_BYTES } from './planningMediaTools'
import type { PlanCard } from './planningModel'
import { planningToolDenial } from './planningPolicy'
import * as realStore from './planningStore'
import { createPlan, openPlan, RevConflictError } from './planningStore'
import { buildPlanningTools, PLANNING_TOOL_NAMES, type PlanningToolContext } from './planningTools'

/**
 * A parte de mídia das ferramentas plan_*: contra o store e o planningMedia
 * REAIS numa pasta temporária (mesmo princípio de planningTools.test.ts).
 * Só o tamanho acima de 5 MB é simulado, pelo listMedia injetado.
 */

type Tool = ReturnType<typeof buildPlanningTools>[number]
type Block = { type: string; text?: string; data?: string; mimeType?: string }

const SLUG = 'checkout'
let cwd: string
let notify: Mock<(change: PlanningChangeNotice) => void>
let tools: Tool[]

function build(over: Partial<PlanningToolContext> = {}): Tool[] {
  return buildPlanningTools({ projectCwd: cwd, slug: SLUG, notify, ...over })
}

async function blocks(name: string, args: unknown, list: Tool[] = tools): Promise<Block[]> {
  const found = list.find((t) => t.name === name)
  if (!found) throw new Error(`tool ${name} não registrada`)
  return ((await found.handler(args as never, undefined)) as { content: Block[] }).content
}

async function call(name: string, args: unknown, list: Tool[] = tools): Promise<string> {
  return (await blocks(name, args, list)).map((b) => b.text ?? '').join('\n')
}

const mediaDir = (): string => path.join(cwd, 'docs', 'spec', SLUG, 'midia')
const cardOf = async (id: string) => (await openPlan(cwd, SLUG)).cards.find((c) => c.id === id)
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Cria um arquivo de origem no projeto e devolve o caminho absoluto. */
async function source(name: string, bytes: string | Buffer = `conteúdo de ${name}`): Promise<string> {
  const file = path.join(cwd, 'assets', name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, bytes)
  return file
}

/** Importa pela ferramenta e devolve o nome saneado em midia/. */
async function importar(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const out = await call('plan_midia_importar', { caminho: await source(name), ...extra })
  const found = out.match(/Mídia importada: \[[^\]]+\] (\S+) — /)
  if (!found) throw new Error(`importação falhou: ${out}`)
  return found[1]
}

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-media-tools-'))
  await createPlan(cwd, SLUG, 'Checkout novo')
  notify = vi.fn<(change: PlanningChangeNotice) => void>()
  tools = build()
})

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true })
})

describe('plan_midia_importar', () => {
  it('está em PLANNING_TOOL_NAMES e passa pela allowlist do Manager', () => {
    expect(PLANNING_TOOL_NAMES).toContain('plan_midia_importar')
    expect(tools.map((t) => t.name)).toContain('plan_midia_importar')
    expect(planningToolDenial({ planning: { slug: SLUG } }, 'mcp__planning__plan_midia_importar')).toBeNull()
    expect(Object.keys(tools.find((t) => t.name === 'plan_midia_importar')?.inputSchema as object)).toEqual([
      'caminho',
      'card_id',
      'expected_rev'
    ])
  })

  it('sem card_id: copia para midia/ e devolve nome, tipo e caminho absoluto', async () => {
    const out = await call('plan_midia_importar', { caminho: await source('Tela de Login.PNG', 'png-bytes') })
    const [name] = await fs.readdir(mediaDir())
    expect(name).toMatch(/^[0-9a-f]{6}-tela-de-login\.png$/)
    const abs = (await realMedia.listMedia(cwd, SLUG))[0].path
    expect(path.isAbsolute(abs)).toBe(true)
    expect(out).toBe(`Mídia importada: [Imagem] ${name} — ${abs} · 9 B\nPara anexá-la a um card, ponha "${name}" em anexos (plan_card_create ou plan_card_update).`)
    expect(await fs.readFile(abs, 'utf8')).toBe('png-bytes')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('caminho relativo é resolvido a partir da raiz do projeto', async () => {
    await source('spec.pdf')
    expect(await call('plan_midia_importar', { caminho: 'assets/spec.pdf' })).toMatch(/Mídia importada: \[PDF\] [0-9a-f]{6}-spec\.pdf — /)
  })

  it('com card_id e expected_rev certo: anexa ao card', async () => {
    await call('plan_card_create', { id: 'r1', tipo: 'requisito', titulo: 'R1' })
    const name = await importar('fluxo.png', { card_id: 'r1', expected_rev: 1 })
    expect((await cardOf('r1'))?.anexos).toEqual([name])
    expect(await call('plan_read', { card_id: 'r1' })).toMatch(new RegExp(`anexos ${escape(name)} · rev 2`))
  })

  it('card_id sem expected_rev, card inexistente ou rev errado: nada é copiado', async () => {
    await call('plan_card_create', { id: 'r1', tipo: 'requisito', titulo: 'R1', corpo: 'atual' })
    notify.mockClear()
    const caminho = await source('a.png')
    expect(await call('plan_midia_importar', { caminho, card_id: 'r1' })).toMatch(/^Nada importado: .*informe expected_rev/)
    expect(await call('plan_midia_importar', { caminho, card_id: 'zzz', expected_rev: 1 })).toMatch(/^Nada importado: não existe card zzz/)
    const conflict = await call('plan_midia_importar', { caminho, card_id: 'r1', expected_rev: 7 })
    expect(conflict).toMatch(/^plan_midia_importar falhou: rev desatualizado: esperado 7, atual 1/)
    expect(conflict).toMatch(/Card atual:\nr1 \[requisito\] R1 · rev 1\n---\natual/)
    await expect(fs.readdir(mediaDir())).rejects.toThrow()
    expect(notify).not.toHaveBeenCalled()
  })

  it('card muda entre a cópia e a gravação: a mídia fica em midia/ e a resposta diz que não anexou', async () => {
    await call('plan_card_create', { id: 'r1', tipo: 'requisito', titulo: 'R1' })
    const saveCard = vi.fn(async () => {
      const disk = await cardOf('r1')
      throw new RevConflictError(disk ?? null, 1)
    })
    const out = await call('plan_midia_importar', { caminho: await source('b.png'), card_id: 'r1', expected_rev: 1 }, build({ store: { ...realStore, saveCard } }))
    expect(out).toMatch(/Mídia importada: \[Imagem\] [0-9a-f]{6}-b\.png/)
    expect(out).toMatch(/Mas NÃO foi anexada ao card r1: rev desatualizado/)
    expect(await fs.readdir(mediaDir())).toHaveLength(1)
  })

  it('origem inexistente vira texto, não exceção', async () => {
    expect(await call('plan_midia_importar', { caminho: path.join(cwd, 'nao-tem.png') })).toMatch(/^plan_midia_importar falhou: .*ENOENT/)
  })
})

describe('anexos em plan_card_create / plan_card_update', () => {
  it('create aceita nomes que existem em midia/ e recusa os que não existem, com texto acionável', async () => {
    const name = await importar('logo.png')
    const bad = await call('plan_card_create', { id: 'n1', tipo: 'nota', titulo: 'N', anexos: [name, 'fantasma.png'] })
    expect(bad).toBe(
      'Card não criado: anexos que não existem em midia/: fantasma.png. Use o nome exato listado em "Mídias do plano" ' +
        '(plan_read) ou traga o arquivo com plan_midia_importar, que devolve o nome a usar.'
    )
    expect(await cardOf('n1')).toBeUndefined()
    expect(await call('plan_card_create', { id: 'n1', tipo: 'nota', titulo: 'N', anexos: [name, name] })).toMatch(/Card criado: n1/)
    expect((await cardOf('n1'))?.anexos).toEqual([name])
  })

  it('tipo midia exige anexo', async () => {
    expect(await call('plan_card_create', { id: 'm1', tipo: 'midia', titulo: 'Tela' })).toMatch(
      /Card não criado: card do tipo "midia" precisa de pelo menos um anexo/
    )
    const name = await importar('tela.png')
    expect(await call('plan_card_create', { id: 'm1', tipo: 'midia', titulo: 'Tela', anexos: [name] })).toMatch(/Card criado: m1 \[midia\]/)
    expect(await call('plan_card_update', { id: 'm1', expected_rev: 1, anexos: [] })).toMatch(/Card não alterado: card do tipo "midia"/)
  })

  it('update substitui a lista, [] limpa, nome novo inexistente é recusado, nome que o card já tinha passa', async () => {
    const a = await importar('a.pdf')
    const b = await importar('b.png')
    await call('plan_card_create', { id: 'r1', tipo: 'requisito', titulo: 'R1', anexos: [a] })
    expect(await call('plan_card_update', { id: 'r1', expected_rev: 1, anexos: [a, 'nao-tem.png'] })).toMatch(
      /^Card não alterado: anexos que não existem em midia\/: nao-tem\.png/
    )
    expect(await call('plan_card_update', { id: 'r1', expected_rev: 1, anexos: [b, a] })).toMatch(/Card atualizado: r1 .* anexos .* · rev 2/)
    expect((await cardOf('r1'))?.anexos).toEqual([b, a])
    // O usuário apagou o arquivo de a por fora: mexer no card mantendo o anexo não trava.
    await fs.rm(path.join(mediaDir(), a))
    expect(await call('plan_card_update', { id: 'r1', expected_rev: 2, titulo: 'R1 novo', anexos: [a] })).toMatch(/Card atualizado/)
    expect(await call('plan_card_update', { id: 'r1', expected_rev: 3, anexos: [] })).toBe('Card atualizado: r1 [requisito] R1 novo · rev 4')
    expect((await cardOf('r1'))?.anexos).toBeUndefined()
  })
})

describe('plan_read com mídia', () => {
  it('sem card_id: anexos por card com [Tipo] nome — caminho e a seção final "Mídias do plano" com órfãs', async () => {
    await call('plan_card_create', { id: 'r1', tipo: 'requisito', titulo: 'R1' })
    const img = await importar('tela.png', { card_id: 'r1', expected_rev: 1 })
    const orfa = await importar('contrato.pdf')
    await call('plan_card_create', { id: 'n1', tipo: 'nota', titulo: 'N1', anexos: [img] })
    // Anexo que o store aceita (nome válido), mas cujo arquivo não existe (gravado por fora).
    const n1 = (await cardOf('n1')) as PlanCard
    await realStore.saveCard(cwd, SLUG, { ...n1, anexos: [img, 'sumiu.mp4'] }, 1)
    const byName = new Map((await realMedia.listMedia(cwd, SLUG)).map((m) => [m.name, m.path]))
    const out = await call('plan_read', {})
    expect(out).toContain(`  - [[R1]] (id r1, requisito) · anexos ${img} · rev 2\n      anexo: [Imagem] ${img} — ${byName.get(img)}`)
    const missing = path.join(cwd, 'docs', 'spec', SLUG, 'midia', 'sumiu.mp4')
    expect(out).toContain(`      anexo: [Vídeo] sumiu.mp4 — ${missing} (arquivo não encontrado em midia/)`)
    // A seção fecha o texto: cabeçalho, uma linha por mídia (ordem de nome) e os anexos sem arquivo.
    const section = out.slice(out.indexOf('Mídias do plano')).split('\n')
    expect(section).toHaveLength(4)
    expect(section[0]).toBe('Mídias do plano (2) — abra imagem e PDF com Read pelo caminho absoluto:')
    expect(section.slice(1, 3).sort()).toEqual(
      [
        `  - [PDF] ${orfa} — ${byName.get(orfa)} · ${Buffer.byteLength('conteúdo de contrato.pdf')} B · sem card`,
        `  - [Imagem] ${img} — ${byName.get(img)} · ${Buffer.byteLength('conteúdo de tela.png')} B · cards n1, r1`
      ].sort()
    )
    expect(section[3]).toBe('Anexos sem arquivo em midia/ (1): sumiu.mp4 (cards n1).')
  })

  it('sem mídia nenhuma, a seção diz onde fica a pasta e como trazer arquivos', async () => {
    expect(await call('plan_read', {})).toMatch(/\nMídias do plano: nenhuma \(pasta .*midia\)\. Para trazer um arquivo ao plano, use plan_midia_importar\.$/)
  })

  it('com card_id: imagens png/jpeg/gif/webp viram blocos image (até 4); as de fora são citadas', async () => {
    const names: string[] = []
    for (const f of ['a.png', 'b.jpg', 'c.gif', 'd.webp', 'e.png', 'f.bmp', 'g.pdf']) names.push(await importar(f))
    await call('plan_card_create', { id: 'm1', tipo: 'midia', titulo: 'Telas', anexos: names })
    const out = await blocks('plan_read', { card_id: 'm1' })
    const images = out.filter((b) => b.type === 'image')
    expect(images.map((b) => b.mimeType)).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    expect(Buffer.from(images[0].data ?? '', 'base64').toString()).toBe('conteúdo de a.png')
    // Cada imagem vem precedida do nome.
    expect(out[1]).toEqual({ type: 'text', text: `Imagem anexada: ${names[0]}` })
    const head = out[0].text ?? ''
    expect(head).toMatch(/^m1 \[midia\] Telas · anexos .* · rev 1\nAnexos \(7\):\n {2}- \[Imagem\] /)
    expect(head).toContain(`[PDF] ${names[6]} — `)
    expect(head).toMatch(new RegExp(`Imagens que não vieram como imagem nesta leitura \\(abra com Read pelo caminho acima\\): ${escape(names[4])} \\(limite de 4 imagens por leitura\\); ${escape(names[5])} \\(formato image/bmp não vai como imagem\\)\\.$`))
  })

  it('com card_id: imagem acima de 5 MB não vai como bloco e é citada', async () => {
    const big = await importar('grande.png')
    const small = await importar('pequena.png')
    await call('plan_card_create', { id: 'm1', tipo: 'midia', titulo: 'T', anexos: [big, small] })
    const listMedia = async (c: string, s: string) =>
      (await realMedia.listMedia(c, s)).map((m) => (m.name === big ? { ...m, size: MAX_IMAGE_BLOCK_BYTES + 1 } : m))
    const out = await blocks('plan_read', { card_id: 'm1' }, build({ media: { ...realMedia, listMedia } }))
    expect(out.filter((b) => b.type === 'image')).toHaveLength(1)
    expect(out[0].text).toMatch(new RegExp(`${escape(big)} \\(5 MB, acima de 5 MB\\)`))
  })

  it('card sem anexos continua exatamente como antes', async () => {
    await call('plan_card_create', { id: 'r1', tipo: 'requisito', titulo: 'R1', corpo: 'x' })
    expect(await blocks('plan_read', { card_id: 'r1' })).toEqual([{ type: 'text', text: 'r1 [requisito] R1 · rev 1\n---\nx' }])
  })
})
