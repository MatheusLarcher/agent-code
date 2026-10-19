import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { TarefaVista } from '@shared/tarefas'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { MessageList } from './MessageList'
import { _resetTarefasParaTeste } from './tarefas/useTarefas'

Element.prototype.scrollIntoView = vi.fn()

const tts = { speakingId: null, onToggleSpeak: (): void => {} }

function tarefa(over: Partial<TarefaVista> = {}): TarefaVista {
  return {
    id: 't1', tipo: 'monitor', titulo: 'Dólar abaixo de 5', mensagem: null, convId: 'c1', cwd: 'C:/x',
    agenda: { tipo: 'intervalo', intervaloMin: 2 }, estado: 'ativa', modelo: null, condicao: 'dólar < 5', combinado: null,
    criadaPor: 'pc', criadaEm: '2026-10-19T14:00:00Z', atualizadaEm: '2026-10-19T14:00:00Z', proximaEm: '2026-10-19T14:02:00Z',
    ultimaEm: null, ultimoResultado: null, ultimoValor: null, avisadoValor: null, falhasSeguidas: 0, bateuNaoVistoEm: null,
    rodando: false, rodadas: [], ...over
  }
}

function msgs(n: number): UIMessage[] {
  return Array.from({ length: n }, (_, i) => ({ kind: 'user', id: `u${i}`, text: `Mensagem ${i}` }))
}

let mudou: ((t: TarefaVista[]) => void) | null = null
function apiCom(lista: TarefaVista[]): void {
  _resetTarefasParaTeste()
  ;(window as unknown as { api: unknown }).api = {
    tarefasList: vi.fn(async () => lista),
    onTarefasChanged: vi.fn((cb: (t: TarefaVista[]) => void) => {
      mudou = cb
      return () => undefined
    }),
    tarefasAcao: vi.fn(async () => ({ ok: true, valor: null }))
  }
}

afterEach(() => {
  cleanup()
  _resetTarefasParaTeste()
  delete (window as unknown as { api?: unknown }).api
  mudou = null
})

function montar(convId: string): ReturnType<typeof render> {
  return render(
    <UiProvider>
      <MessageList convId={convId} messages={msgs(3)} busy={false} tts={tts} onRetry={() => {}} />
    </UiProvider>
  )
}

describe('MessageList — bolinha de tarefas', () => {
  it('com tarefa na conversa: bolinha no wrap e o "ir para o final" sobe (com-tarefas)', async () => {
    apiCom([tarefa()])
    const view = montar('c1')
    await waitFor(() => expect(view.container.querySelector('.tdot')).not.toBeNull())
    const wrap = view.container.querySelector('.message-list-wrap')!
    expect(wrap.classList.contains('com-tarefas')).toBe(true)
    // O "ir para o final" aparece no mesmo wrap (a regra CSS o sobe para cima da bolinha).
    const list = view.container.querySelector<HTMLElement>('.message-list')!
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 2_000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 0 }
    })
    fireEvent.scroll(list)
    expect(wrap.querySelector(':scope > .jump-bottom')).not.toBeNull()
  })

  it('tarefa de outra conversa: nada; a bolinha some quando a última sai', async () => {
    apiCom([tarefa({ convId: 'outra' })])
    const view = montar('c1')
    await act(async () => undefined)
    expect(view.container.querySelector('.tdot')).toBeNull()
    expect(view.container.querySelector('.message-list-wrap')!.classList.contains('com-tarefas')).toBe(false)

    act(() => mudou?.([tarefa()]))
    expect(view.container.querySelector('.tdot')).not.toBeNull()
    act(() => mudou?.([]))
    expect(view.container.querySelector('.tdot')).toBeNull()
  })

  it('sem window.api (celular, escritório): não quebra e não mostra nada', () => {
    _resetTarefasParaTeste()
    const view = montar('c1')
    expect(view.container.querySelector('.tdot')).toBeNull()
  })

  it('remontar a conversa mantém a bolinha (a lista é do app, não do componente)', async () => {
    apiCom([tarefa()])
    const view = montar('c1')
    await waitFor(() => expect(view.container.querySelector('.tdot')).not.toBeNull())
    view.unmount()
    const outra = montar('c1')
    expect(outra.container.querySelector('.tdot')).not.toBeNull()
  })
})
