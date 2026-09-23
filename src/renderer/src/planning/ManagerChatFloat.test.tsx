import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRef, useEffect, type ReactNode } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PlanningCardDto } from '@shared/ipc'
import { useChatDisplay, type ChatDisplay } from '../components/chatDisplay'
import { Composer } from '../components/Composer'
import { MessageList } from '../components/MessageList'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { FLOAT_EDGE_GAP, ManagerChatFloat, maximizedTop } from './ManagerChatFloat'
import { typeColorVar } from './cardTypes'

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** O que o ChatPanel leria do contexto. */
function Probe(): JSX.Element {
  const { compact } = useChatDisplay()
  return <span data-testid="probe">{compact ? 'compacto' : 'completo'}</span>
}

function renderFloat(child: ReactNode = <Probe />) {
  return render(
    <div className="pl-main">
      <ManagerChatFloat>{child}</ManagerChatFloat>
    </div>
  )
}

const panel = () => screen.getByRole('region', { name: 'Agent Manager' })

describe('ManagerChatFloat — estados', () => {
  it('mostra o chat recebido num painel "Agent Manager", maximizado por padrão', () => {
    renderFloat(<div>conversa com o agente</div>)
    expect(panel().textContent).toContain('Agent Manager')
    expect(screen.getByText('conversa com o agente').closest('.pl-chat-float')).toBe(panel())
    expect(panel().classList.contains('minimized')).toBe(false)
    const btn = screen.getByRole('button', { name: 'Minimizar o chat do Agent Manager' })
    expect(btn.getAttribute('title')).toMatch(/^Minimizar o chat/)
  })

  it('minimizar e maximizar alternam a classe, o botão e o modo compacto do chat; a escolha fica lembrada', () => {
    const { unmount } = renderFloat()
    expect(screen.getByTestId('probe').textContent).toBe('completo')
    fireEvent.click(screen.getByRole('button', { name: 'Minimizar o chat do Agent Manager' }))
    expect(panel().classList.contains('minimized')).toBe(true)
    expect(screen.getByTestId('probe').textContent).toBe('compacto')
    expect(localStorage.getItem('agentcode.planning.chatMinimized')).toBe('1')
    unmount()

    renderFloat()
    expect(panel().classList.contains('minimized')).toBe(true)
    const max = screen.getByRole('button', { name: 'Maximizar o chat do Agent Manager' })
    expect(max.getAttribute('title')).toMatch(/^Maximizar o chat/)
    fireEvent.click(max)
    expect(panel().classList.contains('minimized')).toBe(false)
    expect(screen.getByTestId('probe').textContent).toBe('completo')
    expect(localStorage.getItem('agentcode.planning.chatMinimized')).toBe('0')
  })

  it('clicar fora do chat minimiza e tira o foco dele (fica translúcido); clicar dentro não', () => {
    render(
      <div>
        <button type="button">fora</button>
        <div role="dialog">
          <button type="button">permitir</button>
        </div>
        <div className="pl-main">
          <ManagerChatFloat>
            <textarea aria-label="mensagem" />
          </ManagerChatFloat>
        </div>
      </div>
    )
    const box = screen.getByLabelText('mensagem') as HTMLTextAreaElement
    box.focus()
    fireEvent.pointerDown(box)
    expect(panel().classList.contains('minimized')).toBe(false)

    // Responder um diálogo (permissão, pergunta) não é sair do chat.
    fireEvent.pointerDown(screen.getByText('permitir'))
    expect(panel().classList.contains('minimized')).toBe(false)

    fireEvent.pointerDown(screen.getByText('fora'))
    expect(panel().classList.contains('minimized')).toBe(true)
    expect(document.activeElement).not.toBe(box)
    expect(localStorage.getItem('agentcode.planning.chatMinimized')).toBe('1')

    // Já minimizado: digitar e clicar fora de novo só solta o foco.
    box.focus()
    fireEvent.pointerDown(screen.getByText('fora'))
    expect(document.activeElement).not.toBe(box)
    expect(panel().classList.contains('minimized')).toBe(true)
  })

  it('alternar não remonta o chat (rolagem, rascunho e foco ficam)', () => {
    const mounts = vi.fn()
    function Chat(): JSX.Element {
      useEffect(() => mounts(), [])
      return <textarea aria-label="mensagem" defaultValue="rascunho" />
    }
    renderFloat(<Chat />)
    fireEvent.click(screen.getByRole('button', { name: 'Minimizar o chat do Agent Manager' }))
    fireEvent.click(screen.getByRole('button', { name: 'Maximizar o chat do Agent Manager' }))
    expect(mounts).toHaveBeenCalledTimes(1)
  })
})

