import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRef, Fragment, StrictMode } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatPanel } from '../components/ChatPanel'
import { UiProvider } from '../ui/UiProvider'
import { ManagerChatFloat } from './ManagerChatFloat'

/**
 * Etapa 4: o Agent Manager minimizado SEM texto digitado vira uma faixa de 1
 * linha sem os botões (`composer-small`); com texto, a caixa volta ao normal
 * (1 a 3 linhas) com os botões. Anexo sozinho não é texto. A detecção é por
 * estado no React (onHasTextChange do Composer), não por `:placeholder-shown`.
 */

const TOKEN = '\uFFFC'
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

beforeEach(() => {
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  ;(window as unknown as { api: unknown }).api = {
    mentionSearch: vi.fn(async () => []),
    resolvePastedPath: vi.fn(),
    readFileBytes: vi.fn(async () => ({ ok: true, base64: PNG_B64, size: 68 })),
    stashDraftAttachment: vi.fn(async () => ({ ok: true, path: 'C:\\ud\\a.png' }))
  }
})
afterEach(() => {
  cleanup()
  localStorage.clear()
})

interface ChatOpts {
  minimized?: boolean
  draft?: string
  busy?: boolean
  strict?: boolean
  onInterrupt?: () => void
}

function renderChat(opts: ChatOpts = {}) {
  if (opts.minimized ?? true) localStorage.setItem('agentcode.planning.chatMinimized', '1')
  // O app monta dentro de <React.StrictMode> (main.tsx).
  const Wrap = opts.strict ? StrictMode : Fragment
  const ui = (convId: string, draft: string): JSX.Element => (
    <Wrap>
    <UiProvider>
      <div className="pl-main">
        <ManagerChatFloat>
          <ChatPanel
            messages={[{ kind: 'user', id: 'u1', text: 'Oi' }]}
            hasActive
            busy={opts.busy ?? false}
            windowsControlEnabled={false}
            onDisableWindowsControl={() => {}}
            tokens={{ context: 0, output: 0, cost: 0 }}
            chips={[]}
            onChipsConsumed={() => {}}
            onSend={() => {}}
            onInterrupt={opts.onInterrupt ?? (() => {})}
            onRetry={() => {}}
            composerRef={createRef()}
            projects={[]}
            projectRoot={null}
            convId={convId}
            draft={draft}
            onDraftChange={() => {}}
            projectMissing={false}
            projectMissingMsg=""
            queued={[]}
            onDeleteQueued={() => {}}
            onRetryRecovery={() => {}}
            onCancelRecovery={() => {}}
            runningSince={null}
            lastDurationMs={null}
            tts={{ speakingId: null, onToggleSpeak: () => {} }}
            models={[{ id: 'claude-opus-5-5', label: 'Opus 5.5' }]}
            model="claude-opus-5-5"
            runningModel="claude-opus-5-5"
            modelLocked={false}
            onModelChange={() => {}}
            onModelLockedClick={() => {}}
            effortLevels={[]}
            effort="high"
            effortLocked={false}
            onEffortChange={() => {}}
            economyMode={false}
            onEconomyModeChange={() => {}}
            loopEnabled={false}
            loopLocked={false}
            onLoopEnabledChange={() => {}}
            fastModeAvailable={false}
            fastMode={false}
            onFastModeChange={() => {}}
            pendingQuestion={false}
            onReopenQuestion={() => {}}
          />
        </ManagerChatFloat>
      </div>
    </UiProvider>
    </Wrap>
  )
  const view = render(ui('c1', opts.draft ?? ''))
  const panel = (): HTMLElement => screen.getByRole('region', { name: 'Agent Manager' })
  const box = (): HTMLElement => screen.getByRole('textbox', { name: 'Mensagem' })
  return {
    panel,
    box,
    small: (): boolean => panel().classList.contains('composer-small'),
    type: (v: string): void => {
      fireEvent.change(box(), { target: { value: v } })
    },
    switchTo: (convId: string, draft: string): void => view.rerender(ui(convId, draft)),
    container: view.container
  }
}

