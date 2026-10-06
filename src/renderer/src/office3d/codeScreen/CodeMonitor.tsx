/**
 * A tela focada do monitor do agente (clique nele no Escritório 3D), alinhada
 * ao monitor pela âncora do motor. Dois apps, cada um com a própria barra de
 * título, abertos pela barra de tarefas embaixo (estilo Windows, Taskbar):
 *
 *   Código    a janela no jeito do VS Code com os arquivos que o Agent alterou e
 *             leu (CodeView, useCodeApp) e, à direita, o Chat (ChatDock): o
 *             turno como o chat mostra, com o `composer` embaixo quando quem
 *             monta o dá. O cartão de arquivo do Chat abre o arquivo no editor
 *             (chatOpen.ts); a borda entre os dois ajusta a largura do Chat. O
 *             .html do Agent tem a aba "Prévia" (htmlPreview.ts): o agente que
 *             acabou de criar um abre a tela já nela (freshHtmlWrite)
 *   Contexto  o que o Agent recebeu e o que fez, com o modelo de cada coisa
 *             (ContextApp — lê o histórico do contexto só enquanto aberto)
 *
 * Abre no último app usado (localStorage; o 'chat' de antes vale Código); na 1ª
 * vez, em `initialMode`. A raiz é a `data-testid="office-screen"`, com
 * `data-kind` = code | context | empty e `data-mode` = o app. Alt+1/2 trocam de
 * app com a tela aberta; Esc fecha o menu do Agent, se aberto, e senão a tela
 * (o motor). A barra some até o mouse chegar à borda de baixo; o alfinete a
 * fixa e o campo do Chat fica acima.
 *
 * O Chat usa o ToolCard do chat, que pede o UiProvider do app.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { modelDisplayName } from '@shared/modelLabel'
import type { OfficeFeed } from '../../office/adapter/feed'
import { roomName, type OfficeCharacterModel } from '../../office/adapter/model'
import type { UIMessage } from '../../types'
import { freshHtmlWrite, scanHtmlWrites } from '../agentHtml'
import { seedCss } from '../appearance'
import { lookupOf, trackMessages, trackOf, turnHead } from '../chatPage'
import { chatContent, type ChatContent } from '../ChatScreen'
import { ChatDock, MonitorChat, NARROW_W, useWidth } from './ChatDock'
import { openInEditor, useChatFileOpen, type ChatFileOpenInput } from './chatOpen'
import { ContextApp } from './ContextApp'
import { allContextText, contextBlocks } from './contextView'
import { CodeStatus, CodeView } from './CodeView'
import { FLASH_MS } from './EditorPane'
import { lastWriteOf, useHtmlPreview } from './htmlPreview'
import { Icon, VsCodeLogo } from './icons'
import { distinctModels } from './modelTags'
import { MONITOR_APPS, monitorPrefs, type MonitorApp } from './monitorPrefs'
import { diskReadVerdict } from './pathGuard'
import { contextUse, lastResult, sessionEffort, sessionModel, turnElapsed } from './monitorStatus'
import { Taskbar, useTaskbarReveal, APP_LABEL } from './Taskbar'
import { AppPreview, callsByModel, Coach, StartMenu, Toasts, Tray } from './TaskbarExtras'
import { useCodeApp } from './useCodeApp'
import { useMonitorToasts, type MonitorToast } from './useMonitorToasts'
import './codeScreen.css'
import './codeEditor.css'
import './taskbar.css'
import './contextApp.css'

export interface CodeMonitorProps {
  feed: OfficeFeed | null
  model: OfficeCharacterModel
  /** Fecha a tela (o mesmo do Esc). */
  onClose?: () => void
  /** O app na 1ª abertura (sem nenhum lembrado). O Escritório abre no Código (com o Chat ao lado). */
  initialMode?: MonitorApp
  /**
   * O campo de digitar da conversa (o Composer do App), embaixo do Chat. Fica
   * montado também no Contexto (escondido): trocar de app não perde o rascunho.
   */
  composer?: ReactNode
  /** Bateria do escritório (energia do plano, %), para a bandeja; null sem leitura. */
  battery?: number | null
  /** "Abrir no app" do menu do Agent: a conversa dele na aba Conversa. */
  onOpenInApp?: (convId: string) => void
}

const NO_MESSAGES: readonly UIMessage[] = []
/** No Contexto o turno do Chat não é montado: nada a montar a cada pedaço do feed. */
const NO_CHAT: ChatContent = { messages: [], live: null }

