/**
 * O Escritório 3D em tela cheia: a aba "Escritório" da área principal
 * (components/MainTabs) ocupa tudo abaixo da barra superior, no lugar do
 * workspace e da Tela de Planejamento. O chat flutua por cima (OfficeChatFloat)
 * e o HUD (OfficeHud) traz a energia, o aviso do Controle do Windows e a legenda das teclas.
 *
 * O chat flutuante segue a mesa selecionada: com um agente focado (ou uma
 * conversa escolhida fora do 3D) ele mostra a conversa ativa (`chat`, o MESMO
 * ChatPanel do workspace); sem mesa, o painel da Central (`central`). Clicar
 * num agente seleciona a conversa exata dele (`model.convId` — a mesma que o
 * monitor mostra, sem decisor). O usuário desfazer a seleção (Esc, clique no
 * vazio, × da tela, girar/arrastar/zoom/WASD) volta à Central sem trocar a
 * conversa ativa; o motor fechar a tela sozinho (📍, follow, o agente saiu)
 * não. Abrir a aba sem mesa mostra a Central; reabrir com um agente focado
 * seleciona a conversa dele. Sem `central`, o chat é sempre a conversa ativa.
 *
 * O motor (three puro) nasce na montagem e vive enquanto a aba existir: com
 * `active` false (aba Conversa) ele fica PAUSADO — sem RAF, sem simulação, sem
 * textura redesenhada — e volta na hora, com a mesma câmera. Com a aba fechada
 * também não existem a tela do monitor (<ChatScreen>, nem as assinaturas dela
 * no feed e no código ao vivo), a prévia, o telão nem o HUD de desempenho; ao
 * voltar, a tela renasce já com o feed que o motor retomou. Desmontar libera
 * GPU, listeners (os do navegador também) e RAF.
 *
 * Mouse parado num agente (PREVIEW_DELAY_MS): a prévia (<ChatPreview>) com as
 * últimas entradas do turno dele, acima do monitor. Clique num agente voa até o
 * monitor dele e abre por cima, alinhado ao monitor, o turno da conversa como
 * o chat mostra (<ChatScreen>); clique na tela acesa de um projetor abre o
 * telão (<ProjectorOverlay>, com o "Abrir na aba Conversa" de `onShowBrowser`);
 * duplo clique abre a conversa dele no chat flutuante (que expande). Clique no
 * balão de um pedido (permissão, pergunta) leva ao pedido (`onFocusRequest`:
 * o App seleciona a conversa e abre o modal); nos outros balões, foca o agente.
 * Trocar de conversa fora do 3D (sidebar) com a aba aberta voa até o agente
 * dela, salvo se o usuário mexeu na câmera há pouco ou se a tela aberta já é
 * dela (engine.follow), e nunca para a Central (que não tem mesa); só a 1ª
 * conversa desde a montagem (o app acabou de carregar) não leva a câmera. O 📍
 * do chat minimiza o chat e voa até a mesa do agente. Os balões de fala são do
 * motor (speech.ts), numa camada DOM dentro do palco.
 *
 * Só em DEV e com a aba aberta: Ctrl+Alt+Shift+D liga/desliga a demonstração
 * animada (um tique de DEMO_TICK_MS republica demoFeed(Date.now()) no
 * officeStore e o motor encurta o cochilo; desligar, fechar a aba ou desmontar
 * limpa o intervalo e o override), Ctrl+Alt+Shift+P abre/fecha o HUD de
 * desempenho (<PerfHud>) e Ctrl+Alt+Shift+B força o próximo nível de energia.
 */
import './office3d.css'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { isCentralConversation } from '@shared/central'
import { principalKey } from '../office/adapter/model'
import { officeStore } from '../office/officeStore'
import { ChatPreview, useHoverPreview } from './ChatPreview'
import { ChatScreen } from './ChatScreen'
import { DEMO_TICK_MS, demoFeed } from './demoFeed'
import { Office3DEngine, type EngineCallbacks, type EngineOptions } from './engine'
import { OfficeChatFloat, type OfficeConversation } from './OfficeChatFloat'
import { OfficeHud } from './OfficeHud'
import { isPerfShortcut, PerfHud } from './PerfHud'
import type { OfficePower } from './power'
import { ProjectorOverlay } from './ProjectorOverlay'

