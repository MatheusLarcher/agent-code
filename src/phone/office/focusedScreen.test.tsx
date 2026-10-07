/**
 * A tela focada do monitor (CodeMonitor do PC) no celular: sem o UiProvider do
 * PC — com o PhoneUiProvider e o window.api da ponte — abre, mostra os cartões
 * de ferramenta e fecha no ×; o "Baixar" vai pela ponte; e qualquer falha no
 * Escritório vira aviso com "Voltar" (OfficeBoundary), nunca tela preta.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { OfficeCharacterModel } from '@renderer/office/adapter/model'
import { conv, feed } from '@renderer/office/adapter/testFeed'
import { CodeMonitor } from '@renderer/office3d/codeScreen/CodeMonitor'
import type { UIMessage } from '@renderer/types'
import { useUI } from '@renderer/ui/UiProvider'
import { toasts } from '../app/runtime'
import { bridgeApi } from './bridgeApi'
import { OfficeBoundary } from './OfficeBoundary'
import { PhoneUiProvider } from './PhoneUiProvider'

const download = vi.hoisted(() => vi.fn())
vi.mock('../core/download', () => ({ triggerDownload: download }))

const CWD = 'C:\\proj\\loja'
const model: OfficeCharacterModel = {
  key: 'conv:a', convId: 'a', roomId: 'c:/proj/loja', role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
  seed: 'conv:a', active: true, activity: null, bubble: null, label: 'Edit a.ts'
}
const tool = (id: string, name: string, input: unknown): UIMessage => ({ kind: 'tool-use', id, name, input, parentToolUseId: null, result: { isError: false, text: 'ok' } })
const messages: UIMessage[] = [
  { kind: 'user', id: 'u', text: 'gera o apk' },
  tool('e1', 'Edit', { file_path: `${CWD}\\src\\a.ts`, old_string: 'const a = 0', new_string: 'const a = 1' }),
  tool('w1', 'Write', { file_path: `${CWD}\\out\\loja.apk`, content: 'x' })
]
const officeFeed = feed({ conversations: [conv('a', { title: 'Loja', cwd: CWD, messages })], busyIds: new Set(['a']) })
const client = { url: (p: string) => `http://pc${p}`, fileUrl: (p: string) => `http://pc/api/file?path=${encodeURIComponent(p)}` }

beforeEach(() => {
  localStorage.clear()
  toasts.set({ list: [] })
  // O celular: só o que a ponte serve (sem readFile, sem projectDir).
  ;(window as unknown as { api: unknown }).api = bridgeApi(client)
})
afterEach(() => {
  cleanup()
  download.mockReset()
  delete (window as unknown as { api?: unknown }).api
})

/** Abre as linhas-resumo recolhidas do Chat (o chat resumido por resposta), se houver: os cartões ficam à vista. */
function openSteps(): void {
  for (const b of screen.getByTestId('office-screen-chat').querySelectorAll<HTMLElement>('.chat-step button[aria-expanded="false"]')) fireEvent.click(b)
}

describe('tela focada do monitor no celular', () => {
  it('sem provider nenhum o ToolCard lança (a causa da tela preta)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => {
      render(<CodeMonitor feed={officeFeed} model={model} />)
      openSteps()
    }).toThrow(/UiProvider/)
    vi.mocked(console.error).mockRestore()
  })

  it('com o PhoneUiProvider abre com os cartões, sem "Todos os arquivos", e fecha no ×', () => {
    const onClose = vi.fn()
    render(
      <PhoneUiProvider>
        <CodeMonitor feed={officeFeed} model={model} onClose={onClose} />
      </PhoneUiProvider>
    )
    openSteps()
    expect(screen.getByTestId('office-screen')).toBeTruthy()
    expect(screen.getByTestId('office-screen-chat').querySelectorAll('.tool-card').length).toBeGreaterThan(0)
    // Sem window.api.projectDir não há a árvore do projeto (o botão "Apenas usados" some).
    expect(screen.queryByRole('button', { name: /Apenas usados/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Fechar a tela' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('"Baixar" do cartão vai pela ponte (/api/file) e avisa no celular', async () => {
    render(
      <PhoneUiProvider>
        <CodeMonitor feed={officeFeed} model={model} />
      </PhoneUiProvider>
    )
    openSteps()
    const baixar = screen.getByTestId('office-screen-chat').querySelector<HTMLElement>('.tool-download[title="Baixar arquivo"]')!
    await act(async () => {
      fireEvent.click(baixar)
    })
    expect(download).toHaveBeenCalledWith(client.fileUrl(`${CWD}\\out\\loja.apk`), `${CWD}\\out\\loja.apk`)
    expect(toasts.get().list.map((t) => [t.tipo, t.text])).toEqual([['sucesso', 'Baixando loja.apk…']])
  })
})

describe('PhoneUiProvider', () => {
  function Asker({ onAnswer }: { onAnswer: (ok: boolean) => void }): JSX.Element {
    const { confirm, notify } = useUI()
    return (
      <>
        <button type="button" onClick={() => void confirm({ title: 'Apagar?', message: 'Some de vez.', confirmLabel: 'Apagar', danger: true }).then(onAnswer)}>perguntar</button>
        <button type="button" onClick={() => notify('erro', 'deu ruim')}>avisar</button>
      </>
    )
  }

  it('confirm abre a folha e resolve com a escolha; notify vira o aviso do celular', async () => {
    const onAnswer = vi.fn()
    render(
      <PhoneUiProvider>
        <Asker onAnswer={onAnswer} />
      </PhoneUiProvider>
    )
    fireEvent.click(screen.getByText('perguntar'))
    expect(screen.getByRole('dialog', { name: 'Apagar?' }).textContent).toContain('Some de vez.')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apagar' }))
    })
    expect(onAnswer).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByText('perguntar'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    })
    expect(onAnswer).toHaveBeenLastCalledWith(false)
    fireEvent.click(screen.getByText('avisar'))
    expect(toasts.get().list.map((t) => [t.tipo, t.text])).toEqual([['erro', 'deu ruim']])
  })
})

describe('OfficeBoundary', () => {
  it('a falha vira aviso com "Voltar", que remonta o escritório', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let boom = true
    function Office(): JSX.Element {
      if (boom) throw new Error('useUI deve ser usado dentro de <UiProvider>')
      return <p>escritório ok</p>
    }
    render(
      <OfficeBoundary>
        <Office />
      </OfficeBoundary>
    )
    expect(screen.getByRole('alert').textContent).toContain('O Escritório falhou: useUI deve ser usado dentro de <UiProvider>')
    boom = false
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }))
    expect(screen.getByText('escritório ok')).toBeTruthy()
    vi.mocked(console.error).mockRestore()
  })
})
