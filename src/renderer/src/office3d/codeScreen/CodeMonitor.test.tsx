import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { OfficeFeed } from '../../office/adapter/feed'
import type { OfficeCharacterModel } from '../../office/adapter/model'
import { conv, feed } from '../../office/adapter/testFeed'
import { liveInput, type ToolInputDelta } from '../../office/liveInput'
import type { UIMessage } from '../../types'
import { UiProvider } from '../../ui/UiProvider'
import { openSteps } from '../../components/chatStepsTestkit'
import { CodeMonitor } from './CodeMonitor'

const CWD = 'C:\\proj\\loja'
const P = (rel: string): string => `${CWD}\\${rel}`
const TOTAL = ['import { Item } from "./cart"', '', 'export function total(items: Item[]): number {', '  // soma com quantidade', '  return items.reduce((a, i) => a + i.price * i.qty, 0)', '}', ''].join('\r\n')
const DISK: Record<string, string> = {
  [P('src\\total.ts')]: TOTAL,
  [P('src\\novo.ts')]: 'export const novo = 1\n'
}

const model = (over: Partial<OfficeCharacterModel> = {}): OfficeCharacterModel => ({
  key: 'conv:a',
  convId: 'a',
  roomId: 'c:/proj/loja',
  role: 'principal',
  placement: { kind: 'seat', seatKind: 'principal' },
  seed: 'conv:a',
  active: true,
  activity: null,
  bubble: null,
  label: 'Edit total.ts',
  ...over
})

let seq = 0
const tool = (name: string, input: unknown, result?: string): UIMessage => ({
  kind: 'tool-use',
  id: `t${seq++}`,
  name,
  input,
  parentToolUseId: null,
  ...(result === undefined ? {} : { result: { isError: false, text: result } })
})
const editTotal = (): UIMessage =>
  tool('Edit', { file_path: P('src\\total.ts'), old_string: '  let s = 0\n  for (const i of items) s += i.price\n  return s', new_string: '  // soma com quantidade\n  return items.reduce((a, i) => a + i.price * i.qty, 0)' }, 'ok')
const writeNovo = (): UIMessage => tool('Write', { file_path: P('src\\novo.ts'), content: 'export const novo = 1\n' }, 'File created successfully at: x')

const feedOf = (messages: UIMessage[]): OfficeFeed => feed({ conversations: [conv('a', { title: 'Carrinho', cwd: CWD, messages })], busyIds: new Set(['a']) })
const ask: UIMessage = { kind: 'user', id: 'u', text: 'mexe no total' }
/** O Chat do Código usa o ToolCard do chat, que pede o UiProvider do app. */
const ui = (el: JSX.Element): JSX.Element => <UiProvider>{el}</UiProvider>