describe('ManagerChatFloat — posição', () => {
  const originalHeight = window.innerHeight
  afterEach(() => Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: originalHeight }))

  function mockLayout(area: Partial<DOMRect>, panelRect: Partial<DOMRect>, innerHeight: number): void {
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: innerHeight })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.classList.contains('pl-chat-float') ? panelRect : area) as DOMRect
    })
  }

  it('maximizado: a borda de cima fica a 20% da altura da JANELA, descontado o que está acima da área', () => {
    // Janela de 900px; a área do canvas começa em y=54 (cabeçalho da tela).
    mockLayout({ top: 54, right: 1440 }, { right: 1100 }, 900)
    renderFloat()
    expect(panel().style.top).toBe('126px') // 900 × 20% = 180 → 180 − 54
    fireEvent.click(screen.getByRole('button', { name: 'Minimizar o chat do Agent Manager' }))
    // Minimizado: ancorado embaixo pelo CSS, sem top inline.
    expect(panel().style.top).toBe('')
  })

  it('maximizedTop: 20% da janela; desce para baixo do minimapa se cruzar a coluna dele; nunca cola no topo', () => {
    expect(maximizedTop({ viewportHeight: 900, areaTop: 54, areaRight: 1440, panelRight: 1100 })).toBe(126)
    expect(maximizedTop({ viewportHeight: 720, areaTop: 98, areaRight: 1280, panelRight: 1000 })).toBe(46)
    // Canvas estreito: a borda direita do painel entra na coluna do minimapa (15 + 168 + 8 da direita).
    expect(maximizedTop({ viewportHeight: 720, areaTop: 98, areaRight: 1000, panelRight: 850 })).toBe(131)
    // Acima da área já passa de 20% da janela: fica no piso.
    expect(maximizedTop({ viewportHeight: 400, areaTop: 200, areaRight: 1440, panelRight: 900 })).toBe(FLOAT_EDGE_GAP)
  })
})

const PLAN_CARDS: PlanningCardDto[] = [
  { id: 'login', tipo: 'requisito', titulo: 'Login com SSO', links: [], rev: 4, corpo: 'texto longo', etapa: 'requisitos' },
  { id: 'banco', tipo: 'decisao', titulo: 'Usar Postgres', links: ['login'], rev: 2, corpo: '' }
]

