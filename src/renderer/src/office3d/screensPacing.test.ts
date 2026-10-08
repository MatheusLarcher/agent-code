import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Mesh } from 'three'
import type { OfficeFeed } from '../office/adapter/feed'
import type { OfficeCharacterModel } from '../office/adapter/model'
import type { UIMessage } from '../types'
import { lastActionPage, type ActionPage } from './actionPage'
import { actionView } from './actionPaint'
import type { ToolUseMessage } from './chatPage'
import type { CodePage } from './codePage'
import { paintCode } from './codePaint'
import type { ScreenView } from './decor'
import { createKit } from './kit'
import { MON_H, MON_W } from './monitorTexture'
import { MONITOR_SWAP_MS } from './monitorThrottle'
import type { RoomLod } from './roomLod'
import { fillScreen } from './screens'

let seq = 0
const user = (): UIMessage => ({ kind: 'user', id: `u${seq++}`, text: 'pedido' })
const tool = (name: string, input: unknown, result?: string): ToolUseMessage => ({
  kind: 'tool-use', id: `t${seq++}`, name, input, parentToolUseId: null,
  ...(result === undefined ? {} : { result: { isError: false, text: result } })
})

const feedOf = (messages: UIMessage[]): OfficeFeed =>
  ({ conversations: [{ id: 'c1', title: 'Carrinho', messages }, { id: 'c2', title: 'Outro', messages }], tracks: {}, busyIds: new Set() }) as unknown as OfficeFeed

const owner = (key: string, convId: string): OfficeCharacterModel =>
  ({ key, convId, role: 'principal', active: true, label: key }) as unknown as OfficeCharacterModel

