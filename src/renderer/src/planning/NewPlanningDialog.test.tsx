import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { NewPlanningDialog } from './NewPlanningDialog'
import { CWD, makePlan } from './planningTestUtils'

afterEach(cleanup)

function mockApi(slugs: string[] = ['checkout', 'login']) {
  const api = {
    planningList: vi.fn(async () => ({ ok: true as const, slugs })),
    planningCreate: vi.fn(async (req: { slug: string }) => ({ ok: true as const, plan: makePlan({ slug: req.slug }) }))
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

function renderDialog() {
  const onOpen = vi.fn()
  const onClose = vi.fn()
  render(
    <UiProvider>
      <NewPlanningDialog projectCwd={CWD} projectName="app" onOpen={onOpen} onClose={onClose} />
    </UiProvider>
  )
  return { onOpen, onClose }
}

const titleInput = (): HTMLInputElement => screen.getByLabelText('Título') as HTMLInputElement

describe('NewPlanningDialog', () => {
  it('lista os planejamentos da pasta e reabre um deles', async () => {
    const api = mockApi()
    const { onOpen } = renderDialog()
    expect(api.planningList).toHaveBeenCalledWith({ projectCwd: CWD })
    fireEvent.click(await screen.findByRole('button', { name: /login/ }))
    expect(onOpen).toHaveBeenCalledWith('login')
    expect(api.planningCreate).not.toHaveBeenCalled()
  })

  it('deriva o slug do título, sem acento e único contra a pasta (-2)', async () => {
    mockApi()
    renderDialog()
    await screen.findByRole('button', { name: /checkout/ })
    fireEvent.change(titleInput(), { target: { value: 'Checkout' } })
    expect(screen.getByTestId('pl-new-slug').textContent).toBe('docs/spec/checkout-2/')
    fireEvent.change(titleInput(), { target: { value: 'Integração: Pix & Cartão' } })
    expect(screen.getByTestId('pl-new-slug').textContent).toBe('docs/spec/integracao-pix-cartao/')
  })

  it('criar chama planningCreate e abre o plano novo com o título', async () => {
    const api = mockApi()
    const { onOpen } = renderDialog()
    await screen.findByRole('button', { name: /checkout/ })
    fireEvent.change(titleInput(), { target: { value: 'Checkout' } })
    fireEvent.click(screen.getByRole('button', { name: 'Criar planejamento' }))
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('checkout-2', 'Checkout'))
    expect(api.planningCreate).toHaveBeenCalledWith({ projectCwd: CWD, slug: 'checkout-2', titulo: 'Checkout' })
  })

  it('título sem letra nem número não cria', async () => {
    mockApi([])
    renderDialog()
    await screen.findByText('Nenhum planejamento ainda.')
    fireEvent.change(titleInput(), { target: { value: '???' } })
    expect((screen.getByRole('button', { name: 'Criar planejamento' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Use ao menos uma letra ou número no título.')).toBeTruthy()
  })

  it('falha do main vira toast de erro e o diálogo continua aberto', async () => {
    const api = mockApi([])
    api.planningCreate.mockResolvedValueOnce({ ok: false, code: 'invalid', message: 'planejamento já existe: x' } as never)
    const { onOpen } = renderDialog()
    await screen.findByText('Nenhum planejamento ainda.')
    fireEvent.change(titleInput(), { target: { value: 'X' } })
    fireEvent.click(screen.getByRole('button', { name: 'Criar planejamento' }))
    expect(await screen.findByText('Não consegui criar o planejamento: planejamento já existe: x')).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
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