describe('ManagerChatFloat — os cards do plano no contexto do chat', () => {
  let seen: ChatDisplay[] = []
  function CardsProbe(): JSX.Element {
    const display = useChatDisplay()
    seen.push(display)
    return <span data-testid="cards">{display.cardRefs?.map((c) => `${c.id}:${c.tipo}:${c.titulo}`).join('|') ?? 'sem cards'}</span>
  }
  beforeEach(() => {
    seen = []
  })
  const floatWith = (cards?: PlanningCardDto[]): JSX.Element => (
    <div className="pl-main">
      <ManagerChatFloat cards={cards}>
        <CardsProbe />
      </ManagerChatFloat>
    </div>
  )

  it('publica só id/título/tipo; sem cards (ou lista vazia) o chat fica sem eles', () => {
    const { rerender } = render(floatWith(PLAN_CARDS))
    expect(screen.getByTestId('cards').textContent).toBe('login:requisito:Login com SSO|banco:decisao:Usar Postgres')
    expect(seen.at(-1)?.cardRefs?.[0]).toEqual({ id: 'login', titulo: 'Login com SSO', tipo: 'requisito' })
    rerender(floatWith([]))
    expect(screen.getByTestId('cards').textContent).toBe('sem cards')
    rerender(floatWith(undefined))
    expect(screen.getByTestId('cards').textContent).toBe('sem cards')
    expect(seen.at(-1)?.cardRefs).toBeUndefined()
  })

  it('recarga que só muda posição/corpo/rev mantém a MESMA lista; título ou tipo novo troca', () => {
    const { rerender } = render(floatWith(PLAN_CARDS))
    const first = seen.at(-1)?.cardRefs
    rerender(floatWith(PLAN_CARDS.map((c) => ({ ...c, rev: c.rev + 1, corpo: `${c.corpo} editado` }))))
    expect(seen.at(-1)?.cardRefs).toBe(first)
    rerender(floatWith([PLAN_CARDS[0], { ...PLAN_CARDS[1], titulo: 'Usar SQLite' }]))
    expect(seen.at(-1)?.cardRefs).not.toBe(first)
    expect(screen.getByTestId('cards').textContent).toContain('banco:decisao:Usar SQLite')
  })

  it('minimizar mantém os cards no contexto (compacto + cards)', () => {
    render(floatWith(PLAN_CARDS))
    fireEvent.click(screen.getByRole('button', { name: 'Minimizar o chat do Agent Manager' }))
    expect(seen.at(-1)?.compact).toBe(true)
    expect(seen.at(-1)?.cardRefs).toHaveLength(2)
  })
})

describe('ManagerChatFloat — o chat de verdade dentro do painel', () => {
  Element.prototype.scrollIntoView = vi.fn()
  const tts = { speakingId: null, onToggleSpeak: (): void => {} }
  const MESSAGES: UIMessage[] = [
    { kind: 'user', id: 'u1', text: 'Revise [[Login com SSO]] e [[Nada]]' },
    { kind: 'assistant-text', id: 'a1', text: 'Feito: [[usar postgres]] depende de **[[Login com SSO]]**.', final: true, answer: true }
  ]
  const list = (): JSX.Element => <MessageList messages={MESSAGES} busy={false} tts={tts} onRetry={() => {}} />

  it('[[Nome]] nas mensagens sai com a cor do tipo do card; o que não resolve fica como texto', () => {
    const { container } = render(
      <UiProvider>
        <div className="pl-main">
          <ManagerChatFloat cards={PLAN_CARDS}>{list()}</ManagerChatFloat>
        </div>
      </UiProvider>
    )
    const user = container.querySelector('.msg.user .bubble') as HTMLElement
    const [login] = user.querySelectorAll<HTMLElement>('.pl-card-ref')
    expect(login.textContent).toBe('Login com SSO')
    expect(login.style.getPropertyValue('--pl-ref')).toBe(typeColorVar('requisito'))
    expect(user.textContent).toContain('[[Nada]]')
    const answer = container.querySelector('.msg.assistant .bubble') as HTMLElement
    expect([...answer.querySelectorAll('.pl-card-ref')].map((c) => [c.textContent, c.getAttribute('data-tipo')])).toEqual([
      ['usar postgres', 'decisao'],
      ['Login com SSO', 'requisito']
    ])
  })

  it('a mesma lista fora do painel (conversa normal) não destaca nada', () => {
    const { container } = render(<UiProvider>{list()}</UiProvider>)
    expect(container.querySelector('.pl-card-ref')).toBeNull()
    expect(container.querySelector('.msg.user .bubble')?.textContent).toBe('Revise [[Login com SSO]] e [[Nada]]')
    expect(container.querySelector('.msg.assistant .bubble')?.textContent).toContain('[[usar postgres]]')
  })

  it('o Composer sugere os cards com "[[" maximizado e minimizado', () => {
    render(
      <UiProvider>
        <div className="pl-main">
          <ManagerChatFloat cards={PLAN_CARDS}>
            <Composer
              disabled={false}
              busy={false}
              chips={[]}
              onRemoveChip={() => {}}
              onSend={() => {}}
              onInterrupt={() => {}}
              textareaRef={createRef<HTMLTextAreaElement>()}
              projects={[]}
              projectRoot={null}
              voiceReady={false}
              onNeedVoiceKey={() => {}}
              convId="c1"
              draft=""
              onDraftChange={() => {}}
              projectMissing={false}
              projectMissingMsg=""
            />
          </ManagerChatFloat>
        </div>
      </UiProvider>
    )
    const box = screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '[[post' } })
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.getAttribute('data-tipo'))).toEqual(['decisao'])
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box.value).toBe('[[Usar Postgres]]')

    fireEvent.click(screen.getByRole('button', { name: 'Minimizar o chat do Agent Manager' }))
    expect(panel().classList.contains('minimized')).toBe(true)
    fireEvent.change(box, { target: { value: '[[Usar Postgres]] e [[log' } })
    expect(screen.getByRole('listbox').closest('.composer-card-refs')).toBeTruthy()
    fireEvent.keyDown(box, { key: 'Tab' })
    expect(box.value).toBe('[[Usar Postgres]] e [[Login com SSO]]')
  })
})