function screen(): ScreenView {
  const lod = { level: 0, culled: false, placed: true } as unknown as RoomLod
  return { mesh: new Mesh(), state: 'off', on: null, page: null, accent: '', status: 'idle', lod, zone: 'island0' }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('fillScreen: a tela troca no máximo a cada 2 s, sem redesenho à toa', () => {
  const kit = createKit(1)
  const bash = [user(), tool('Bash', { command: 'npm test' }, 'ok')]
  const read = [...bash, tool('Read', { file_path: 'C:\\p\\a.ts' }, '1→x')]
  const grep = [...read, tool('Grep', { pattern: 'x' }, 'C:\\p\\a.ts:1:x')]

  it('primeira página na hora; a do meio do intervalo entra quando ele vence (e pede um quadro); página igual não redesenha', () => {
    const s = screen()
    const dirty = vi.fn()
    const me = owner('a', 'c1')
    fillScreen(s, kit, me, 'p', feedOf(bash), null, false, true, false, dirty)
    expect(s.page?.code?.action?.kind).toBe('terminal')
    const draw = vi.spyOn(s.on!.mon, 'draw')
    const repainted = (): number => draw.mock.results.filter((r) => r.value === true).length

    // O mesmo feed de novo: a página não muda, nada é redesenhado.
    fillScreen(s, kit, me, 'p', feedOf(bash), null, false, true, false, dirty)
    expect(repainted()).toBe(0)

    // Ações novas dentro dos 2 s: a tela segura a anterior.
    vi.advanceTimersByTime(500)
    fillScreen(s, kit, me, 'p', feedOf(read), null, false, true, false, dirty)
    vi.advanceTimersByTime(500)
    fillScreen(s, kit, me, 'p', feedOf(grep), null, false, true, false, dirty)
    expect(s.page?.code?.action?.kind).toBe('terminal')
    expect(repainted()).toBe(0)
    expect(dirty).not.toHaveBeenCalled()

    // Venceu o intervalo: só a última (a busca) aparece, num redesenho só.
    vi.advanceTimersByTime(MONITOR_SWAP_MS - 1000)
    expect(s.page?.code?.action?.kind).toBe('search')
    expect(repainted()).toBe(1)
    expect(draw).toHaveBeenLastCalledWith(s.page, s.accent)
    expect(dirty).toHaveBeenCalledTimes(1)

    // E o mesmo feed depois disso não redesenha.
    fillScreen(s, kit, me, 'p', feedOf(grep), null, false, true, false, dirty)
    vi.advanceTimersByTime(MONITOR_SWAP_MS * 2)
    expect(repainted()).toBe(1)
  })

  it('outro dono na mesa: a página dele entra na hora', () => {
    const s = screen()
    fillScreen(s, kit, owner('a', 'c1'), 'p', feedOf(bash), null, false, true)
    fillScreen(s, kit, owner('b', 'c2'), 'p', feedOf(read), null, false, true)
    expect(s.page?.code?.action?.kind).toBe('read')
  })

  it('tela fora da vista: a troca atrasada só guarda a página (desenha quando voltar)', () => {
    const s = screen()
    const dirty = vi.fn()
    const me = owner('a', 'c1')
    fillScreen(s, kit, me, 'p', feedOf(bash), null, false, true, false, dirty)
    const draw = vi.spyOn(s.on!.mon, 'draw')
    s.lod.culled = true
    fillScreen(s, kit, me, 'p', feedOf(read), null, false, false, false, dirty)
    vi.advanceTimersByTime(MONITOR_SWAP_MS)
    expect(s.page?.code?.action?.kind).toBe('read')
    expect(draw).not.toHaveBeenCalled()
    expect(dirty).not.toHaveBeenCalled()
  })

  it('protetor de tela: a cadência recomeça e a volta é imediata', () => {
    const s = screen()
    const me = owner('a', 'c1')
    fillScreen(s, kit, me, 'p', feedOf(bash), null, false, true)
    fillScreen(s, kit, { ...me, active: false }, 'p', feedOf(bash), null, false, true)
    expect(s.state).toBe('saver')
    fillScreen(s, kit, me, 'p', feedOf(read), null, false, true)
    expect(s.page?.code?.action?.kind).toBe('read')
    expect(vi.getTimerCount()).toBe(0)
  })
})

/** Contexto 2D de mentira: anota cada texto com a fonte do momento. */
function fakeCtx(): { ctx: CanvasRenderingContext2D; texts: Array<{ text: string; font: string }> } {
  const texts: Array<{ text: string; font: string }> = []
  const noop = (): void => {}
  const ctx = {
    fillStyle: '', font: '', textBaseline: '', textAlign: '',
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillText(text: string) {
      texts.push({ text, font: this.font })
    },
    fillRect: noop, beginPath: noop, rect: noop, clip: noop, save: noop, restore: noop, setTransform: noop,
    moveTo: noop, arcTo: noop, closePath: noop, fill: noop
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts }
}

describe('actionView: a última ação no VS Code do monitor', () => {
  const code: CodePage = { files: [{ name: 'cart.ts', status: 'M' }], code: ['const a = 1'], firstLine: 1, pending: false }
  const paint = (msgs: UIMessage[]): string[] => {
    const a = lastActionPage(msgs) as ActionPage
    const { ctx, texts } = fakeCtx()
    paintCode(ctx, code, 'Carrinho', true, '#3fa', MON_W, MON_H, actionView(a, code))
    return texts.map((t) => t.text)
  }

  it('Read: aba em itálico com o arquivo lido, o trecho numerado e o resumo no status', () => {
    const { ctx, texts } = fakeCtx()
    const a = lastActionPage([user(), tool('Read', { file_path: 'C:\\p\\total.ts' }, '7→const total = 0')]) as ActionPage
    paintCode(ctx, code, 'Carrinho', true, '#3fa', MON_W, MON_H, actionView(a, code))
    expect(texts.find((t) => t.text === 'total.ts')?.font).toMatch(/^italic /)
    expect(texts.some((t) => t.text === '7')).toBe(true)
    expect(texts.some((t) => t.text === 'total')).toBe(true)
    expect(texts.some((t) => t.text.startsWith('Somente leitura'))).toBe(true)
    expect(texts.some((t) => t.text.startsWith('total.ts — Carrinho'))).toBe(true)
  })

  it('Bash: painel TERMINAL com o prompt, o comando e o fim da saída', () => {
    const t = paint([user(), tool('Bash', { command: 'npm test' }, 'Tests 3 passed')])
    expect(t).toEqual(expect.arrayContaining(['TERMINAL', '$ ', 'npm test', 'Tests 3 passed', '✓ comando concluído', 'const']))
  })

  it('Grep: aba de busca, o padrão e as ocorrências', () => {
    const t = paint([user(), tool('Grep', { pattern: 'total' }, 'C:\\p\\src\\a.ts:12:const total = 1')])
    expect(t).toEqual(expect.arrayContaining(['Busca: total', 'total', 'src/a.ts', ':12', 'const total = 1']))
  })

  it('navegador: o host, o endereço e o que faz', () => {
    const t = paint([user(), tool('mcp__browser__browser_navigate', { url: 'https://loja.dev/x' })])
    expect(t).toEqual(expect.arrayContaining(['loja.dev', 'https://loja.dev/x', 'Abrindo', '● navegando']))
  })

  it('Agent: "Delegou para" o subagente e a tarefa', () => {
    const t = paint([user(), tool('Agent', { subagent_type: 'Explore', description: 'achar o checkout' })])
    expect(t).toEqual(expect.arrayContaining(['Delegou para', 'Explore', 'achar o checkout', '● subagente trabalhando']))
  })
})
