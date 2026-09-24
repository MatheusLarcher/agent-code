import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { PlanMediaDto } from '@shared/ipc'
import { UiProvider } from '../ui/UiProvider'
import { PlanningScreen } from './PlanningScreen'
import { clearThumbCache } from './mediaView'
import { toCardDto } from './usePlanning'
import { CWD, PLAN_DIR, SLUG, makeCard, makePlan, mockPlanningApi, stubResizeObserver } from './planningTestUtils'

beforeAll(stubResizeObserver)
beforeEach(() => {
  localStorage.clear()
  clearThumbCache()
})
afterEach(async () => {
  cleanup()
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5))
  })
  vi.restoreAllMocks()
})

const media = (name: string, kind: PlanMediaDto['kind'] = 'imagem', mediaType = 'image/png'): PlanMediaDto => ({
  name,
  path: `${PLAN_DIR}\\midia\\${name}`,
  kind,
  size: 10,
  mediaType
})

/** window.api com a mídia: getPathForFile, importMedia devolvendo `imported` e openInFolder. */
function mockWithMedia(plan = makePlan(), imported: PlanMediaDto[] = [media('a1b2c3-foto.png')], paths: Record<string, string> = {}) {
  const m = mockPlanningApi(plan)
  const api = m.api as typeof m.api & Record<string, unknown>
  api.planningImportMedia.mockImplementation((async () => ({ ok: true as const, media: imported })) as never)
  api.getPathForFile = vi.fn((f: File) => paths[f.name] ?? '')
  api.openInFolder = vi.fn(async () => ({ ok: true, message: 'Abrindo…' }))
  return { ...m, api }
}

function renderScreen() {
  return render(
    <UiProvider>
      <PlanningScreen projectCwd={CWD} slug={SLUG} />
    </UiProvider>
  )
}

function dropOn(el: Element, files: File[]): void {
  fireEvent.drop(el, { dataTransfer: { types: ['Files'], files, items: [] }, clientX: 10, clientY: 10 })
}

describe('toCardDto', () => {
  it('leva os anexos (sem repetir); sem anexos, nem a chave', () => {
    expect(toCardDto(makeCard('x', { anexos: ['a1b2c3-a.png', 'a1b2c3-a.png'] })).anexos).toEqual(['a1b2c3-a.png'])
    expect('anexos' in toCardDto(makeCard('x', { anexos: [] }))).toBe(false)
  })
})