/** A cor do texto sobre a cor do Agent (a que contrasta mais) e o tom do bloco da esquerda. */
function agentInk(css: string): { ink: string; shade: string } {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(css)
  if (!m) return { ink: '#ffffff', shade: 'rgba(0, 0, 0, 0.18)' }
  const [r, g, b] = m.slice(1).map((v) => {
    const c = Number(v) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const dark = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179
  return dark ? { ink: '#161616', shade: 'rgba(255, 255, 255, 0.24)' } : { ink: '#ffffff', shade: 'rgba(0, 0, 0, 0.2)' }
}

let memoriesDirCache: string | null = null
/** A pasta de memórias do app (para separar a leitura de memória das outras). */
function useMemoriesDir(): string | null {
  const [dir, setDir] = useState(memoriesDirCache)
  useEffect(() => {
    if (memoriesDirCache !== null) return
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.getCacheInfo !== 'function') return
    let alive = true
    void api.getCacheInfo().then((info) => {
      memoriesDirCache = info.memoriesDir
      if (alive) setDir(info.memoriesDir)
    }, () => undefined)
    return () => {
      alive = false
    }
  }, [])
  return dir
}

/** Uma tela por personagem: trocar o foco recomeça do zero (aba, seguir, cache do disco) — nada vaza de um Agent para outro. */
export function CodeMonitor(props: CodeMonitorProps): JSX.Element {
  return <Monitor key={props.model.key} {...props} />
}

function Monitor({ feed, model, onClose, initialMode = 'code', composer, battery = null, onOpenInApp }: CodeMonitorProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLElement>(null)
  // O agente acabou de criar um .html que a Prévia abre (de dentro da pasta da conversa): a tela abre no Código com a Prévia dele (sem mudar o app lembrado).
  const [fresh] = useState(() => {
    const w = feed ? freshHtmlWrite(feed, model, Date.now()) : null
    return w && diskReadVerdict(w.path, feed?.conversations.find((c) => c.id === model.convId)?.cwd ?? '') === 'ok' ? w : null
  })
  const [app, setAppState] = useState<MonitorApp>(() => (fresh ? 'code' : (monitorPrefs.app() ?? initialMode)))
  const [pinned, setPinned] = useState(() => monitorPrefs.pinned())
  const [coachSeen, setCoachSeen] = useState(() => monitorPrefs.coachSeen())
  const [startOpen, setStartOpen] = useState(false)
  const [hoverApp, setHoverApp] = useState<MonitorApp | null>(null)
  const [resentSignal, setResentSignal] = useState(0)
  const [turnModels, setTurnModels] = useState<Array<{ model: string; calls: number | null }> | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // O arquivo que o Chat abriu (o trecho dele pisca) e o "ir ao fim do chat" (com o campo em foco).
  const [flash, setFlash] = useState<{ key: string; n: number } | null>(null)
  const [go, setGo] = useState({ n: 0, focus: false })
  const reveal = useTaskbarReveal(rootRef, barRef, pinned, startOpen)
  const setApp = useCallback((a: MonitorApp) => {
    setAppState(a)
    monitorPrefs.setApp(a)
  }, [])
  const goChat = useCallback((focus: boolean) => setGo((g) => ({ n: g.n + 1, focus })), [])
  const showChat = useCallback(() => goChat(true), [goChat])
  // O explorador abriu ou fechou (estado do CodeView): o teto do Chat é medido de novo (ChatDock).
  const [, relayout] = useReducer((n: number) => n + 1, 0)
  // O pisca vale para o clique: passado FLASH_MS, voltar ao arquivo (outra aba, o Contexto, a Prévia) não pisca de novo.
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(t)
  }, [flash])
  // Tela estreita (o cartão sem mesa, ~420 px): o editor não cabe; o Chat ocupa a janela.
  const screenW = useWidth(rootRef)
  const narrow = screenW > 0 && screenW < NARROW_W

  const isMain = model.role === 'principal' && !model.trackId
  const track = trackOf(feed, lookupOf(model))
  const conv = feed?.conversations.find((c) => c.id === model.convId)
  const convMessages = isMain ? conv?.messages : undefined
  const messages = useMemo(() => (track ? trackMessages(track) : (convMessages ?? NO_MESSAGES)), [track, convMessages])
  const head = turnHead(feed, model)
  const cwd = conv?.cwd ?? ''
  const project = cwd ? roomName(cwd) : head.who
  const permission = feed?.permissions[model.convId]
  const needsYou = !!permission
  const memoriesDir = useMemoriesDir()

  const code = useCodeApp(messages, { convId: isMain ? model.convId : null, cwd, busy: head.busy, visible: app === 'code' && !narrow })
  const turnActionModels = code.actions.models
  const effort = sessionEffort(conv)
  // O modelo do rodapé: o das ações do turno; trabalhando e sem ação ainda, o da sessão.
  const footerModels = turnActionModels.length ? turnActionModels : head.busy && isMain ? distinctModels([sessionModel(conv)]) : []
  const mixed = turnActionModels.length > 1

  const memoriesCount = code.actions.memory.read.length + code.actions.memory.saved.length
  const { toasts, dismiss, push } = useMonitorToasts({ convId: model.convId, messages, busy: head.busy, permission, counts: { files: code.changed, memories: memoriesCount } })
  const pages = useHtmlPreview(code)
  // A Prévia à vista (a tela estreita não tem editor) recarrega a cada escrita nova do arquivo (o id da última que deu certo).
  const page = narrow ? null : pages.active
  const pageWrite = page && feed ? lastWriteOf(scanHtmlWrites(feed, [model]), page.key) : null
  // O cartão do Chat abre pelo mesmo caminho das abas: escolher um arquivo sai da Prévia (o .html escrito volta a ela).
  const openInput: ChatFileOpenInput = { code: { changedItems: code.changedItems, reads: code.reads, open: pages.onSelect, onBrowse: pages.onBrowse }, cwd, flash: (key) => setFlash((f) => ({ key, n: (f?.n ?? 0) + 1 })), toast: push, page: pages.open }
  const opener = useChatFileOpen(openInput)
  useEffect(() => {
    if (fresh) openInEditor(openInput, fresh.path, true)
    // Só ao abrir a tela (o clique no agente).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A barra abriu pela 1ª vez: a dica some para sempre.
  useEffect(() => {
    if (!reveal.open || coachSeen) return
    setCoachSeen(true)
    monitorPrefs.setCoachSeen()
  }, [reveal.open, coachSeen])

  // Relógio do turno na bandeja (só com a tela aberta, uma vez por segundo trabalhando).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), head.busy ? 1000 : 30_000)
    return () => clearInterval(t)
  }, [head.busy])

  // Alt+1/2 trocam de app; Esc fecha o menu antes de fechar a tela (captura: antes do motor).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const at = Number(e.key) - 1
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^\d$/.test(e.key) && at >= 0 && at < MONITOR_APPS.length) {
        e.preventDefault()
        e.stopPropagation()
        setApp(MONITOR_APPS[at])
        return
      }
      if (e.key === 'Escape' && startOpen) {
        e.preventDefault()
        e.stopPropagation()
        setStartOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [startOpen, setApp])

  // Clique fora do menu do Agent fecha o menu.
  useEffect(() => {
    if (!startOpen) return
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Element | null
      if (t?.closest?.('.cm-startmenu, .cm-tb-start')) return
      setStartOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [startOpen])

  // O menu do Agent: os modelos do turno com as chamadas de cada um (o resumo do histórico).
  const subagentTurn = useMemo(() => {
    if (!track) return null
    const spawn = conv?.messages.find((m) => m.kind === 'tool-use' && m.id === track.id)
    const ids = spawn ? (spawn as { turnIds?: string[] }).turnIds : undefined
    return { parentToolUseId: track.id, turnId: ids?.[0] ?? null }
  }, [track, conv?.messages])
  useEffect(() => {
    if (!startOpen) return
    setTurnModels(null)
    const api = typeof window !== 'undefined' ? window.api : undefined
    const fallback = (): void => setTurnModels(turnActionModels.map((m) => ({ model: m, calls: null })))
    if (track || typeof api?.listContextTurns !== 'function') return fallback()
    let alive = true
    void api.listContextTurns(model.convId).then(
      (list) => {
        if (!alive) return
        const latest = list[0]
        if (latest && latest.models.length) setTurnModels(callsByModel(latest.models))
        else fallback()
      },
      () => alive && fallback()
    )
    return () => {
      alive = false
    }
    // Lido quando o menu abre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startOpen])

  const copyContext = async (): Promise<void> => {
    setStartOpen(false)
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.listContextTurns !== 'function' || typeof api.readContextTurn !== 'function') return
    const list = await api.listContextTurns(model.convId).catch(() => [])
    const turnId = subagentTurn?.turnId ?? list[0]?.turnId
    const detail = turnId ? await api.readContextTurn(model.convId, turnId, subagentTurn?.parentToolUseId).catch(() => null) : null
    const text = detail ? allContextText(contextBlocks({ detail, subagent: !!subagentTurn })) : ''
    if (!text) {
      push({ id: 'copy', kind: 'warn', icon: 'alert', app: 'ctx', title: 'Nada para copiar', body: 'Este turno não tem contexto gravado.' })
      return
    }
    await navigator.clipboard?.writeText(text).catch(() => undefined)
    push({ id: 'copy', kind: 'ok', icon: 'copy', app: 'ctx', title: 'Contexto copiado', body: 'Sem as senhas: cada uma vai como [senha: nome].' })
  }

  const openToast = (t: MonitorToast): void => {
    dismiss(t.id)
    setApp(t.app)
    if (t.file) pages.onSelect(t.file)
    if (t.resent) setResentSignal((n) => n + 1)
    // A permissão: o fim do Chat, onde o Agent parou esperando.
    if (t.id === 'perm') goChat(false)
  }
  const openFile = useCallback(
    (key: string) => {
      setApp('code')
      pages.onSelect(key)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setApp, pages.onSelect]
  )

  const agent = useMemo(() => seedCss(model.seed), [model.seed])
  const { ink, shade } = agentInk(agent)
  const chat = app === 'code' ? chatContent(feed, model, code.live.latest) : NO_CHAT
  const kind = app === 'ctx' ? 'context' : code.items.length > 0 || code.terminal.length > 0 ? 'code' : 'empty'
  const agentName = isMain ? 'Agent principal' : `Agent · ${head.who}`
  const agentModel = isMain ? sessionModel(conv) : (turnActionModels[turnActionModels.length - 1] ?? '')
  const result = lastResult(messages)
  const elapsed = turnElapsed(head.busy, feed?.busySince[model.convId], result, now)
  const ctxUse = contextUse(conv)
  const open = reveal.open || startOpen

  const mood = needsYou
    ? 'Parado na porta: precisa da sua permissão para continuar.'
    : head.busy
      ? code.typingName
        ? `Digitando ${code.typingName}.`
        : 'Lendo e pensando.'
      : `Turno fechado: ${code.changed === 1 ? '1 arquivo alterado' : `${code.changed} arquivos alterados`}.`

  const preview = hoverApp && !startOpen ? previewOf(hoverApp) : null
  function previewOf(a: MonitorApp): ReactNode {
    if (a === 'code') {
      return (
        <>
          {code.typingName && <div>Digitando {code.typingName}</div>}
          {code.changedItems.slice(0, 5).map((t) => (
            <div key={t.key}>{t.name}</div>
          ))}
          {code.changedItems.length === 0 && <div>Nenhum arquivo alterado ainda.</div>}
          {code.reads.length > 0 && <div className="cm-dim">{code.reads.length === 1 ? '1 arquivo só lido' : `${code.reads.length} arquivos só lidos`}</div>}
          {needsYou && <div>Esperando a sua permissão no Chat.</div>}
        </>
      )
    }
    const others = code.actions.other.reduce((n, g) => n + g.items.length, 0) + code.reads.length
    return (
      <div>
        Contexto ocupado: {ctxUse.pct}% · {memoriesCount === 1 ? '1 memória' : `${memoriesCount} memórias`} · {others === 1 ? '1 ação' : `${others} ações`}
      </div>
    )
  }
  const previewLeft = (() => {
    if (!hoverApp) return 0
    const btn = barRef.current?.querySelector<HTMLElement>(`[data-app="${hoverApp}"]`)
    const width = rootRef.current?.clientWidth ?? 1280
    return btn ? Math.max(8, Math.min(width - 278, btn.offsetLeft + btn.offsetWidth / 2 - 135)) : 8
  })()

  return (
    <div
      ref={rootRef}
      className={`cm-root${pinned ? ' pinned' : ''}${open ? ' tb-open' : ''}`}
      data-testid="office-screen"
      data-kind={kind}
      data-mode={app}
      style={{ '--cm-agent': agent, '--cm-on-agent': ink, '--cm-agent-shade': shade } as CSSProperties}
    >
      <section className="cm-win" data-app={app} aria-label={APP_LABEL[app]}>
        <header className="cm-titlebar">
          <span className="cm-logo" aria-hidden="true">
            {app === 'code' ? <VsCodeLogo size={16} /> : <span className="cm-appico-ctx"><Icon name="layers" /></span>}
          </span>
          <span className="cm-title" title={head.title}>
            {app === 'code' ? <b>{page ? `Prévia: ${page.name}` : (code.activeName ?? 'Agent')}</b> : <b>{APP_LABEL[app]}</b>}
            {app === 'ctx' ? (
              <span className="cm-title-project"> — o que o Agent recebeu e o que fez neste turno</span>
            ) : (
              <>
                {project && app === 'code' && <span className="cm-title-project"> — {project}</span>}
                {head.title && <span className="cm-title-conv"> {app === 'code' ? '·' : '—'} {head.title}</span>}
              </>
            )}
          </span>
          {onClose && (
            <button type="button" className="cm-close" onClick={onClose} aria-label="Fechar a tela" title="Fechar (Esc)">
              <Icon name="close" />
            </button>
          )}
        </header>
        <ChatDock
          chatOn={app === 'code'}
          narrow={narrow}
          status={app === 'code' ? <CodeStatus code={code} who={isMain ? '' : head.who} models={footerModels} effort={effort} page={page} /> : null}
          onWidthSaved={(w) => push({ id: 'chat-width', kind: 'ok', icon: 'check', app: 'code', title: 'Largura do chat guardada', body: `${w} px · vale para todos os monitores` })}
          chat={
            <MonitorChat
              head={head}
              seed={model.seed}
              content={chat}
              who={[agentName, modelDisplayName(agentModel)].filter(Boolean).join(' · ')}
              state={needsYou ? 'you' : head.busy ? 'busy' : 'idle'}
              composer={composer}
              hidden={app !== 'code'}
              opener={narrow ? null : opener}
              go={go}
            />
          }
        >
          {app === 'ctx' ? (
            <ContextApp
              convId={model.convId}
              messages={messages}
              subagent={subagentTurn}
              memoriesDir={memoriesDir}
              focusResent={resentSignal}
              onOpenFile={openFile}
              onOpenChat={() => {
                setApp('code')
                goChat(true)
              }}
              onToast={push}
            />
          ) : narrow ? null : (
            <CodeView
              items={code.items}
              changedItems={code.changedItems}
              reads={code.reads}
              mixed={mixed}
              activeKey={code.activeKey}
              activePath={code.activePath}
              view={code.view}
              terminal={code.terminal}
              cwd={cwd}
              project={project}
              busy={head.busy}
              activity={model.label}
              changed={code.changed}
              follow={code.follow}
              target={code.target}
              targetKey={code.targetKey}
              flash={flash}
              pages={pages.pages}
              page={page}
              pageWrite={pageWrite}
              onSelect={pages.onSelect}
              onSelectPage={pages.onSelectPage}
              onOpenPage={pages.onOpenPage}
              onBrowse={pages.onBrowse}
              onUserScroll={code.onUserScroll}
              onShowChat={showChat}
              onLayout={relayout}
            />
          )}
        </ChatDock>
      </section>
      {!coachSeen && !pinned && !open && <Coach onClose={() => { setCoachSeen(true); monitorPrefs.setCoachSeen() }} />}
      <Taskbar
        app={app}
        pinned={pinned}
        reveal={reveal}
        barRef={barRef}
        badges={{ code: code.changed, ctx: memoriesCount }}
        busy={head.busy}
        needsYou={needsYou}
        startOpen={startOpen}
        tray={<Tray context={ctxUse} battery={battery} busy={head.busy} needsYou={needsYou} elapsed={elapsed} now={new Date(now)} />}
        onOpenApp={(a) => {
          setStartOpen(false)
          setApp(a)
        }}
        onToggleStart={() => {
          setHoverApp(null)
          setStartOpen((o) => !o)
        }}
        onTogglePin={() => {
          // Fora do updater: o React pode chamá-lo mais de uma vez.
          const next = !pinned
          setPinned(next)
          monitorPrefs.setPinned(next)
        }}
        onHoverApp={setHoverApp}
      />
      {startOpen && (
        <StartMenu
          name={agentName}
          model={agentModel}
          effort={effort}
          turnModels={turnModels}
          conversation={conv?.title ?? head.title}
          project={project}
          busy={head.busy}
          needsYou={needsYou}
          mood={mood}
          elapsed={elapsed}
          context={ctxUse}
          outputTokens={head.busy ? null : (result?.outputTokens ?? null)}
          costUsd={head.busy ? null : (result?.costUsd ?? null)}
          onCopyContext={() => void copyContext()}
          onOpenInApp={onOpenInApp ? () => { setStartOpen(false); onOpenInApp(model.convId) } : undefined}
        />
      )}
      {preview && hoverApp && (
        <AppPreview app={hoverApp} left={previewLeft}>
          {preview}
        </AppPreview>
      )}
      <Toasts toasts={toasts} onOpen={openToast} />
    </div>
  )
}