export interface Office3DWorkspaceProps {
  /** A aba está à vista; false pausa o motor (padrão: true). */
  active?: boolean
  /** O ChatPanel da conversa ativa; sem ele e sem `central` (aba fechada), sem chat flutuante. */
  chat: ReactNode
  /** O painel da Central: o chat flutuante o mostra quando nenhuma mesa está selecionada. Sem ele, sempre `chat`. */
  central?: ReactNode
  /** A conversa ativa: cabeçalho do chat e o voo da câmera quando ela muda. */
  conversation?: OfficeConversation | null
  /** Seleciona a conversa (clique ou duplo clique num agente, aba reaberta com um agente focado). */
  onOpenConversation: (convId: string) => void
  /** Sem uso desde que a tela do monitor segue o chat (o ToolCard abre o arquivo pelo Preview); mantido para o App. */
  onOpenFile?: (path: string) => void
  /** Balão de pedido (permissão, pergunta) clicado: leva ao pedido da conversa. Sem ele, o balão foca o agente. */
  onFocusRequest?: (convId: string) => void
  /** O telão do projetor: abre a conversa dele com o navegador, na aba Conversa. Sem ele, sem o botão. */
  onShowBrowser?: (convId: string) => void
  /** Controle do Windows ligado: o HUD mostra o aviso (o chat minimizado o esconde). */
  windowsControlEnabled?: boolean
  /** O "Desativar" do aviso — o mesmo do aviso do chat. */
  onDisableWindowsControl?: () => void
  /** Só testes: renderer, RAF e fonte do feed injetáveis. */
  engineOptions?: EngineOptions
}

/** Atalho de DEV: Ctrl+Alt+Shift+D. */
export function isDemoShortcut(e: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>): boolean {
  return e.ctrlKey && e.altKey && e.shiftKey && e.key.toLowerCase() === 'd'
}

/** Atalho de DEV: Ctrl+Alt+Shift+B (força o próximo nível de energia). */
export function isPowerShortcut(e: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>): boolean {
  return e.ctrlKey && e.altKey && e.shiftKey && e.key.toLowerCase() === 'b'
}

