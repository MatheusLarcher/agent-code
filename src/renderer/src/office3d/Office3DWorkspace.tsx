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
 * Com `monitorComposer`, a tela do monitor focado É o chat: abre no modo Chat
 * com o campo de digitar embaixo (o Composer do App, que envia para a conversa
 * ativa — a do agente) e o chat flutuante sai enquanto ela está aberta; fechar
 * a tela o traz de volta (sem mesa, a Central). Toda troca de foco tira o foco
 * do campo da tela e do chat antes (o blur grava o rascunho). Em cima do campo,
 * `monitorModelPicker` (o seletor de modelo/esforço do chat) para a conversa do
 * agente focado. Ir à Central (`centralSignal` ou a Central virando a conversa
 * ativa) fecha a tela e volta a câmera à vista inicial (`engine.resetView`, o
 * mesmo do "↺ Vista inicial" do HUD), com a Central no flutuante.
 *
 * O motor (three puro) nasce na montagem e vive enquanto a aba existir: com `active` false (aba
 * Conversa) fica PAUSADO e volta na hora, com a mesma câmera; com a aba fechada não existem a tela
 * do monitor, a prévia, o foco da TV nem o HUD de desempenho. Desmontar libera GPU, listeners e RAF.
 *
 * Mouse parado num agente: a prévia (<ChatPreview>) acima do monitor. Clique num agente voa até o
 * monitor e abre por cima a tela dele (<CodeMonitor>, com Código, Chat e Contexto); duplo clique
 * abre a conversa no chat flutuante. Clique na Central (ou na tela do console) voa até o console e
 * encaixa o chat dela (`central`) na tela inclinada. Clique na TV voa até ela de frente e abre DENTRO
 * dela o que estava na tela (<TvFocus>, useTvFocus.ts: o mockup com Aprovar / Pedir ajuste, o teste
 * ao vivo, o planejamento; na TV vazia, o "📋 Planejar"). Papel do kanban: o cartão grande
 * (<BoardOverlay>). Balão de pedido: o pedido (`onFocusRequest`). Trocar de conversa fora do 3D voa
 * até o agente dela (engine.follow; nunca para a Central). 📍 minimiza o chat e voa até a mesa.
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
import { principalKey, roomIdFor } from '../office/adapter/model'
import { officeStore } from '../office/officeStore'
import { BoardOverlay } from './board/BoardOverlay'
import { ChatPreview, useHoverPreview } from './ChatPreview'
import { CodeMonitor } from './codeScreen/CodeMonitor'
import { DEMO_TICK_MS, demoFeed } from './demoFeed'
import { Office3DEngine, type EngineCallbacks, type EngineOptions } from './engine'
import { MEMORY_SHELF_KEY, type BoardOpen } from './engineTypes'
import type { ProjectLayout } from './layout'
import { OfficeChatFloat, type OfficeConversation } from './OfficeChatFloat'
import { OfficeHud } from './OfficeHud'
import { isPerfShortcut, PerfHud } from './PerfHud'
import { setMeetingProbe } from './officeWatch'
import type { OfficePower } from './power'
import { OfficeMemoryPanel } from './OfficeMemoryPanel'
import { OfficePlanDialog, type PlanProject } from './OfficePlanDialog'
import { TvFocus } from './TvFocus'
import { useTvFocus } from './useTvFocus'

