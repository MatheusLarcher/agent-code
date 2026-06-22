# Arquitetura — Agent Code

Este documento descreve **como o app funciona por dentro**. Para a referência arquivo por arquivo, veja [REFERENCIA.md](REFERENCIA.md). Para uso/instalação, veja o [README](../README.md).

## Como rodar

A forma padrão de iniciar o projeto é executar o **`start.bat`** na raiz da pasta (duplo-clique no Windows). Ele usa o Node do sistema ou, se não houver, **baixa um Node portátil** (v24.11.1, extraído em `.node/`, sem admin — reaproveitado depois); instala as dependências na primeira vez (incluindo o Chromium do Playwright), garante o binário do Electron e então roda `npm run dev`. Não é preciso rodar `npm install`/`npm run dev` à mão — o `start.bat` cuida de tudo.

## Sumário

- [Como rodar](#como-rodar)
- [Modelo de processos e segurança](#modelo-de-processos-e-segurança)
- [Sequência de inicialização](#sequência-de-inicialização)
- [Ciclo de vida da sessão do agente](#ciclo-de-vida-da-sessão-do-agente)
- [Tradução de mensagens do SDK em eventos de UI](#tradução-de-mensagens-do-sdk-em-eventos-de-ui)
- [Permissões de ferramentas](#permissões-de-ferramentas)
- [Conversas, projetos e persistência](#conversas-projetos-e-persistência)
- [Interface do chat (cards, janela, referências)](#interface-do-chat-cards-janela-referências)
- [Preview: abas (web + Android)](#preview-abas-web--android)
- [Preview Android (emulador + moldura de device)](#preview-android-emulador--moldura-de-device)
- [Controle remoto (Android ↔ PC)](#controle-remoto-android--pc)
- [Contrato de IPC](#contrato-de-ipc)
- [Notificações e modais](#notificações-e-modais)
- [Build, tipos e ferramentas](#build-tipos-e-ferramentas)
- [Fluxo ponta a ponta de uma mensagem](#fluxo-ponta-a-ponta-de-uma-mensagem)

---

## Modelo de processos e segurança

Três camadas do Electron, com a renderer isolada do Node:

- **Main** (`src/main`, Node): dona da janela, da sessão do agente e do navegador. É o único processo com acesso ao sistema, ao Agent SDK e ao Playwright.
- **Preload** (`src/preload`): ponte segura. Com `contextIsolation: true`, expõe um objeto `window.api` tipado via `contextBridge`, sem vazar o `ipcRenderer` cru para a página.
- **Renderer** (`src/renderer`, React): a interface. Só fala com o main através de `window.api`.

Garantias de segurança:

- `contextIsolation: true` e `sandbox: false` (necessário para o preload usar `ipcRenderer`).
- **Content-Security-Policy** no `index.html`: `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'` — só permite recursos próprios + imagens `data:` (os frames JPEG do navegador).
- Links externos (`window.open`/target=_blank) são interceptados em `setWindowOpenHandler` e abertos no navegador padrão do sistema (`shell.openExternal`), nunca dentro do app.

A janela usa `titleBarStyle: 'hidden'` com `titleBarOverlay` (controles do Windows à direita, altura 52). O ícone vem de `build/icon.ico` (Windows) ou `build/icon.png`.

---

## Sequência de inicialização

`src/main/index.ts`:

1. `app.whenReady()` → `registerIpc()` registra **todos** os handlers `ipcMain.handle(...)`.
2. `createWindow()` cria o `BrowserWindow` (1500×950, mínimo 1000×640, `backgroundColor #1f1e1d`, ícone, title bar oculta com overlay).
3. Em dev, carrega `process.env.ELECTRON_RENDERER_URL`; em produção, `out/renderer/index.html`.
4. A `BrowserController` é criada de forma **preguiçosa** (`getBrowser()`), só quando o navegador é realmente necessário.
5. As `AgentSession` vivem num `Map<convId, AgentSession>` — `agent:start` substitui apenas a sessão **daquela** conversa (descarta a anterior do mesmo `convId` com `dispose()`); as demais seguem rodando.

No encerramento (`window-all-closed`): fecha todos os navegadores e descarta todas as sessões; sai do app (exceto no macOS).

---

## Ciclo de vida da sessão do agente

`src/main/agentSession.ts` encapsula uma conversa com o Agent SDK.

**Entrada de mensagens** — uma `AsyncQueue<SDKUserMessage>` (`src/main/asyncQueue.ts`) é passada como `prompt` para o `query()` do SDK. O SDK consome a fila como um `AsyncIterable`; `send(text, images?)` empurra uma mensagem na fila (string, ou array de blocos quando há imagens) quando o usuário envia algo.

**`start()`** monta as `Options` do SDK e itera o stream:

```ts
const options: Options = {
  cwd,
  model,
  ...(resume ? { resume } : {}),         // retoma uma sessão anterior
  executable: 'node',                    // roda o CLI sob o Node do sistema, não o Electron
  includePartialMessages: true,          // habilita streaming token a token
  permissionMode: 'default',
  settingSources: ['user', 'project', 'local'],   // lê ~/.claude e .claude do projeto
  systemPrompt: { type: 'preset', preset: 'claude_code', append: `${BROWSER_HINT}\n\n${ANDROID_HINT}` },
  mcpServers: {
    browser: createBrowserMcpServer(browser),     // ferramentas browser_* + abas
    android: createAndroidMcpServer(browser)       // ferramentas android_* (build/preview/device)
  },
  canUseTool: (toolName, input) => this.handlePermission(toolName, input)
}
this.q = query({ prompt: this.input, options })
for await (const message of this.q) this.handleMessage(message)
```

- `BROWSER_HINT` explica que o agente tem as ferramentas `browser_*`, que o preview é organizado em **abas** (reusar a aba atual por padrão) e que a página é renderizada ao vivo. `ANDROID_HINT` explica o fluxo Android (instalar a toolchain com `android_setup`, gerar APK, abrir preview e testar em vários tamanhos com `android_set_device`).
- `executable: 'node'` evita que o binário do Electron seja usado como runtime do CLI embutido.
- **Interromper:** `interrupt()` chama `q.interrupt()` (ignora erro se não houver turno ativo).
- **Encerrar:** `dispose()` fecha a fila de entrada (encerra o loop do SDK).

---

## Tradução de mensagens do SDK em eventos de UI

`handleMessage` converte cada `SDKMessage` em um `ChatEvent` normalizado (definido em `src/shared/ipc.ts`) e o emite ao renderer pelo canal `agent:event`:

| Mensagem do SDK | Vira `ChatEvent` |
|-----------------|------------------|
| `system` (subtype `init`) | `{ kind: 'system', sessionId, model, cwd, tools }` |
| `stream_event` → `message_start` | inicia o buffer de texto ao vivo (`liveId`/`liveText`) |
| `stream_event` → `content_block_delta` (`text_delta`) | `{ kind: 'assistant-text', id, text, final: false }` (incremental) |
| `assistant` → bloco `text` | `{ kind: 'assistant-text', ..., final: true }` |
| `assistant` → bloco `thinking` | `{ kind: 'thinking', id, text }` |
| `assistant` → bloco `tool_use` | `{ kind: 'tool-use', id, name, input }` |
| `user` → bloco `tool_result` | `{ kind: 'tool-result', toolUseId, isError, text }` |
| `result` | `{ kind: 'result', isError, text, durationMs, costUsd, contextTokens, usage }` |
| erro no loop | `{ kind: 'error', text }` |

O `sessionId` do evento `system` é capturado pelo renderer e guardado em `Conversation.sdkSessionId` para permitir o `resume` depois. O texto de `result` não é renderizado (duplica a resposta final); ele só serve para marcar a última fala do assistente como "resposta" e atualizar o medidor de tokens/custo.

**Medidor de tokens** — `result.usage` é **cumulativo do turno** (soma o input de todas as requisições à API daquele turno), então **não** serve como "tamanho do contexto". Por isso a sessão captura, a cada mensagem `assistant` **da thread principal** (`parent_tool_use_id === null` — mensagens de **subagentes**/skills são ignoradas, pois reportam o contexto deles, não o da conversa), o `usage` daquela requisição e guarda `lastContextTokens = input + cache_read + cache_creation` (o contexto real da última chamada ao modelo). Ele é enviado como `contextTokens` no `result` (`|| undefined` para o renderer cair no fallback se nunca houve usagem principal). No `App`, o medidor usa **`ctx = contextTokens`** (foto do contexto atual — sobe e desce com compactação), **`out`** acumula `usage.output` e **`$`** acumula `total_cost_usd`.

---

## Permissões de ferramentas

O gate é `canUseTool` → `AgentSession.handlePermission(toolName, input)`.

**Aprovação automática** (retorna na hora) quando:

- `bypassAll` está ligado ("Permitir tudo"); ou
- `toolName` está no conjunto `READ_ONLY` = `Read, Glob, Grep, LS, NotebookRead, TodoWrite, WebFetch, WebSearch`; ou
- `toolName` começa com `mcp__browser__` (ferramentas do navegador); ou
- `toolName` está no conjunto `ANDROID_AUTO` — ferramentas Android de **interação/inspeção** (`android_open_preview`, `android_list_devices`, `android_list_device_models`, `android_set_device`, `android_screenshot`, `android_tap`, `android_swipe`, `android_type`, `android_key`). As ferramentas **pesadas** (`android_setup` — download de GBs —, `android_build_apk`, `android_install_run`) **não** estão aqui, então passam pelo modal; ou
- `toolName` já está em `approvedTools` ("sempre permitir" desta sessão).

**Senão**, registra a pendência e pede ao usuário:

```ts
const id = nextId()
this.askPermission({ id, toolName, input })   // → canal agent:permission-request → modal
return new Promise((resolve) => this.pendingPermissions.set(id, { toolName, input, resolve }))
```

O renderer mostra o `PermissionModal`; a resposta volta por `agent:permission-response` → `resolvePermission(res)`, que resolve a Promise pendente.

### `updatedInput` é obrigatório no `allow`

> Este é o detalhe que causou o bug do "erro de validação interno".

O SDK repassa o retorno do `canUseTool` direto para o CLI embutido, que executa a ferramenta usando o `updatedInput` recebido. Se o `allow` **não devolver** o input, a ferramenta roda com input vazio e falha na própria validação de schema (`Bash` sem `command`, `Write` sem `content`, …). Ferramentas de leitura não quebravam porque são pré-aprovadas pelo CLI e **nem chegam** ao nosso gate.

Por isso **todos** os caminhos de aprovação devolvem o input:

```ts
// auto-aprovação
return Promise.resolve({ behavior: 'allow', updatedInput: input })
// aprovação pelo usuário (resolvePermission)
pending.resolve({ behavior: 'allow', updatedInput: pending.input })
// "permitir tudo" ligado ao vivo (setBypass) resolve as pendências
pending.resolve({ behavior: 'allow', updatedInput: pending.input })
```

A negação retorna `{ behavior: 'deny', message }`.

### "Permitir tudo" a quente

`setBypass(on)` alterna `bypassAll` durante a sessão. Ao **ligar**, resolve imediatamente todas as permissões pendentes (com `updatedInput`). É acionado por:

- `skipPermissions` ao iniciar a sessão (checkbox marcado no momento de conectar), ou
- o canal `agent:set-bypass` quando o usuário marca/desmarca o interruptor com a sessão já conectada.

Comportamento garantido (e coberto por testes em `agentSession.test.ts`):

- Sem permissão e sem bypass → **pergunta no chat** (modal).
- Com "Permitir tudo" → **não pergunta nada** e libera tudo.
- Todo `allow` devolve o `input` original.

---

## Conversas, projetos e persistência

O estado central vive em `src/renderer/src/App.tsx`.

**Modelo** — uma lista de `Conversation` (ver [REFERENCIA.md](REFERENCIA.md#tipos-de-dados)) e um `activeId`. Os **projetos** da barra são derivados (memoizados) agrupando as conversas por `cwd`; os **recentes** são as 15 conversas mais recentes por `updatedAt`.

**Sessões paralelas por conversa** — cada conversa tem a sua própria sessão de agente no main; elas rodam **em paralelo**, então trocar de conversa ou enviar em outra **não cancela** o que estava rodando. O renderer rastreia, em *Sets*, `connectedIds` (conversas com sessão viva) e `busyIds` (as que estão no meio de um turno), além de `permissions` (pedido pendente por conversa). *Refs* (`connectedRef`, `busyRef`, `activeIdRef`) mantêm o valor atual para o listener (registrado uma vez) e o caminho de envio assíncrono. `connect()` chama `agent:start` (com `cwd`, `model`, `skipPermissions`, `resume`) e **deduplica** chamadas concorrentes via `connectingRef` (um `Map` de promessas em voo), para dois envios simultâneos compartilharem **um** start em vez de recriar a sessão e perder mensagem.

**Fila de mensagens** — se o usuário envia algo enquanto o agente está **ocupado naquela conversa** (`busyIds.has(id)`), a mensagem **não** vai pro SDK (que a trataria como *steering*, cancelando/atrapalhando o turno): entra numa fila no renderer (`queue`). A próxima é despachada quando chega o `result` do turno (em `onEvent`); a conversa segue "ocupada" durante o *handoff*. A fila aparece acima do composer e cada item pode ser **removido** antes de enviar (`deleteQueued`). **Interromper** (botão ■) também limpa a fila daquela conversa. É descartada ao excluir a conversa; não é persistida.

**Indicadores de atividade** — o conjunto `busyIds` (passado à `Sidebar` e ao `ChatPanel`) governa a sinalização visual de processamento: na barra lateral, a conversa em execução troca o ícone de chat por um **anel girando** (estilo Windows) e o projeto que tem qualquer conversa ocupada gira no lugar do ícone de pasta; no topo do chat ativo, uma faixa **"Claude está trabalhando…"** (anel + reticências animadas + barra varrendo a borda) aparece enquanto `busy`. A criação de novas conversas saiu do botão fixo no topo da barra para um **"+" ao lado de cada projeto** (`onNewChatIn(path)` → `createConversation`, herdando o modelo já usado naquele `cwd`).

**Permissões por conversa** — cada pedido de ferramenta fica em `permissions[convId]`; o modal só renderiza o da **conversa ativa**. Se um pedido chega para uma conversa **em segundo plano**, um toast avisa que aquele chat está aguardando (senão a sessão dele congelaria sem o usuário perceber). "Permitir tudo" aplica `setBypass` a **todas** as sessões vivas (interruptor global).

**Roteamento de eventos** — cada evento chega ao renderer como `AgentEventMsg` (`{ convId, event }`); `onEvent` aplica o `ChatEvent` à conversa indicada pelo `convId` (não à ativa), então respostas vão para a conversa certa mesmo com várias rodando ao mesmo tempo. `reduceMessages` é um reducer puro que:

- atualiza o texto ao vivo do assistente (mesmo `id`),
- anexa o `result` a um `tool-use` existente,
- marca a última fala como "resposta" no `result`,
- e dedup­lica a nota de "sessão pronta".

**Persistência** (`src/renderer/src/storage.ts`):

- `agentcode.conversations.v1` — todas as conversas; salvo com **debounce de 400ms** (o streaming muda o estado muitas vezes por segundo).
- `agentcode.ui.v1` — `{ collapsed, activeId, browserMinimized }`.
- Um *flag* `hydrated` evita sobrescrever o storage antes de carregar.

---

## Interface do chat (cards, janela, referências)

`src/renderer/src/components/MessageList.tsx` e `Composer.tsx` concentram a apresentação do chat.

**Cards de ferramenta/skill** (`ToolCard` + `describeTool`) — cada `tool_use` vira um card compacto que **encolhe para o tamanho do conteúdo** (`align-self: flex-start`) e **nunca é espremido verticalmente** na coluna rolável (`flex-shrink: 0`). `describeTool` deriva um rótulo no estilo Claude Code:

- **Skill** → mostra o nome real da skill (de `input.skill`), com destaque em cor de acento e fonte em tamanho normal para não se perder no meio do texto.
- **Edit/Write/MultiEdit/NotebookEdit** → nome do arquivo + contadores **`+N`** (verde) / **`−N`** (vermelho) de linhas, calculados de `new_string`/`old_string`/`content`.
- **Read** → nome do arquivo; demais ferramentas → nome limpo (sem o prefixo `mcp__…`).

O badge de status é `running…`/`done`/`error` (erro em vermelho). O corpo expansível mostra `input` e `result`.

**Markdown** — as mensagens do assistente são renderizadas com **`react-markdown` + `remark-gfm`** (componente `Markdown` no `MessageList`): títulos, listas, código/blocos, tabelas, citações e links. É seguro (gera nós React, sem HTML cru → compatível com a CSP); links recebem `target="_blank"` para abrir no navegador do sistema (via `setWindowOpenHandler`) em vez de navegar o frame do app. O `.md` reseta o `white-space: pre-wrap` da bolha para os blocos controlarem o próprio espaçamento.

**Renderização em janela** — conversas longas só renderizam as últimas `PAGE` (40) mensagens. Ao rolar perto do topo (`scrollTop < 80`) e havendo mais antigas, `visible` cresce em +`PAGE` e a posição do scroll é **ancorada** num `useLayoutEffect` (ajusta `scrollTop` pela diferença de altura) para a vista não saltar — estilo Gemini. O auto-scroll para o fim só ocorre na primeira pintura e quando o usuário já está perto do fim (`atBottom`). A janela é **resetada por conversa** via `key={convId}` no `MessageList`.

**Referências `@`** (`Composer.tsx`) — um botão `@` ao lado do campo abre um menu para referenciar **arquivo** (`app:pick-file`), **pasta** (`app:pick-directory`) ou **outro projeto do histórico** (lista derivada em `App`). A escolha insere `@<caminho>` no cursor; **não há leitura própria de arquivos** — o agente resolve a referência com as ferramentas nativas (`Read`/`Glob`/`LS`, auto-aprovadas).

**Envio de imagens** — botão 🖼, **colar** (`onPaste`) ou **arrastar** (`onDrop`) lê os arquivos no renderer via `FileReader` (data URL → base64) e os guarda como `ImageAttachment[]` (`{ mediaType, data }`) com miniaturas. No envio, `sendMessage` passa as imagens por `agent:send`; `AgentSession.send` monta um **array de blocos** (`{ type: 'image', source: { type: 'base64', media_type, data } }` + bloco de texto) em vez de uma string. As miniaturas aparecem na bolha do usuário, mas **não são persistidas** (descartadas em `saveConversations` para não estourar a cota do `localStorage`).

**Minimizar o navegador** — `BrowserPanel` aceita `minimized`/`onToggleMinimize`; minimizado, colapsa para uma faixa fina com botão de restaurar e o chat ocupa a largura toda. O estado persiste em `agentcode.ui.v1`.

---

## Preview: abas (web + Android)

O painel da direita é **multi-aba**, **um por conversa** — o main mantém `Map<convId, BrowserController>` + `activeConvId` (a conversa exibida). `getBrowser(convId)` cria sob demanda; os *callbacks* (`onFrame`/`onState`/`onPicked`/`onAndroidProgress`) só repassam ao renderer quando `convId === activeConvId`. Trocar de conversa manda `browser:set-active` (→ `refreshView()`); excluir manda `browser:dispose`. A sessão do agente recebe `getBrowser(opts.convId)`, então as ferramentas agem no preview da própria conversa.

Cada aba é uma superfície de um **tipo** (`TabKind`): `web` (página do Chromium) ou `android` (tela de um device/emulador). `iphone` está **reservado** (nome + ícone existem; abrir retorna "não implementado"). `TAB_KINDS` (em `src/shared/ipc.ts`) é a fonte única de rótulo/ícone/implementado, e `tabName(tab)` gera o nome exibido **e visto pelo LLM**: `web - <site>` / `android - <app>`.

**Sempre há uma aba ativa** e toda ação age sobre ela. O `BrowserController` mantém `Map<id, Tab>` + `activeTabId`; só a ativa transmite frames (as outras seguem vivas em segundo plano). Um `Tab` tem `page` (web) **ou** `device` (android), nunca os dois.

**Barra de abas** (`BrowserTabs.tsx`) — cada aba com ícone (`TabIcon`: globo/robô/telefone) + nome + "×"; o **"+"** abre o **modal de nova aba** (`NewTabModal`, renderizado na raiz do app para **não ser cortado** pela barra, que rola horizontalmente — era esse o bug do antigo dropdown). O modal lista Web / Android / iPhone (reservado, desabilitado). Canais: `browser:new-tab`, `browser:select-tab`, `browser:close-tab`.

**O LLM controla as abas** — `browser_list_tabs`, `browser_new_tab`, `browser_select_tab`, `browser_close_tab`. O system prompt orienta a **reusar a aba atual** e só abrir outra quando precisar de uma página separada. Ao usar "Select", o `PickedElement` carrega `tabId`/`tabName`, então a mensagem informa de qual aba veio.

### Aba web

`chromium.launch({ headless: true })`, contexto com viewport 1280×800 e `deviceScaleFactor: 2` (renderiza em 2× para o texto ficar nítido). Cada aba web tem sua **sessão CDP** + `Page.startScreencast` (JPEG, qualidade 82); o handler só pinta se a aba for a ativa, e confirma com `screencastFrameAck`. O **picker** é um init script (`PICKER_SCRIPT`, em `src/main/picker.ts`) adicionado **no contexto** (vale para todas as abas); o callback é exposto via `context.exposeBinding('__agentPick', …)`, então `source.page` identifica a aba do clique. A lógica de página (navegar, snapshot, screenshot, click, type, getText, evaluate, select-mode, input) vive em `src/main/pageActions.ts` (funções puras sobre uma `Page`); os tipos/constantes de aba ficam em `src/main/browserTabs.ts`. Assim o `browserController.ts` só orquestra abas.

`src/main/browserTools.ts` expõe, como **servidor MCP em processo**, as ferramentas de aba + `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_get_text`, `browser_evaluate`, `browser_back`, `browser_reload` (todas na aba ativa, esquemas `zod`).

---

## Preview Android (emulador + moldura de device)

A aba Android transmite a tela de um **device físico** (se conectado) ou do **emulador** (AVD padrão) via `adb`. Tudo em `src/main/android/`.

**Toolchain sob demanda** (`androidEnv.ts`) — `detect()` localiza JDK, Android SDK, `adb`, emulador, `sdkmanager`/`avdmanager` (no SDK do próprio app em `userData`, no `ANDROID_HOME`/`ANDROID_SDK_ROOT` ou no SDK do Android Studio). `ensureInstalled()` baixa o que falta com progresso — JDK 17 (Temurin), command-line tools, platform-tools, plataforma `android-34`, build-tools, emulador, system image — aceita licenças e cria um AVD padrão. É **idempotente** (só baixa o ausente) e fica cacheado no `userData` (baixa uma vez, reusa). O Electron é importado de forma preguiçosa para o módulo rodar também em Node puro (testes/scripts).

**Device ao vivo** (`androidDevice.ts`) — `ensureBooted()` sobe o device/emulador; `startStreaming()` empurra frames **PNG** (~6 fps) via `adb exec-out screencap`; toques/swipes/texto/teclas vão por `adb shell input` (coordenadas normalizadas 0–1 → pixels). `setScreenSize(w,h,dpi)` aplica `wm size`/`wm density` (e `resetScreenSize()` restaura); `screenSize` expõe o tamanho atual. `install()`/`launch()` instalam e abrem um APK. Ao fechar a aba: se o device já rodava (não foi o app que subiu), a resolução nativa é restaurada; um emulador que o app subiu é encerrado (`emu kill`). `androidTab.ts` isola o boot e o mapeamento de input do device.

**Moldura + modelos** (`src/shared/devices.ts`, `BrowserPanel.tsx`) — uma **tabela** de presets (telefones e tablets) com resolução (px) e densidade. A lista exibida é **deduplicada por resolução** (`uniqueByResolution`): quando vários aparelhos compartilham a mesma resolução, fica o **mais recente** (maior `year`). O preview começa como **Galaxy S26 Ultra** (`DEFAULT_DEVICE_ID`). O usuário escolhe num seletor ou usa **"Personalizado…"** (largura×altura). Selecionar chama `browser:set-android-size` → `AndroidDevice.setScreenSize`, então o emulador renderiza **naquele tamanho real**. A UI desenha uma **moldura de celular** (bezel arredondado, câmera *punch-hole* nos telefones; bezel fino nos tablets) dimensionada para caber no painel mantendo o aspecto do device.

**Fonte única de verdade** — o tamanho atual vai em `BrowserState.androidSize` (lido do device); a UI (seletor, moldura, status) é derivada disso. Por isso **mudar pelo dropdown ou pela tool do LLM dá no mesmo** — a moldura acompanha. O controller aplica o S26 Ultra ao abrir a aba.

**Frames com `mime`** — como Android transmite PNG e a web JPEG, `BrowserFrame` carrega `mime` (`image/png`|`image/jpeg`, default JPEG) e o `<canvas>` desenha com o tipo certo.

**Ferramentas do agente** (`androidTools.ts`, servidor MCP `android`): `android_setup`, `android_open_preview`, `android_build_apk` (`gradlew assembleDebug`), `android_install_run`, `android_screenshot`, `android_tap`, `android_swipe`, `android_type`, `android_key`, `android_list_devices`, `android_list_device_models` (deduplicada) e `android_set_device` (modelo por id **ou** resolução custom; abre o preview se preciso). O progresso do boot/instalação é transmitido pelo canal `browser:android-progress`.

---

## Controle remoto (Android ↔ PC)

Um celular pode dirigir as **mesmas sessões** do Claude Code que rodam no PC: ele envia comandos e o PC executa, devolvendo os eventos do agente ao vivo. É uma **ponte LAN** (mesma Wi‑Fi) em HTTP + Server‑Sent Events, sem dependências nativas, para um broker/relay poder substituí‑la depois.

**Servidor** (`src/main/remote/remoteServer.ts`) — `RemoteServer` sobe um `http.createServer` em `0.0.0.0:8765` (com *fallback* de porta se ocupada), gera um **token** aleatório e descobre o IP da LAN. Rotas:

- `/` — landing com QR/instruções; `/download` — o APK gerado; `/app` — o cliente web embutido (fallback no navegador).
- `/api/state` — lista de conversas (sem as mensagens); `/api/history?conv=ID` — histórico de uma conversa; `/api/events` — **SSE** com os eventos do agente ao vivo; `POST /api/send` — envia um comando para uma conversa.
- Tudo em `/api/*` exige `?token=` (o mesmo do QR). CORS liberado para o WebView do Capacitor.

**Fluxo** (em `src/main/index.ts`): o `RemoteServer` é criado com `onInbound` (um comando do celular → `remote:inbound` → o renderer despacha na conversa certa, como se fosse digitado), `apkPath`/`wwwDir` (servem o APK e o `www/`) e `onClientsChanged` (→ `remote:clients`). Cada evento do agente é **tee‑ado**: além de ir ao renderer, `remote.broadcast(convId, event)` envia por SSE aos celulares. O renderer publica um **snapshot** das conversas (todas, com mensagens) por `remote:publish-state` (debounce 400ms) para a ponte servir o histórico. A UI do PC (`RemoteModal`) liga/desliga a ponte, mostra o QR/endereço/token e a contagem de celulares, e gera o APK (`remote:build-apk` → `buildApk.ts`, progresso por `remote:build-progress`).

**Cliente do celular** (`smartfone-remote/`) — um app **Capacitor** cujo `www/` (`index.html` + `app.js` + `styles.css` + `jsqr.js`) é o cliente: pareia por **QR** (câmera + jsQR) ou endereço/token manual, lista o **histórico de conversas** num drawer (agrupado por projeto, espelhando a sidebar do PC), abre uma conversa (carrega `/api/history`, acompanha por SSE) e envia comandos. As **permissões continuam sendo aprovadas no PC** — o celular só envia comandos. Sair da conexão fica no menu do indicador "online" (com confirmação). O `www/` é servido em `/app` (atualiza na hora) e empacotado no APK por `scripts/build-apk.mjs` (precisa **regerar o APK** para o app instalado pegar mudanças no `www/`).

---

## Contrato de IPC

Nomes em `src/shared/ipc.ts` (`Channels`). Tipos da API em `src/shared/api.ts`; ponte no preload.

### Renderer → Main (`ipcRenderer.invoke` / `ipcMain.handle`)

| Constante | Canal | Handler (main) | Payload |
|-----------|-------|----------------|---------|
| `pickDirectory` | `app:pick-directory` | abre `dialog.showOpenDialog` (pasta) | — → `string \| null` |
| `pickFile` | `app:pick-file` | abre `dialog.showOpenDialog` (arquivo) | — → `string \| null` |
| `openInEditor` | `app:open-in-editor` | abre a pasta no VS Code (CLI `code`, com *fallback* `vscode://file/`) | `dir` → `{ ok, message }` |
| `agentStart` | `agent:start` | substitui a sessão de `convId` em `sessions` (usa `getBrowser(convId)`) | `StartAgentOptions` `{ convId, cwd, model?, skipPermissions?, resume? }` |
| `agentSend` | `agent:send` | `sessions.get(convId).send(text, images)` | `convId`, `string`, `ImageAttachment[]?` |
| `agentInterrupt` | `agent:interrupt` | `sessions.get(convId).interrupt()` | `convId` |
| `agentSetBypass` | `agent:set-bypass` | `sessions.get(convId).setBypass(on)` | `convId`, `boolean` |
| `agentPermissionResponse` | `agent:permission-response` | `sessions.get(convId).resolvePermission(res)` | `convId`, `PermissionResponse` |
| `agentDispose` | `agent:dispose` | descarta a sessão de `convId` | `convId` |
| `browserLaunch` | `browser:launch` | `browser.ensureLaunched()` | — |
| `browserNavigate` | `browser:navigate` | `browser.navigate(url)` | `string` → `string` |
| `browserBack` / `browserForward` / `browserReload` | `browser:back` / `:forward` / `:reload` | navegação | — |
| `browserSetSelectMode` | `browser:set-select-mode` | `browser.setSelectMode(on)` | `boolean` |
| `browserInput` | `browser:input` | `browser.forwardInput(ev)` (navegador ativo) | `BrowserInput` |
| `browserClose` | `browser:close` | `browser.close()` (navegador ativo) | — |
| `browserSetViewport` | `browser:set-viewport` | redimensiona o viewport da aba web ativa ao painel | `width`, `height` |
| `browserNewTab` | `browser:new-tab` | `getBrowser(activeConvId).newTab(kind)` (web/android) | `TabKind?` → `string` (status) |
| `browserSelectTab` | `browser:select-tab` | torna uma aba a ativa | `tabId` |
| `browserCloseTab` | `browser:close-tab` | fecha uma aba | `tabId` |
| `browserSetAndroidSize` | `browser:set-android-size` | aplica resolução (modelo/custom) no device Android ativo | `width`, `height`, `dpi?` → `string` |
| `browserSetActive` | `browser:set-active` | define `activeConvId` e repinta o painel (`refreshView`) | `string \| null` |
| `browserDispose` | `browser:dispose` | fecha e remove o navegador da conversa | `string` |
| `remoteStart` / `remoteStop` / `remoteStatus` | `remote:start` / `:stop` / `:status` | liga/desliga/consulta a ponte LAN | — → `RemoteInfo` |
| `remotePublishState` | `remote:publish-state` | publica o snapshot das conversas para a ponte servir | `RemoteStatePayload` |
| `remoteBuildApk` | `remote:build-apk` | gera o APK do app remoto (progresso por `remote:build-progress`) | — → `{ ok, apkPath?, message }` |

> Os controles manuais do painel (`launch`/`navigate`/`back`/`forward`/`reload`/`set-select-mode`/`input`/`close`) agem sempre no navegador da **conversa ativa** (`activeConvId`).

### Main → Renderer (`webContents.send` / `ipcRenderer.on`)

| Constante | Canal | Payload |
|-----------|-------|---------|
| `agentEvent` | `agent:event` | `AgentEventMsg` `{ convId, event: ChatEvent }` |
| `agentPermissionRequest` | `agent:permission-request` | `PermissionRequestMsg` `{ convId, req: PermissionRequest }` |
| `browserFrame` | `browser:frame` | `BrowserFrame` `{ data, width, height, mime? }` (mime = `image/png` no Android) |
| `browserStateChanged` | `browser:state` | `BrowserState` (inclui `tabs[]` e, no Android, `androidSize`) |
| `browserPicked` | `browser:picked` | `PickedElement` (com `tabId`/`tabName`) |
| `androidProgress` | `browser:android-progress` | `AndroidProgressMsg` `{ convId, line }` (progresso do boot/instalação) |
| `remoteInbound` | `remote:inbound` | `RemoteInboundMsg` `{ convId, text }` (comando vindo de um celular) |
| `remoteBuildProgress` | `remote:build-progress` | `RemoteBuildProgressMsg` `{ line, done?, ok? }` |
| `remoteClients` | `remote:clients` | `RemoteInfo` (mudou a contagem de celulares / estado da ponte) |

---

## Notificações e modais

`src/renderer/src/ui/UiProvider.tsx` provê o contexto `useUI()` com:

- **`notify(tipo, msg)`** — adiciona um toast ao array de estado. Cada `ToastItem` se auto-remove após `TOAST_MS` (4500ms): marca `leaving` (animação de saída ~280ms) e então chama `onClose`. Fecha também no clique. Três tipos com cor: `sucesso`/`erro`/`aviso`.
- **`confirm(opts)`** — guarda `{ opts, resolve }` no estado e renderiza o `ConfirmDialog`; o clique resolve a `Promise<boolean>`. `Enter` confirma, `Esc`/clique no overlay cancela; `danger: true` deixa o botão de confirmar vermelho.

O valor do contexto é memoizado (`useMemo`) para os consumidores não re-renderizarem a cada toast. O `App` é envolvido pelo `UiProvider` em `main.tsx`, então qualquer componente (incl. `Sidebar`) usa `useUI()`.

`PermissionModal` reusa o mesmo visual de modal para o pedido de permissão do agente, com 3 ações (Negar / Permitir uma vez / Sempre permitir). `NewTabModal` usa o mesmo padrão (`.modal-overlay`/`.modal-card`) para escolher o tipo da nova aba de preview (Web / Android / iPhone reservado) — renderizado na raiz do app, então nunca é cortado pela barra de abas.

---

## Build, tipos e ferramentas

- **electron-vite** (`electron.vite.config.ts`): três alvos. Main e preload usam `externalizeDepsPlugin()` para **não empacotar** o Agent SDK nem o Playwright (eles abrem subprocessos/navegadores nativos). A renderer usa o plugin do React e o alias `@shared → src/shared`.
- **TypeScript** com *project references* (`tsconfig.json` → `tsconfig.node.json` + `tsconfig.web.json`). `node` cobre `src/main`, `src/preload`, `src/shared`; `web` cobre `src/renderer` + `src/shared` (com `lib: DOM`, `jsx: react-jsx`). Ambos `strict`, `moduleResolution: Bundler`, alias `@shared/*`.
- **Vitest** (`vitest.config.ts`): ambiente `jsdom`, `globals`, alias `@shared`, plugin do React; inclui `src/**/*.test.{ts,tsx}`.
- **Ícone** (`scripts/make-icon.mjs`): usa o Playwright para renderizar `build/icon.svg` e salvar `icon.png` (512) e `icon.ico` (256, ICO de uma imagem PNG). Rodar com `npm run icon`.
- **Scripts auxiliares** (`scripts/`): `screenshot.mjs` (gera o print do README dirigindo o app via `_electron`), `ui-tab-test.mjs` (smoke test do sistema de abas) e `android-probe.mjs` (verifica o caminho do preview Android). São utilitários de desenvolvimento, executados com `node scripts/<arquivo>.mjs`.
- **Organização do `BrowserController`**: para manter o arquivo enxuto, a parte de página web está em `pageActions.ts`, os tipos/constantes de aba em `browserTabs.ts`, o init script do picker em `picker.ts` e a parte Android em `android/` (`androidEnv`, `androidDevice`, `androidTab`, `androidTools`).
- **App remoto** (`smartfone-remote/`): projeto **Capacitor** separado (próprio `package.json`). O cliente é o `www/` (HTML/JS puro, sem build). `scripts/build-apk.mjs` gera o APK; o `.gitignore` ignora `smartfone-remote/{node_modules,android,dist,.gradle}`. O **ícone do app** reaproveita a arte do desktop: `scripts/make-icons.mjs` rasteriza `build/icon.svg` em `resources/` (`icon-only`/`-foreground`/`-background` + `splash`), e o build roda `@capacitor/assets generate --android` para gerar mipmaps + ícone adaptativo. Trocar o ícone do desktop e regerar reflete nos dois.

---

## Fluxo ponta a ponta de uma mensagem

1. Usuário digita no `Composer` e envia → `App.sendMessage(text)`.
2. Se houver *chips* (elementos selecionados na página), eles são anexados ao texto.
3. Se a conversa ativa não está conectada, `connect()` dispara `agent:start` (com `resume` se houver) → o main cria uma `AgentSession` e começa o loop do SDK.
4. A mensagem do usuário é adicionada à conversa (e vira o título, se ainda for o padrão) e enviada por `agent:send` → entra na `AsyncQueue`.
5. O SDK processa: emite `system` (init, captura `sessionId`), textos em streaming, `thinking`, `tool_use`.
6. Cada `tool_use` passa pelo gate de permissão: auto-aprovado (com `updatedInput`) ou pede no modal.
7. Ferramentas `browser_*` dirigem o Chromium; os frames aparecem ao vivo no `BrowserPanel`.
8. `tool_result` e a resposta final chegam como `ChatEvent`; o `MessageList` renderiza os cartões e a resposta; o medidor de tokens/custo é atualizado pelo `result`.
9. Tudo é persistido (debounce) no `localStorage` e reaparece no próximo início.
