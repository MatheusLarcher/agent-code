import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { NewPlanningDialog } from './NewPlanningDialog'
import { CWD, makePlan } from './planningTestUtils'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Título do roteiro de cada plano "em disco" (o que o planningOpen devolve). */
const TITULOS: Record<string, string> = { checkout: 'Checkout com Pix', login: 'Login com SSO', rascunho: 'Sem nome' }

function mockApi(slugs: string[] = ['checkout', 'login']) {
  const api = {
    planningList: vi.fn(async () => ({ ok: true as const, slugs })),
    planningCreate: vi.fn(async (req: { slug: string }) => ({ ok: true as const, plan: makePlan({ slug: req.slug }) })),
    planningOpen: vi.fn(async (req: { projectCwd: string; slug: string }) => ({
      ok: true as const,
      plan: makePlan({ slug: req.slug, roteiro: { titulo: TITULOS[req.slug] ?? '', rev: 1, etapas: [] } })
    })),
    planningClose: vi.fn(async () => ({ ok: true as const }))
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

function renderDialog() {
  const onOpen = vi.fn()
  const onClose = vi.fn()
  const view = render(
    <UiProvider>
      <NewPlanningDialog projectCwd={CWD} projectName="app" onOpen={onOpen} onClose={onClose} />
    </UiProvider>
  )
  return { onOpen, onClose, unmount: view.unmount }
}

/** Só o relógio é falso: os timers de verdade seguem para o findBy/waitFor. */
function freezeClock(at: Date): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(at)
}

const createButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Criar planejamento' }) as HTMLButtonElement

describe('NewPlanningDialog', () => {
  it('lista os planejamentos da pasta e reabre um deles com o título do roteiro (não o slug)', async () => {
    const api = mockApi()
    const { onOpen } = renderDialog()
    expect(api.planningList).toHaveBeenCalledWith({ projectCwd: CWD })
    fireEvent.click(await screen.findByRole('button', { name: /login/ }))
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1))
    expect(onOpen).toHaveBeenCalledWith('login', 'Login com SSO')
    expect(api.planningOpen).toHaveBeenCalledWith({ projectCwd: CWD, slug: 'login' })
    // A vigia aberta aqui fica para a tela que abre em seguida.
    expect(api.planningClose).not.toHaveBeenCalled()
    expect(api.planningCreate).not.toHaveBeenCalled()
  })

  it('reabrir um plano "Sem nome": a conversa recebe "Sem nome" (entra no título automático)', async () => {
    mockApi(['rascunho'])
    const { onOpen } = renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: /rascunho/ }))
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('rascunho', 'Sem nome'))
  })

  it('plano ilegível ao reabrir: abre assim mesmo, sem título (fica o slug)', async () => {
    const api = mockApi()
    api.planningOpen.mockResolvedValueOnce({ ok: false, code: 'invalid', message: 'roteiro quebrado' } as never)
    const { onOpen } = renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: /login/ }))
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1))
    expect(onOpen.mock.calls[0]).toEqual(['login', undefined])
  })

  it('enquanto lê o título, nada mais dispara; fechar no meio não abre nada', async () => {
    const api = mockApi()
    let release: () => void = () => {}
    api.planningOpen.mockImplementationOnce(
      (req) =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true as const, plan: makePlan({ slug: req.slug }) })
        })
    )
    const { onOpen, unmount } = renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: /login/ }))
    expect(await screen.findByText('Abrindo…')).toBeTruthy()
    expect(createButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /checkout/ }))
    expect(api.planningOpen).toHaveBeenCalledTimes(1)

    unmount() // Esc/Cancelar: o App desmonta o diálogo
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('não pede nome: nenhum campo de título no diálogo', async () => {
    mockApi()
    renderDialog()
    await screen.findByRole('button', { name: /checkout/ })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByLabelText('Título')).toBeNull()
  })

  it('criar: "Sem nome" numa pasta plano-AAAAMMDD-HHMM e abre na hora', async () => {
    freezeClock(new Date(2026, 8, 22, 14, 30))
    const api = mockApi([])
    const { onOpen } = renderDialog()
    await screen.findByText('Nenhum planejamento ainda.')
    fireEvent.click(createButton())
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('plano-20260922-1430', 'Sem nome'))
    expect(api.planningCreate).toHaveBeenCalledWith({ projectCwd: CWD, slug: 'plano-20260922-1430', titulo: 'Sem nome' })
  })

  it('o slug gerado é único contra os planos da pasta (-2, -3)', async () => {
    freezeClock(new Date(2026, 8, 22, 14, 30))
    const api = mockApi(['plano-20260922-1430', 'plano-20260922-1430-2'])
    const { onOpen } = renderDialog()
    await screen.findByRole('button', { name: /plano-20260922-1430-2/ })
    fireEvent.click(createButton())
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('plano-20260922-1430-3', 'Sem nome'))
    expect(api.planningCreate).toHaveBeenCalledWith(expect.objectContaining({ slug: 'plano-20260922-1430-3' }))
  })

  it('enquanto a lista carrega, criar fica desabilitado (evita colidir)', async () => {
    const api = mockApi()
    let release: () => void = () => {}
    api.planningList.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ ok: true as const, slugs: [] })))
    )
    renderDialog()
    expect(createButton().disabled).toBe(true)
    release()
    await waitFor(() => expect(createButton().disabled).toBe(false))
  })

  it('falha do main vira toast de erro e o diálogo continua aberto', async () => {
    const api = mockApi([])
    api.planningCreate.mockResolvedValueOnce({ ok: false, code: 'invalid', message: 'planejamento já existe: x' } as never)
    const { onOpen } = renderDialog()
    await screen.findByText('Nenhum planejamento ainda.')
    fireEvent.click(createButton())
    expect(await screen.findByText('Não consegui criar o planejamento: planejamento já existe: x')).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(createButton().disabled).toBe(false)
  })

  it('erro ao listar vira toast', async () => {
    const api = mockApi()
    api.planningList.mockRejectedValueOnce(new Error('canal fechado'))
    renderDialog()
    expect(await screen.findByText('Não consegui listar os planejamentos: canal fechado')).toBeTruthy()
  })

  it('Esc fecha', async () => {
    mockApi()
    const { onClose } = renderDialog()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    await screen.findByRole('button', { name: /checkout/ })
  })
})
