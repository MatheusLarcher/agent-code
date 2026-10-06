import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { OfficeCharacterModel } from '../../office/adapter/model'
import { conv, feed } from '../../office/adapter/testFeed'
import { liveInput } from '../../office/liveInput'
import type { UIMessage } from '../../types'
import { UiProvider } from '../../ui/UiProvider'
import { CodeMonitor } from './CodeMonitor'

const CWD = 'C:\\proj\\loja'
const P = (rel: string): string => `${CWD}\\${rel}`
const SIX = ['um', 'dois', 'três', 'quatro', 'cinco', 'seis'].join('\r\n') + '\r\n'
const model: OfficeCharacterModel = {
  key: 'conv:a', convId: 'a', roomId: 'c:/proj/loja', role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
  seed: 'conv:a', active: true, activity: null, bubble: null, label: 'x'
}
let seq = 0
const tool = (name: string, input: unknown, result = 'ok', m?: string): UIMessage =>
  ({ kind: 'tool-use', id: `r${seq++}`, name, input, parentToolUseId: null, result: { isError: false, text: result }, ...(m ? { model: m } : {}) }) as UIMessage
const ask: UIMessage = { kind: 'user', id: 'u', text: 'olha o código' }
const feedOf = (messages: UIMessage[]) => feed({ conversations: [conv('a', { title: 'Loja', cwd: CWD, messages })], busyIds: new Set(['a']) })
const ui = (messages: UIMessage[]): JSX.Element => (
  <UiProvider>
    <CodeMonitor feed={feedOf(messages)} model={model} />
  </UiProvider>
)
const rows = (): string[] =>
  [...screen.getByRole('tabpanel').querySelectorAll<HTMLElement>('.cm-row')].map((r) =>
    r.classList.contains('cm-hunk') ? `[${r.querySelector('.cm-hunk-label')?.textContent}]` : `${r.querySelector('.cm-num')?.textContent} ${r.querySelector('.cm-code')?.textContent}`
  )