export interface Office3DWorkspaceProps {
  /** A aba está à vista; false pausa o motor (padrão: true). */
  active?: boolean
  /** O ChatPanel da conversa ativa; sem ele e sem `central` (aba fechada), sem chat flutuante. */
  chat: ReactNode
  /**
   * O campo de digitar da conversa ativa (o Composer do App, mesmo envio do
   * chat). Com ele, a tela do monitor focado o mostra embaixo do Chat — quando a
   * conversa ativa é a do agente — e o chat flutuante some enquanto a tela está aberta.
   */
  monitorComposer?: ReactNode
  /**
   * O seletor de modelo/esforço da conversa do agente focado (`model.convId`),
   * em cima do campo da tela do monitor. A troca vale para ela, não para a ativa.
   */
  monitorModelPicker?: (convId: string) => ReactNode
  /** Sobe a cada clique na Central do app: com a tela de um monitor aberta, ela fecha (visão geral, Central no flutuante). */
  centralSignal?: number
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
  /** "Abrir no app" do menu do Agent (tela do monitor): a conversa dele na aba Conversa. */
  onOpenInApp?: (convId: string) => void
  /** Aprovar / Pedir ajuste do mockup na TV: manda o texto para a conversa do agente (o envio do chat). */
  onSendToConversation?: (convId: string, text: string) => void
  /** A Tela de Planejamento da conversa ativa (o App monta): o foco da TV num plano a mostra dentro da TV. */
  planning?: ReactNode
  /** "📋 Planejar" (HUD ou TV vazia): cria o plano e a conversa; devolve o id dela (null se falhou). Sem ela, sem o botão. */
  onStartPlanning?: (cwd: string, pedido: string) => Promise<string | null>
  /** Os projetos do formulário do planejamento. */
  planProjects?: readonly PlanProject[]
  /** Sobe a cada clique na notificação de um chamado: o filtro vai para o projeto dele e a câmera para a TV. */
  callSignal?: { n: number; projectId: string | null }
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
  monitorComposer = null,
  monitorModelPicker,
  centralSignal = 0,
  central = null,
  conversation = null,
  onOpenConversation,
  onFocusRequest,
  onShowBrowser,
  onOpenInApp,
  onSendToConversation,
  callSignal,
  planning = null,
  onStartPlanning,
  planProjects = [],
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
  // Filtro de projeto do HUD: os projetos no escritório e o filtro em vigor (o motor guarda e aplica).
  const [projects, setProjects] = useState<{ list: readonly ProjectLayout[]; filter: string | null }>({ list: [], filter: null })
  // Sobem a cada duplo clique num agente (o chat expande com a conversa dele) e a cada 📍 (minimiza).
  const [expand, setExpand] = useState(0)
  const [collapse, setCollapse] = useState(0)
  // Nenhuma mesa selecionada (nem conversa escolhida fora do 3D): o chat flutuante mostra a Central.
  const [showCentral, setShowCentral] = useState(true)
  const [, setTick] = useState(0)
  // Prévia do hover: o agente sob o mouse há PREVIEW_DELAY_MS. Telão: a sala cujo projetor foi clicado.
  const [previewKey, onHover] = useHoverPreview(active)
  // Clique no kanban: o cartão grande (ou a lista da pilha); acompanha os dados do Quadro enquanto aberto.
  const [boardOpen, setBoardOpen] = useState<BoardOpen | null>(null)
  const boardOpenRef = useRef(boardOpen)
  boardOpenRef.current = boardOpen
  const cbs = useRef({ onOpenConversation, onFocusRequest, onHover })
  const tvFocus = useRef<ReturnType<typeof useTvFocus>>({ tvInfo: null, onFocus: () => false, pickPlan: () => {}, sendFromTv: undefined, reset: () => {}, focusPlan: () => {} })
  // "📋 Planejar": o formulário aberto (pelo HUD ou pela TV vazia).
  const [planDialog, setPlanDialog] = useState(false)
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
        // A tela do monitor troca ou fecha, e o chat flutuante troca de conteúdo, some ou volta:
        // o campo com foco num deles (a roda não tira o foco) grava o rascunho antes, no blur.
        const el = document.activeElement
        if (el instanceof HTMLElement && el.closest('.o3d-chat, .o3d-screen-anchor')) el.blur()
        setFocusKey(key)
        // A TV (useTvFocus.ts): o conteúdo congela no foco; o chat não troca.
        if (tvFocus.current.onFocus(key)) return
        // O motor fechou a tela sozinho (voo, follow, o agente saiu): o chat fica onde está.
        if (!byUser) return
        // O usuário desfez a seleção: sem mesa, a Central (a conversa ativa não muda).
        if (!key) return setShowCentral(true)
        // A Central no console: o chat dela vai na tela do console, sem trocar a conversa ativa.
        if (engineRef.current?.scene.character(key)?.spot === 'central') return
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
      onProjects: (list, filter) => setProjects({ list, filter }),
      onHover: (key) => cbs.current.onHover(key),
      onBoardOpen: setBoardOpen,
      onBoardChange: () => {
        if (boardOpenRef.current) setTick((t) => t + 1)
      },
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
    // O aviso do chamado não notifica quem já está olhando a sala de reunião.
    setMeetingProbe(() => !engine.isPaused && engine.scene.projectors.tvInView())
    // Montado com a aba fechada (só testes; o App monta na 1ª abertura): já nasce parado.
    if (!activeRef.current) engine.pause()
    return () => {
      setMeetingProbe(null)
      engine.dispose()
      engineRef.current = null
      setFocusKey(null)
      tvFocus.current.reset()
      setPower(null)
      setProjects({ list: [], filter: null })
      setBoardOpen(null)
    }
    // engineOptions é fixo por montagem (testes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const convId = conversation?.id ?? null
  // O foco dentro da TV (useTvFocus.ts); o motor o lê pelo ref (os callbacks nascem uma vez).
  const tv = useTvFocus({ engineRef, active, convId, openConversation: (id) => cbs.current.onOpenConversation(id), onSendToConversation, callSignal, onEmptyTv: onStartPlanning ? () => setPlanDialog(true) : undefined })
  tvFocus.current = tv
  const tvInfo = tv.tvInfo
  const convIsCentral = isCentralConversation(conversation)
  // Ir à Central é o usuário desfazendo a seleção: a tela aberta fecha, a câmera
  // volta à vista inicial (o escritório inteiro, como o "↺ Vista inicial") e o flutuante volta, na Central.
  const openCentral = useCallback((): void => {
    engineRef.current?.resetView()
    setShowCentral(true)
  }, [])
  const resetView = useCallback((): void => engineRef.current?.resetView(), [])
  const onFilter = useCallback((id: string | null): void => engineRef.current?.setProjectFilter(id), [])

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
    if (convIsCentral) return openCentral()
    setShowCentral(false)
    // O plano em foco na TV virou a conversa ativa (abrir pela TV, trocar de aba): a câmera fica na TV.
    if (tvFocus.current.tvInfo?.kind === 'plan' && tvFocus.current.tvInfo.convId === convId) return
    engineRef.current?.follow(convId)
  }, [convId, active, convIsCentral, openCentral])

  // Clique na Central do app (mesmo já sendo a ativa): idem.
  const seenCentralSignal = useRef(centralSignal)
  useEffect(() => {
    if (seenCentralSignal.current === centralSignal) return
    seenCentralSignal.current = centralSignal
    if (active) openCentral()
  }, [centralSignal, active, openCentral])

  // Aba fechada: a janela do kanban fecha.
  useEffect(() => {
    if (active) return
    setBoardOpen(null)
  }, [active])

  // Com a tela ou a prévia aberta e a aba à vista, o conteúdo acompanha o feed.
  const showing = !!focusKey || !!previewKey
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
  const closeBoard = useCallback(() => setBoardOpen(null), [])
  // "Abrir a conversa" do cartão: o chat flutuante passa a mostrá-la (como o clique no agente).
  const openCardConversation = useCallback((id: string) => {
    setShowCentral(false)
    cbs.current.onOpenConversation(id)
  }, [])
  // 📍: o agente fica no meio da tela, atrás do chat maximizado — o chat minimiza antes do voo.
  const locate = useCallback((id: string) => {
    setCollapse((n) => n + 1)
    engineRef.current?.flyToAgent(principalKey(id), 'desk')
  }, [])
  // Sem mesa selecionada e com a Central à mão, o chat flutuante mostra a Central.
  const centralShown = showCentral && !!central
  // Com o campo de digitar na tela do monitor, a tela é o chat: o flutuante sai (e volta ao fechá-la).
  // O campo só entra quando a conversa ativa é a do agente (o envio vai para a conversa ativa).
  // A Central no console: a tela do console É o chat dela (o painel `central`).
  const consoleChat = focused?.spot === 'central' && central ? central : null
  const screenTakesChat = !!focused && (!!monitorComposer || !!consoleChat)
  const fieldComposer = screenTakesChat && conversation?.id === focused.model.convId ? monitorComposer : null
  // O seletor de modelo/esforço é da conversa do agente focado (não depende da ativa).
  const picker = screenTakesChat && monitorModelPicker ? monitorModelPicker(focused.model.convId) : null
  const screenComposer =
    picker || fieldComposer ? (
      <>
        {picker ? (
          <div className="composer-bar cm-model-bar" data-testid="office-screen-model">
            {picker}
          </div>
        ) : null}
        {fieldComposer}
      </>
    ) : null

  return (
    <div className="workspace office3d-workspace" hidden={!active} data-testid="office3d-workspace">
      <div className="o3d-stage" ref={stageRef} data-testid="office3d-stage">
        <canvas ref={canvasRef} className="o3d-canvas" data-testid="office3d-canvas" tabIndex={-1} />
        {error ? (
          <div className="o3d-error" role="alert">
            Não foi possível iniciar o 3D (WebGL): {error}
          </div>
        ) : null}
        <OfficeHud
          power={power}
          windowsControlEnabled={windowsControlEnabled}
          onDisableWindowsControl={onDisableWindowsControl}
          projects={projects.list}
          filter={projects.filter}
          onFilter={onFilter}
          onPlan={onStartPlanning ? () => setPlanDialog(true) : undefined}
          onResetView={resetView}
        />
        {active && planDialog && onStartPlanning ? (
          <OfficePlanDialog
            projects={planProjects}
            initialCwd={planProjects.find((p) => roomIdFor(p.cwd) === projects.filter)?.cwd ?? null}
            onClose={() => setPlanDialog(false)}
            onStart={(cwd, pedido) => {
              setPlanDialog(false)
              void onStartPlanning(cwd, pedido).then((id) => id && tv.focusPlan(id))
            }}
          />
        ) : null}
        {focused && consoleChat ? (
          <div ref={screenRef} className="o3d-screen-anchor o3d-console-screen" key={focused.key} data-testid="office-console-screen">
            {consoleChat}
          </div>
        ) : null}
        {focused && !consoleChat && (
          <div ref={screenRef} className="o3d-screen-anchor" key={focused.key}>
            <CodeMonitor
              feed={feed}
              model={focused.model}
              onClose={closeScreen}
              initialMode="chat"
              composer={screenComposer}
              battery={power ? power.pct : null}
              onOpenInApp={onOpenInApp}
            />
          </div>
        )}
        {active && tvInfo && engine ? (
          <div ref={screenRef} className="o3d-screen-anchor" key="tv">
            <TvFocus
              info={tvInfo}
              projectors={engine.scene.projectors}
              onClose={closeScreen}
              onSend={tv.sendFromTv}
              planning={planning}
              activeConvId={convId}
              onPickPlan={tv.pickPlan}
            />
          </div>
        ) : null}
        {/* O clique na estante de Memórias é um foco nela: o painel (só leitura) dura enquanto ele durar. */}
        {active && engine && focusKey === MEMORY_SHELF_KEY ? (
          <OfficeMemoryPanel engine={engine} feed={feed} onClose={closeScreen} onOpenConversation={(id) => cbs.current.onOpenConversation(id)} />
        ) : null}
        {previewed && (
          <div ref={previewRef} className="o3d-preview-anchor" data-key={previewed.key} key={previewed.key}>
            <ChatPreview feed={feed} model={previewed.model} />
          </div>
        )}
        {active && boardOpen && engine ? (
          <BoardOverlay open={boardOpen} board={engine.board} onClose={closeBoard} onOpen={setBoardOpen} onOpenConversation={openCardConversation} />
        ) : null}
        {import.meta.env.DEV && active && hud ? <PerfHud source={readEngine} /> : null}
      </div>
      {active && (chat || central) && !screenTakesChat && !tvInfo && focusKey !== MEMORY_SHELF_KEY ? (
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