export function Office3DWorkspace({
  active = true,
  chat,
  central = null,
  conversation = null,
  onOpenConversation,
  onFocusRequest,
  onShowBrowser,
  windowsControlEnabled = false,
  onDisableWindowsControl,
  engineOptions
}: Office3DWorkspaceProps): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Office3DEngine | null>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hud, setHud] = useState(false)
  const [power, setPower] = useState<OfficePower | null>(null)
  // Sobem a cada duplo clique num agente (o chat expande com a conversa dele) e a cada 📍 (minimiza).
  const [expand, setExpand] = useState(0)
  const [collapse, setCollapse] = useState(0)
  // Nenhuma mesa selecionada (nem conversa escolhida fora do 3D): o chat flutuante mostra a Central.
  const [showCentral, setShowCentral] = useState(true)
  const [, setTick] = useState(0)
  // Prévia do hover: o agente sob o mouse há PREVIEW_DELAY_MS. Telão: a sala cujo projetor foi clicado.
  const [previewKey, onHover] = useHoverPreview(active)
  const [projectorRoom, setProjectorRoom] = useState<string | null>(null)
  const cbs = useRef({ onOpenConversation, onFocusRequest, onHover })
  cbs.current = { onOpenConversation, onFocusRequest, onHover }
  const activeRef = useRef(active)
  activeRef.current = active
  const source = engineOptions?.source ?? officeStore
  const readEngine = useCallback(() => engineRef.current, [])

  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return
    const callbacks: EngineCallbacks = {
      onFocus: (key, byUser) => {
        setFocusKey(key)
        // O motor fechou a tela sozinho (voo, follow, o agente saiu): o chat fica onde está.
        if (!byUser) return
        // O usuário desfez a seleção: sem mesa, a Central (a conversa ativa não muda).
        if (!key) {
          // O painel troca de conteúdo: o campo com foco nele (a roda não tira o foco) grava o rascunho antes, no blur.
          const el = document.activeElement
          if (el instanceof HTMLElement && el.closest('.o3d-chat')) el.blur()
          return setShowCentral(true)
        }
        // Clique no agente: o chat vai para a conversa exata dele (a que o monitor mostra).
        const conv = engineRef.current?.scene.character(key)?.model.convId
        if (!conv) return
        setShowCentral(false)
        cbs.current.onOpenConversation(conv)
      },
      onOpen: (convId) => {
        setExpand((n) => n + 1)
        setShowCentral(false)
        cbs.current.onOpenConversation(convId)
      },
      onPower: setPower,
      onHover: (key) => cbs.current.onHover(key),
      onProjector: setProjectorRoom,
      // Lido na hora do clique: o pedido vai para o callback do render atual (sem ele, o balão foca o agente).
      get onFocusRequest() {
        return cbs.current.onFocusRequest
      }
    }
    let engine: Office3DEngine
    try {
      engine = new Office3DEngine(stage, canvas, callbacks, engineOptions)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    engineRef.current = engine
    // Montado com a aba fechada (só testes; o App monta na 1ª abertura): já nasce parado.
    if (!activeRef.current) engine.pause()
    return () => {
      engine.dispose()
      engineRef.current = null
      setFocusKey(null)
      setPower(null)
      setProjectorRoom(null)
    }
    // engineOptions é fixo por montagem (testes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const convId = conversation?.id ?? null
  const convIsCentral = isCentralConversation(conversation)

  // Aba fechada: motor montado e parado; de volta, retoma na hora (feed guardado,
  // palco remedido) e o componente re-renderiza com o que o motor tem agora —
  // a tela do monitor não mostra nada de antes da pausa. Antes da pintura.
  // De volta, o chat segue a mesa selecionada: a conversa do agente que ficou
  // focado (selecionada se não for a ativa) ou, sem mesa, a Central.
  useLayoutEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    if (active) {
      engine.resume()
      setTick((t) => t + 1)
      const key = engine.focused
      const focusConv = key ? engine.scene.character(key)?.model.convId : undefined
      setShowCentral(!focusConv)
      if (focusConv && focusConv !== convId) cbs.current.onOpenConversation(focusConv)
    } else {
      engine.pause()
    }
    // Só a troca de aba conta; a conversa ativa é a deste render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // Conversa trocada fora do 3D com a aba aberta: o chat flutuante passa a
  // mostrá-la e a câmera vai até o agente dela (a Central não tem mesa). Só a
  // 1ª conversa desde a montagem (o app acabou de carregar as conversas) não
  // conta; depois, toda troca conta — inclusive id → null → id (apagar a
  // última conversa e criar outra).
  const seenConv = useRef(convId)
  const hadConv = useRef(convId !== null)
  useEffect(() => {
    const prev = seenConv.current
    if (prev === convId) return
    seenConv.current = convId
    const had = hadConv.current
    if (convId) hadConv.current = true
    if (!active || !convId || !had) return
    setShowCentral(false)
    if (!convIsCentral) engineRef.current?.follow(convId)
  }, [convId, active, convIsCentral])

  // Aba fechada: o telão fecha.
  useEffect(() => {
    if (!active) setProjectorRoom(null)
  }, [active])

  // Com a tela, a prévia ou o telão aberto e a aba à vista, o conteúdo acompanha o feed.
  const showing = !!focusKey || !!previewKey || !!projectorRoom
  useEffect(() => {
    if (!showing || !active) return
    return source.subscribe(() => setTick((t) => t + 1))
  }, [showing, source, active])

  // Só DEV e com a aba aberta: demonstração animada (linha do tempo do demoFeed,
  // um quadro por tique) e HUD de desempenho. Fechar a aba para a demo e limpa o override.
  useEffect(() => {
    if (!import.meta.env.DEV || !active) return
    let timer: ReturnType<typeof setInterval> | null = null
    const publish = (): void => officeStore.setOverride(demoFeed(Date.now()))
    const stop = (): void => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
      engineRef.current?.setDemo(false)
      officeStore.setOverride(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (isPerfShortcut(e)) {
        e.preventDefault()
        setHud((on) => !on)
        return
      }
      if (isPowerShortcut(e)) {
        e.preventDefault()
        engineRef.current?.cyclePower()
        return
      }
      if (!isDemoShortcut(e)) return
      e.preventDefault()
      if (timer !== null) return stop()
      // Na demo o cochilo chega mais cedo (o loop tem 2 min, o sono pede 10).
      engineRef.current?.setDemo(true)
      publish()
      timer = setInterval(publish, DEMO_TICK_MS)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      stop()
    }
  }, [active])

  const engine = engineRef.current
  const feed = engine?.currentFeed ?? null
  const focused = active && focusKey && engine ? engine.scene.character(focusKey) : undefined
  // A prévia não aparece no agente que já está com a tela aberta.
  const previewed = active && previewKey && previewKey !== focusKey && engine ? engine.scene.character(previewKey) : undefined
  // Estáveis: o motor só ouve quando a tela (ou a prévia) nasce ou some, não a cada render do App.
  const screenRef = useCallback((el: HTMLDivElement | null): void => engineRef.current?.setScreenElement(el), [])
  const previewRef = useCallback((el: HTMLDivElement | null): void => engineRef.current?.setPreviewElement(el), [])
  // O × da tela é o usuário desfazendo a seleção (o chat volta à Central).
  const closeScreen = useCallback(() => engineRef.current?.leaveFocus(true, true), [])
  const projector = active && projectorRoom && engine ? engine.scene.projectors.info(projectorRoom) : null
  const mirror = useCallback((el: HTMLCanvasElement | null): void => {
    if (projectorRoom) engineRef.current?.scene.projectors.mirror(projectorRoom, el)
  }, [projectorRoom])
  const closeProjector = useCallback(() => setProjectorRoom(null), [])
  const showBrowser = useCallback(
    (id: string) => {
      setProjectorRoom(null)
      onShowBrowser?.(id)
    },
    [onShowBrowser]
  )
  // 📍: o agente fica no meio da tela, atrás do chat maximizado — o chat minimiza antes do voo.
  const locate = useCallback((id: string) => {
    setCollapse((n) => n + 1)
    engineRef.current?.flyToAgent(principalKey(id), 'desk')
  }, [])
  // Sem mesa selecionada e com a Central à mão, o chat flutuante mostra a Central.
  const centralShown = showCentral && !!central

  return (
    <div className="workspace office3d-workspace" hidden={!active} data-testid="office3d-workspace">
      <div className="o3d-stage" ref={stageRef} data-testid="office3d-stage">
        <canvas ref={canvasRef} className="o3d-canvas" data-testid="office3d-canvas" tabIndex={-1} />
        {error ? (
          <div className="o3d-error" role="alert">
            Não foi possível iniciar o 3D (WebGL): {error}
          </div>
        ) : null}
        <OfficeHud power={power} windowsControlEnabled={windowsControlEnabled} onDisableWindowsControl={onDisableWindowsControl} />
        {focused && (
          <div ref={screenRef} className="o3d-screen-anchor" key={focused.key}>
            <ChatScreen feed={feed} model={focused.model} onClose={closeScreen} />
          </div>
        )}
        {previewed && (
          <div ref={previewRef} className="o3d-preview-anchor" data-key={previewed.key} key={previewed.key}>
            <ChatPreview feed={feed} model={previewed.model} />
          </div>
        )}
        {projector && (
          <ProjectorOverlay key={projector.roomId} info={projector} mirror={mirror} onClose={closeProjector} onShowBrowser={onShowBrowser ? showBrowser : undefined} />
        )}
        {import.meta.env.DEV && active && hud ? <PerfHud source={readEngine} /> : null}
      </div>
      {active && (chat || central) ? (
        <OfficeChatFloat
          conversation={conversation}
          central={centralShown || convIsCentral}
          expandSignal={expand}
          collapseSignal={collapse}
          onLocate={locate}
        >
          {centralShown ? central : chat}
        </OfficeChatFloat>
      ) : null}
    </div>
  )
}
