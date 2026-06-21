# Referência de arquivos — Agent Code

Inventário completo do projeto: **cada arquivo versionado** e sua responsabilidade. Para o funcionamento interno, veja [ARQUITETURA.md](ARQUITETURA.md).

## Sumário

- [Raiz do projeto](#raiz-do-projeto)
- [build/ — ícone](#build--ícone)
- [scripts/](#scripts)
- [src/main — processo principal](#srcmain--processo-principal)
- [src/preload — ponte](#srcpreload--ponte)
- [src/shared — contrato compartilhado](#srcshared--contrato-compartilhado)
- [src/renderer — interface](#srcrenderer--interface)
- [Tipos de dados](#tipos-de-dados)

---

## Raiz do projeto

| Arquivo | Responsabilidade |
|---------|------------------|
| `start.bat` | Inicialização no Windows: verifica o Node, instala dependências na primeira vez (baixa o Chromium do Playwright), garante o binário do Electron e roda `npm run dev`. |
| `package.json` | Metadados, **scripts** (`dev`, `build`, `start`, `icon`, `postinstall`, `typecheck`, `test`) e dependências. Runtime: `@anthropic-ai/claude-agent-sdk`, `playwright`, `zod`, `react-markdown`, `remark-gfm`. Dev: Electron, electron-vite, React 19, TypeScript, Vite, Vitest, jsdom, Testing Library. |
| `package-lock.json` | Lockfile de dependências (gerado). |
| `electron.vite.config.ts` | Config do **electron-vite**: alvos main/preload (com `externalizeDepsPlugin`) e renderer (plugin React + alias `@shared`). |
| `vitest.config.ts` | Config dos testes: ambiente `jsdom`, `globals`, alias `@shared`, plugin React; inclui `src/**/*.test.{ts,tsx}`. |
| `tsconfig.json` | Apenas *project references* para `tsconfig.node.json` e `tsconfig.web.json`. |
| `tsconfig.node.json` | TS do lado Node (`src/main`, `src/preload`, `src/shared`, config). `strict`, `moduleResolution: Bundler`, `types: ["node"]`, alias `@shared/*`. |
| `tsconfig.web.json` | TS do renderer (`src/renderer` + `src/shared`). Igual ao node, com `lib: DOM` e `jsx: react-jsx`. |
| `.gitignore` | Ignora `node_modules/`, `out/`, `dist/`, `.vite/`, logs, `.env*`, `*.tsbuildinfo`, ferramentas locais (`.claude/`, `.claude-flow/`, `.mcp.json`, `CLAUDE.md`) e o arquivo solto `{}`. |
| `.gitattributes` | `* text=auto` (normalização de fim de linha). |
| `README.md` | Documentação principal (uso, requisitos, funcionalidades, scripts). |
| `docs/ARQUITETURA.md` | Arquitetura detalhada. |
| `docs/REFERENCIA.md` | Este arquivo. |

---

## build/ — ícone

| Arquivo | Responsabilidade |
|---------|------------------|
| `build/icon.svg` | **Arte-fonte** do ícone (faísca coral `#d97757` sobre quadrado escuro arredondado, com brilho radial). Editável. |
| `build/icon.png` | Ícone 512×512 gerado a partir do SVG (usado como ícone da janela fora do Windows). |
| `build/icon.ico` | Ícone 256×256 para Windows (ICO contendo um PNG). Usado pelo `BrowserWindow`. |

Regenere ambos com `npm run icon` após editar o SVG.

---

## scripts/

| Arquivo | Responsabilidade |
|---------|------------------|
| `scripts/make-icon.mjs` | Usa o **Playwright** (Chromium já instalado) para rasterizar `build/icon.svg` em `icon.png` (512) e `icon.ico` (256). Renderiza o SVG numa página com fundo transparente e tira screenshot (`omitBackground`); monta o `.ico` empacotando o PNG 256 num cabeçalho ICO de uma imagem. |
| `scripts/screenshot.mjs` | Gera o print do README (`docs/screenshot.png`): sobe o app via Playwright `_electron`, semeia uma conversa de exemplo, abre uma aba web num site real e captura a janela. |
| `scripts/ui-tab-test.mjs` | Smoke test do sistema de abas: abre o app, cria abas web, navega e troca entre elas, conferindo que cada aba mostra o site certo. |
| `scripts/android-probe.mjs` | Verifica o caminho do preview Android: abre a aba Android (conecta ao device/emulador), checa as linhas de progresso e captura a tela com a moldura. |

---

## src/main — processo principal

| Arquivo | Responsabilidade |
|---------|------------------|
| `index.ts` | Cria o `BrowserWindow` (tamanho, ícone, title bar oculta + overlay, CSP via HTML), abre links externos no navegador do sistema e **registra todos os handlers IPC** (incl. `app:pick-file`, `agent:dispose`, `browser:set-active`/`dispose`/`set-viewport`, `browser:new-tab`/`select-tab`/`close-tab`, `browser:set-android-size`). Mantém `mainWindow`, um **`Map<convId, AgentSession>`** (sessões paralelas) e um **`Map<convId, BrowserController>`** + `activeConvId` (um preview por conversa; só o ativo transmite). Eventos/permissões/progresso Android são emitidos com o `convId` (envelopes). |
| `agentSession.ts` | Encapsula uma conversa com o **Agent SDK**: monta as `Options` (`resume`, `executable: 'node'`, `includePartialMessages`, `settingSources`, system prompt `claude_code` + `BROWSER_HINT` + `ANDROID_HINT`, MCP `browser` **e** `android`, `canUseTool`), itera o stream e traduz cada `SDKMessage` em `ChatEvent`. `send(text, images?)` envia string ou **array de blocos** (imagens base64 + texto). Rastreia `lastContextTokens` (thread principal — ignora subagentes). **Gate de permissão** (`handlePermission`/`resolvePermission`/`setBypass`) — todo `allow` devolve `updatedInput`. Conjuntos `READ_ONLY` e `ANDROID_AUTO` (ferramentas Android de interação auto-aprovadas; setup/build/install pedem confirmação). |
| `agentSession.test.ts` | Testes (Vitest) do fluxo de permissão: auto-aprova leitura com `updatedInput`; pede no chat para `Bash`; resolve `allow`/`deny`; bypass não pede; ligar bypass resolve pendências. |
| `asyncQueue.ts` | `AsyncQueue<T>` — `AsyncIterable` push-based que alimenta o `query()` do SDK com as mensagens do usuário (pull sob demanda). |
| `browserController.ts` | Orquestra o preview **multi-aba** (um Chromium do Playwright por conversa): `Map<id, Tab>` + `activeTabId`, abrir/selecionar/fechar aba (web ou android), screencast CDP por aba web (só a ativa pinta), `refreshView`, `emitState` (inclui `tabs[]` e `androidSize`), `setAndroidSize`, e os métodos das ferramentas (delegando a `pageActions`). Tab tem `page` **ou** `device`. |
| `browserTabs.ts` | Tipos/constantes do preview: interface `Tab`, `EMPTY_STATE`, `nextTabId`, `isAndroid`, viewport/escala/qualidade/`MAX_FRAME`. |
| `pageActions.ts` | Funções puras sobre uma `Page` (a metade web da aba): `gotoUrl`/`absolutize`, `pageSnapshot`, `pageScreenshot`, `clickSelector`, `fillOrType`, `readText`, `evaluateExpression`, `setSelectMode`/`syncSelectMode`, `forwardPageInput`. |
| `picker.ts` | `PICKER_SCRIPT` — init script injetado no contexto que realça elementos no hover e reporta o clicado via `__agentPick` (gated por `__agentSelectMode`). |
| `browserTools.ts` | `createBrowserMcpServer(browser)` — servidor MCP `browser`: abas (`browser_list_tabs`/`new_tab`/`select_tab`/`close_tab`) + `browser_navigate`/`snapshot`/`screenshot`/`click`/`type`/`get_text`/`evaluate`/`back`/`reload` (esquemas `zod`, agem na aba ativa). |
| `browserController.tabs.test.ts` | Teste de integração (Chromium real) das abas: abre várias, lista, confirma que o snapshot reflete a aba ativa, troca e fecha; iPhone é recusado. |
| `android/androidEnv.ts` | **Toolchain Android**: `detect()` (localiza JDK/SDK/adb/emulador/sdkmanager) e `ensureInstalled()` (baixa JDK 17, cmdline-tools, platform-tools, `android-34`, build-tools, emulador, system image; aceita licenças; cria AVD padrão — idempotente, cacheado em `userData`). Electron importado de forma preguiçosa. |
| `android/androidDevice.ts` | Um device/emulador ao vivo via `adb`: `ensureBooted`, `startStreaming` (PNG por `screencap`), input (`tap`/`swipe`/`type`/`key`), `setScreenSize`/`resetScreenSize`/`screenSize` (override de resolução com `wm size`/`density`), `install`/`launch`, `stop`. |
| `android/androidTab.ts` | Metade Android da aba: `bootAndroidDevice` e `forwardAndroidInput` (mapeia input do canvas no device), separados do controller. |
| `android/androidTools.ts` | `createAndroidMcpServer(browser)` — servidor MCP `android`: `android_setup`, `android_open_preview`, `android_build_apk`, `android_install_run`, `android_screenshot`, `android_tap`/`swipe`/`type`/`key`, `android_list_devices`, `android_list_device_models`, `android_set_device` (modelo/custom). |

---

## src/preload — ponte

| Arquivo | Responsabilidade |
|---------|------------------|
| `index.ts` | Implementa o objeto `api: AgentCodeApi` (mapeando cada método para `ipcRenderer.invoke`/`on`) e o expõe como `window.api` via `contextBridge`. Helper `on()` retorna a função de *unsubscribe*. |
| `index.d.ts` | Declara `Window.api: AgentCodeApi` para o TypeScript. |

---

## src/shared — contrato compartilhado

Importável pelos três processos (somente tipos + constantes).

| Arquivo | Responsabilidade |
|---------|------------------|
| `ipc.ts` | **Fonte única** dos tipos do IPC e dos nomes de canais (`Channels`): `ChatEvent`, `AgentEventMsg`/`PermissionRequestMsg`/`AndroidProgressMsg` (envelopes com `convId`), `PermissionRequest`/`Response`, `BrowserFrame` (com `mime`), `BrowserState` (com `tabs[]` e `androidSize`), `BrowserInput`, `PickedElement` (com `tabId`/`tabName`), `ImageAttachment`, `TokenUsage`, `StartAgentOptions`. **Sistema de abas:** `TabKind`, `TabKindMeta`/`TAB_KINDS`, `TabInfo`, `tabName()`. Canais de aba/Android: `browserNewTab`/`SelectTab`/`CloseTab`, `browserSetViewport`, `browserSetAndroidSize`, `androidProgress`. |
| `devices.ts` | **Tabela de aparelhos Android** (`ANDROID_DEVICES`: telefones e tablets com resolução px + dpi + ano), `DEFAULT_DEVICE_ID` (`s26-ultra`), `uniqueByResolution()` (deduplica por resolução mantendo o mais recente), `DEVICE_OPTIONS` (lista exibida), `findDevice()`/`deviceForResolution()`. |
| `api.ts` | Interface `AgentCodeApi` — a forma exata de `window.api`. Métodos de agente recebem `convId`; inclui `disposeAgent`, `pickFile`, `setActiveBrowser`, `disposeBrowser`, **`newTab`/`selectTab`/`closeTab`**, **`setAndroidSize`**; eventos como envelopes (`onAgentEvent`/`onPermissionRequest`/`onAndroidProgress`). |

---

## src/renderer — interface

| Arquivo | Responsabilidade |
|---------|------------------|
| `index.html` | HTML raiz, `<div id="root">`, carrega `src/main.tsx` e define a **Content-Security-Policy**. |
| `src/main.tsx` | Ponto de entrada do React: monta `<UiProvider><App/></UiProvider>` em `StrictMode` e importa `styles.css`. |
| `src/App.tsx` | **Estado central**: lista de `Conversation`, `activeId`, `collapsed`, `browserMinimized`, *chips*, estado do navegador, e — por conversa — `connectedIds`/`busyIds` (Sets) + `permissions` + `queue`. Deriva projetos (por `cwd`) e recentes; roteia cada `AgentEventMsg` para a conversa do `convId` (`reduceMessages`); **sessões paralelas** (trocar/enviar não cancela outra conversa); `connect()` deduplica chamadas concorrentes (`connectingRef`); **fila** por conversa quando ocupada (sem cancelar o turno), despachada ao fim do turno; **interromper** limpa a fila; modal de permissão só para a conversa ativa (toast avisa pedidos em segundo plano); "permitir tudo" aplica a todas as sessões; cria/seleciona/renomeia/exclui conversas (`disposeAgent` + `disposeBrowser`); sincroniza o navegador ativo (`setActiveBrowser`); abre o `NewTabModal` (estado `newTabOpen`) e cria a aba via `openTab(kind)` (com toast de sucesso/erro no Android); dispara toasts; renderiza topbar + `Sidebar` + `ChatPanel` + `BrowserPanel` + `PermissionModal` + `NewTabModal`. |
| `src/types.ts` | Tipos da UI: `UserMessage`, `UIMessage`, `TokenTotals`, `Conversation`, e a constante `DEFAULT_TITLE`. |
| `src/storage.ts` | Carrega/salva conversas e estado da UI no `localStorage` (`agentcode.conversations.v1`, `agentcode.ui.v1` = `{ collapsed, activeId, browserMinimized }`), tolerante a erros/cota. Descarta o campo `images` (data URLs) ao persistir para não estourar a cota. |
| `src/env.d.ts` | Tipos do ambiente: `Window.api` e o namespace global `JSX` (React 19). |
| `src/styles.css` | Tema (variáveis CSS: `--bg`, `--accent` coral, `--ok`/`--err`/`--warn`, etc.) e **todos** os estilos: topbar, sidebar (expandida/colapsada), chat, cartões de ferramenta, composer, navegador, toasts, modais e animações. |

### src/renderer/src/components

| Arquivo | Responsabilidade |
|---------|------------------|
| `Sidebar.tsx` | Barra de histórico: cabeçalho com marca + botão minimizar; "Nova conversa"; seção **Projetos** (agrupados, expansíveis, com contador) e **Chats** (recentes); trilha de ícones quando colapsada. `ConvRow` é um componente de **nível de módulo** (estável entre renders); a edição é identificada **por linha** (`editing.key`) — não por `id` — porque a mesma conversa aparece em duas seções. Renomear por duplo-clique; excluir via `useUI().confirm` + toast. |
| `Sidebar.test.tsx` | Testes do renomear: a conversa aparece 2×; duplo-clique abre **um** campo; Enter chama `onRename`; Esc cancela. |
| `ChatPanel.tsx` | Cabeçalho "Chat" + medidor de tokens/custo; estado vazio; `MessageList` (com `key={convId}` para resetar a janela ao trocar de conversa); **fila de mensagens** (`queued` + `onDeleteQueued`, acima do composer, com botão de remover); `Composer`. Recebe `hasActive` (habilita o composer) e `projects` (menu `@`). |
| `MessageList.tsx` | Renderiza as mensagens com **janela** (`PAGE`=40; carrega +40 ao rolar ao topo, ancorando o scroll — estilo Gemini) e **markdown** nas respostas do assistente (componente `Markdown`: `react-markdown` + `remark-gfm`; links com `target="_blank"`). Bolhas de usuário/assistente (incl. **miniaturas de imagens** anexadas), narração discreta vs. resposta final, *thinking*, nota de sistema, erros, e o `ToolCard` (`describeTool`): skill destacada em acento, **`+N`/`−N`** verde/vermelho em edições, nome de arquivo, badge de status (erro em vermelho). Cards não comprimem (`flex-shrink: 0`). Auto-scroll ao fim só quando o usuário já está perto do fim. |
| `Composer.tsx` | Caixa de texto com auto-crescimento (até 8 linhas), *chips* de elementos da página (mostram a aba de origem — `chip-tab`), **botão `@`** (referenciar arquivo/pasta/projeto → insere `@<caminho>`; o agente resolve com `Read`/`Glob`/`LS`), **anexo de imagens** (botão 🖼, colar ou arrastar → `ImageAttachment[]` base64 com miniaturas) e botão **enviar** (↑, sempre disponível — enfileira quando ocupado) + **parar** (■, aparece durante o turno). Enter envia/enfileira, Shift+Enter quebra linha. |
| `BrowserTabs.tsx` | **Barra de abas** do preview: cada aba com `TabIcon` + nome (`tabName`) + "×"; trocar/fechar via `window.api`. O **"+"** chama `onRequestNewTab` (abre o `NewTabModal` na raiz do app). |
| `TabIcon.tsx` | Ícones em linha (currentColor) por tipo de aba: globo (web), robô (android), telefone (iphone). |
| `BrowserPanel.tsx` | Painel do preview: `BrowserTabs` + barra de navegação + `<canvas>` (desenha frames com o `mime` certo) + status. **Aba web:** URL/Go + botão **Select**. **Aba Android:** botões Voltar/Home, **seletor de modelo** (`DEVICE_OPTIONS`) + **resolução personalizada**, e a tela vai dentro de uma **moldura de aparelho** (bezel + punch-hole) dimensionada ao painel; o tamanho atual vem de `state.androidSize` (sincroniza com o que o LLM define). **Minimizado** vira faixa fina. Reenvia mouse/scroll/teclado do canvas (vira toque no Android). |

### src/renderer/src/ui

| Arquivo | Responsabilidade |
|---------|------------------|
| `UiProvider.tsx` | Provider + hook `useUI()` com `notify` (toasts auto-dispensáveis, 3 tipos) e `confirm` (modal que resolve `Promise<boolean>`). Contém `ToastItem` e `ConfirmDialog`. Valor do contexto memoizado. |
| `PermissionModal.tsx` | Pedido de permissão de ferramenta como modal (Negar / Permitir uma vez / Sempre permitir); Esc nega. |
| `NewTabModal.tsx` | Modal de **nova aba de preview** (Web / Android / iPhone reservado), com ícone + descrição por tipo; renderizado na raiz do app (não é cortado pela barra de abas). Esc/clique fora cancela. |

---

## Tipos de dados

Principais formas (ver `src/shared/ipc.ts` e `src/renderer/src/types.ts`):

```ts
// Evento normalizado de chat (main → renderer)
type ChatEvent =
  | { kind: 'system'; sessionId: string; model: string; cwd: string; tools: string[] }
  | { kind: 'assistant-text'; id: string; text: string; final: boolean }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool-use'; id: string; name: string; input: unknown; parentToolUseId: string | null }
  | { kind: 'tool-result'; id: string; toolUseId: string; isError: boolean; text: string }
  | { kind: 'result'; id: string; isError: boolean; text: string; durationMs: number; costUsd?: number; usage?: TokenUsage }
  | { kind: 'status'; id: string; text: string }
  | { kind: 'error'; id: string; text: string }

interface StartAgentOptions { convId: string; cwd: string; model?: string; skipPermissions?: boolean; resume?: string }
interface AgentEventMsg { convId: string; event: ChatEvent }            // main → renderer (cada evento marcado com a conversa)
interface PermissionRequestMsg { convId: string; req: PermissionRequest }
interface AndroidProgressMsg { convId: string; line: string }           // progresso do boot/instalação do Android
interface PermissionRequest { id: string; toolName: string; input: Record<string, unknown> }
interface PermissionResponse { id: string; behavior: 'allow' | 'deny'; always?: boolean; message?: string }

// Abas de preview
type TabKind = 'web' | 'android' | 'iphone'
interface TabInfo { id: string; kind: TabKind; title: string; url: string; active: boolean }
function tabName(t: { kind: TabKind; title: string; url: string }): string   // ex.: "web - Google" / "android - <app>"

interface BrowserState {
  url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; launched: boolean
  tabs: TabInfo[]                                  // todas as abas (ordem da barra)
  androidSize?: { width: number; height: number } // tamanho atual da aba Android ativa
}
interface BrowserFrame { data: string; width: number; height: number; mime?: 'image/jpeg' | 'image/png' }  // web = JPEG, Android = PNG
type BrowserInput =
  | { type: 'move'; nx: number; ny: number }
  | { type: 'click'; nx: number; ny: number; button: 'left' | 'right' | 'middle' }
  | { type: 'wheel'; nx: number; ny: number; dx: number; dy: number }
  | { type: 'key'; key: string; text?: string }
interface PickedElement { selector: string; tagName: string; id: string; classes: string; text: string; html: string; url: string; tabId: string; tabName: string }
interface ImageAttachment { mediaType: string; data: string }   // data = base64 sem prefixo

// Aparelhos Android (src/shared/devices.ts)
type DeviceType = 'phone' | 'tablet'
interface AndroidDeviceModel { id: string; name: string; type: DeviceType; width: number; height: number; dpi: number; year: number }

// UI (renderer)
type UIMessage = (ChatEvent | { kind: 'user'; id: string; text: string }) & {
  result?: { isError: boolean; text: string }
  answer?: boolean
}
interface Conversation {
  id: string; title: string; cwd: string; model: string
  sdkSessionId: string | null
  messages: UIMessage[]
  tokens: { context: number; output: number; cost: number }
  createdAt: number; updatedAt: number
}
```

A tabela completa de canais IPC (direção, handler e payload) está em [ARQUITETURA.md](ARQUITETURA.md#contrato-de-ipc).