describe('Agent Manager minimizado — caixa pequena sem texto', () => {
  it('minimizado e vazio: composer-small; a lista de 5 linhas continua lá', () => {
    const { small, panel, container } = renderChat()
    expect(panel().classList.contains('minimized')).toBe(true)
    expect(small()).toBe(true)
    expect(container.querySelector('.message-list-wrap')).toBeTruthy()
  })

  it('1 caractere tira a caixa pequena na hora; apagar tudo devolve', () => {
    const { small, type } = renderChat()
    type('a')
    expect(small()).toBe(false)
    type('ab\ncd')
    expect(small()).toBe(false)
    type('')
    expect(small()).toBe(true)
  })

  it('só anexo (TOKEN) não é texto: continua pequena; texto ao lado do anexo tira', () => {
    const { small, type } = renderChat()
    type(TOKEN)
    expect(small()).toBe(true)
    type(`${TOKEN}oi`)
    expect(small()).toBe(false)
    type(TOKEN)
    expect(small()).toBe(true)
  })

  it('imagem anexada de verdade (arquivo) sem texto: continua pequena', async () => {
    const { small, container } = renderChat()
    const png = new File([Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0))], 'foto.png', { type: 'image/png' })
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [png] } })
    expect(await screen.findByAltText('Imagem anexada: foto.png')).toBeTruthy()
    expect(small()).toBe(true)
  })

  it('voltar a uma conversa com rascunho de texto: tamanho normal na hora; sem rascunho, pequena', () => {
    const { small, switchTo } = renderChat()
    switchTo('c2', 'rascunho guardado')
    expect(small()).toBe(false)
    switchTo('c3', '')
    expect(small()).toBe(true)
  })

  it('montar minimizado já com rascunho: tamanho normal', () => {
    const { small } = renderChat({ draft: 'texto' })
    expect(small()).toBe(false)
  })

  it('maximizado nunca tem a caixa pequena, mesmo vazio', () => {
    const { small } = renderChat({ minimized: false })
    expect(small()).toBe(false)
  })

  it('clicar no painel minimizado maximiza sem perder o rascunho nem o foco', () => {
    const { panel, box, type, small } = renderChat()
    box().focus()
    type('meu rascunho')
    fireEvent.click(box())
    expect(panel().classList.contains('minimized')).toBe(false)
    expect(small()).toBe(false)
    expect((box() as HTMLElement & { value: string }).value).toBe('meu rascunho')
    expect(document.activeElement).toBe(box())
  })

  it('clicar na faixa vazia também maximiza, e a caixa fica focável', () => {
    const { panel, box, small } = renderChat()
    box().focus()
    fireEvent.click(box())
    expect(panel().classList.contains('minimized')).toBe(false)
    expect(small()).toBe(false)
    expect(document.activeElement).toBe(box())
  })
})

// ---------------------------------------------------------------------------
// CSS: a regra do minimizado tem de vencer a do styles.css pela ESPECIFICIDADE.
// O bundle importa o planningChat.css (via App → ManagerChatFloat) ANTES do
// styles.css, então um empate perde; se alguém reordenar, inverte sem aviso.
// ---------------------------------------------------------------------------

type Spec = [number, number, number]
interface Rule {
  selector: string
  props: Set<string>
}

const cssOf = (p: string): string =>
  readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Divide numa vírgula de fora de parênteses. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++
    if (ch === ')' || ch === ']') depth--
    if (ch === sep && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean)
}

/** Regras simples (seletor { declarações }), inclusive as de dentro de @media. */
function rulesOf(css: string): Rule[] {
  const out: Rule[] = []
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = m[1].trim()
    if (head.startsWith('@')) continue
    const props = new Set(
      m[2]
        .split(';')
        .map((d) => d.split(':')[0].trim().toLowerCase())
        .filter(Boolean)
    )
    for (const selector of splitTop(head, ',')) out.push({ selector, props })
  }
  return out
}

const FUNC = /:(not|is|has|where)\(((?:[^()]|\([^()]*\))*)\)/g

