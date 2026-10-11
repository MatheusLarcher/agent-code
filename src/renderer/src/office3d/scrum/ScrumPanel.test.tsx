import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ScrumChatMessage, ScrumPanelSnapshot } from '@shared/scrumPanel'
import { ProjectIconsContext } from '../../components/projectIcons'
import { ScrumPanel, type ScrumPanelProps } from './ScrumPanel'
import { at, decisao, envio, histItem, NOW } from './scrumPanelFixtures'
import { resumeText } from './scrumPanelText'
import type { ScrumPanelData } from './useScrumPanel'

const ENVIOS = [
  envio({
    envioId: 'e2',
    convId: 'c2',
    conversationTitle: 'Funil de vendas',
    projectCwd: 'C:\\GitHub\\crm',
    estado: 'parado',
    vezes: 3,
    etapaN: 2,
    etapaTotal: 4,
    marcos: [150, 200, 300],
    paradoMotivo: 'o escopo saiu da API',
    proximoNaFila: 'q1',
    falas: [{ id: 'f9', at: at(12, 48), quem: 'sm', marco: 300, veredito: 'parar', tipoDesvio: null, texto: 'Parei o envio: o escopo saiu da API.', avisouVoce: true }]
  }),
  envio({
    falas: [
      { id: 'f1', at: at(13, 12), quem: 'sm', marco: 150, veredito: 'desvio', tipoDesvio: 'reexplorando', texto: 'Feche o que tem.', avisouVoce: false },
      { id: 'f2', at: at(13, 14), quem: 'agente', marco: 150, veredito: null, tipoDesvio: null, texto: 'Entendido, falta o parser.', avisouVoce: false },
      { id: 'f3', at: at(13, 31), quem: 'sm', marco: 200, veredito: 'desvio', tipoDesvio: 'laco-de-teste', texto: 'Pare de repetir o vitest.', avisouVoce: true }
    ],
    semResposta: true
  }),
  envio({ envioId: 'e3', convId: 'c3', conversationTitle: 'Rotas', projectCwd: 'C:\\GitHub\\mapa', estado: 'no-prazo', vezes: 0.6, marcos: [] })
]

const snapshot = (extra: Partial<ScrumPanelSnapshot> = {}): ScrumPanelSnapshot => ({
  enabled: true,
  podeParar: true,
  logFile: 'C:\\u\\scrum-decisions.log',
  tiles: { acompanhados: 3, cobrancasHoje: 2, parados: 1 },
  contestados: 1,
  envios: ENVIOS,
  ...extra
})

const CORTE = decisao()
const COBRANCA = decisao({ id: 'd2', at: at(13, 31), tipo: 'cobrou', marco: 200, veredito: 'desvio', tipoDesvio: 'laco-de-teste', conversationTitle: 'Handoff autônomo', projectCwd: 'C:\\GitHub\\agent-code', convId: 'c1' })
const HIST = [
  histItem({ id: 'd2', at: at(13, 31), tipo: 'cobrou', marco: 200, veredito: 'desvio', tipoDesvio: 'laco-de-teste', conversationTitle: 'Handoff autônomo', projectCwd: 'C:\\GitHub\\agent-code', convId: 'c1' }),
  histItem({}, { contestacao: { frase: 'a tela fazia parte da etapa', at: at(13, 5) } }),
  histItem({ id: 'd0', at: at(18, 0, 1), tipo: 'cobrou', marco: 150, veredito: 'justificado' })
]

function data(extra: Partial<ScrumPanelData> = {}): ScrumPanelData {
  return {
    snapshot: snapshot(),
    error: null,
    history: { items: HIST, total: HIST.length },
    historyError: null,
    histReq: { filtro: 'tudo', periodo: '7d', busca: '' },
    setHistReq: vi.fn(),
    decisions: new Map([
      [CORTE.id, CORTE],
      [COBRANCA.id, COBRANCA]
    ]),
    chat: [],
    chatMore: false,
    chatError: null,
    loadOlderChat: vi.fn(),
    asking: false,
    ask: vi.fn(async () => null),
    decide: vi.fn(async () => null),
    dequeue: vi.fn(async () => null),
    setPodeParar: vi.fn(async () => null),
    reload: vi.fn(),
    ...extra
  }
}

