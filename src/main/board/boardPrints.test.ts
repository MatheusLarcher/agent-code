import { describe, expect, it, vi } from 'vitest'
import type { BoardItem } from '../../shared/ipc'
import { compressPrint, PRINT_MAX_WIDTH, PRINT_TARGET_BYTES, resolvePrintCard, sniffImage, type ImageLike } from './boardPrints'
import { attachPrint, type AttachPrintDeps, type NewBoardItemPrint } from './printAttach'

/**
 * `app_anexar_print`: arquivo inválido, grande demais, não-imagem, tarefa
 * ambígua, a compressão (até 1600 px, ~300 KB) e a recusa da tela inteira.
 * O limite de 4 por cartão é do banco (boardPrints.sqlite.test.ts).
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')])

function item(id: string, over: Partial<BoardItem> = {}): BoardItem {
  return {
    id, projectId: 'p1', projectCwd: 'C:/proj', conversationId: 'c1', origin: 'agent', sourceId: `t-${id}`,
    sourceTitle: `Tarefa ${id}`, sourceStatus: 'pending', activeForm: null, seq: 0, poTitle: null, poNote: null,
    poStatus: null, poReason: null, poAt: null, dismissedAt: null, revision: 1,
    createdAt: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T10:00:00.000Z', ...over
  }
}

/** Um nativeImage falso: `bytesAt(width, quality)` diz o tamanho do JPEG. */
function fakeImage(width: number, height: number, bytesAt: (w: number, q: number) => number, calls: string[] = []): ImageLike {
  return {
    isEmpty: () => width === 0,
    getSize: () => ({ width, height }),
    resize: (o) => {
      calls.push(`resize:${o.width}`)
      return fakeImage(o.width, Math.round((height * o.width) / width), bytesAt, calls)
    },
    toJPEG: (q) => {
      calls.push(`jpeg:${width}@${q}`)
      return Buffer.alloc(bytesAt(width, q))
    }
  }
}

describe('sniffImage', () => {
  it('reconhece pelos bytes, não pela extensão', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(JPEG)).toBe('image/jpeg')
    expect(sniffImage(WEBP)).toBe('image/webp')
    expect(sniffImage(Buffer.from('<html>não sou imagem</html>'))).toBeNull()
  })
})

describe('resolvePrintCard', () => {
  const items = [
    item('a', { sourceStatus: 'in_progress', sourceTitle: '[tela-login] Tela de login' }),
    item('b', { sourceTitle: 'API de login' }),
    item('c', { sourceTitle: '[tela-login] Ajustar o erro' }),
    item('x', { conversationId: 'outra', sourceStatus: 'in_progress' })
  ]

  it('sem tarefa: o único em andamento da conversa', () => {
    expect(resolvePrintCard(items, 'c1')).toMatchObject({ ok: true, item: { id: 'a' } })
  })

  it('pelo id do TodoWrite, pelo título exato (sem caixa) e pelo prefixo da etapa', () => {
    expect(resolvePrintCard(items, 'c1', 't-b')).toMatchObject({ ok: true, item: { id: 'b' } })
    expect(resolvePrintCard(items, 'c1', 'api de LOGIN')).toMatchObject({ ok: true, item: { id: 'b' } })
    expect(resolvePrintCard([items[0], items[1]], 'c1', '[tela-login]')).toMatchObject({ ok: true, item: { id: 'a' } })
  })

  it('ambíguo ou nenhum: erro que diz quais cartões existem', () => {
    const many = resolvePrintCard(items, 'c1', '[tela-login]')
    expect(many.ok).toBe(false)
    expect(!many.ok && many.error).toMatch(/mais de um cartão.*Tela de login.*Ajustar o erro/)
    const none = resolvePrintCard(items, 'c1', 'nada disso')
    expect(!none.ok && none.error).toMatch(/nenhum cartão desta conversa/)
    const twoDoing = resolvePrintCard([...items, item('d', { sourceStatus: 'in_progress' })], 'c1')
    expect(!twoDoing.ok && twoDoing.error).toMatch(/mais de um cartão em andamento/)
  })
})

