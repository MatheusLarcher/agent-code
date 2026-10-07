/**
 * Aba Planos: lista por projeto recolhida, colunas de etapas, folha do card,
 * "Comentar no chat", novo planejamento, PC antigo, plano apagado, releitura no
 * planning-changed e o voltar do Android (folha → plano → raiz).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PlanningCardDto } from '@shared/ipc'
import { client, nav, toasts } from '../app/runtime'
import { resetApp } from '../app/testSupport'
import { HttpError } from '../core/net'
import type { ConvSummary, RemotePlan, RemotePlanSummary } from '../core/types'
import { handleBack } from '../shell/backButton'
import { PlanningTab } from './PlanningTab'
import { planUi, RELOAD_DEBOUNCE_MS, resetPlanUi } from './planState'

const ALFA = 'C:\\proj\\alfa'
const BETA = 'C:\\proj\\beta'
const LIST_ALFA = '/api/planning/list?cwd=' + encodeURIComponent(ALFA)
const LIST_BETA = '/api/planning/list?cwd=' + encodeURIComponent(BETA)

const card = (o: Partial<PlanningCardDto> & Pick<PlanningCardDto, 'id' | 'tipo' | 'titulo'>): PlanningCardDto => ({ links: [], rev: 1, corpo: '', ...o })

const PLAN: RemotePlan = {
  slug: 'site',
  roteiro: { titulo: 'Site novo', etapas: [
    { id: 'base', titulo: 'Base', status: 'concluida', estimativa: 30 },
    { id: 'zap', titulo: 'WhatsApp', status: 'pendente' }
  ] },
  cards: [
    card({ id: 'botao', tipo: 'requisito', titulo: 'Botão verde', etapa: 'zap', links: ['cor'], anexos: ['logo.png', 'brief.pdf'], fonte: 'https://x.dev/a', corpo: '**Fixo** no canto. Ver [[Cor do botão]].' }),
    card({ id: 'cor', tipo: 'ambiguidade', titulo: 'Cor do botão', etapa: 'zap', status: 'aberta', corpo: 'Verde ou coral?' }),
    card({ id: 'html', tipo: 'decisao', titulo: 'HTML puro', etapa: 'base', corpo: 'Sem framework.' }),
    card({ id: 'solta', tipo: 'nota', titulo: 'Fotos', corpo: 'Chegam sexta.' })
  ],
  invalid: [],
  media: [
    { name: 'logo.png', kind: 'imagem', size: 10, mediaType: 'image/png' },
    { name: 'brief.pdf', kind: 'pdf', size: 10, mediaType: 'application/pdf' }
  ]
}

const SUMMARY: RemotePlanSummary = { slug: 'site', titulo: 'Site novo', etapas: { total: 2, concluidas: 1 }, cards: 4, ambiguidadesAbertas: 1 }
const MANAGER = { id: 'pm', title: 'Planejamento: Site', cwd: ALFA, busy: false, connected: true, updatedAt: 5, queued: [], mode: 'planning', planningSlug: 'site' } as ConvSummary

type Handler = (path: string) => unknown
let routes: Record<string, Handler>
let request: ReturnType<typeof vi.spyOn>

function useRoutes(r: Record<string, Handler>): void {
  routes = r
}

const flush = (): Promise<void> => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
})

const groupHeader = (name: string): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.coll-toggle')).find((b) => b.textContent?.toLowerCase().includes(name))

async function openSite(): Promise<void> {
  render(<PlanningTab />)
  await flush()
  fireEvent.click(groupHeader('alfa')!)
  fireEvent.click(screen.getByText('Site novo'))
  await flush()
}

describe('Aba Planos', () => {
  beforeEach(() => {
    resetApp()
    resetPlanUi()
    nav.set({ tab: 'planos', chatOpen: false })
    client.store.set({ base: 'http://pc', token: 'tk', loaded: true, projects: [ALFA, BETA], conversations: [MANAGER], convId: null, messages: [] })
    useRoutes({
      [LIST_ALFA]: () => ({ ok: true, plans: [SUMMARY] }),
      [LIST_BETA]: () => new HttpError(404, { ok: false, code: 'not_found', message: 'pasta do projeto não encontrada' }),
      '/api/planning/plan': () => ({ ok: true, plan: PLAN }),
      '/api/history': () => ({ messages: [] })
    })
    request = vi.spyOn(client, 'request').mockImplementation((async (path: string) => {
      const key = Object.keys(routes).find((k) => path.startsWith(k))
      const r = key ? routes[key](path) : new HttpError(404, { error: 'rota desconhecida' })
      if (r instanceof Error) throw r
      return r
    }) as never)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('lista: projetos recolhidos com nº de planos e o "?" de ambiguidade; projeto sem pasta some', async () => {
    render(<PlanningTab />)
    await flush()
    const alfa = groupHeader('alfa')!
    expect(alfa.getAttribute('aria-expanded')).toBe('false')
    expect(alfa.querySelector('.coll-count')?.textContent).toBe('1')
    expect(alfa.querySelector('.coll-ask')).toBeTruthy()
    expect(groupHeader('beta')).toBeUndefined()
    expect(screen.queryByText('Site novo')).toBeNull()
    fireEvent.click(alfa)
    expect(screen.getByText('Site novo')).toBeTruthy()
    expect(screen.getByText('1/2 etapas')).toBeTruthy()
    expect(screen.getByText('1 ambiguidade aberta')).toBeTruthy()
  })

  it('sem planos: o aviso de lista vazia', async () => {
    routes[LIST_ALFA] = () => ({ ok: true, plans: [] })
    render(<PlanningTab />)
    await flush()
    expect(screen.getByText('Nenhum planejamento ainda')).toBeTruthy()
  })

  it('PC antigo (404 "rota desconhecida"): "Atualize o app do PC"', async () => {
    routes = {}
    render(<PlanningTab />)
    await flush()
    expect(screen.getByText('Atualize o app do PC')).toBeTruthy()
  })

  it('plano aberto: uma coluna por etapa + "Sem etapa", pontos de progresso e os cards com selos', async () => {
    await openSite()
    expect(Array.from(document.querySelectorAll('.pl-col h2')).map((h) => h.textContent)).toEqual(['Base', 'WhatsApp', 'Sem etapa'])
    const dots = document.querySelectorAll('.pl-dot')
    expect(dots).toHaveLength(3)
    expect(dots[0].className).toContain('concluida')
    expect(dots[0].className).toContain('active')
    expect(screen.getByText(/estimativa 30 min/)).toBeTruthy()
    const botao = Array.from(document.querySelectorAll('.pl-card')).find((c) => c.textContent?.includes('Botão verde'))!
    expect(botao.textContent).toContain('1 link')
    expect(botao.textContent).toContain('2 anexos')
    const cor = Array.from(document.querySelectorAll('.pl-card')).find((c) => c.querySelector('.pl-card-title')?.textContent === 'Cor do botão')!
    expect(cor.querySelector('.pl-badge.amb')?.textContent).toBe('aberta')
    expect(document.querySelectorAll('.pl-col')[2].textContent).toContain('Fotos')
  })

  it('folha do card: Markdown, fonte, imagem pela ponte, [[ref]] e ligação levam ao card citado', async () => {
    await openSite()
    fireEvent.click(screen.getByText('Botão verde'))
    const sheet = screen.getByRole('dialog')
    expect(sheet.querySelector('strong')?.textContent).toBe('Fixo')
    expect(sheet.querySelector('.pl-fonte a')?.getAttribute('href')).toBe('https://x.dev/a')
    const img = sheet.querySelector('.pl-sheet-imgs img')!
    expect(img.getAttribute('src')).toContain('/api/planning/media?cwd=' + encodeURIComponent(ALFA) + '&slug=site&name=logo.png')
    expect(sheet.textContent).toContain('brief.pdf')
    fireEvent.click(sheet.querySelector('.pl-card-ref')!)
    expect(screen.getByRole('dialog').querySelector('.pl-sheet-title')?.textContent).toBe('Cor do botão')
    fireEvent.click(screen.getByLabelText('Fechar'))
    fireEvent.click(screen.getByText('Botão verde'))
    fireEvent.click(screen.getByRole('dialog').querySelector('.pl-link')!)
    expect(screen.getByRole('dialog').querySelector('.pl-sheet-title')?.textContent).toBe('Cor do botão')
  })

  it('"Comentar no chat": abre o Chat do Agent Manager com [[Título]] no campo', async () => {
    const select = vi.spyOn(client, 'selectConv')
    await openSite()
    fireEvent.click(screen.getByText('Botão verde'))
    fireEvent.click(screen.getByText('Comentar no chat'))
    await flush()
    expect(select).toHaveBeenCalledWith('pm')
    expect(planUi.get().view).toBe('chat')
    const field = document.querySelector<HTMLTextAreaElement>('.composer textarea')!
    expect(field.value).toBe('[[Botão verde]] ')
    expect(planUi.get().draft).toBeNull()
  })

  it('Chat: [[Nome]] nas mensagens do Manager saem coloridos pelo tipo', async () => {
    await openSite()
    routes['/api/history'] = () => ({ messages: [{ kind: 'assistant-text', id: 'a1', text: 'Veja [[Cor do botão]] e [[Fantasma]].', answer: true, final: true }] })
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }))
    await flush()
    const chips = document.querySelectorAll('.messages .pl-card-ref')
    expect(chips).toHaveLength(1)
    expect((chips[0] as HTMLElement).dataset.tipo).toBe('ambiguidade')
  })

  it('novo planejamento: projeto + pedido → POST create → abre a conversa do Manager', async () => {
    const post = vi.spyOn(client, 'post').mockResolvedValue({ ok: true, convId: 'c-novo' } as never)
    render(<PlanningTab />)
    await flush()
    fireEvent.click(screen.getByText('Novo planejamento'))
    const dialog = screen.getByRole('dialog', { name: 'Novo planejamento' })
    expect(Array.from(dialog.querySelectorAll('option')).map((o) => o.value)).toEqual([ALFA]) // beta: sem pasta
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'Login com SSO' } })
    fireEvent.click(screen.getByText('Criar planejamento'))
    await flush()
    expect(post).toHaveBeenCalledWith('/api/planning/create', { cwd: ALFA, pedido: 'Login com SSO' })
    expect(nav.get().tab).toBe('conversas')
    expect(client.state.convId).toBe('c-novo')
    expect(client.state.conversations.find((c) => c.id === 'c-novo')?.mode).toBe('planning')
  })

  it('plano apagado no PC: volta à lista com aviso', async () => {
    await openSite()
    routes['/api/planning/plan'] = () => new HttpError(404, { ok: false, code: 'not_found', message: 'planejamento não encontrado: site' })
    vi.useFakeTimers()
    act(() => {
      for (const tap of client.eventTaps) tap({ convId: 'planning', event: { kind: 'planning-changed', projectCwd: ALFA, slug: 'site' } })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS + 10)
    })
    expect(planUi.get().open).toBeNull()
    expect(toasts.get().list.some((t) => t.text.includes('não existe mais'))).toBe(true)
  })

  it('planning-changed relê SÓ o plano aberto, uma vez por rajada', async () => {
    await openSite()
    const reads = (): number => request.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith('/api/planning/plan')).length
    const before = reads()
    routes['/api/planning/plan'] = () => ({ ok: true, plan: { ...PLAN, cards: [...PLAN.cards, card({ id: 'novo', tipo: 'nota', titulo: 'Card novo', etapa: 'base' })] } })
    vi.useFakeTimers()
    const emit = (convId: string, projectCwd: string, slug: string): void => {
      for (const tap of client.eventTaps) tap({ convId, event: { kind: 'planning-changed', projectCwd, slug } })
    }
    act(() => {
      emit('planning', ALFA, 'outro') // outro plano: nada
      emit('c1', ALFA, 'site') // outra "conversa": nada
      emit('planning', ALFA, 'site')
      emit('planning', ALFA, 'site')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS + 10)
    })
    expect(reads()).toBe(before + 1)
    expect(screen.getByText('Card novo')).toBeTruthy()
  })

  it('voltar do Android: fecha a folha, depois volta à lista, depois é a raiz', async () => {
    await openSite()
    fireEvent.click(screen.getByText('Botão verde'))
    expect(screen.queryByRole('dialog')).toBeTruthy()
    act(() => void expect(handleBack()).toBe(true))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(planUi.get().open).not.toBeNull()
    act(() => void expect(handleBack()).toBe(true))
    expect(planUi.get().open).toBeNull()
    expect(screen.getByText('Novo planejamento')).toBeTruthy()
    expect(handleBack()).toBe(false)
  })
})