describe('ManagerChatFloat — o CSS que o posiciona e o encolhe', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/planning/planningChat.css'), 'utf8')
  const block = (selector: string): string => {
    const start = css.indexOf(`${selector} {`)
    expect(start, selector).toBeGreaterThan(-1)
    return css.slice(start, css.indexOf('}', start))
  }

  it('flutua centralizado sobre a área do canvas, com a largura pedida e a 12px do fim', () => {
    const float = block('.pl-chat-float')
    expect(float).toMatch(/position: absolute;/)
    expect(float).toMatch(/left: 0;[\s\S]*right: 0;/)
    expect(float).toMatch(/margin: 0 auto;/)
    expect(float).toMatch(/width: clamp\(420px, 55%, 860px\);/)
    expect(float).toMatch(/bottom: 12px;/)
    expect(block('.pl-chat-float.minimized')).toMatch(/top: auto;/)
  })

  it('minimizado: a lista tem 5 linhas do texto das mensagens e a caixa de digitação 3', () => {
    expect(block('.pl-chat-float')).toMatch(/--pl-chat-line: 21px;/)
    expect(block('.pl-chat-float.minimized .message-list-wrap')).toMatch(/height: calc\(5 \* var\(--pl-chat-line\)\);/)
    const input = block('.pl-chat-float.minimized .composer-input')
    expect(input).toMatch(/min-height: calc\(3 \* var\(--pl-chat-line\) \+ 9px\);/)
    expect(input).toMatch(/max-height: calc\(3 \* var\(--pl-chat-line\) \+ 9px\);/)
    // 21px é o line-height real das mensagens e da caixa: 14px × 1.5 no styles.css.
    const app = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    expect(app).toMatch(/\nbody \{[^}]*font-size: 14px;/)
    expect(app).toMatch(/\n\.bubble \{[^}]*line-height: 1\.5;/)
    expect(app).toMatch(/\n\.composer-input \{[^}]*font-size: 14px;[^}]*line-height: 1\.5;/)
    expect(app).toMatch(/\n\.composer-input-wrap \.composer-input \{[^}]*padding: 4\.5px 0;/)
  })

  it('a lista do "[[" abre acima da caixa e, minimizado, cabe no espaço da conversa; [[Nome]] ganha a pílula da prévia', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    expect(app).toMatch(/\n\.composer \{[^}]*position: relative;/)
    expect(app).toMatch(/\n\.composer-card-refs \{[^}]*position: absolute;[^}]*bottom: calc\(100% \+ 6px\);/)
    // Minimizado: 5 linhas de conversa + o cabeçalho de 34px ficam acima da caixa; a lista não passa disso.
    expect(block('.pl-chat-float.minimized .composer-card-refs')).toMatch(/max-height: calc\(5 \* var\(--pl-chat-line\) \+ 24px\);/)
    expect(block('.pl-chat-float-head')).toMatch(/height: 34px;/)
    const chip = block('.pl-card-ref')
    expect(chip).toMatch(/background: color-mix\(in srgb, var\(--pl-ref\) 14%, transparent\);/)
    expect(chip).toMatch(/color: var\(--pl-ref\);/)
  })
})