let readFile: ReturnType<typeof vi.fn>
beforeEach(() => {
  localStorage.clear()
  readFile = vi.fn(async (p: string) => (p === P('src\\total.ts') ? SIX : `Erro ao ler arquivo: Error: ENOENT: no such file or directory, open '${p}'`))
  ;(window as unknown as { api: unknown }).api = { readFile }
})
afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('CodeMonitor — arquivos lidos', () => {
  it('Explorador com Alterados e Lidos; o lido abre na aba de prévia (itálico), só as linhas lidas, somente leitura', async () => {
    render(ui([ask, tool('Edit', { file_path: P('src\\a.ts'), old_string: 'x', new_string: 'y' }), tool('Read', { file_path: P('src\\total.ts'), offset: 3, limit: 2 })]))
    const explorer = screen.getByRole('navigation', { name: /Explorador/ })
    expect([...explorer.querySelectorAll('.cm-section')].map((s) => s.textContent)).toEqual(['Alterados1', 'Lidos1'])
    expect(explorer.querySelector('.cm-file.read .cm-file-range')?.textContent).toBe('3–4')
    // Seguindo o Agent: a última coisa que ele fez foi ler — a prévia está à vista.
    const pv = screen.getByRole('tab', { name: 'total.ts, lido' })
    expect([pv.classList.contains('cm-tab-pv'), pv.getAttribute('aria-selected')]).toEqual([true, 'true'])
    await vi.waitFor(() => expect(rows()).toEqual(['[linhas 1–2 não lidas]', '3 três', '4 quatro', '[linhas 5–6 não lidas]']))
    const status = screen.getByTestId('office-screen').querySelector('.cm-statusbar')!.textContent
    expect(status).toContain('Somente leitura · leu as linhas 3–4 de 6')
    expect(status).toContain('1 arquivo alterado · 1 lido')
    expect(screen.getByRole('tabpanel').querySelector('.cm-add, .cm-del')).toBeNull()
  })

  it('a próxima leitura troca a aba de prévia (uma só); lido e depois alterado fica só em Alterados', () => {
    const view = render(ui([ask, tool('Read', { file_path: P('src\\total.ts') }), tool('Read', { file_path: P('src\\b.ts') })]))
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'))).toEqual(['b.ts, lido'])
    view.rerender(ui([ask, tool('Read', { file_path: P('src\\total.ts') }), tool('Edit', { file_path: P('src\\total.ts'), old_string: 'um', new_string: 'UM' })]))
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'))).toEqual(['total.ts, modificado'])
    expect(screen.getByRole('navigation', { name: /Explorador/ }).querySelectorAll('.cm-file.read')).toHaveLength(0)
  })

  it('arquivo sensível nunca abre; fora do projeto, o texto do próprio Read quando chegou inteiro', async () => {
    const view = render(ui([ask, tool('Read', { file_path: P('.env') }, '1→SEGREDO=1')]))
    expect(screen.getByRole('note').textContent).toContain('Arquivo sensível')
    expect(screen.getByRole('tabpanel').textContent).not.toContain('SEGREDO')
    expect(readFile).not.toHaveBeenCalled()
    view.rerender(ui([ask, tool('Read', { file_path: 'D:\\mem\\nota.md', offset: 1, limit: 2 }, '     1→# Nota\n     2→texto')]))
    await vi.waitFor(() => expect(rows()).toEqual(['1 # Nota', '2 texto', '[o resto do arquivo não foi lido]']))
    expect(readFile).not.toHaveBeenCalledWith('D:\\mem\\nota.md')
  })

  it('seguir o Agent inclui leituras; digitando, o arquivo digitado vence; clicar num lido para de seguir', () => {
    render(ui([ask, tool('Edit', { file_path: P('src\\a.ts'), old_string: 'x', new_string: 'y' }), tool('Read', { file_path: P('src\\total.ts') })]))
    expect(screen.getByRole('tab', { name: 'total.ts, lido' }).getAttribute('aria-selected')).toBe('true')
    act(() => liveInput.push('a', { kind: 'tool-input-delta', toolUseId: 'w', name: 'Write', filePath: P('src\\c.ts'), newText: 'x', totalLines: 1, done: false }))
    expect(screen.getByRole('tab', { name: 'c.ts, digitando' }).getAttribute('aria-selected')).toBe('true')
    act(() => liveInput.push('a', { kind: 'tool-input-delta', toolUseId: 'w', name: 'Write', filePath: P('src\\c.ts'), newText: 'x', totalLines: 1, done: true }))
    fireEvent.click(screen.getByRole('button', { name: 'total.ts, lido' }))
    expect(screen.getByRole('button', { name: /Seguir o Agent/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('modelo: no rodapé a sequência do turno; etiqueta por arquivo só num turno misto, e a dica sempre diz quem fez', () => {
    const view = render(ui([ask, tool('Edit', { file_path: P('src\\a.ts'), old_string: 'x', new_string: 'y' }, 'ok', 'claude-opus-5-5')]))
    const status = (): string => screen.getByTestId('office-screen').querySelector('.cm-statusbar')!.textContent ?? ''
    expect(status()).toContain('Opus 5.5')
    expect(document.querySelectorAll('.cm-explorer .cm-mt')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'a.ts, modificado' }).getAttribute('title')).toContain('feito por Opus 5.5')
    view.rerender(ui([ask, tool('Edit', { file_path: P('src\\a.ts'), old_string: 'x', new_string: 'y' }, 'ok', 'claude-opus-5-5'), tool('Read', { file_path: P('src\\total.ts') }, 'ok', 'gpt-6.1-sol')]))
    expect(status()).toContain('Opus 5.5 → GPT-6.1 Sol')
    expect([...document.querySelectorAll('.cm-explorer .cm-mt')].map((t) => t.textContent)).toEqual(['Opus', 'Sol'])
    expect(status()).not.toContain('Automático')
  })

  it('conversa antiga, sem modelo nos eventos: abre sem erro e sem modelo nenhum', () => {
    const old = feed({ conversations: [conv('a', { title: 'Loja', cwd: CWD, messages: [ask, tool('Edit', { file_path: P('src\\a.ts'), old_string: 'x', new_string: 'y' })] })], busyIds: new Set() })
    render(
      <UiProvider>
        <CodeMonitor feed={old} model={model} />
      </UiProvider>
    )
    expect(screen.getByTestId('office-screen').querySelector('.cm-sb-model')).toBeNull()
    expect(document.querySelectorAll('.cm-mt')).toHaveLength(0)
  })
})

describe('CodeMonitor — Chat (à direita do editor)', () => {
  it('a troca de modelo aparece no ponto da troca com "A → B" e o motivo; o anúncio do Automático continua nota; o app "chat" lembrado de antes abre no Código', () => {
    localStorage.setItem('agentcode.monitor.app', 'chat')
    const msgs: UIMessage[] = [
      ask,
      { kind: 'provider-switch', id: 'auto1', fromModel: 'auto', model: 'claude-opus-5-5', fastMode: false, text: 'Automático: Opus 5.5, esforço alto.' },
      tool('Bash', { command: 'npm run typecheck' }),
      { kind: 'provider-switch', id: 'sw1', fromModel: 'claude-opus-5-5', model: 'gpt-6.1-sol', fastMode: false, text: 'O limite de uso de claude-opus-5-5 foi atingido.' },
      tool('Bash', { command: 'npx vitest run' })
    ]
    render(ui(msgs))
    expect(screen.getByTestId('office-screen').dataset.mode).toBe('code')
    const note = screen.getByTestId('office-screen-chat').querySelector('.o3d-model-switch')!
    expect(note.textContent).toContain('Trocou de modelo: Opus 5.5 → GPT-6.1 Sol')
    expect(note.textContent).toContain('O limite de uso de claude-opus-5-5 foi atingido.')
    expect(screen.getByTestId('office-screen').querySelectorAll('.o3d-model-switch')).toHaveLength(1)
    expect(screen.getByTestId('office-screen').textContent).toContain('Automático: Opus 5.5, esforço alto.')
  })
})