describe('Tela de Planejamento — mídia no canvas', () => {
  it('soltar arquivo do Explorer em área vazia importa POR CAMINHO e cria card de mídia', async () => {
    const { api } = mockWithMedia(makePlan(), [media('a1b2c3-foto.png')], { 'foto.png': 'C:\\Users\\m\\foto.png' })
    const { container } = renderScreen()
    await screen.findByTestId('pl-card-login')
    const canvas = container.querySelector('.pl-canvas')!
    fireEvent.dragEnter(canvas, { dataTransfer: { types: ['Files'] } })
    expect(canvas.classList.contains('pl-dropping')).toBe(true)
    dropOn(canvas, [new File(['x'], 'foto.png', { type: 'image/png' })])
    expect(canvas.classList.contains('pl-dropping')).toBe(false)
    await waitFor(() => expect(api.planningSaveCard).toHaveBeenCalledTimes(1))
    expect(api.planningImportMedia).toHaveBeenCalledWith({ projectCwd: CWD, slug: SLUG, files: [{ path: 'C:\\Users\\m\\foto.png' }] })
    expect(api.planningSaveCard.mock.calls[0][0]).toMatchObject({
      expectedRev: 0,
      card: { tipo: 'midia', titulo: 'Foto', anexos: ['a1b2c3-foto.png'] }
    })
    expect(await screen.findByText('Card de mídia "Foto" criado')).toBeTruthy()
  })

  it('soltar em cima de um card anexa a ele, com o rev do card', async () => {
    const { api } = mockWithMedia(makePlan(), [media('d4e5f6-fluxo.pdf', 'pdf', 'application/pdf')], { 'fluxo.pdf': 'C:\\fluxo.pdf' })
    renderScreen()
    const card = await screen.findByTestId('pl-card-login')
    dropOn(within(card).getByText('Login com SSO'), [new File(['x'], 'fluxo.pdf', { type: 'application/pdf' })])
    await waitFor(() => expect(api.planningSaveCard).toHaveBeenCalledTimes(1))
    expect(api.planningSaveCard.mock.calls[0][0]).toMatchObject({ expectedRev: 4, card: { id: 'login', anexos: ['d4e5f6-fluxo.pdf'] } })
    expect(await screen.findByText('Arquivo anexado a "Login com SSO"')).toBeTruthy()
    // O nó passa a mostrar a etiqueta do anexo (PDF não tem miniatura).
    await waitFor(() => expect(within(screen.getByTestId('pl-card-login')).getByText('fluxo.pdf')).toBeTruthy())
  })

  it('importação recusada vira toast de erro e nada é gravado', async () => {
    const { api } = mockWithMedia(makePlan(), [], { 'a.png': 'C:\\a.png' })
    api.planningImportMedia.mockResolvedValueOnce({ ok: false, code: 'invalid', message: 'arquivo grande demais' } as never)
    const { container } = renderScreen()
    await screen.findByTestId('pl-card-login')
    dropOn(container.querySelector('.pl-canvas')!, [new File(['x'], 'a.png', { type: 'image/png' })])
    expect(await screen.findByText('Não consegui importar: arquivo grande demais')).toBeTruthy()
    expect(api.planningSaveCard).not.toHaveBeenCalled()
  })

  it('Ctrl+V com imagem fora de campo de texto cria card de mídia com a imagem em base64', async () => {
    const { api } = mockWithMedia(makePlan(), [media('a1b2c3-colada.png')])
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    renderScreen()
    await screen.findByTestId('pl-card-login')
    const img = new File([new Uint8Array([104, 105])], 'image.png', { type: 'image/png' })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { types: ['Files'], files: [img], items: [] } })
    act(() => void document.body.dispatchEvent(paste))
    expect(paste.defaultPrevented).toBe(true)
    await waitFor(() => expect(api.planningSaveCard).toHaveBeenCalledTimes(1))
    const sent = (api.planningImportMedia.mock.calls[0] as unknown as [{ files: unknown[] }])[0].files
    expect(sent).toEqual([{ name: expect.stringMatching(/^colada-\d{8}-\d{6}\.png$/), data: 'aGk=' }])
    expect(api.planningSaveCard.mock.calls[0][0]).toMatchObject({ expectedRev: 0, card: { tipo: 'midia' } })
    // Colar numa caixa de texto é colar texto.
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    const typed = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(typed, 'clipboardData', { value: { types: ['Files'], files: [img], items: [] } })
    ta.dispatchEvent(typed)
    expect(typed.defaultPrevented).toBe(false)
    ta.remove()
  })

  it('imagem anexada vira miniatura (data URL do readMedia); o resto vira etiqueta', async () => {
    const plan = makePlan({
      cards: [makeCard('tela', { tipo: 'midia', titulo: 'Tela', anexos: ['a1b2c3-tela.png', 'd4e5f6-fluxo.pdf'] })],
      media: [media('a1b2c3-tela.png'), media('d4e5f6-fluxo.pdf', 'pdf', 'application/pdf')]
    })
    const { api } = mockWithMedia(plan)
    api.planningReadMedia.mockImplementation((async () => ({ ok: true, mediaType: 'image/png', base64: 'aGk=', size: 2 })) as never)
    renderScreen()
    const node = await screen.findByTestId('pl-card-tela')
    const img = (await within(node).findByAltText('tela.png')) as HTMLImageElement
    expect(img.src).toBe('data:image/png;base64,aGk=')
    expect(within(node).getByText('fluxo.pdf')).toBeTruthy()
    expect(api.planningReadMedia).toHaveBeenCalledWith({ projectCwd: CWD, slug: SLUG, name: 'a1b2c3-tela.png' })
    expect(api.planningReadMedia).toHaveBeenCalledTimes(1) // o PDF não é lido
  })

  it('Abrir no editor abre o arquivo no app padrão; programa abre a pasta e avisa', async () => {
    const plan = makePlan({
      cards: [makeCard('k', { titulo: 'Kit', anexos: ['a1b2c3-manual.pdf', 'a1b2c3-setup.exe'] })],
      media: [media('a1b2c3-manual.pdf', 'pdf', 'application/pdf'), media('a1b2c3-setup.exe', 'outro', 'application/octet-stream')]
    })
    const { api } = mockWithMedia(plan)
    renderScreen()
    fireEvent.doubleClick(await screen.findByTestId('pl-card-k'))
    const dialog = await screen.findByRole('dialog', { name: 'Editar card' })
    fireEvent.click(within(within(dialog).getByTestId('pl-anexo-a1b2c3-manual.pdf')).getByRole('button', { name: 'Abrir' }))
    await waitFor(() => expect(api.openInFolder).toHaveBeenCalledWith(`${PLAN_DIR}\\midia\\a1b2c3-manual.pdf`))
    fireEvent.click(within(within(dialog).getByTestId('pl-anexo-a1b2c3-setup.exe')).getByRole('button', { name: 'Abrir' }))
    await waitFor(() => expect(api.openInFolder).toHaveBeenCalledWith(`${PLAN_DIR}\\midia`))
    expect(await screen.findByText(/setup\.exe é um programa: abri a pasta/)).toBeTruthy()
  })
})
