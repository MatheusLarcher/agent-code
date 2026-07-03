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
- [smartfone-remote — app do celular](#smartfone-remote--app-do-celular)
- [Tipos de dados](#tipos-de-dados)

---

## Raiz do projeto

| Arquivo | Responsabilidade |
|---------|------------------|
| `start.bat` | Inicialização no Windows: usa o Node do sistema ou **baixa um Node portátil** (v24.11.1, em `.node/`, sem admin) se faltar; **linka as skills** (`.agents\skills\* → .claude\skills\` via junction `mklink /J`, idempotente, sem reinstalar); instala dependências na primeira vez (baixa o Chromium do Playwright), garante o binário do Electron e roda `npm run dev`. |
| `package.json` | Metadados, **scripts** (`dev`, `build`, `start`, `icon`, `postinstall`, `typecheck`, `test`) e dependências. Runtime: `@anthropic-ai/claude-agent-sdk`, `playwright`, `zod`, `react-markdown`, `remark-gfm`, `qrcode` (QR do controle remoto), `ws` (RelayClient → broker da VPS). Dev: Electron 42, electron-vite, React 19, TypeScript, Vite, Vitest, jsdom, Testing Library, `@types/qrcode`. O SQLite usa o **`node:sqlite` embutido** (sem dependência nova). |
| `skills-lock.json` | Lockfile do **kit de skills** (`npx skills`): origem (repo GitHub) + hash de cada skill **instalada via `npx skills add`**. A skill própria `planejar` (escrita à mão) **não** entra aqui. |
| `package-lock.json` | Lockfile de dependências (gerado). |
| `electron.vite.config.ts` | Config do **electron-vite**: alvos main/preload (com `externalizeDepsPlugin`) e renderer (plugin React + alias `@shared`). |
| `vitest.config.ts` | Config dos testes: ambiente `jsdom`, `globals`, alias `@shared`, plugin React; inclui `src/**/*.test.{ts,tsx}`. |
| `tsconfig.json` | Apenas *project references* para `tsconfig.node.json` e `tsconfig.web.json`. |
| `tsconfig.node.json` | TS do lado Node (`src/main`, `src/preload`, `src/shared`, config). `strict`, `moduleResolution: Bundler`, `types: ["node"]`, alias `@shared/*`. |
| `tsconfig.web.json` | TS do renderer (`src/renderer` + `src/shared`). Igual ao node, com `lib: DOM` e `jsx: react-jsx`. |
| `.gitignore` | Ignora `node_modules/`, `out/`, `dist/`, `.vite/`, logs, `.env*`, `*.tsbuildinfo`, ferramentas locais (`.claude/`, `.claude-flow/`, `.mcp.json`, `CLAUDE.md`), o Node portátil (`.node/`) e os gerados do app remoto (`smartfone-remote/{node_modules,android,dist,.gradle}`). **`.agents/` é versionado** (kit de skills). |
| `.agents/skills/` | **Kit de skills** versionado (fonte da verdade): `brainstorming`, `frontend-design`, `copywriting`, `landing-page-design`, `adversarial-review` (esta adaptada para subagentes Claude nativos) e **`planejar`** (própria do projeto, escrita à mão — *Plan & Execute* guiado por tarefas; não vem do `npx skills`/`skills-lock.json`). O `start.bat` cria junctions disso em `.claude/skills/`. |
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
| `index.ts` | Cria o `BrowserWindow` (tamanho, ícone, title bar oculta + overlay, CSP via HTML), libera a permissão de **microfone** (`setPermissionRequestHandler`/`setPermissionCheckHandler` só para `media`), abre links externos no navegador do sistema, chama **`initStore()`** no `app.whenReady` (abre o SQLite da pasta de cache + migra o `settings.json` legado) e **registra todos os handlers IPC** (incl. `app:pick-file`, **`app:path-exists`** — guarda da pasta do projeto, `app:open-in-editor`, **`app:file-download`** — copia um entregável para Downloads e revela, **`openai:transcribe`/`openai:tts`** — voz (key lida da config), **`auth:status`/`auth:login`** — login do Claude com um clique, **`cache:get-info`/`cache:choose-dir`** — pasta de dados, `agent:dispose`, **`agent:refresh-usage`** — força um poll do uso da conta (5h/semana) numa sessão conectada, `browser:*`). Mantém `mainWindow`, um **`Map<convId, AgentSession>`** (sessões paralelas) e um **`Map<convId, BrowserController>`** + `activeConvId`. O `RemoteServer` recebe `loadToken`/`saveToken` (token fixo), `onInbound` carregando `images` e `transcribe`/`tts`/`voiceReady` (voz no celular). Mantém um `authLog()` de diagnóstico temporário (`auth-debug.log`). |
| `openai.ts` | **Cliente de áudio da OpenAI** (voz no chat) — vive no main para a key nunca chegar ao renderer; usa `fetch`/`FormData`/`Blob` embutidos do Node. `transcribeAudio` (fala → texto, `gpt-4o-transcribe`, `language: 'pt'` + `prompt` de contexto pt-BR — segmentos curtos/ruidosos alucinavam outro alfabeto, ex. cirílico, mesmo com `language` setado) e `synthesizeSpeech` (texto → MP3, `gpt-4o-mini-tts`, instrução forçando pt-BR; a velocidade é aplicada no renderer via `playbackRate`). |
| `auth.ts` | Estado de autenticação do Claude: `isAuthenticated()` pergunta ao próprio CLI (`claude auth status --json`) — **não** lê `.credentials.json` porque no Windows o token fica no Credential Manager. Multiplataforma e autoritativo. |
| `login.ts` | **Login do Claude com um clique**: `runClaudeLogin(openUrl, log)` faz `spawn` de `claude auth login --claudeai`, **raspa a URL de OAuth do stdout** e a abre no navegador do sistema, confirma via `auth status` (poll/marker/exit/timeout 3 min). Um login por vez (`inFlight`). |
| `claudeCli.ts` | `claudeCliPath()` resolve o **binário do CLI nativo do Claude Code** que o Agent SDK distribui como dependência opcional por plataforma (`@anthropic-ai/claude-agent-sdk-<plat>-<arch>`, `-musl` no Linux) via `require.resolve`; cacheia e lança se não achar. **Esse binário é diferente** da instalação global do `claude` (a que o comando `claude update` do sistema atualiza) — vive dentro do `node_modules` do projeto, e sua versão é fixada pela versão do `@anthropic-ai/claude-agent-sdk` no `package.json`. **Este projeto não usa o CLI global** para nada (login, sessões, tudo passa pelo binário empacotado) — rodar `claude update` no sistema **não tem efeito nenhum** aqui. |
| **Atualizar o CLI do Claude Code deste projeto** | ➜ `npm install @anthropic-ai/claude-agent-sdk@latest` (bump da dependência em `package.json`/`package-lock.json`, versão travada por `claudeCliPath()` acima). Depois: `npm run typecheck && npm test && npm run build` antes de considerar concluído. Esse é o único comando que atualiza o Claude **deste projeto** — o `claude update` do sistema é irrelevante para ele. |
| `store.ts` | **Persistência por usuário** via `node:sqlite` (embutido): ponteiro `~/.agent-code/location.json` (só o caminho da pasta de cache) + `<escolhida>/agent-code/agent-code.db` (tabela `kv` key→JSON) + pasta `memories/` (Markdown da [memória persistente](ARQUITETURA.md#memória-persistente)). `initStore` (padrão `Documentos/agent-code` no 1º uso + migra `settings.json`), `kvGet`/`kvSet`, `getCacheInfo` (devolve `dir`/`dbPath`/`memoriesDir`), `setCacheDir` (cria a subpasta `agent-code`; se já houver db, só carrega). |
| `config.ts` | Lê/grava `AppConfig` na chave `config` do SQLite (`store.ts`) — antes era `settings.json`. Guarda a API key do Stitch, a **API key da OpenAI** (`openai`, com merge aninhado), a **integração Ollama Cloud** (`ollama` = `{enabled, apiKey}`, com merge aninhado), "permitir tudo", o **token fixo do Android** (`remoteToken`) e `remoteEnabled`. `loadConfig`/`saveConfig`/`updateConfig` (merge sem clobber). |
| `attachments.ts` | Salva anexos **não-imagem** (Excel, PDF, zip, código…) em disco no main e devolve o caminho, para o agente abrir com `Read`/etc. (imagens seguem como blocos base64). |
| `agentSession.ts` | Encapsula uma conversa com o **Agent SDK**: monta as `Options` (`resume`, **`effort`** — esforço de raciocínio, repassado direto se a conversa tiver um definido, `executable: 'node'`, `includePartialMessages`, `settingSources`, **`additionalDirectories: [memoriesDir]`** — libera a pasta de memórias fora do `cwd`, system prompt `claude_code` + `BROWSER_HINT` + `ANDROID_HINT` + **`DOWNLOAD_HINT`** — orienta o agente a emitir `[[download:CAMINHO]]` para entregar arquivos — + **`buildMemoryHint(memoriesDir)`** — instrui a **memória persistente** e pré-carrega o `MEMORY.md`, MCP `browser` **e** `android`, `canUseTool`), itera o stream e traduz cada `SDKMessage` em `ChatEvent`. `send(text, images?)` é **async**: com imagem e modelo sem suporte a visão (`!modelSupportsVision`), intercepta via **`vision_fallback_router`** (`visionRelay.ts`) — o texto final já mesclado com `[VISUAL_CONTEXT]` é o que vai pra fila, sem a imagem; caso contrário, envia string ou **array de blocos** (imagens base64 + texto), igual antes. Rastreia `lastContextTokens` (thread principal — ignora subagentes). **Roteamento Ollama Cloud:** quando o modelo escolhido é um modelo Ollama (`isOllamaModel` — id com sufixo `:cloud`), injeta `options.env` (`{...process.env, ANTHROPIC_BASE_URL: OLLAMA_BASE_URL, ANTHROPIC_AUTH_TOKEN: <api key>, ANTHROPIC_API_KEY: ''}`) para apontar a CLI do Claude Code para a API compatível com a Anthropic do Ollama — mesmo truque do `ollama launch claude`; sem key configurada, emite erro amigável e não inicia. **Gate de permissão** (`handlePermission`/`resolvePermission`/`setBypass`) — todo `allow` devolve `updatedInput`. Conjuntos `READ_ONLY` e `ANDROID_AUTO` (e auto-aprovação por prefixo `mcp__browser__`/`mcp__stitch*__`). **`AskUserQuestion`** é interceptado (`parseAskQuestions` → campo `questions` no pedido) e roteado ao `QuestionModal` mesmo com bypass; a resposta volta ao modelo como um `deny` com `message`. **Auto-timeout** (`PERMISSION_TIMEOUT_MS = 7 min`): cada pendência (`registerPending`) arma um `setTimeout().unref()` e manda `deadline` no pedido; sem resposta, `expirePermission` resolve `deny` (permissão = não autoriza; pergunta = "siga sem resposta") e emite `agent:permission-expired` p/ fechar o modal. Responder/`setBypass` limpam o timer. **`case 'rate_limit_event'`**: emite `{kind:'rate-limit', limits}` a partir do `rate_limit_info` do SDK (uso de conta — 5h/semana; só contas por assinatura), com `updatedAt: Date.now()`. **`refreshUsage()`**: faz *poll* manual do endpoint experimental do SDK (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`) e emite `rate-limit` para `five_hour`/`seven_day`/`seven_day_opus`/`seven_day_sonnet`/`overage` — chamado ao fim de cada turno e via `agent:refresh-usage`; falhas são silenciosas (endpoint experimental). |
| `agentSession.test.ts` | Testes (Vitest, ambiente **node** — `// @vitest-environment node`, porque o main puxa `node:sqlite` via `config → store`) do fluxo de permissão: auto-aprova leitura com `updatedInput`; pede no chat para `Bash`; resolve `allow`/`deny`; bypass não pede; ligar bypass resolve pendências; **auto-timeout** (fake timers) — manda `deadline`, no prazo auto-nega ferramenta / faz a pergunta prosseguir e chama o callback de expiração, e cancela se o usuário responder antes. **`vision_fallback_router`** (`describeImages` de `visionRelay.ts` mockado): modelo sem visão + imagem → intercepta e envia só texto com `[VISUAL_CONTEXT]`; relay falha → degrada com aviso, não trava o envio; modelo com visão nativa (Claude ou Kimi K2.7 Code — verificado com probe real contra a API do Ollama Cloud) → não chama o relay, imagem vai direto; sem imagem → fluxo idêntico ao anterior. |
| `visionRelay.ts` | **`vision_fallback_router`** — deixa um modelo texto-only "ver" uma imagem sem recebê-la: `describeImages(images, userText)` roda um `query()` **avulso** do SDK (sessão própria, não a principal) contra um modelo multimodal fixo (`claude-sonnet-5`), com `tools: []` (só interpreta, não age) e `maxTurns: 1`; o prompt pede a extração em 8 seções fixas (OCR completo, erros encontrados, elementos de interface, layout visual, contexto técnico, logs/stack traces, componentes relevantes, possíveis problemas). `buildVisualContextBlock` envolve o resultado em `[VISUAL_CONTEXT]…[/VISUAL_CONTEXT]`; `mergeUserTextWithVisualContext` monta o texto final que substitui a imagem no envio ao modelo principal. |
| `visionRelay.test.ts` | Testes (Vitest, `query` do SDK mockado): chama `query()` com o modelo/params certos e devolve o texto concatenado dos blocos do stream; `buildVisualContextBlock`/`mergeUserTextWithVisualContext` montam o wrapper e a mensagem final (com e sem texto original). |
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
| `remote/remoteServer.ts` | **Ponte LAN** (HTTP + SSE) para o controle remoto pelo celular: rotas `/` (landing), `/download` (APK), `/app` (cliente web), `/api/state`/`history`/`events`(SSE)/`send` (com imagens) e **`/api/file`** (stream de entregável com allowlist); **token fixo** (`loadToken`/`saveToken`, `randomBytes(16)` p/ novos); `sanitizeImages`; `downloadablePaths()` (allowlist: `Write` entregável + marcadores `[[download:]]`); **`/api/set-model`** (POST `{convId, model?, effort?}` → dep `onSetModel` + eco otimista no snapshot — o celular troca o modelo/esforço da conversa); o `/api/state` também devolve `models`/`modelEffort`/`effortLabels` (catálogo p/ os seletores do celular); `start`/`stop`/`info`/`broadcast`/`setState`/`setRelayConnected` (`relayConnected` no `RemoteInfo`). |
| `remote/relayClient.ts` | **RelayClient**: WS de saída pro **broker** da VPS (acesso remoto multiusuário, sem senha de VPS). Registra `{token}`, e para cada request relayada faz `http.request` pro `127.0.0.1:<porta>` (reaproveita o `RemoteServer`), devolvendo a resposta em frames (incl. SSE). Reconecta com backoff. Liga/desliga junto com a ponte (`index.ts`). Testes: `relayClient.test.ts` (broker+relay) e `relayE2E.test.ts` (pipe real com o `RemoteServer`). |
| `remote/buildApk.ts` | Gera o APK do app remoto (`smartfone-remote`) via Capacitor, transmitindo o progresso linha a linha. Após o `cap sync`, reaplica de forma idempotente as customizações nativas do `android/` (gitignorado/regenerado): **permissão de câmera**, **ícone adaptativo** (`@capacitor/assets`, mesma arte do desktop) e o **`MainActivity` com `DownloadListener`** (DownloadManager) + permissão de armazenamento. |
| `remote/remoteServer.test.ts` | Testes (Vitest) da ponte: auth por token, `/api/state`/`history`, `send` → `onInbound`, contagem de clientes, e **`/api/file`** (download permitido por `Write`/marcador → 200; fora da allowlist/arquivo de código → 403). |

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
| `ipc.ts` | **Fonte única** dos tipos do IPC e dos nomes de canais (`Channels`): `ChatEvent`, envelopes com `convId`, `PermissionRequest`/`Response` (com `questions?`/`answers?` do `AskUserQuestion`), `AskQuestion`/`AskQuestionOption`/`QuestionAnswer`, `BrowserFrame` (com `mime`), `BrowserState` (com `tabs[]` e `androidSize`), `BrowserInput`, `PickedElement`, `ImageAttachment`, **`FileAttachment`** (anexo não-imagem), `TokenUsage`, `StartAgentOptions`, **`AppConfig`/`DEFAULT_CONFIG`** (inclui `openai`, `remoteToken`, `remoteEnabled`), **`OpenAiConfig`/`OPENAI_VOICES`**, `StitchConfig`, **`OllamaConfig`** + **`OLLAMA_MODELS`/`OLLAMA_BASE_URL`/`isOllamaModel()`** (modelos Ollama Cloud + detecção/roteamento), **`modelSupportsVision()`** (Claude sempre; Ollama só o que estiver em `OLLAMA_VISION_MODELS` — verificado com probe real contra a API, hoje só Kimi K2.7 Code; o resto passa pelo `vision_fallback_router`), **`CacheInfo`** (pasta de dados). **Download:** `DOWNLOADABLE_EXTS`/`isDownloadableFile`, `DOWNLOAD_MARKER`/`parseDownloads` (extrai `[[download:PATH]]` do texto). **Abas:** `TabKind` (incl. `stitch`), `TAB_KINDS`, `TabInfo`, `tabName()`. **Remoto:** `RemoteInfo`, `RemoteConversation` (com `model?`/`effort?`), `RemoteStatePayload` (com `models`/`modelEffort`/`effortLabels` — catálogo p/ os seletores do celular), `RemoteInboundMsg` (com `images?`), **`RemoteSetModelMsg`** (troca de modelo/esforço vinda do celular; canal `remoteSetModel`), `RemoteBuildProgressMsg`. **Esforço:** `EffortLevel` (`low`/`medium`/`high`/`xhigh`/`max`), `MODEL_EFFORT` (níveis suportados por modelo — Haiku só até `high`; Opus/Sonnet/Fable até `max`; Ollama não tem entrada, então o seletor some), `DEFAULT_EFFORT` (`high`); `StartAgentOptions.effort` repassa o nível ao SDK. `RateLimitStatus.updatedAt` (epoch ms do snapshot, para persistência/staleness). Canais novos: `configGet`/`Set`, **`cacheGetInfo`/`cacheChooseDir`**, **`kvGet`/`kvSet`** (store key→JSON), **`fileDownload`**, **`pathExists`**, **`openaiTranscribe`/`openaiTts`**, **`authStatus`/`authLogin`**, **`agentRefreshUsage`**, `browser*`, `remote*`. |
| `speechText.ts` | Tratamento de texto para a **leitura em voz alta**: `toSpeechText(markdown)` (remove código/URLs, mantém o texto de links, não lê tabelas — cita "conforme a tabela") e `splitForSpeech(text)` (fatia por frases numa rampa de tamanho — `CHUNK_RAMP` — para o 1º áudio começar rápido). Funções puras, fáceis de testar. |
| `speechText.test.ts` | Testes (Vitest) de `toSpeechText`/`splitForSpeech`: blocos de código removidos, tabelas citadas, texto de links preservado, rampa de pedaços. |
| `devices.ts` | **Tabela de aparelhos Android** (`ANDROID_DEVICES`: telefones e tablets com resolução px + dpi + ano), `DEFAULT_DEVICE_ID` (`s26-ultra`), `uniqueByResolution()` (deduplica por resolução mantendo o mais recente), `DEVICE_OPTIONS` (lista exibida), `findDevice()`/`deviceForResolution()`. |
| `api.ts` | Interface `AgentCodeApi` — a forma exata de `window.api`. Métodos de agente recebem `convId`; inclui `disposeAgent`, **`refreshUsage`** (poll manual do uso da conta numa sessão), `pickFile`, **`pathExists`** (guarda da pasta do projeto), `openInEditor`, **`downloadFile`** (entregável → Downloads), **`transcribeAudio`/`speak`** (voz), **`authStatus`/`authLogin`** (login do Claude), **`getCacheInfo`/`chooseCacheDir`** (pasta de dados), `setActiveBrowser`, `disposeBrowser`, `newTab`/`selectTab`/`closeTab`, `setAndroidSize`, e o **controle remoto** (`remoteStart`/`Stop`/`Status`, `publishRemoteState`, `buildRemoteApk`, `onRemoteInbound`/`onRemoteBuildProgress`/`onRemoteClients`); eventos como envelopes. |

---

## src/renderer — interface

| Arquivo | Responsabilidade |
|---------|------------------|
| `index.html` | HTML raiz, `<div id="root">`, carrega `src/main.tsx` e define a **Content-Security-Policy**. |
| `src/main.tsx` | Ponto de entrada do React: monta `<UiProvider><App/></UiProvider>` em `StrictMode` e importa `styles.css`. |
| `src/App.tsx` | **Estado central**: lista de `Conversation`, `activeId`, `collapsed`, `browserMinimized`, *chips*, estado do navegador, e — por conversa — `connectedIds`/`busyIds` (Sets) + `permissions` + `queue`. Deriva projetos (por `cwd`) e recentes; roteia cada `AgentEventMsg` para a conversa do `convId` (`reduceMessages`); **sessões paralelas** (trocar/enviar não cancela outra conversa); `connect()` deduplica chamadas concorrentes (`connectingRef`); **fila** por conversa quando ocupada (sem cancelar o turno), despachada ao fim do turno; **interromper** limpa a fila; **rascunho por conversa** (`onDraftChange` grava `Conversation.draft`, restaurado ao trocar de conversa/reabrir o app; *flush* no `beforeunload`); **mensagem nunca se perde no erro** — a bolha do usuário é mostrada na hora; se o turno falhar (`kind:'error'` ou `result.isError` que **não** veio de uma interrupção do usuário — `interruptedRef`), a bolha é marcada com `error` e ganha **"Tentar de novo"** (`inflightRef` rastreia a mensagem em voo; `failedRef` guarda o payload para reenviar via `retryMessage`); mensagens que estavam na **fila** quando a sessão caiu viram bolhas com erro+retry (não somem); modal de permissão só para a conversa ativa (toast avisa pedidos em segundo plano); "permitir tudo" aplica a todas as sessões; cria/seleciona/renomeia/exclui conversas (`disposeAgent` + `disposeBrowser`) e abre nova conversa por projeto (`newChatIn`); passa `busyIds` à `Sidebar`/`ChatPanel` para os indicadores de "processando"; sincroniza o navegador ativo (`setActiveBrowser`); abre o `NewTabModal` (estado `newTabOpen`) e cria a aba via `openTab(kind)` (com toast de sucesso/erro no Android); **controle remoto** (`remoteRunning`, botão 📱 na topbar abre o `RemoteModal`; publica o snapshot das conversas com debounce — incluindo `model`/`effort` por conversa e o catálogo `models`/`MODEL_EFFORT`/`EFFORT_LABELS`; `onRemoteInbound` despacha comandos do celular na conversa certa; `onRemoteSetModel` aplica troca de modelo/esforço vinda do celular via `changeModel`/`changeEffort`, ignorada se a conversa está ocupada); dispara toasts; **botão na topbar abre o projeto da conversa ativa no VS Code** (`openInEditor`, com toast de sucesso/erro); **guarda da pasta do projeto** antes de conectar/enviar (`ensureProject` → `pathExists`) e **bloqueio do composer** quando a pasta sumiu (`projectMissing`, verificado ao trocar de conversa e no `focus` da janela — passado ao `ChatPanel`/`Composer` para impedir a digitação); **gate de login do Claude** no `connect()` (`authStatus` → `authLogin` com toasts antes do `startAgent`; **pulado quando o modelo é Ollama** — `isOllamaModel`, que autentica pela API key); **seletor de modelo** combina os modelos Claude (`MODELS`) com os do Ollama (`OLLAMA_MODELS`) quando a integração está ativa com key (`ollamaReady`); **seletor de esforço** (`effortLevelsFor(model)` → níveis do `MODEL_EFFORT`, some quando o modelo não suporta) — `Conversation.effort` persiste por conversa, `changeEffort` reinicia a sessão ociosa (mesma lógica do `changeModel`) e reseta o esforço ao trocar de modelo se o nível atual não existir no novo (`MODEL_EFFORT[model]`); **snapshot de uso salvo** (`usageLimits`): carrega o último valor do `storage.ts` na abertura e persiste a cada mudança; **`isSpuriousUsageZero`** descarta um 0% espúrio (sessão nova sem dado real) enquanto o snapshot salvo ainda não resetou (`resetsAt` futuro) — vale no evento ao vivo e no seed da abertura; **poll periódico** (5 min, `window.api.refreshUsage` — endpoint de uso, não consome tokens) numa sessão conectada mesmo sem o agente responder; **leitura em voz alta** (`toggleSpeak`/`stopSpeak`/`playClip` — trata o texto com `toSpeechText`/`splitForSpeech`, sintetiza em pipeline com pré-busca e aplica a velocidade via `playbackRate`); `voiceReady`/`needVoiceKey` (abre Configurações com `focus: 'openai'`); responde ao **`AskUserQuestion`** (`answerQuestion`) escolhendo entre `QuestionModal` e `PermissionModal`; renderiza topbar + `Sidebar` + `ChatPanel` + `BrowserPanel` + `PermissionModal`/`QuestionModal` + `NewTabModal` + `RemoteModal` + `SettingsModal`. |
| `src/types.ts` | Tipos da UI: `UserMessage` (com `error?` opcional para a bolha que falhou), `UIMessage`, `TokenTotals`, `Conversation` (com `draft?` — rascunho não enviado, **`effort?`** — esforço de raciocínio do modelo), e a constante `DEFAULT_TITLE`. |
| `src/storage.ts` | Carrega/salva (assíncrono) conversas e estado da UI no **SQLite** da pasta de cache via `window.api.kvGet`/`kvSet` (chaves `agentcode.conversations.v1`, `agentcode.ui.v1`, **`agentcode.usage-limits.v1`**). **Migra** o valor antigo do `localStorage` na primeira leitura. Descarta o campo `images` ao persistir (o `draft` e o `error` da mensagem são persistidos junto da conversa). **`loadUsageLimits`/`saveUsageLimits`**: snapshot do uso da conta (5h/semana), para o badge aparecer já na abertura do app, antes do 1º evento ao vivo. Tolerante a erros. |
| `src/env.d.ts` | Tipos do ambiente: `Window.api` e o namespace global `JSX` (React 19). |
| `src/styles.css` | Tema (variáveis CSS: `--bg`, `--accent` coral, `--ok`/`--err`/`--warn`, etc.) e **todos** os estilos: topbar, sidebar (expandida/colapsada), chat, cartões de ferramenta, composer, navegador, toasts, modais e animações. |
| `src/vad.ts` | **VAD local** (detecção de voz) para o ditado, sem biblioteca externa — funções puras e testáveis: `frameRms` (RMS do waveform), `newVadState`/`vadStep` (marca fala, fecha a fala na pausa `VAD_SILENCE_HOLD_MS` ou no teto `VAD_MAX_SEG_MS`; limiar `VAD_SPEECH_RMS`), `tryArmedTrigger` (transição "armado" → gravando: enquanto não detecta fala retorna `null` — o `Composer` não grava nada nesse meio tempo; no quadro que cruza o limiar, devolve um `VadState` já com `hadSpeech: true`, então a gravação nasce exatamente na fala, sem silêncio de antes embutido no áudio). Testes em `src/vad.test.ts`. |

### src/renderer/src/components

| Arquivo | Responsabilidade |
|---------|------------------|
| `Sidebar.tsx` | Barra de histórico: cabeçalho com marca + botão minimizar; seção **Projetos** (agrupados, expansíveis, com contador e um **"+" por projeto** — `onNewChatIn(path)` — que abre nova conversa naquele projeto) e **Chats** (recentes); trilha de ícones quando colapsada. **Indicador de processamento** (`busyIds`): conversa ocupada mostra um anel girando (`Spinner`) no lugar do ícone de chat e o projeto com alguma conversa ocupada gira no lugar do ícone de pasta. `ConvRow` é um componente de **nível de módulo** (estável entre renders); a edição é identificada **por linha** (`editing.key`) — não por `id` — porque a mesma conversa aparece em duas seções. Renomear por duplo-clique; excluir via `useUI().confirm` + toast. |
| `Sidebar.test.tsx` | Testes do renomear: a conversa aparece 2×; duplo-clique abre **um** campo; Enter chama `onRename`; Esc cancela. |
| `UsageBadge.tsx` | Uso da **conta** (5h/semana) na **topbar** — GLOBAL, não por conversa. Recebe `limits: Record<rateLimitType, RateLimitStatus>`; **renderiza `null`** se vazio (conta por API key ou nenhum evento ainda). Reaproveita as classes `.ctx-bar*` do `ContextBar` (mesma linguagem visual); nível `warn`/`crit` por `utilization` **ou** `status` (`allowed_warning`/`rejected`). Rótulos por `rateLimitType` (`Sessão 5h`, `Semana`, `Semana · Opus/Sonnet`, `Excedente`), ordem fixa. Tooltip explica o **conceito** por tipo (`EXPLAIN`: é da conta, soma Claude Desktop/claude.ai/Claude Code/este app — não é desta conversa), não só o número. Horário de reset (`fmtResetsAt`: min/h/dias) fica **visível do lado da pílula** em texto pequeno/discreto (`.usage-reset`), sem precisar de hover — só o tooltip repete a explicação completa. |
| `UsageBadge.test.tsx` | Sem dado → não renderiza; mostra %/rótulo/dica de reset; ordem correta com vários tipos; nível crítico com `utilization` alto ou `status: 'rejected'`. |
| `ChatPanel.tsx` | Cabeçalho "Chat" + **medidor de contexto/custo**: cronômetro da tarefa, **barra de limite de contexto** (`ContextBar` — uso da **janela de entrada** real `tokens.context` sobre o limite do modelo via `contextLimitFor(model)`; rótulo `usado / limite` ex. `120.0k / 1M`, preenchimento que vira âmbar ≥80% e vermelho ≥95%, com `título` explicando que é "contexto de entrada"), chip **"↑ … saída"** (tokens **gerados** pelo modelo, **acumulado** na conversa — deliberadamente separado da janela de entrada para não confundir) e custo; **faixa "Claude está trabalhando…"** logo abaixo do header enquanto `busy` (anel girando + reticências animadas + barra varrendo a borda); estado vazio; `MessageList` (com `key={convId}` para resetar a janela ao trocar de conversa); **fila de mensagens** (`queued` + `onDeleteQueued`, acima do composer, com botão de remover); `Composer`. Repassa `convId`/`draft`/`onDraftChange` (rascunho por conversa) e `onRetry` (reenvio da mensagem que falhou). Recebe `hasActive` (habilita o composer) e `projects` (menu `@`). **`EffortPicker`** (componente interno): substitui o antigo `<select>` de esforço por um botão (nível atual + seta que gira ao abrir) que revela um **popover** com título "Esforço **Nível**" + ícone de ajuda (tooltip explicando o trade-off) e um `<input type="range">` rotulado "Mais rápido" ↔ "Mais inteligente" (um degrau por nível de `effortLevels`); fecha ao clicar fora (`mousedown` fora de `.effort-picker`). |
| `MessageList.tsx` | Renderiza as mensagens com **janela** (`PAGE`=40; carrega +40 ao rolar ao topo, ancorando o scroll — estilo Gemini) e **markdown** (`Markdown`: `react-markdown` + `remark-gfm`; links `target="_blank"`). Bolhas de usuário/assistente (com **miniaturas de imagens**), narração vs. resposta, *thinking*, sistema, erros, e o `ToolCard`. **Falha na bolha do usuário:** quando `UserMessage.error` está setado, a bolha fica com contorno vermelho e mostra a linha de erro + botão **"↻ Tentar de novo"** (`onRetry(msgId)`, desabilitado enquanto `busy`). (`describeTool`): skill em acento, **`+N`/`−N`** verde/vermelho, nome de arquivo, badge. **Download:** chip "⬇️ Baixar" em `Write` entregável (`isDownloadableFile`) e `DownloadChip` para cada `[[download:PATH]]` no texto do assistente (`parseDownloads` limpa o marcador). **Voz:** botão **"Ouvir/Parar"** (`IconSpeaker`/`IconStopSmall`) no rodapé de cada resposta final → `tts.onToggleSpeak`. **Pergunta (`AskUserQuestion`):** não é pintada como erro — a resposta volta sempre como `deny` (`is_error`), então o card ignora o `tool-error` e usa badge **"respondido"** (ou **"sem resposta"** no timeout), verbo **"Pergunta"**. Cards não comprimem (`flex-shrink: 0`). Auto-scroll só perto do fim. |
| `Composer.tsx` | Caixa de texto com auto-crescimento, *chips* de elementos da página, **botão `@`** (referenciar arquivo/pasta/projeto), **anexo de imagens** (botão, colar ou arrastar → `ImageAttachment[]` base64) **e de qualquer arquivo** (não-imagem → card por tipo, salvo em disco pelo main e referenciado por caminho), **microfone / ditado** (grava **uma fala por segmento** com `MediaRecorder`, cortada nas **pausas** por um **VAD local** — `../vad.ts`, sem biblioteca; **silêncio nunca é gravado, não só nunca enviado**: enquanto "armado" — antes da 1ª palavra, ou no intervalo entre duas falas — o `MediaRecorder` simplesmente não roda; `tryArmedTrigger` (no `runMeter`) só abre o segmento no instante em que detecta fala de verdade, então não sobra silêncio de antes pra cortar depois; transcreve cada segmento somando o texto; ao parar, `stopRecording` (exportada, testada em `Composer.recording.test.ts` com fakes) só desliga o microfone **depois** do evento `'stop'` real do `MediaRecorder` disparar — matar a faixa antes cortava a cauda do áudio (a última frase); enquanto grava mostra uma **forma de onda rolando estilo WhatsApp** — ponto vermelho + cronômetro `rec-time` + faixa `rec-wave` de `WAVE_BARS` barras que rolam da direita p/ a esquerda — alimentada pelo pico de RMS a cada `WAVE_SAMPLE_MS`, junto do VAD no mesmo `runMeter` via Web Audio `AnalyserNode`, sem re-render por frame; setinha → menu de escolha do microfone, `deviceId` persistido em `localStorage`), e **enviar** (↑) + **parar** (■). Enter envia/enfileira, Shift+Enter quebra linha. **Rascunho por conversa:** `value` local sincroniza com `props.draft` ao trocar de `convId` (carrega o rascunho daquela conversa) e reporta cada edição do usuário via `updateValue` → `onDraftChange`; ao enviar, limpa caixa e rascunho. **Pasta do projeto sumiu (`projectMissing`):** o campo fica **read-only** (não `disabled`, para captar o clique), botões `@`/anexo/mic/enviar desabilitados, e qualquer interação (clique/foco/colar/arrastar) mostra o toast de erro e tira o foco — não dá para digitar. |
| `Icons.tsx` | **Ícones SVG de linha** (currentColor) usados na topbar, abas, composer e navegador — substituem emojis/símbolos. Inclui `IconMic`, `IconSpeaker`, `IconStopSmall`, `IconChevronDown` (voz no chat; também a seta do `EffortPicker`), `IconHelp` (tooltip do popover de esforço). |
| `BrowserTabs.tsx` | **Barra de abas** do preview: cada aba com `TabIcon` + nome (`tabName`) + "×"; trocar/fechar via `window.api`. O **"+"** chama `onRequestNewTab` (abre o `NewTabModal` na raiz do app). |
| `TabIcon.tsx` | Ícones em linha (currentColor) por tipo de aba: globo (web), robô (android), telefone (iphone). |
| `BrowserPanel.tsx` | Painel do preview: `BrowserTabs` + barra de navegação + `<canvas>` (desenha frames com o `mime` certo) + status. **Aba web:** URL/Go + botão **Select**. **Aba Android:** botões Voltar/Home, **seletor de modelo** (`DEVICE_OPTIONS`) + **resolução personalizada**, e a tela vai dentro de uma **moldura de aparelho** (bezel + punch-hole) dimensionada ao painel; o tamanho atual vem de `state.androidSize` (sincroniza com o que o LLM define). **Minimizado** vira faixa fina. Reenvia mouse/scroll/teclado do canvas (vira toque no Android). |

### src/renderer/src/ui

| Arquivo | Responsabilidade |
|---------|------------------|
| `UiProvider.tsx` | Provider + hook `useUI()` com `notify` (toasts auto-dispensáveis, 3 tipos) e `confirm` (modal que resolve `Promise<boolean>`). Contém `ToastItem` e `ConfirmDialog`. Valor do contexto memoizado. |
| `PermissionModal.tsx` | Pedido de permissão de ferramenta como modal (Negar / Permitir uma vez / Sempre permitir); Esc nega. Mostra a `CountdownBar` (auto-nega em 7 min sem resposta). |
| `QuestionModal.tsx` | Modal de **pergunta interativa** (`AskUserQuestion`): uma ou mais perguntas com opções clicáveis (single ou **multi-select**), opção **"Outro…"** com campo de texto livre, e botão Responder habilitado só quando toda pergunta tem escolha. A resposta (`QuestionAnswer[]`) volta ao modelo. Esc/clique fora cancela. Mostra a `CountdownBar` (em 7 min sem resposta, o agente prossegue sem a resposta). |
| `CountdownBar.tsx` | Barrinha de contagem regressiva no rodapé dos modais; **esvazia da direita p/ a esquerda** via uma transição CSS única (`scaleX(1→0)`, `transform-origin: left`, duração = `deadline - now`). Só visual — o timeout real é do main. |
| `NewTabModal.tsx` | Modal de **nova aba de preview** (Web / Android / iPhone reservado), com ícone + descrição por tipo; renderizado na raiz do app (não é cortado pela barra de abas). Esc/clique fora cancela. |
| `RemoteModal.tsx` | Modal de **controle remoto** (PC): liga/desliga a ponte LAN, exibe **QR** + endereço/token (**fixo**), contagem de celulares conectados e o botão de **gerar APK** (com progresso). O **QR sempre aponta para a VPS** (constante `REMOTE_PUBLIC_HOST` + `buildPublicUrl` exportada → `https://host/?token=…`; testes em `RemoteModal.url.test.ts`), com legenda 🌐; a URL local (LAN) fica só como texto. Mostra o **status do relay** (`relayConnected`: "Acesso remoto pronto" 🌐 / "Conectando…" ⏳). Acesso remoto multiusuário via **broker** na VPS (ver `broker/` + `scripts/vps-remote-broker.sh`). |
| `SettingsModal.tsx` | Tela de **Configurações**: seção **📁 Pasta de dados (cache)** (mostra o caminho do SQLite/memórias e o botão "Trocar…" → `chooseCacheDir`), a integração **Google Stitch** (ativar + API key), a **🎙️ OpenAI (voz no chat)** (API key + seletor de **voz** `OPENAI_VOICES` + **velocidade**) e a **🦙 Ollama Cloud** (ativar + API key — adiciona os modelos do Ollama ao seletor; Qwen3 Coder/GPT-OSS no plano grátis, demais exigem assinatura). A prop `focus: 'openai'` rola/destaca/foca a seção da key quando uma feature de voz precisa dela. Carrega/salva via `getConfig`/`setConfig` (salva só os campos editados). |

---

## broker — relay multiusuário (VPS)

Projeto **Node separado** (`broker/`, próprio `package.json`, deps: `ws`; Docker) que roda na VPS e faz o acesso remoto **sem senha de VPS**: o PC disca por WebSocket e se registra pelo token; o celular conecta por HTTP e o broker roteia pelo `?token=`. **Stateless** (só o mapa token→conexão em memória; sem DB → sem backup).

| Arquivo | Responsabilidade |
|---------|------------------|
| `src/broker.js` | `createBroker({relayKey})`: HTTP (celular) + WS `/__relay` (PCs) na mesma porta; mapa `token→conexão`; relay HTTP↔WS com **SSE em streaming**; cookie `relay_token` (fallback); `RELAY_KEY` opcional; um PC por token (isolamento). |
| `server.js` | Entrypoint (env `PORT`/`RELAY_KEY`; SIGINT/SIGTERM). |
| `test/broker.test.js` | Integração real (round-trip http↔ws, isolamento por token, SSE, POST com corpo). Config próprio em `vitest.config.mjs`. |
| `Dockerfile` / `docker-compose.yml` | Imagem `node:22-alpine`; expõe `127.0.0.1:8099` (só o Nginx fala); `env_file` `.env`+`.env-prod` (padrão do projeto). |
| `README.md` | Como rodar/deployar e o fluxo do relay. |

> Deploy: subir a pasta `broker/` pra VPS + `docker compose up -d --build`; o Nginx é configurado por `scripts/vps-remote-broker.sh` (proxy pro broker com upgrade de WebSocket + SSE).

## smartfone-remote — app do celular

Projeto **Capacitor** separado (próprio `package.json`/`package-lock.json`) que vira o APK do controle remoto. O cliente é `www/` (HTML/JS puro, servido em `/app` pelo PC e empacotado no APK).

| Arquivo | Responsabilidade |
|---------|------------------|
| `capacitor.config.json` | Config do Capacitor (id/nome do app, pasta `www`). |
| `package.json` | Deps do Capacitor (+ `@capacitor/assets` para os ícones) e scripts (`icons`, `assets`, `build:apk`). |
| `resources/` | **Arte do ícone/splash** do app (mesma faísca coral do desktop): `icon-only.png`, `icon-foreground.png`, `icon-background.png` (1024²) e `splash.png`/`splash-dark.png` (2732²). Geradas de `build/icon.svg`; consumidas por `@capacitor/assets generate --android` para criar todas as densidades de mipmap + o ícone adaptativo. |
| `scripts/make-icons.mjs` | Rasteriza `build/icon.svg` (via Playwright do projeto pai) nos assets de `resources/`. Rode da raiz do repo: `node smartfone-remote/scripts/make-icons.mjs`. |
| `scripts/build-apk.mjs` | Gera o APK: copia o `www/`, adiciona/atualiza a plataforma Android, **aplica o ícone** (`@capacitor/assets generate`, se houver `resources/`) e roda o Gradle (chamado por `remote:build-apk`). |
| `www/index.html` | Telas do app: pareamento (QR/manual, ícones SVG), overlay do scanner, e o chat (header com status pill, mensagens, composer com **anexo de imagem**, **barra de modelo/esforço** (`#model-bar` — dois `<select>` nativos acima do composer), bandeja de preview, **drawer de histórico** e **menu de sair**). |
| `www/app.js` | Lógica do cliente: parear, **auto-conectar** na última sessão, **auto-reconexão** do SSE com backoff + **wake lock**, histórico por projeto (drawer), abrir conversa (`/api/history` + SSE), enviar comando + **imagens** (base64), **markdown** das respostas (`mdToHtml`/`parseDownloads`, seguro por escape), **cards de ferramenta recolhidos/expansíveis** (`renderTool`/`describeTool`, estado em `state.openTools`), **scroll** preservado durante o streaming (`scheduleRender` + rAF), e **botões de download** (chip de `Write` entregável + marcador `[[download:]]` → `/api/file`). **Trocar modelo/esforço** (`renderModelBar`/`setModel`): seletores preenchidos do catálogo do `/api/state` (`models`/`modelEffort`/`effortLabels`), mostram o modelo/esforço atuais da conversa, POST `/api/set-model` na troca (otimista, o poll reconcilia); esforço some para modelo sem suporte (Ollama), ambos desabilitados enquanto a conversa está `busy`, e o rebuild é pulado se o usuário estiver com o dropdown aberto (activeElement). |
| `www/styles.css` | Tema escuro moderno (gradientes, status pill, bolhas com gradiente, drawer/popover animados): pareamento, scanner, chat, markdown (`.md`), cards de ferramenta, bandeja de imagens, botões de download. |
| `www/jsqr.js` | Biblioteca jsQR (decodifica o QR a partir dos frames da câmera). |
| `android/app/src/main/java/.../MainActivity.java` | `BridgeActivity` do Capacitor com um **`DownloadListener`**: arquivos servidos pela ponte (`/api/file`, `Content-Disposition: attachment`) são salvos via **DownloadManager** na pasta Downloads do aparelho. Gerenciado/reaplicado pelo `buildApk.ts` (o `android/` é gitignorado/regenerado). |
| `README.md` | Como buildar/instalar o app remoto. |

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
  | { kind: 'result'; id: string; isError: boolean; text: string; durationMs: number; costUsd?: number; contextTokens?: number; usage?: TokenUsage }
  | { kind: 'status'; id: string; text: string }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'rate-limit'; limits: RateLimitStatus }   // uso da CONTA (5h/semana) — global, nunca vira bolha de chat

interface StartAgentOptions { convId: string; cwd: string; model?: string; skipPermissions?: boolean; resume?: string; effort?: string }
interface AgentEventMsg { convId: string; event: ChatEvent }            // main → renderer (cada evento marcado com a conversa)
interface PermissionRequestMsg { convId: string; req: PermissionRequest }
interface PermissionExpiredMsg { convId: string; id: string }           // main → renderer: pendência expirou (7 min) → fecha o modal
interface AndroidProgressMsg { convId: string; line: string }           // progresso do boot/instalação do Android
interface PermissionRequest { id: string; toolName: string; input: Record<string, unknown>; questions?: AskQuestion[]; deadline?: number }  // deadline = epoch ms p/ auto-resolver
interface PermissionResponse { id: string; behavior: 'allow' | 'deny'; always?: boolean; message?: string; answers?: QuestionAnswer[] }

// Pergunta interativa do agente (AskUserQuestion)
interface AskQuestionOption { label: string; description: string }
interface AskQuestion { header: string; question: string; multiSelect: boolean; options: AskQuestionOption[] }
interface QuestionAnswer { header: string; question: string; selected: string[] }  // picks + texto livre ("Outro")

// Abas de preview
type TabKind = 'web' | 'android' | 'stitch' | 'iphone'
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
interface FileAttachment { name: string; mediaType: string; data: string }  // anexo não-imagem (base64; o main salva em disco e passa o caminho ao agente)

// Configuração e pasta de dados (por usuário)
interface StitchConfig { enabled: boolean; apiKey: string }
interface OpenAiConfig { apiKey: string; voice: string; speed: number }   // voz no chat (TTS + transcrição)
interface OllamaConfig { enabled: boolean; apiKey: string }   // Ollama Cloud (modelos via API compatível com a Anthropic)
const OLLAMA_BASE_URL = 'https://ollama.com'                  // ANTHROPIC_BASE_URL no modo Ollama
function isOllamaModel(model?: string): boolean               // true se o id termina em ':cloud'
const CONTEXT_LIMITS: Record<string, number>                  // janela de contexto REAL por modelo (Opus/Sonnet/Fable=1M, Haiku=200K; Ollama: Qwen3-Coder=256K, gpt-oss=128K, DeepSeek V4 Pro=1M, GLM-5.2=1M, Kimi K2.7=256K — verificados contra os specs de cada modelo)
const DEFAULT_CONTEXT_LIMIT = 200_000                          // fallback p/ modelo fora do mapa
function contextLimitFor(model?: string): number              // limite do modelo (cai no DEFAULT) — denominador da barra de contexto
function modelSupportsVision(model?: string): boolean          // Claude sempre true; Ollama só true p/ OLLAMA_VISION_MODELS (hoje só kimi-k2.7-code:cloud, verificado c/ probe real) — o resto passa pelo vision_fallback_router
interface AppConfig { stitch: StitchConfig; openai: OpenAiConfig; ollama: OllamaConfig; skipPermissions: boolean; remoteToken: string; remoteEnabled: boolean }
interface CacheInfo { dir: string; dbPath: string; memoriesDir: string }   // …/agent-code/{agent-code.db, memories/}

// Download pelo chat
function isDownloadableFile(path: string): boolean                 // extensão entregável (DOWNLOADABLE_EXTS)
function parseDownloads(text: string): { clean: string; paths: string[] }  // remove [[download:PATH]] e devolve os caminhos

// Aparelhos Android (src/shared/devices.ts)
type DeviceType = 'phone' | 'tablet'
interface AndroidDeviceModel { id: string; name: string; type: DeviceType; width: number; height: number; dpi: number; year: number }

// Controle remoto (ponte LAN com o celular)
interface RemoteInfo { running: boolean; url: string; ip: string; port: number; token: string; clients: number }
interface RemoteConversation { id: string; title: string; cwd: string; busy: boolean; connected: boolean; updatedAt: number; messages: unknown[] }
interface RemoteStatePayload { conversations: RemoteConversation[] }
interface RemoteInboundMsg { convId: string; text: string; images?: ImageAttachment[] }   // comando do celular → conversa (+ imagens)
interface RemoteBuildProgressMsg { line: string; done?: boolean; ok?: boolean }

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
