import { describe, it, expect } from 'vitest'
import type { PlanMediaDto } from '@shared/ipc'
import { MAX_ANEXOS_POR_CARD } from '@shared/planningMedia'
import { CARD_W, FIRST_CARD_Y, NO_STAGE_ID, computeLayout } from './layout'
import {
  MAX_IMPORT_FILES,
  buildImport,
  columnAt,
  dropPosition,
  dropTargetOf,
  hasFiles,
  isTextTarget,
  mediaCard,
  mediaTitle,
  openTarget,
  pasteAllowed,
  pastedName,
  toBase64,
  transferFiles,
  withAnexos,
  type DroppedFile
} from './mediaDrop'
import { makeCard, makePlan } from './planningTestUtils'

function file(name: string, type: string, bytes: number[] = [1, 2, 3]): DroppedFile {
  const buf = new Uint8Array(bytes).buffer
  return { name, type, size: bytes.length, arrayBuffer: async () => buf }
}

function media(name: string, kind: PlanMediaDto['kind'] = 'imagem'): PlanMediaDto {
  return { name, path: `D:\\dados\\plano\\midia\\${name}`, kind, size: 10, mediaType: 'image/png' }
}

const plan = makePlan()
const layout = computeLayout(plan.roteiro, plan.cards, plan.layout.positions)

describe('hasFiles / transferFiles', () => {
  it('só arrasto com "Files" conta; texto arrastado não', () => {
    expect(hasFiles({ types: ['Files'] })).toBe(true)
    expect(hasFiles({ types: ['text/plain'] })).toBe(false)
    expect(hasFiles(null)).toBe(false)
  })

  it('pega os arquivos de files; sem eles, os items do tipo file (sem repetir)', () => {
    const a = file('a.png', 'image/png')
    expect(transferFiles({ files: [a, a] })).toEqual([a])
    const b = file('b.png', 'image/png')
    const items = [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => b }
    ]
    expect(transferFiles({ files: [], items })).toEqual([b])
    expect(transferFiles(undefined)).toEqual([])
  })
})

describe('colar: isTextTarget / pasteAllowed', () => {
  const canvas = document.createElement('div')
  const inside = document.createElement('div')
  canvas.appendChild(inside)
  document.body.appendChild(canvas)

  it('campo de texto é do texto', () => {
    expect(isTextTarget(document.createElement('textarea'))).toBe(true)
    expect(isTextTarget(document.createElement('input'))).toBe(true)
    expect(isTextTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTextTarget(document.createElement('button'))).toBe(false)
  })

  it('aceita foco no body ou dentro do canvas visível; recusa texto, fora do canvas, diálogo e canvas escondido', () => {
    expect(pasteAllowed(document.body, canvas, true)).toBe(true)
    expect(pasteAllowed(inside, canvas, true)).toBe(true)
    expect(pasteAllowed(inside, canvas, false)).toBe(false)
    expect(pasteAllowed(document.createElement('textarea'), canvas, true)).toBe(false)
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    expect(pasteAllowed(outside, canvas, true)).toBe(false)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const btn = document.createElement('button')
    dialog.appendChild(btn)
    canvas.appendChild(dialog)
    expect(pasteAllowed(btn, canvas, true)).toBe(false)
    expect(pasteAllowed(document.body, null, true)).toBe(false)
  })
})

describe('pastedName / toBase64', () => {
  const now = new Date(2026, 8, 24, 9, 5, 7)
  it('imagem colada sem nome (ou "image.png") ganha nome com data; nome de verdade fica', () => {
    expect(pastedName({ name: '', type: 'image/png' }, now)).toBe('colada-20260924-090507.png')
    expect(pastedName({ name: 'image.png', type: 'image/jpeg' }, now)).toBe('colada-20260924-090507.jpg')
    expect(pastedName({ name: 'Tela de login.png', type: 'image/png' }, now)).toBe('Tela de login.png')
  })

  it('base64 igual ao do btoa, também para arrays grandes', () => {
    expect(toBase64(new Uint8Array([104, 105]))).toBe('aGk=')
    const big = new Uint8Array(100_000).fill(65)
    expect(toBase64(big)).toBe(btoa('A'.repeat(100_000)))
  })
})