/** Especificidade (a, b, c) de um seletor: ids; classes/atributos/pseudo-classes; tipos. */
function specificity(sel: string): Spec {
  let a = 0
  let b = 0
  let c = 0
  let s = sel.replace(FUNC, (_all, fn: string, inner: string) => {
    if (fn !== 'where') {
      const best = splitTop(inner, ',').map(specificity).sort(cmp).at(-1) ?? [0, 0, 0]
      a += best[0]
      b += best[1]
      c += best[2]
    }
    return ' '
  })
  a += (s.match(/#[\w-]+/g) ?? []).length
  b += (s.match(/\.[\w-]+/g) ?? []).length + (s.match(/\[[^\]]*\]/g) ?? []).length
  c += (s.match(/::[\w-]+/g) ?? []).length
  s = s.replace(/::[\w-]+/g, ' ')
  b += (s.match(/:[\w-]+/g) ?? []).length
  s = s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:[\w-]+/g, ' ')
  c += (s.match(/[a-zA-Z][\w-]*/g) ?? []).length
  return [a, b, c]
}
function cmp(x: Spec, y: Spec): number {
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/** As classes do elemento-alvo (o último composto do seletor), sem as de :not()/:has(). */
function subjectClasses(sel: string): string[] {
  const parts = sel.replace(FUNC, '').split(/\s*[\s>+~]\s*/).filter(Boolean)
  return (parts.at(-1)?.match(/\.[\w-]+/g) ?? []).map((x) => x.slice(1))
}

/**
 * Cada propriedade que uma regra do planningChat.css com `.minimized` e
 * `composer` declara, contra toda regra do styles.css que pode pegar o mesmo
 * elemento (as classes-alvo dela contidas nas da regra do minimizado) e declara
 * a mesma propriedade. Devolve as disputas que NÃO são vencidas por especificidade.
 */
function lostOrTied(planningRules: Rule[], appRules: Rule[]): string[] {
  const bad: string[] = []
  for (const p of planningRules) {
    if (!p.selector.includes('.minimized') || !p.selector.includes('composer')) continue
    const subj = new Set(subjectClasses(p.selector))
    for (const a of appRules) {
      const aSubj = subjectClasses(a.selector)
      if (!aSubj.length || !aSubj.every((c) => subj.has(c))) continue
      for (const prop of p.props) {
        if (!a.props.has(prop)) continue
        const d = cmp(specificity(p.selector), specificity(a.selector))
        if (d <= 0) bad.push(`${prop}: "${p.selector}" ${specificity(p.selector)} vs "${a.selector}" ${specificity(a.selector)}`)
      }
    }
  }
  return bad
}

describe('planningChat.css — o minimizado vence pela especificidade, não pela ordem', () => {
  const app = rulesOf(cssOf('src/renderer/src/styles.css'))
  const planning = rulesOf(cssOf('src/renderer/src/planning/planningChat.css'))

  it('calcula especificidade como o navegador nos casos usados aqui', () => {
    expect(specificity(".composer-input-wrap .composer-input[role='textbox']")).toEqual([0, 3, 0])
    expect(specificity(".pl-chat-float.minimized .composer-input-wrap .composer-input[role='textbox']")).toEqual([0, 5, 0])
    expect(specificity('.a > .b:not(:has(.c))')).toEqual([0, 3, 0])
    expect(specificity('body .x::before')).toEqual([0, 1, 2])
  })

  it('nenhuma propriedade do minimizado empata ou perde para o styles.css', () => {
    expect(lostOrTied(planning, app)).toEqual([])
  })

  it('a regra antiga (3 linhas fixas em ".pl-chat-float.minimized .composer-input") seria pega pelo teste', () => {
    const old = rulesOf('.pl-chat-float.minimized .composer-input { min-height: 72px; max-height: 72px; }')
    expect(lostOrTied(old, app).some((d) => d.startsWith('min-height:'))).toBe(true)
  })

  it('o teto de 3 linhas está no seletor forte e a caixa pequena não usa :placeholder-shown', () => {
    const cap = planning.find((r) => r.selector === ".pl-chat-float.minimized .composer-input-wrap .composer-input[role='textbox']")
    expect(cap?.props.has('max-height')).toBe(true)
    const raw = cssOf('src/renderer/src/planning/planningChat.css')
    expect(raw).not.toMatch(/placeholder-shown/)
    expect(raw).not.toMatch(/!important/)
  })

})

// ---------------------------------------------------------------------------
// O que fica à vista na faixa pequena, pelo estilo COMPUTADO: o planningChat.css
// real vai para o documento e cada elemento real é conferido com ele e com os
// ancestrais (display:none em qualquer um esconde). Nada de reescrever seletor.
// ---------------------------------------------------------------------------

describe('faixa pequena — o que some e o que fica (CSS real, estilo computado)', () => {
  let style: HTMLStyleElement
  beforeEach(() => {
    style = document.createElement('style')
    style.textContent = readFileSync(resolve(process.cwd(), 'src/renderer/src/planning/planningChat.css'), 'utf8')
    document.head.appendChild(style)
  })
  afterEach(() => style.remove())

  const shown = (el: Element | null): boolean => {
    if (!el) return false
    for (let x: Element | null = el; x; x = x.parentElement) if (getComputedStyle(x).display === 'none') return false
    return true
  }

  it('sem turno rodando: some @, anexo, microfone, revisar, enviar e a barra do modelo; a caixa fica', () => {
    const { container, small, box } = renderChat()
    expect(small()).toBe(true)
    const row = container.querySelector('.composer-row') as HTMLElement
    const hidden = [...row.querySelectorAll('button'), container.querySelector('.composer-bar .model-select')]
    expect(hidden.length).toBeGreaterThanOrEqual(6)
    for (const b of hidden) expect(shown(b), b?.outerHTML.slice(0, 80)).toBe(false)
    expect(shown(box())).toBe(true)
  })

  it('com texto, os botões voltam (o CSS da faixa só vale sem texto)', () => {
    const { container, type } = renderChat()
    type('a')
    expect(shown(container.querySelector('.composer-row .btn.send'))).toBe(true)
    expect(shown(container.querySelector('.composer-row .mic-btn'))).toBe(true)
  })

  it('turno em andamento (busy): o "parar" fica visível e clicável na faixa vazia', () => {
    const onInterrupt = vi.fn()
    const { container, small } = renderChat({ busy: true, onInterrupt })
    expect(small()).toBe(true)
    const stop = screen.getByTitle('Parar tarefa atual')
    expect(shown(stop)).toBe(true)
    expect((stop as HTMLButtonElement).disabled).toBe(false)
    // O resto some mesmo assim — o enviar é um .btn também.
    expect(shown(container.querySelector('.composer-row .btn.send'))).toBe(false)
    fireEvent.click(stop)
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })

  it('microfone GRAVANDO continua visível na faixa (gravação real: clique, getUserMedia, classe recording)', async () => {
    const trackStop = vi.fn()
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }))
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
    try {
      // Grava com o chat aberto e a caixa vazia; depois minimiza — cai na faixa pequena.
      const { container, small } = renderChat({ minimized: false })
      const mic = container.querySelector('.composer-row .mic-btn') as HTMLElement
      fireEvent.click(mic)
      await waitFor(() => expect(mic.classList.contains('recording')).toBe(true))
      expect(getUserMedia).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByRole('button', { name: 'Minimizar o chat do Agent Manager' }))
      expect(small()).toBe(true)
      expect(shown(mic)).toBe(true)
      // O resto da faixa continua escondido, inclusive o seletor de microfone.
      expect(shown(container.querySelector('.composer-row .mic-caret'))).toBe(false)
      expect(shown(container.querySelector('.composer-row .btn.send'))).toBe(false)
      // Parar a gravação pelo microfone da faixa (o clique também abre o chat,
      // como qualquer clique no minimizado). Minimizado de novo, ele volta a sumir.
      fireEvent.click(mic)
      await waitFor(() => expect(mic.classList.contains('recording')).toBe(false))
      expect(trackStop).toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Minimizar o chat do Agent Manager' }))
      expect(small()).toBe(true)
      expect(shown(mic)).toBe(false)
    } finally {
      Reflect.deleteProperty(navigator, 'mediaDevices')
    }
  })

  it('StrictMode: montar minimizado com rascunho restaurado já vem em tamanho normal, com os botões', () => {
    const { small, container } = renderChat({ draft: 'texto', strict: true })
    expect(small()).toBe(false)
    expect(shown(container.querySelector('.composer-row .btn.send'))).toBe(true)
  })

  it('StrictMode: voltar a uma conversa com rascunho tira a faixa na hora; sem rascunho, volta', () => {
    const { small, switchTo } = renderChat({ strict: true })
    expect(small()).toBe(true)
    switchTo('c2', 'rascunho guardado')
    expect(small()).toBe(false)
    switchTo('c3', '')
    expect(small()).toBe(true)
  })
})