function setup(d: ScrumPanelData = data(), props: Partial<ScrumPanelProps> = {}) {
  const cbs = { onClose: vi.fn(), onLocate: vi.fn(), onOpenConversation: vi.fn(), onSend: vi.fn() }
  const colorOf = (cwd: string | null): string => (cwd?.endsWith('crm') ? '#c48ad0' : '#6f9cf0')
  const view = render(
    <ProjectIconsContext.Provider value={{ 'C:\\GitHub\\agent-code': 'data:image/png;base64,AAAA' }}>
      <ScrumPanel data={d} colorOf={colorOf} now={NOW} {...cbs} {...props} />
    </ProjectIconsContext.Provider>
  )
  return { ...cbs, view, d }
}

const card = (title: string): HTMLElement => screen.getAllByTestId('smp-envio').find((c) => c.textContent?.includes(title)) as HTMLElement

describe('o Diário do Scrum Master (painel do escritório)', () => {
  it('cabeçalho, tiles, abas com o selo e a chave "Pode parar envios"', () => {
    const { d } = setup()
    expect(screen.getByRole('dialog', { name: 'Diário do Scrum Master' })).toBeTruthy()
    expect(screen.getByText('Gestão do escritório')).toBeTruthy()
    expect(screen.getByTestId('smp-tile-acompanhados').textContent).toBe('3envios acompanhados')
    expect(screen.getByTestId('smp-tile-cobrancas').textContent).toBe('2cobranças hoje')
    expect(screen.getByTestId('smp-tile-parados').textContent).toBe('1envio parado por ele')
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Agora', 'Histórico1 contestado', 'Conversa com o SM'])
    const sw = screen.getByRole('switch', { name: /Pode parar envios/ })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    expect(d.setPodeParar).toHaveBeenCalledWith(false)
  })

  it('Agora: os três estados, a trilha, a troca SM ↔ agente e o "sem resposta"', () => {
    setup()
    expect(screen.getAllByTestId('smp-status').map((s) => s.textContent)).toEqual(['parado pelo Scrum · 3× do prazo', 'atrasado · 2,1× do prazo', 'no prazo · 0,6×'])
    const late = card('Handoff autônomo')
    expect(within(late).getByText('Etapa 3 de 5 — Ações')).toBeTruthy()
    expect(within(late).getAllByTestId('smp-fala').map((f) => f.textContent)).toEqual([
      expect.stringContaining('marco 150% DESVIO · reexplorando o projeto'),
      expect.stringContaining('resposta do agenteEntendido'),
      expect.stringContaining('marco 200% DESVIO · laço de teste · avisou você')
    ])
    expect(within(late).getByText(/ainda sem resposta — a próxima ferramenta do agente traz a cobrança/)).toBeTruthy()
    expect([...late.querySelectorAll('.smp-m.hit')].map((m) => m.getAttribute('data-pct'))).toEqual(['100', '150', '200'])
    expect(within(late).getByTestId('smp-now').getAttribute('data-t')).toBe('84 min / 40 min')
    const stopped = card('Funil de vendas')
    expect(stopped.querySelector('.smp-m.hit.bad')?.getAttribute('data-pct')).toBe('300')
    expect(within(card('Rotas')).getByText('Nada a cobrar. O Scrum Master só fala a partir de 150% do prazo da etapa.')).toBeTruthy()
  })

  it('a linha do projeto: o ícone do projeto na cor dele, e a pasta quando não tem ícone', () => {
    setup()
    const withIcon = within(card('Handoff autônomo')).getByTestId('smp-projrow')
    expect(withIcon.querySelector('img.project-icon-img')).toBeTruthy()
    expect(withIcon.style.getPropertyValue('--pc')).toBe('#6f9cf0')
    expect(withIcon.querySelector('.smp-pname')?.textContent).toBe('agent-code')
    expect(withIcon.querySelector('.smp-ppath')?.textContent).toBe('C:\\GitHub\\agent-code')
    const folder = within(card('Rotas')).getByTestId('smp-projrow')
    expect(folder.querySelector('img')).toBeNull()
    expect(folder.querySelector('svg')).toBeTruthy()
    expect(within(card('Funil de vendas')).getByTestId('smp-projrow').style.getPropertyValue('--pc')).toBe('#c48ad0')
  })

  it('Agora: chips, 📍, e as ações do envio parado', async () => {
    const { onLocate, onSend, onOpenConversation, d } = setup()
    fireEvent.click(within(card('Handoff autônomo')).getByRole('button', { name: /Handoff autônomo/ }))
    expect(onLocate).toHaveBeenCalledWith('c1')
    const stopped = card('Funil de vendas')
    fireEvent.click(within(stopped).getByRole('button', { name: 'Retomar com o aviso' }))
    expect(onSend).toHaveBeenCalledWith('c2', resumeText(ENVIOS[0]))
    fireEvent.click(within(stopped).getByRole('button', { name: 'Ver a conversa' }))
    expect(onOpenConversation).toHaveBeenCalledWith('c2')
    await act(async () => fireEvent.click(within(stopped).getByRole('button', { name: 'Tirar da fila' })))
    expect(d.dequeue).toHaveBeenCalledWith('q1')
    // Os outros cartões não têm as ações da parada.
    expect(within(card('Handoff autônomo')).queryByRole('button', { name: 'Retomar com o aviso' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Só parados' }))
    expect(screen.getAllByTestId('smp-envio')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Só atrasados' }))
    expect(screen.getAllByTestId('smp-envio').map((c) => c.getAttribute('data-estado'))).toEqual(['atrasado'])
  })

  it('a declaração acima do teto: Aprovar / Recusar, e o erro na tela', async () => {
    const d = data({ snapshot: snapshot({ envios: [envio({ declaracao: { entregaId: 'g1', pedidoMin: 200, validoMin: 120, motivo: 'build longo' } })] }), decide: vi.fn(async () => 'já decidida') })
    setup(d)
    expect(screen.getByTestId('smp-decl').textContent).toContain('200 min')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Aprovar' })))
    expect(d.decide).toHaveBeenCalledWith('e1', 'g1', true)
    expect(screen.getByRole('alert').textContent).toBe('já decidida')
  })

  it('estados vazio e de erro do Agora; Esc e ✕ fecham', () => {
    const d = data({ snapshot: null, error: 'banco ocupado' })
    const { onClose, view } = setup(d)
    expect(screen.getByRole('alert').textContent).toContain('Não deu para ler o painel: banco ocupado')
    fireEvent.click(screen.getByRole('button', { name: 'tentar de novo' }))
    expect(d.reload).toHaveBeenCalled()
    expect(screen.getByTestId('smp-tile-acompanhados').textContent).toContain('–')
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    view.unmount()
    setup(data({ snapshot: snapshot({ envios: [], enabled: false }) }))
    expect(screen.getByText('Nenhum envio de handoff em andamento agora.')).toBeTruthy()
    expect(screen.getByText(/O Scrum Master está desligado/)).toBeTruthy()
  })

  it('Histórico: por dia, o contestado com a frase, filtros, período, busca e o dia fechado', () => {
    const { d, onOpenConversation } = setup()
    fireEvent.click(screen.getByRole('tab', { name: /Histórico/ }))
    const days = screen.getAllByTestId('smp-day')
    expect(days.map((x) => x.querySelector('.smp-h')?.textContent)).toEqual(['Hoje', 'Ontem'])
    const evs = within(days[0]).getAllByTestId('smp-ev')
    expect(evs.map((e) => e.getAttribute('data-tipo'))).toEqual(['cobrou', 'parou'])
    const cut = evs[1]
    expect(cut.className).toContain('contestado')
    expect(cut.textContent).toContain('Cortou o envio Funil de vendas')
    expect(within(cut).getByTestId('smp-ev-flag').textContent).toBe('Você contestou: “a tela fazia parte da etapa” · 13:05')
    expect(within(cut).getByTestId('smp-projtag').textContent).toBe('crm')
    expect(cut.textContent).toContain('12:48 · marco 300% · PARAR · 96 min de 30 min · avisou você')
    fireEvent.click(within(cut).getByRole('button', { name: 'Ver o envio' }))
    expect(onOpenConversation).toHaveBeenCalledWith('c2')
    expect(within(evs[0]).queryByRole('button', { name: 'Ver o envio' })).toBeNull()
    // Ontem fechado, com o resumo; "mostrar" abre.
    expect(days[1].textContent).toContain('1 cobrança · 1 justificada · 0 cortes')
    fireEvent.click(within(days[1]).getByRole('button', { name: 'mostrar' }))
    expect(within(screen.getAllByTestId('smp-day')[1]).getAllByTestId('smp-ev')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Só cortes' }))
    expect(d.setHistReq).toHaveBeenCalledWith({ filtro: 'cortes' })
    fireEvent.click(screen.getByRole('button', { name: '30 dias' }))
    expect(d.setHistReq).toHaveBeenCalledWith({ periodo: '30d' })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar por projeto ou conversa' }), { target: { value: 'crm' } })
    expect(d.setHistReq).toHaveBeenCalledWith({ busca: 'crm' })
  })

  it('Histórico vazio e com erro', () => {
    const { view } = setup(data({ history: { items: [], total: 0 }, historyError: null }), { initialTab: 'hist' })
    expect(screen.getByText('O Scrum Master ainda não fez nada neste período.')).toBeTruthy()
    view.unmount()
    setup(data({ history: null, historyError: 'arquivo trancado' }), { initialTab: 'hist' })
    expect(screen.getByRole('alert').textContent).toContain('Não deu para ler o diário: arquivo trancado')
  })

  it('Questionar prende o "Sobre:" e leva à Conversa; Enter envia; corte errado contesta', async () => {
    const { d } = setup()
    fireEvent.click(screen.getByRole('tab', { name: /Histórico/ }))
    fireEvent.click(within(screen.getAllByTestId('smp-ev')[0]).getByRole('button', { name: 'Questionar' }))
    expect(screen.getByRole('tab', { name: 'Conversa com o SM' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText(/Esta conversa fica guardada inteira, sem limite/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sobre: cobrança em agent-code ✕' })).toBeTruthy()
    const box = screen.getByRole('textbox', { name: 'Pergunta ao Scrum Master' })
    fireEvent.change(box, { target: { value: 'Por que cobrou?' } })
    await act(async () => fireEvent.keyDown(box, { key: 'Enter' }))
    expect(d.ask).toHaveBeenCalledWith('Por que cobrou?', 'd2', false)
    expect((box as HTMLTextAreaElement).value).toBe('')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Marcar como corte errado' })))
    expect(d.ask).toHaveBeenLastCalledWith('', 'd2', true)
    // ✕ solta a decisão: sem ela, sem contestação.
    fireEvent.click(screen.getByRole('button', { name: 'Sobre: cobrança em agent-code ✕' }))
    expect((screen.getByRole('button', { name: 'Marcar como corte errado' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('"Ver a conversa contestada" abre a Conversa presa no corte', () => {
    setup()
    fireEvent.click(screen.getByRole('tab', { name: /Histórico/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Ver a conversa contestada' }))
    expect(screen.getByRole('button', { name: 'Sobre: corte em crm ✕' })).toBeTruthy()
  })

  it('Conversa: "Sobre:" quando o assunto muda, carregar anteriores, pensando e erro', async () => {
    const msg = (id: string, role: ScrumChatMessage['role'], text: string, sobre: string | null): ScrumChatMessage => ({ id, at: at(13, 5), role, text, sobre, projectCwd: 'C:\\GitHub\\crm' })
    const chat = [msg('1', 'usuario', 'Por que cortou?', 'd1'), msg('2', 'sm', 'Porque fugiu do escopo.', 'd1'), msg('3', 'usuario', 'E esta?', 'zz'), msg('4', 'sm', 'Não sei.', 'zz')]
    const d = data({ chat, chatMore: true, asking: true, ask: vi.fn(async () => 'o modelo não respondeu') })
    setup(d, { initialTab: 'chat' })
    expect(screen.getAllByTestId('smp-chat-msg').map((m) => m.getAttribute('data-role'))).toEqual(['usuario', 'sm', 'usuario', 'sm'])
    expect(screen.getByTestId('smp-ctx').textContent).toBe('Sobre: Cortou Funil de vendas · crm · 12:48')
    expect(screen.getByText('Sobre: uma decisão em crm')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Carregar anteriores' }))
    expect(d.loadOlderChat).toHaveBeenCalled()
    expect(screen.getByText('O Scrum Master está pensando…')).toBeTruthy()
    // Pensando: não envia de novo.
    expect((screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Conversa: o erro do envio aparece e o texto fica', async () => {
    const d = data({ ask: vi.fn(async () => 'o modelo não respondeu') })
    setup(d, { initialTab: 'chat' })
    expect(screen.getByText(/Nenhuma pergunta ainda/)).toBeTruthy()
    const box = screen.getByRole('textbox', { name: 'Pergunta ao Scrum Master' })
    fireEvent.change(box, { target: { value: 'oi' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Enviar' })))
    expect(d.ask).toHaveBeenCalledWith('oi', null, false)
    expect(screen.getByRole('alert').textContent).toBe('o modelo não respondeu')
    expect((box as HTMLTextAreaElement).value).toBe('oi')
  })
})