describe('compressPrint', () => {
  it('reduz para 1600 px e desce a qualidade até ~300 KB; miniatura de 320 px', async () => {
    const calls: string[] = []
    const img = fakeImage(2400, 1500, (w, q) => (w >= 1600 && q > 62 ? 500_000 : 250_000), calls)
    const out = await compressPrint(PNG, 'image/png', { fromBuffer: () => img })
    expect('error' in out).toBe(false)
    if ('error' in out) return
    expect(out).toMatchObject({ mime: 'image/jpeg', width: PRINT_MAX_WIDTH, sourceWidth: 2400, sourceHeight: 1500 })
    expect(out.data.length).toBeLessThanOrEqual(PRINT_TARGET_BYTES)
    expect(calls).toContain('resize:320')
  })

  it('WebP passa pelo decodificador do Chromium; sem ele, recusa com motivo', async () => {
    const decodeWebp = vi.fn(async () => PNG)
    const ok = await compressPrint(WEBP, 'image/webp', { fromBuffer: () => fakeImage(800, 600, () => 50_000), decodeWebp })
    expect(decodeWebp).toHaveBeenCalled()
    expect('error' in ok).toBe(false)
    const no = await compressPrint(WEBP, 'image/webp', { fromBuffer: () => fakeImage(800, 600, () => 50_000) })
    expect(no).toEqual({ error: 'não consegui ler o WebP; salve o print como PNG ou JPEG' })
  })

  it('imagem que não abre: erro', async () => {
    expect(await compressPrint(PNG, 'image/png', { fromBuffer: () => fakeImage(0, 0, () => 1) })).toMatchObject({ error: expect.stringMatching(/não abriu/) })
  })
})

describe('attachPrint', () => {
  function deps(over: Partial<AttachPrintDeps> = {}) {
    const saved: NewBoardItemPrint[] = []
    const changed: string[] = []
    const d: AttachPrintDeps = {
      stat: async () => ({ isFile: () => true, size: 2000 }),
      readFile: async () => PNG,
      board: async () => ({ projectId: 'p1', items: [item('a', { sourceStatus: 'in_progress' })] }),
      image: { fromBuffer: () => fakeImage(1200, 800, () => 120_000) },
      fullScreen: (w, h) => w === 1920 && h === 1080,
      save: async (p) => void saved.push(p),
      changed: (p) => void changed.push(p),
      now: () => Date.UTC(2026, 9, 7, 12, 0),
      newId: () => 'print-1',
      ...over
    }
    return { d, saved, changed }
  }
  const input = { conversationId: 'c1', cwd: 'C:/proj', arquivo: 'shots/login.png', legenda: '  tela de login  ' }

  it('anexa: caminho relativo à pasta da conversa, legenda limpa, grava e avisa o quadro', async () => {
    const stat = vi.fn(async (_path: string) => ({ isFile: () => true, size: 2000 }))
    const { d, saved, changed } = deps({ stat })
    const res = await attachPrint(input, d)
    expect(res).toMatchObject({ ok: true, boardItemId: 'a', message: expect.stringMatching(/print anexado ao cartão "Tarefa a"/) })
    expect(String(stat.mock.calls[0]?.[0]).replace(/\\/g, '/')).toBe('C:/proj/shots/login.png')
    expect(saved[0]).toMatchObject({ id: 'print-1', boardItemId: 'a', projectId: 'p1', conversationId: 'c1', legenda: 'tela de login', mime: 'image/jpeg', createdAt: '2026-10-07T12:00:00.000Z' })
    expect(changed).toEqual(['p1'])
  })

  it('arquivo inexistente, grande demais ou que não é imagem: recusa sem gravar', async () => {
    const missing = deps({ stat: async () => Promise.reject(new Error('ENOENT')) })
    expect(await attachPrint(input, missing.d)).toMatchObject({ ok: false, message: expect.stringMatching(/não existe/) })
    const big = deps({ stat: async () => ({ isFile: () => true, size: 11 * 1024 * 1024 }) })
    expect(await attachPrint(input, big.d)).toMatchObject({ ok: false, message: expect.stringMatching(/limite é 10 MB/) })
    const text = deps({ readFile: async () => Buffer.from('não sou imagem') })
    expect(await attachPrint(input, text.d)).toMatchObject({ ok: false, message: expect.stringMatching(/não é imagem PNG, JPEG ou WebP/) })
    expect([...missing.saved, ...big.saved, ...text.saved]).toEqual([])
  })

  it('tarefa ambígua, tela inteira ou quadro fora do ar: recusa com o motivo', async () => {
    const two = deps({ board: async () => ({ projectId: 'p1', items: [item('a', { sourceStatus: 'in_progress' }), item('b', { sourceStatus: 'in_progress' })] }) })
    expect(await attachPrint(input, two.d)).toMatchObject({ ok: false, message: expect.stringMatching(/mais de um cartão em andamento/) })
    const screen = deps({ image: { fromBuffer: () => fakeImage(1920, 1080, () => 200_000) } })
    expect(await attachPrint(input, screen.d)).toMatchObject({ ok: false, message: expect.stringMatching(/tela inteira do computador \(1920×1080\)/) })
    const off = deps({ board: async () => null })
    expect(await attachPrint(input, off.d)).toMatchObject({ ok: false, message: expect.stringMatching(/quadro está indisponível/) })
    expect([...two.saved, ...screen.saved, ...off.saved]).toEqual([])
  })
})
