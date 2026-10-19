/**
 * Aba Planos: lista por projeto recolhida, colunas de etapas, folha do card,
 * "Comentar no chat", novo planejamento, PC antigo, plano apagado, releitura no
 * planning-changed e o voltar do Android (folha → plano → raiz).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PlanningCardDto } from '@shared/ipc'
import { managerQuestionnaireRequest } from '@shared/managerRequests'
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
    // Sem `fonte` (PC antigo): o N/M é a especificação do roteiro.
    expect(screen.getByText('1/2 especificadas')).toBeTruthy()
    expect(screen.getByText('1 ambiguidade aberta')).toBeTruthy()
  })

  it('lista: o "N/M" diz de onde vem — "prontas" (implementação) ou "especificadas" (roteiro)', async () => {
    routes[LIST_ALFA] = () => ({
      ok: true,
      plans: [
        { ...SUMMARY, slug: 'impl', titulo: 'Em implementação', etapas: { total: 5, concluidas: 2, fonte: 'implementacao' } },
        { ...SUMMARY, slug: 'spec', titulo: 'Em especificação', etapas: { total: 4, concluidas: 3, fonte: 'especificacao' } },
        { ...SUMMARY, slug: 'vazio', titulo: 'Vazio', etapas: { total: 0, concluidas: 0, fonte: 'especificacao' } }
      ]
    })
    render(<PlanningTab />)
    await flush()
    fireEvent.click(groupHeader('alfa')!)
    expect(screen.getByText('2/5 prontas')).toBeTruthy()
    expect(screen.getByText('3/4 especificadas')).toBeTruthy()
    expect(screen.getByText('sem etapas')).toBeTruthy()
  })

  it('lista: do mais recente ao mais antigo, só 5 visíveis + "Ver mais (2)" e "Ver menos"', async () => {
    const plans = Array.from({ length: 7 }, (_, i) => ({ ...SUMMARY, slug: `p${i}`, titulo: `Plano ${i}`, atualizadoEm: 1000 + ((i * 3) % 7) }))
    routes[LIST_ALFA] = () => ({ ok: true, plans })
    render(<PlanningTab />)
    await flush()
    fireEvent.click(groupHeader('alfa')!)
    const titles = (): string[] => Array.from(document.querySelectorAll('.pl-row-title')).map((t) => t.textContent ?? '')
    // atualizadoEm: p0=1000 p1=1003 p2=1006 p3=1002 p4=1005 p5=1001 p6=1004
    expect(titles()).toEqual(['Plano 2', 'Plano 4', 'Plano 6', 'Plano 1', 'Plano 3'])
    expect(groupHeader('alfa')!.querySelector('.coll-count')?.textContent).toBe('7')
    fireEvent.click(screen.getByText('Ver mais (2)'))
    expect(titles()).toEqual(['Plano 2', 'Plano 4', 'Plano 6', 'Plano 1', 'Plano 3', 'Plano 5', 'Plano 0'])
    fireEvent.click(screen.getByText('Ver menos'))
    expect(titles()).toHaveLength(5)
  })

  it('lista: PC antigo (sem atualizadoEm) ordena pela conversa do Manager e, sem ela, pela data do slug; projetos pelo mais recente', async () => {
    const old = (slug: string): RemotePlanSummary => ({ ...SUMMARY, slug, titulo: slug })
    client.store.set({ conversations: [{ ...MANAGER, planningSlug: 'plano-20200101-0000', updatedAt: new Date(2031, 0, 1).getTime() }] })
    routes[LIST_ALFA] = () => ({ ok: true, plans: [old('plano-20240101-0900'), old('plano-20200101-0000'), old('plano-20250101-0900'), old('sem-data')] })
    routes[LIST_BETA] = () => ({ ok: true, plans: [{ ...old('beta-x'), atualizadoEm: new Date(2032, 0, 1).getTime() }] })
    render(<PlanningTab />)
    await flush()
    expect(Array.from(document.querySelectorAll('.coll-title')).map((t) => t.textContent)).toEqual(['beta', 'alfa'])
    fireEvent.click(groupHeader('alfa')!)
    const titles = Array.from(document.querySelectorAll('.pl-row-title')).map((t) => t.textContent)
    expect(titles).toEqual(['plano-20200101-0000', 'plano-20250101-0900', 'plano-20240101-0900', 'sem-data'])
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

  describe('Chat do plano: "Iniciar questionário" e "Enviar para implementação"', () => {
    const P1 = { name: '2026-10-19-01.md', createdAt: 1, content: '# Implementação 1 de 2 — Base\ntexto', etapas: ['base'] }
    const P2 = { name: '2026-10-19-02.md', createdAt: 2, content: 'Sem título markdown', etapas: ['zap'] }
    let posts: Array<[string, unknown]>
    let postReply: (path: string) => unknown

    async function openChat(plan: RemotePlan): Promise<void> {
      routes['/api/planning/plan'] = () => ({ ok: true, plan })
      await openSite()
      fireEvent.click(screen.getByRole('tab', { name: 'Chat' }))
      await flush()
    }

    beforeEach(() => {
      posts = []
      postReply = () => ({ ok: true })
      vi.spyOn(client, 'post').mockImplementation((async (path: string, body: unknown) => {
        posts.push([path, body])
        const r = postReply(path)
        if (r instanceof Error) throw r
        return r
      }) as never)
    })

    it('"Iniciar questionário" manda ao Manager EXATAMENTE o texto do PC pelo envio normal', async () => {
      await openChat(PLAN)
      fireEvent.click(screen.getByText('Iniciar questionário'))
      await flush()
      expect(posts[0][0]).toBe('/api/send')
      expect((posts[0][1] as { convId: string; text: string }).convId).toBe('pm')
      expect((posts[0][1] as { text: string }).text).toBe(managerQuestionnaireRequest())
    })

    it('ambiguidade aberta bloqueia até "enviar mesmo assim"; Enviar manda os nomes e o override, fecha e esconde os enviados', async () => {
      await openChat({ ...PLAN, handoffs: { pendentes: [P1, P2], enviados: [] } })
      fireEvent.click(screen.getByText('Enviar para implementação'))
      const sheet = screen.getByRole('dialog', { name: 'Enviar para implementação' })
      expect(sheet.textContent).toContain('1 ambiguidade aberta')
      expect(sheet.textContent).toContain('Cor do botão')
      expect(sheet.textContent).toContain('Implementação 1 de 2 — Base')
      expect(sheet.textContent).toContain('Total estimado: 30 min · 1 etapa')
      const enviar = (): HTMLButtonElement => screen.getByText(/^Enviar/, { selector: '.pl-sheet-actions button' }) as HTMLButtonElement
      expect(enviar().disabled).toBe(true)
      fireEvent.click(screen.getByLabelText(/Enviar mesmo assim/))
      expect(enviar().disabled).toBe(false)
      fireEvent.click(enviar())
      await flush()
      expect(posts).toContainEqual(['/api/planning/handoff', { cwd: ALFA, slug: 'site', names: [P1.name, P2.name], override: true }])
      expect(screen.queryByRole('dialog', { name: 'Enviar para implementação' })).toBeNull()
      expect(planUi.get().justSent).toEqual([P1.name, P2.name])
      fireEvent.click(screen.getByText('Enviar para implementação'))
      expect(screen.getByRole('dialog', { name: 'Enviar para implementação' }).textContent).toContain('Nenhum prompt a enviar')
    })

    it('tocar no prompt abre o texto só leitura; voltar do Android volta à lista e depois fecha a folha', async () => {
      await openChat({ ...PLAN, cards: PLAN.cards.filter((c) => c.tipo !== 'ambiguidade'), handoffs: { pendentes: [P1], enviados: [] } })
      fireEvent.click(screen.getByText('Enviar para implementação'))
      fireEvent.click(screen.getByText('Implementação 1 de 2 — Base'))
      expect(document.querySelector('.pl-handoff-text')?.textContent).toBe(P1.content)
      expect(document.querySelector('.pl-handoff-text textarea, textarea.pl-handoff-text')).toBeNull()
      act(() => void handleBack())
      expect(document.querySelector('.pl-handoff-text')).toBeNull()
      act(() => void handleBack())
      expect(screen.queryByRole('dialog', { name: 'Enviar para implementação' })).toBeNull()
    })

    it('sem prompt: "Gerar prompts" pede ao PC e espera; o planning-changed traz o prompt novo e a lista aparece', async () => {
      const plan = { ...PLAN, cards: PLAN.cards.filter((c) => c.tipo !== 'ambiguidade'), handoffs: { pendentes: [], enviados: [] } }
      await openChat(plan)
      fireEvent.click(screen.getByText('Enviar para implementação'))
      fireEvent.click(screen.getByText('Gerar prompts'))
      await flush()
      expect(posts).toContainEqual(['/api/planning/handoff-generate', { cwd: ALFA, slug: 'site' }])
      expect(screen.getByRole('status').textContent).toContain('Pedi os prompts ao Agent Manager')
      routes['/api/planning/plan'] = () => ({ ok: true, plan: { ...plan, handoffs: { pendentes: [P1], enviados: [] } } })
      vi.useFakeTimers()
      act(() => {
        for (const tap of client.eventTaps) tap({ convId: 'planning', event: { kind: 'planning-changed', projectCwd: ALFA, slug: 'site' } })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS + 10)
      })
      expect(screen.queryByRole('status')).toBeNull()
      expect(screen.getByText('Implementação 1 de 2 — Base')).toBeTruthy()
    })

    it('antigos: não entram no envio; "Descartar os antigos" pergunta num modal próprio (Manter cancela)', async () => {
      const old = { ...P2, antigo: true }
      await openChat({ ...PLAN, cards: PLAN.cards.filter((c) => c.tipo !== 'ambiguidade'), handoffs: { pendentes: [P1, old], enviados: [] } })
      fireEvent.click(screen.getByText('Enviar para implementação'))
      expect(screen.getByText(/1 prompt antigo/)).toBeTruthy()
      fireEvent.click(screen.getByText('Descartar os antigos', { selector: '.pl-handoff-old button' }))
      expect(screen.getByRole('alertdialog')).toBeTruthy()
      fireEvent.click(screen.getByText('Manter'))
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(screen.getByRole('dialog', { name: 'Enviar para implementação' })).toBeTruthy()
      fireEvent.click(screen.getByText('Descartar os antigos', { selector: '.pl-handoff-old button' }))
      postReply = () => ({ ok: true, discarded: [old.name] })
      fireEvent.click(screen.getByText('Descartar os antigos', { selector: '.pl-confirm-actions button' }))
      await flush()
      expect(posts).toContainEqual(['/api/planning/handoff-discard', { cwd: ALFA, slug: 'site' }])
      expect(toasts.get().list.some((t) => t.text.includes('_descartados'))).toBe(true)
      fireEvent.click(screen.getByText(/^Enviar/, { selector: '.pl-sheet-actions button' }))
      await flush()
      expect(posts).toContainEqual(['/api/planning/handoff', { cwd: ALFA, slug: 'site', names: [P1.name] }])
    })

    it('PC antigo: sem `handoffs` no plano, ou a rota 404, a folha diz "Atualize o app do PC"', async () => {
      await openChat(PLAN)
      fireEvent.click(screen.getByText('Enviar para implementação'))
      expect(screen.getByRole('dialog', { name: 'Enviar para implementação' }).textContent).toContain('Atualize o app do PC')
      act(() => void handleBack())
      planUi.set({ plan: { ...PLAN, cards: [], handoffs: { pendentes: [], enviados: [] } } })
      postReply = () => new HttpError(404, { error: 'rota desconhecida' })
      fireEvent.click(screen.getByText('Enviar para implementação'))
      fireEvent.click(screen.getByText('Gerar prompts'))
      await flush()
      expect(screen.getByRole('dialog', { name: 'Enviar para implementação' }).textContent).toContain('Atualize o app do PC')
    })
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