let readFile: ReturnType<typeof vi.fn>
beforeEach(() => {
  // A tela lembra o último app, o alfinete e a largura do chat no localStorage: cada teste começa do zero.
  localStorage.clear()
  readFile = vi.fn(async (path: string) => DISK[path] ?? `Erro ao ler arquivo: Error: ENOENT: no such file or directory, open '${path}'`)
  ;(window as unknown as { api: unknown }).api = { readFile }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

const rows = (): HTMLElement[] => [...screen.getByRole('tabpanel').querySelectorAll<HTMLElement>('.cm-row')]
/** Número, sinal (espaço na linha igual) e o texto — ou o rótulo do trecho. */
const show = (r: HTMLElement): string =>
  r.classList.contains('cm-hunk')
    ? (r.querySelector('.cm-hunk-label')?.textContent ?? '')
    : `${r.querySelector('.cm-num')?.textContent ?? ''}${r.querySelector('.cm-sign')?.textContent || ' '}${r.querySelector('.cm-code')?.textContent ?? ''}`

describe('CodeMonitor', () => {
  it('abre em Código: abas do mais recente ao mais antigo, U/M, e o arquivo novo inteiro em verde', async () => {
    render(ui(<CodeMonitor feed={feedOf([ask, editTotal(), writeNovo()])} model={model()} onClose={vi.fn()} />))
    const root = screen.getByTestId('office-screen')
    expect(root.dataset.kind).toBe('code')
    expect(screen.getByRole('button', { name: 'Código' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'))).toEqual(['novo.ts, novo', 'total.ts, modificado'])
    expect(screen.getByRole('tab', { name: 'novo.ts, novo' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tablist', { name: 'Arquivos abertos' })).toBeTruthy()
    expect(await screen.findByText('export')).toBeTruthy()
    expect(rows().map(show)).toEqual(['1+export const novo = 1'])
    expect(readFile).toHaveBeenCalledWith(P('src\\novo.ts'))
    expect(screen.getByRole('button', { name: 'Fechar a tela' })).toBeTruthy()
  })

  it('arquivo lido do disco: o diff com os números reais do arquivo (removida sem número)', async () => {
    render(ui(<CodeMonitor feed={feedOf([ask, editTotal()])} model={model()} />))
    await screen.findByText('soma com quantidade', { exact: false })
    expect(rows().map(show)).toEqual([
      '1 import { Item } from "./cart"',
      '2 ',
      '3 export function total(items: Item[]): number {',
      '−  let s = 0',
      '−  for (const i of items) s += i.price',
      '−  return s',
      '4+  // soma com quantidade',
      '5+  return items.reduce((a, i) => a + i.price * i.qty, 0)',
      '6 }'
    ])
    const status = screen.getByTestId('office-screen').querySelector('.cm-statusbar')!
    expect(status.textContent).toContain('Ln 4, Col 1')
    expect(status.textContent).toContain('+2')
    expect(status.textContent).toContain('−3')
    expect(status.textContent).toContain('1 arquivo alterado')
  })

  it('nunca lê do disco arquivo sensível nem fora do projeto: só os trechos, sem número, com o aviso', () => {
    const env = tool('Edit', { file_path: P('.env'), old_string: 'A=1', new_string: 'A=2' }, 'ok')
    const fora = tool('Edit', { file_path: 'D:\\outro\\a.ts', old_string: 'x', new_string: 'y' }, 'ok')
    render(ui(<CodeMonitor feed={feedOf([ask, env, fora])} model={model()} />))
    expect(screen.getByRole('note').textContent).toContain('Fora da pasta do projeto')
    fireEvent.click(screen.getByRole('tab', { name: '.env, modificado' }))
    expect(screen.getByRole('note').textContent).toContain('Arquivo sensível')
    expect(rows().map(show)).toEqual(['Trecho 1 de 1', '−A=1', '+A=2'])
    expect(readFile).not.toHaveBeenCalled()
  })

  it('ao vivo: abre o arquivo que o Agent digita, com o cursor e o "digitando"; o tool-use final substitui', () => {
    const view = render(ui(<CodeMonitor feed={feedOf([ask, editTotal()])} model={model()} />))
    const delta: ToolInputDelta = { kind: 'tool-input-delta', toolUseId: 'w9', name: 'Write', filePath: P('src\\cupom.ts'), newText: 'export const CUPOM = "BEMVINDO10"\nexport const', totalLines: 2, done: false }
    act(() => liveInput.push('a', delta))
    expect(screen.getAllByRole('tab')[0].getAttribute('aria-label')).toBe('cupom.ts, digitando')
    expect(screen.getByRole('tab', { name: 'cupom.ts, digitando' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').querySelector('.cm-current .cm-caret .cm-flag')?.textContent).toBe('Agent')
    expect(screen.getByTestId('office-screen').querySelector('.cm-statusbar')?.textContent).toContain('digitando cupom.ts…')
    expect(screen.getByTestId('office-screen').querySelector('.cm-statusbar')?.textContent).toContain('Ln 2, Col 13')
    // O tool-use chegou (ainda sem resultado): a entrada completa toma o lugar do texto costurado.
    const final = { ...tool('Write', { file_path: P('src\\cupom.ts'), content: 'export const CUPOM = "BEMVINDO10"\nexport const ATIVO = true' }), id: 'w9' }
    view.rerender(ui(<CodeMonitor feed={feedOf([ask, editTotal(), final])} model={model()} />))
    expect(screen.getByRole('tab', { name: 'cupom.ts, modificado' })).toBeTruthy()
    expect(screen.getByRole('tabpanel').querySelector('.cm-caret')).toBeNull()
    expect(screen.getByRole('tabpanel').textContent).toContain('ATIVO = true')
  })

  it('I2: o caminho cortado dos primeiros pedaços não vira aba nem leitura de disco', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    render(ui(<CodeMonitor feed={feedOf([ask, editTotal()])} model={model()} />))
    const push = (over: Partial<ToolInputDelta>): void =>
      act(() => {
        liveInput.push('a', { kind: 'tool-input-delta', toolUseId: 'e7', name: 'Edit', newText: '', totalLines: 0, done: false, ...over })
        vi.advanceTimersByTime(150) // passa o intervalo de 100 ms entre dois renders do código ao vivo
      })
    const tabs = (): Array<string | null> => screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'))
    // Contrato atual do main: o file_path ainda aberto no JSON chega cortado.
    push({ filePath: P('src\\c') })
    expect(tabs()).toEqual(['total.ts, modificado'])
    // Contrato novo: o caminho vem inteiro, mas o trecho antigo ainda não — também nada de aba.
    push({ filePath: P('src\\cupom.ts') })
    expect(tabs()).toEqual(['total.ts, modificado'])
    // Outro campo começou (o caminho fechou no JSON): agora é o arquivo dele.
    push({ filePath: P('src\\cupom.ts'), oldText: 'export const A = 1' })
    expect(tabs()[0]).toBe('cupom.ts, digitando')
    expect(readFile.mock.calls.map(([p]) => p)).not.toContain(P('src\\c'))
  })

  it('I5: trocar de aba abre o arquivo rolado até a mudança dele, não na rolagem do anterior', async () => {
    // jsdom não rola: um scrollTop que guarda o valor, só neste teste.
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: { _top?: number }) {
        return this._top ?? 0
      },
      set(this: { _top?: number }, v: number) {
        this._top = v
      }
    })
    const lines = (p: string, n: number): string => Array.from({ length: n }, (_, i) => `const ${p}${i} = ${i}`).join('\n')
    DISK[P('src\\a.ts')] = lines('a', 400)
    DISK[P('src\\b.ts')] = lines('b', 50)
    const ed = (f: string, old: string, neu: string): UIMessage => tool('Edit', { file_path: P(`src\\${f}`), old_string: old, new_string: neu }, 'ok')
    try {
      render(ui(<CodeMonitor feed={feedOf([ask, ed('b.ts', 'const b20 = 0', 'const b20 = 20'), ed('a.ts', 'const a300 = 0', 'const a300 = 300')])} model={model()} />))
      await vi.waitFor(() => expect(rows().map(show)).toContain('301+const a300 = 300'))
      expect(screen.getByLabelText('Código de a.ts').scrollTop).toBeGreaterThan(250 * 19)
      fireEvent.click(screen.getByRole('tab', { name: 'b.ts, modificado' }))
      await vi.waitFor(() => expect(rows().map(show)).toContain('21+const b20 = 20'))
      expect(screen.getByLabelText('Código de b.ts').scrollTop).toBeLessThan(20 * 19)
    } finally {
      delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop
      delete DISK[P('src\\a.ts')]
      delete DISK[P('src\\b.ts')]
    }
  })

  it('seguir o Agent: a aba clicada para de seguir; o botão da barra de status volta para o que ele digita', () => {
    render(ui(<CodeMonitor feed={feedOf([ask, editTotal(), writeNovo()])} model={model()} />))
    const follow = screen.getByRole('button', { name: /Seguindo o Agent/ })
    expect(follow.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'total.ts, modificado' }))
    const back = screen.getByRole('button', { name: /Seguir o Agent/ })
    expect(back.getAttribute('aria-pressed')).toBe('false')
    expect(back.textContent).toBe('Você escolheu um arquivo · Seguir o Agent')
    // Ele começa a digitar outro arquivo: sem seguir, a aba escolhida fica.
    act(() => liveInput.push('a', { kind: 'tool-input-delta', toolUseId: 'w1', name: 'Write', filePath: P('src\\b.ts'), newText: 'b', totalLines: 1, done: false }))
    expect(screen.getByRole('tab', { name: 'total.ts, modificado' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /Seguir o Agent/ }))
    expect(screen.getByRole('tab', { name: 'b.ts, digitando' }).getAttribute('aria-selected')).toBe('true')
    // Setas no tablist trocam de aba (e param de seguir).
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'novo.ts, novo' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'novo.ts, novo' }))
  })

  it('arquivo grande: só as linhas à vista vão para o DOM, e rolar mostra as de baixo', async () => {
    const big = Array.from({ length: 5000 }, (_, i) => `const linha${i} = ${i}`)
    DISK[P('src\\grande.ts')] = big.join('\n')
    const e = tool('Edit', { file_path: P('src\\grande.ts'), old_string: 'const linha4990 = 0', new_string: 'const linha4990 = 4990' }, 'ok')
    render(ui(<CodeMonitor feed={feedOf([ask, e])} model={model()} />))
    await screen.findByLabelText('Código de grande.ts')
    await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0))
    expect(rows().length).toBeLessThan(120)
    const scroller = screen.getByLabelText('Código de grande.ts')
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 4985 * 19 })
    fireEvent.scroll(scroller)
    expect(rows().length).toBeLessThan(120)
    expect(rows().some((r) => show(r) === '4991+const linha4990 = 4990')).toBe(true)
    delete DISK[P('src\\grande.ts')]
  })

  it('código ao vivo chega no máximo 10 vezes por segundo à tela', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let commits = 0
    render(
      ui(
        <Profiler id="m" onRender={() => commits++}>
          <CodeMonitor feed={feedOf([ask])} model={model()} />
        </Profiler>
      )
    )
    const before = commits
    for (let i = 1; i <= 40; i++) {
      act(() => {
        liveInput.push('a', { kind: 'tool-input-delta', toolUseId: 'w2', name: 'Write', filePath: P('src\\c.ts'), newText: 'x'.repeat(i), totalLines: 1, done: false })
        vi.advanceTimersByTime(10)
      })
    }
    act(() => void vi.advanceTimersByTime(200))
    // 400 ms de pedaços a cada 10 ms: o 1º na hora e depois um a cada 100 ms (+ o último pendente).
    expect(commits - before).toBeLessThanOrEqual(6)
    expect(screen.getByRole('tabpanel').textContent).toContain('x'.repeat(40))
  })

  it('Código com o Chat à direita: o turno como o chat mostra; a raiz diz o que está à vista; no Contexto o Chat sai', () => {
    render(ui(<CodeMonitor feed={feedOf([ask, editTotal()])} model={model()} />))
    const root = screen.getByTestId('office-screen')
    const chat = screen.getByTestId('office-screen-chat')
    expect(root.dataset.kind).toBe('code')
    expect(chat.hidden).toBe(false)
    expect(chat.querySelector('.cm-chat-head')?.textContent).toContain('Chat')
    expect(chat.querySelector('.cm-chat-head')?.textContent).toContain('Agent principal')
    expect(chat.querySelector('.cm-chat-state')?.textContent).toBe('trabalhando')
    openSteps(chat) // o cartão fica atrás da linha-resumo da resposta (chat resumido)
    expect(chat.querySelector('.tool-card .tool-name')?.textContent).toBe('Edit')
    // Um cabeçalho só: o compacto do painel, sem o do turno.
    expect(chat.querySelector('.o3d-turn-head')).toBeNull()
    expect(screen.getByRole('tablist', { name: 'Arquivos abertos' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Contexto' }))
    expect([root.dataset.mode, root.dataset.kind]).toEqual(['ctx', 'context'])
    expect(screen.getByTestId('office-screen-chat').hidden).toBe(true)
    expect(screen.queryByRole('tablist', { name: 'Arquivos abertos' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Código' }))
    expect(root.dataset.kind).toBe('code')
  })

  it('disco: guarda por arquivo (voltar à aba não relê), relê quando chega resultado novo; erro de leitura não vira código', async () => {
    const reads = (rel: string): number => readFile.mock.calls.filter(([p]) => p === P(rel)).length
    const msgs = [ask, editTotal(), writeNovo()]
    const view = render(ui(<CodeMonitor feed={feedOf(msgs)} model={model()} />))
    await vi.waitFor(() => expect(rows().map(show)).toEqual(['1+export const novo = 1']))
    fireEvent.click(screen.getByRole('tab', { name: 'total.ts, modificado' }))
    await screen.findByText('soma com quantidade', { exact: false })
    fireEvent.click(screen.getByRole('tab', { name: 'novo.ts, novo' }))
    fireEvent.click(screen.getByRole('tab', { name: 'total.ts, modificado' }))
    expect([reads('src\\novo.ts'), reads('src\\total.ts')]).toEqual([1, 1])
    // Resultado novo no arquivo: relê — e a edição já aparece enquanto a releitura não volta.
    DISK[P('src\\total.ts')] = TOTAL.replace('// soma com quantidade', '// preço × quantidade')
    const again = tool('Edit', { file_path: P('src\\total.ts'), old_string: '  // soma com quantidade', new_string: '  // preço × quantidade' }, 'ok')
    view.rerender(ui(<CodeMonitor feed={feedOf([...msgs, again])} model={model()} />))
    expect(screen.getByRole('tabpanel').textContent).toContain('preço × quantidade')
    await vi.waitFor(() => expect(reads('src\\total.ts')).toBe(2))
    DISK[P('src\\total.ts')] = TOTAL
    // Erro do IPC: só os trechos e o aviso; a mensagem de erro não aparece como código.
    DISK[P('src\\trancado.ts')] = "Erro ao ler arquivo: Error: EACCES: permission denied, open 'x'"
    const locked = tool('Edit', { file_path: P('src\\trancado.ts'), old_string: 'a', new_string: 'b' }, 'ok')
    view.rerender(ui(<CodeMonitor feed={feedOf([...msgs, again, locked])} model={model()} />))
    fireEvent.click(screen.getByRole('tab', { name: 'trancado.ts, modificado' }))
    await vi.waitFor(() => expect(screen.getByRole('note').textContent).toContain('Não deu para ler o arquivo'))
    expect(rows().map(show)).toEqual(['Trecho 1 de 1', '−a', '+b'])
    expect(screen.getByRole('tabpanel').textContent).not.toContain('Erro ao ler arquivo')
    delete DISK[P('src\\trancado.ts')]
  })

  it('trocar o foco recomeça do zero: aba escolhida e seguir de um Agent não vazam para o outro (o app aberto é lembrado)', () => {
    const b = tool('Write', { file_path: P('src\\b.ts'), content: 'b' }, 'File created successfully at: x')
    const two = feed({
      conversations: [conv('a', { title: 'Carrinho', cwd: CWD, messages: [ask, editTotal(), writeNovo()] }), conv('b', { title: 'Outro', cwd: CWD, messages: [ask, b] })],
      busyIds: new Set(['a', 'b'])
    })
    const view = render(ui(<CodeMonitor feed={two} model={model()} />))
    fireEvent.click(screen.getByRole('tab', { name: 'total.ts, modificado' }))
    expect(screen.getByRole('button', { name: /Seguir o Agent/ }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Contexto' }))
    view.rerender(ui(<CodeMonitor feed={two} model={model({ key: 'conv:b', convId: 'b', seed: 'conv:b' })} />))
    // O último app usado vale para a próxima tela (localStorage); o resto recomeça.
    expect(screen.getByRole('button', { name: 'Contexto' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Código' }))
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'))).toEqual(['b.ts, novo'])
    expect(screen.getByRole('button', { name: /Seguindo o Agent/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('nada mexido ainda: a tela vazia diz o que vai aparecer e "Escrever no chat" põe o foco no campo do Chat ao lado', () => {
    render(ui(<CodeMonitor feed={feedOf([ask])} model={model({ label: 'Read src/a.ts' })} composer={<textarea aria-label="Mensagem" />} />))
    const root = screen.getByTestId('office-screen')
    expect(root.dataset.kind).toBe('empty')
    expect(root.textContent).toContain('Nenhum arquivo editado ainda')
    expect(root.textContent).toContain('Agora: Read src/a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Escrever no chat' }))
    expect(screen.getByRole('button', { name: 'Código' }).getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Mensagem' }))
  })
})