describe('buildImport', () => {
  it('arquivo do Explorer vai por caminho; imagem colada (sem caminho) vai em base64', async () => {
    const dropped = file('relatorio.pdf', 'application/pdf')
    const pasted = file('image.png', 'image/png', [104, 105])
    const paths = new Map([[dropped, 'C:\\Users\\m\\relatorio.pdf']])
    const out = await buildImport([dropped, pasted], (f) => paths.get(f) ?? '', new Date(2026, 0, 2, 3, 4, 5))
    expect(out.skipped).toEqual([])
    expect(out.files).toEqual([
      { path: 'C:\\Users\\m\\relatorio.pdf' },
      { name: 'colada-20260102-030405.png', data: 'aGk=' }
    ])
  })

  it('sem caminho e sem ser imagem fica de fora com o motivo', async () => {
    const out = await buildImport([file('notas.txt', 'text/plain')], () => '')
    expect(out.files).toEqual([])
    expect(out.skipped[0]).toMatch(/notas\.txt: só dá para colar imagem/)
  })

  it(`acima de ${MAX_IMPORT_FILES} arquivos o resto fica de fora; getPath que lança vale como sem caminho`, async () => {
    const many = Array.from({ length: MAX_IMPORT_FILES + 2 }, (_, i) => file(`f${i}.png`, 'image/png'))
    const out = await buildImport(many, (f) => (f.name === 'f0.png' ? (() => { throw new Error('x') })() : `C:\\${f.name}`))
    expect(out.files).toHaveLength(MAX_IMPORT_FILES)
    expect(out.files[0]).toMatchObject({ data: expect.any(String) })
    expect(out.skipped).toHaveLength(2)
  })
})

describe('onde o drop cai', () => {
  it('columnAt: a coluna que contém o x; antes da primeira, a primeira; depois da última, "Sem etapa"', () => {
    const [c0, c1] = layout.columns
    expect(columnAt(layout, c0.x + 10)).toBe(c0.id)
    expect(columnAt(layout, c1.x + CARD_W)).toBe(c1.id)
    expect(columnAt(layout, -500)).toBe(c0.id)
    expect(columnAt(layout, 99_999)).toBe(NO_STAGE_ID)
  })

  it('dropPosition centra o card no ponto e não deixa cair no cabeçalho', () => {
    expect(dropPosition({ x: 500, y: 400 })).toEqual({ x: 500 - CARD_W / 2, y: 380 })
    expect(dropPosition({ x: 0, y: 0 }).y).toBe(FIRST_CARD_Y)
  })

  it('dropTargetOf: sobre um card anexa; fora, cria na coluna (sem etapa na coluna "Sem etapa")', () => {
    expect(dropTargetOf(layout, 'login', { x: 0, y: 0 })).toEqual({ kind: 'card', cardId: 'login' })
    const col = layout.columns[1]
    expect(dropTargetOf(layout, 'stage:desenho', { x: col.x + 20, y: 300 })).toEqual({
      kind: 'empty',
      etapa: col.id,
      position: dropPosition({ x: col.x + 20, y: 300 })
    })
    expect(dropTargetOf(layout, null, { x: 99_999, y: 300 })).toEqual({ kind: 'empty', position: dropPosition({ x: 99_999, y: 300 }) })
  })
})

describe('card de mídia e anexos', () => {
  it('mediaTitle tira o prefixo e a extensão', () => {
    expect(mediaTitle('a1b2c3-tela-de-login.png')).toBe('Tela de login')
    expect(mediaTitle('relatorio_final.pdf')).toBe('Relatorio final')
    expect(mediaTitle('')).toBe('Mídia')
  })

  it('mediaCard: tipo midia, rev 0, anexos na ordem, etapa quando há, id livre', () => {
    const card = mediaCard([media('a1b2c3-tela.png'), media('d4e5f6-fluxo.pdf', 'pdf')], ['tela-e-mais-1'], 'desenho')
    expect(card).toMatchObject({ tipo: 'midia', rev: 0, etapa: 'desenho', titulo: 'Tela e mais 1', anexos: ['a1b2c3-tela.png', 'd4e5f6-fluxo.pdf'] })
    expect(card.id).toBe('tela-e-mais-1-2')
    expect(mediaCard([media('a1b2c3-x.png')], []).etapa).toBeUndefined()
  })

  it('withAnexos: soma no fim sem repetir e para no máximo do card', () => {
    const c = makeCard('c', { anexos: ['a1b2c3-a.png'] })
    expect(withAnexos(c, ['a1b2c3-a.png', 'a1b2c3-b.png'])).toMatchObject({ added: 1, dropped: 0, card: { anexos: ['a1b2c3-a.png', 'a1b2c3-b.png'] } })
    const full = makeCard('f', { anexos: Array.from({ length: MAX_ANEXOS_POR_CARD }, (_, i) => `a1b2c3-${i}.png`) })
    expect(withAnexos(full, ['a1b2c3-novo.png'])).toMatchObject({ added: 0, dropped: 1 })
  })

  it('openTarget: arquivo comum abre; programa abre a pasta dele', () => {
    expect(openTarget('D:\\p\\midia\\a1b2c3-x.pdf')).toEqual({ path: 'D:\\p\\midia\\a1b2c3-x.pdf', folder: false })
    expect(openTarget('D:\\p\\midia\\a1b2c3-setup.EXE')).toEqual({ path: 'D:\\p\\midia', folder: true })
    expect(openTarget('/p/midia/a1b2c3-run.bat')).toEqual({ path: '/p/midia', folder: true })
  })
})
