# Arquitetura — Agent Code

Este documento descreve **como o app funciona por dentro**. Para a referência arquivo por arquivo, veja [REFERENCIA.md](REFERENCIA.md). Para uso/instalação, veja o [README](../README.md).

## Como rodar

A forma padrão de iniciar o projeto é executar o **`start.bat`** na raiz da pasta (duplo-clique no Windows). Ele usa o Node do sistema ou, se não houver, **baixa um Node portátil** (v24.11.1, extraído em `.node/`, sem admin — reaproveitado depois); instala as dependências na primeira vez (incluindo o Chromium do Playwright), garante o binário do Electron e então roda `npm run dev`. Não é preciso rodar `npm install`/`npm run dev` à mão — o `start.bat` cuida de tudo. As skills são sincronizadas pelo processo principal depois que a pasta de dados ativa é carregada.

## Sumário

- [Como rodar](#como-rodar)
- [Modelo de processos e segurança](#modelo-de-processos-e-segurança)
- [Autenticação (login do Claude)](#autenticação-login-do-claude)
- [Sequência de inicialização](#sequência-de-inicialização)
- [Ciclo de vida da sessão do agente](#ciclo-de-vida-da-sessão-do-agente)
- [Tradução de mensagens do SDK em eventos de UI](#tradução-de-mensagens-do-sdk-em-eventos-de-ui)
- [Permissões de ferramentas](#permissões-de-ferramentas)
- [Reiniciar o app pelo agente](#reiniciar-o-app-pelo-agente)
- [Modal de pergunta interativa (AskUserQuestion)](#modal-de-pergunta-interativa-askuserquestion)
- [Vigia — o observador que questiona premissas](#vigia--o-observador-que-questiona-premissas)
- [Memorista — o observador que grava memória sozinho](#memorista--o-observador-que-grava-memória-sozinho)
- [Quadro de tarefas do projeto (trava do plano + agente PO)](#quadro-de-tarefas-do-projeto-trava-do-plano--agente-po)
- [Tela de Planejamento (Agent Manager)](#tela-de-planejamento-agent-manager)
- [Voz no chat (OpenAI)](#voz-no-chat-openai)
- [Modelos via Ollama Cloud](#modelos-via-ollama-cloud)
- [Pasta de dados (cache) e SQLite](#pasta-de-dados-cache-e-sqlite)
- [Memória persistente](#memória-persistente)
- [Conversas, projetos e persistência](#conversas-projetos-e-persistência)
- [Interface do chat (cards, janela, referências)](#interface-do-chat-cards-janela-referências)
- [Baixar arquivos pelo chat](#baixar-arquivos-pelo-chat)
- [Preview: abas (web + Android)](#preview-abas-web--android)
- [Preview Android (emulador + moldura de device)](#preview-android-emulador--moldura-de-device)
- [Controle remoto (Android ↔ PC)](#controle-remoto-android--pc)
- [Skills (kit portátil)](#skills-kit-portátil)
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
- **Content-Security-Policy** no `index.html`: `default-src 'self'; img-src 'self' data:; media-src 'self' data: blob:; frame-src 'self' blob:; object-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'` — só permite recursos próprios + imagens `data:` (frames JPEG do navegador) + `blob:` em frames/objetos (visualizador de PDF da Janela de Arquivo).
- Links externos (`window.open`/target=_blank) são interceptados em `setWindowOpenHandler` e abertos no navegador padrão do sistema (`shell.openExternal`), nunca dentro do app.

A janela usa `titleBarStyle: 'hidden'` com `titleBarOverlay` (controles do Windows à direita, altura 52). O ícone vem de `build/icon.ico` (Windows) ou `build/icon.png`.

Além disso, a sessão da janela libera a permissão de **microfone** (necessária para o ditado por voz, ver [Voz no chat](#voz-no-chat-openai)): o Electron nega `media` por padrão quando não há handler, então `setPermissionRequestHandler` e `setPermissionCheckHandler` (os dois são necessários — o `getUserMedia` consulta o *check* síncrono primeiro e depois o *request* assíncrono) liberam **só** `media` da própria renderer. A CSP do `index.html` ganhou `media-src 'self' data: blob:` para o `<audio>` da leitura em voz alta tocar áudio `data:`/`blob:`.

---

## Autenticação (login do Claude)

O app faz o **login do Claude com um clique**: ao clicar em **Conectar** sem um login existente, ele detecta e dispara o fluxo de OAuth sozinho, sem pedir para o usuário digitar `/login` no chat (o loop `query()` do SDK roda em modo `--print`, headless, e **não** consegue conduzir o fluxo interativo de OAuth — por isso a abordagem antiga nunca abria o navegador).

- **Resolver o binário do CLI** (`src/main/claudeCli.ts`) — `claudeCliPath()` localiza o **CLI nativo do Claude Code** que o Agent SDK distribui como dependência opcional por plataforma (`@anthropic-ai/claude-agent-sdk-<plat>-<arch>`, mais a variante `-musl` no Linux). Usa `createRequire(import.meta.url).resolve(\`${pkg}/${bin}\`)` (`claude.exe` no Windows, `claude` nos demais), cacheia o caminho e lança se nenhum candidato resolver. Como o `externalizeDepsPlugin` mantém esses pacotes como `require` de runtime em `node_modules`, o `require.resolve` acha o binário em produção também. **No Windows, isso é o binário nativo `win32-x64` (`claude.exe`) — não WSL, não uma camada de compatibilidade Linux.** A única aparição de "WSL" em todo o projeto é um regex em `remoteServer.ts` que **filtra** o adaptador de rede virtual do WSL ao detectar o IP da LAN pro QR do controle remoto — não tem relação com rodar o agente.
- **Status** (`src/main/auth.ts`) — `isAuthenticated()` pergunta ao **próprio CLI** (`claude auth status --json`, `cwd: homedir()`, timeout 15 s) e lê `loggedIn === true` do JSON. **Não** lê `~/.claude/.credentials.json` porque esse arquivo **não** é a fonte da verdade: no Windows o token de OAuth vive no **Credential Manager** (keychain), então o arquivo pode estar ausente/desatualizado mesmo logado. O `auth status` lê o store que a plataforma usa, então é autoritativo e multiplataforma; qualquer falha (CLI ausente, JSON inválido) resolve `false`.
- **Login** (`src/main/login.ts`) — `runClaudeLogin(openUrl, log)` faz `spawn` de `claude auth login --claudeai` (`stdin: 'ignore'` para o CLI ver uma sessão não-interativa e usar o callback de loopback em vez de pedir para colar o código). Conforme o CLI imprime no stdout/stderr, `scan()` **raspa a primeira URL de OAuth** (filtra por `claude.ai`/`anthropic.com`/`/oauth`/`authorize`) e a abre no **navegador do sistema** via `openUrl` (garante a abertura mesmo se o auto-open do CLI não disparar). A conclusão é confirmada por **`auth status`** (não por esperar o CLI sair, que pode ficar travado esperando `[Enter]` que não podemos enviar): há um poll de backstop a cada 2,5 s, confirmação ao ver `"Login successful"`, no `exit` do processo e um timeout de 3 min. Um único login roda por vez — `inFlight` faz cliques concorrentes (ou várias conversas conectando juntas) **compartilharem** a mesma tentativa em vez de gerar vários processos `auth login`.
- **IPC** — `auth:status` → `{ authenticated }`; `auth:login` → `{ ok }` (passa `shell.openExternal` como `openUrl`). No `src/renderer/src/App.tsx`, o `connect()` faz o **gate**: chama `authStatus()` e, se não logado, mostra um toast "abrindo o login… é só autenticar", chama `authLogin()` e, no sucesso, toast "Login concluído!" antes de chamar `startAgent`; se falhar, toast de erro e aborta o connect (lança para o caminho de envio não prosseguir).

> Diagnóstico temporário: `index.ts` ainda mantém um `authLog()` que grava `auth-debug.log` na pasta de cache — é só instrumentação do fluxo de OAuth, não uma feature permanente.

---

## Sequência de inicialização

`src/main/index.ts`:

1. `app.whenReady()` → `registerIpc()` registra **todos** os handlers `ipcMain.handle(...)`.
2. `createWindow()` cria o `BrowserWindow` (1500×950, mínimo 1000×640, `backgroundColor #1f1e1d`, ícone, title bar oculta com overlay).
3. Em dev, carrega `process.env.ELECTRON_RENDERER_URL`; em produção, `out/renderer/index.html`.
4. A `BrowserController` é criada de forma **preguiçosa** (`getBrowser()`), só quando o navegador é realmente necessário.
5. As `AgentSession` vivem num `Map<convId, AgentSession>` — `agent:start` substitui apenas a sessão **daquela** conversa (descarta a anterior do mesmo `convId` com `dispose()`); as demais seguem rodando.

No encerramento (`window-all-closed`): fecha todos os navegadores e descarta todas as sessões; sai do app (exceto no macOS).

**A abertura é lenta e precisa parecer abertura, não travamento.** Medido no `auth-debug.log` (a linha `boot electron/store/janela`, no mesmo molde do `bootStage`): o Electron sobe em ~240 ms, o `initStore()` custa ~3 ms e a janela aparece ~100 ms depois do `whenReady` — o custo real é o **`boot storage`**, de ~1,3 s com o cache do SO quente a **~4–6 s frio**, porque o banco tem dezenas de MB e a pasta de dados do usuário pode estar numa pasta sincronizada (OneDrive). A janela **já vinha antes do banco** de propósito; o que faltava era dizer isso na tela. São duas etapas com a mesma aparência, para a troca não piscar: o `#boot` do `src/renderer/index.html` (CSS e markup puros, dentro do próprio HTML — qualquer coisa que dependa do bundle de 2,3 MB chegaria tarde demais para o problema que resolve) cobre da primeira pintura até o React montar, e o `.app-boot` do `App.tsx` cobre daí até `hydrated`, trocando o rótulo para "Carregando conversas…" quando a persistência já respondeu. O `.app-boot` fica **por cima** da casca em vez de substituí-la — trocar de árvore no meio da abertura custaria remontar tudo.

---

## Ciclo de vida da sessão do agente

`src/main/agentSession.ts` encapsula uma conversa com o Agent SDK.

**Entrada de mensagens** — uma `AsyncQueue<SDKUserMessage>` (`src/main/asyncQueue.ts`) é passada como `prompt` para o `query()` do SDK. O SDK consome a fila como um `AsyncIterable`; `send(text, images?)` empurra uma mensagem na fila (string, ou array de blocos quando há imagens) quando o usuário envia algo.

**`start()`** monta as `Options` do SDK e itera o stream:

```ts
const options: Options = {
  cwd,
  model,
  ...(effort ? { effort } : {}),         // esforço de raciocínio da conversa (low…max)
  additionalDirectories: [memoriesDir],  // libera a pasta de memórias (fora do cwd) p/ ler/gravar
  ...(resume ? { resume } : {}),         // retoma uma sessão anterior
  executable: 'node',                    // roda o CLI sob o Node do sistema, não o Electron
  includePartialMessages: true,          // habilita streaming token a token
  permissionMode: 'default',
  settingSources: ['user', 'project', 'local'],   // lê ~/.claude e .claude do projeto
  systemPrompt: { type: 'preset', preset: 'claude_code', append: `${BROWSER_HINT}\n\n${ANDROID_HINT}\n\n${DOWNLOAD_HINT}\n\n${buildMemoryHint(memoriesDir)}` },
  mcpServers: {
    browser: createBrowserMcpServer(browser),     // ferramentas browser_* + abas
    android: createAndroidMcpServer(browser)       // ferramentas android_* (build/preview/device)
  },
  canUseTool: (toolName, input) => this.handlePermission(toolName, input)
}
this.q = query({ prompt: this.input, options })
for await (const message of this.q) this.handleMessage(message)
```

- `BROWSER_HINT` explica que o agente tem as ferramentas `browser_*`, que o preview é organizado em **abas** (reusar a aba atual por padrão) e que a página é renderizada ao vivo. `ANDROID_HINT` explica o fluxo Android (instalar a toolchain com `android_setup`, gerar APK, abrir preview e testar em vários tamanhos com `android_set_device`). `DOWNLOAD_HINT` instrui o agente a, quando o usuário pede um arquivo entregável (APK, zip, PDF…), emitir um marcador `[[download:CAMINHO_ABSOLUTO]]` numa linha própria — o app transforma isso num botão de **Baixar** no chat (ver [Baixar arquivos pelo chat](#baixar-arquivos-pelo-chat)). `buildMemoryHint(memoriesDir)` é montado **por sessão** (o caminho e o índice são dinâmicos): diz ao agente onde fica a **memória persistente** do usuário, como salvar/recall e **pré-carrega o `MEMORY.md`** atual (ver [Memória persistente](#memória-persistente)).
- `additionalDirectories: [memoriesDir]` — a pasta de memórias vive **fora** do `cwd` do projeto, então é liberada explicitamente; sem isso o limite do workspace bloquearia ler/gravar os `.md` de memória.
- `executable: 'node'` evita que o binário do Electron seja usado como runtime do CLI embutido.
- **Interromper:** `interrupt()` manda o pedido ao SDK, **solta toda permissão/pergunta pendente com uma negativa** e espera o recibo por no máximo `INTERRUPT_ACK_TIMEOUT_MS` (5 s). A ordem é deliberada — um turno parado num pedido de permissão não está rodando: está pendurado na promessa do `canUseTool` **deste** processo, que o `q.interrupt()` sozinho não resolve (era o caso em que o botão parecia não fazer nada). Soltar antes de enviar o pedido daria ao modelo o resultado da ferramenta e ele emendaria a próxima chamada; soltar só depois do `await` trava, porque o recibo não vem enquanto o CLI espera a permissão. Se nada sobreviveu, `markTurnIdle()` é chamado aqui mesmo: quando o Stop pega a mensagem **antes** de o turno começar, o SDK a descarta e **não emite `result` nenhum** — sem isso `turnActive` ficava de pé para sempre (e com ele o bloqueio de suspensão e o "tem agente ocupado" do relançador). Erro do SDK (fora de turno) continua ignorado e não marca cancelamento.
- **Encerrar:** `dispose()` fecha a fila de entrada (encerra o loop do SDK).

**Watchdog de travamento (`src/main/stallWatch.ts`)** — "ocupado" sozinho é otimista: liga ao enviar e só desliga com `result`/`error`, então uma sessão travada e uma trabalhando ficam idênticas na tela — e é justamente com muitos agentes ao mesmo tempo que isso acontece.

`isStalled(now, lastActivityAt, toolInFlight)` compara o tempo parado contra um limiar curto (`STALL_THRESHOLD_MS` = 60 s, sem ferramenta em voo) ou longo (`STALL_THRESHOLD_TOOL_MS` = 5 min, com ferramenta em voo). Os dois limiares existem porque um build ou download legítimo passa minutos sem emitir nada: um aviso que dispara nesse caso é falso positivo, e falso positivo é o que faz o usuário parar de acreditar no aviso.

- A `AgentSession` guarda `lastActivityAt` e um `setInterval` (`STALL_POLL_MS` = 5 s, com `unref`) chama `isStalled`. Ele **só roda durante um turno**: fora dele o silêncio é o estado normal, não uma falha.
- **Sinal de vida** é qualquer `SDKMessage` (inclusive um delta de streaming) e qualquer ferramenta entrando ou saindo de voo. Sair do estado travado é imediato, sem esperar o próximo tique.
- `toolsInFlight` é **paralelo** a `restartOpaqueCalls` e não se confunde com ele: aquele rastreia só ferramenta não verificável (é sobre reiniciar com segurança), este rastreia **qualquer** ferramenta (é sobre quanto silêncio é normal).
- A mudança de estado vira o `ChatEvent` `stall-status` (`{ stalled, since }`). Como o `rate-limit`, é **estado e não conteúdo**: o `App.tsx` o intercepta antes do reducer e ele nunca vira bolha. O mesmo vale no celular — `reduce()` em `app.js` tem um conjunto `STATE_ONLY`, senão o evento cairia no `push` final e engordaria a lista a cada ocorrência (invisível, porque a renderização é whitelist, mas acumulando).
- No `ChatPanel`, a faixa "Claude está trabalhando…" vira **"Sem resposta há Xs"** em âmbar, com a varredura da borda parada (animação de progresso durante silêncio é a informação errada) e o anel ainda girando (o trabalho segue em aberto). O texto afirma o observável, não um diagnóstico: **nada é cancelado** por causa disso e o turno pode terminar sozinho.
- O contador fica num componente próprio (`WorkingBanner`) por causa do relógio: um `now` tiquetaqueando no corpo do `ChatPanel` re-renderizaria a lista de mensagens inteira a cada segundo.
- No renderer o aviso é atrelado ao `busy`: uma entrada que sobrou (sessão morta sem emitir o "voltou") não pode acusar travamento num chat parado. E `dispose()` limpa o intervalo antes de tudo — um tique sobrevivendo à sessão emitiria evento de uma conversa que já não existe.

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

**Entrada (janela de contexto) vs. saída** — são coisas distintas e o `ChatPanel` as mostra separadas para não confundir:
- **Contexto de entrada** = `ctx` (`tokens.context`) = o que está sendo **enviado** ao modelo naquela requisição (a janela que ele recebe). É o numerador da **barra de limite de contexto** (`ContextBar`); o denominador é o limite do modelo (`contextLimitFor(model)` — `CONTEXT_LIMITS` em `shared/ipc.ts`: Opus/Sonnet/Fable 1M, Haiku 200K — valores Anthropic **autoritativos**; Ollama Cloud com a janela **nativa real** de cada modelo — Nemotron 3 Ultra 256K, gpt-oss 128K, **DeepSeek V4 Pro e a família GLM-5.3 1M** (verificados contra a documentação de cada modelo — antes estavam sub-relatados em 128K/200K, o que fazia a barra parecer cheia bem antes do limite de verdade), Kimi K3 1M; fallback `DEFAULT_CONTEXT_LIMIT`). A barra mostra `usado / limite` e a % de preenchimento. Manter o mapa em sinc ao adicionar modelo ao seletor — limite errado = barra errada.
- **Contexto de saída** = `out` (`tokens.output`) = tudo que o modelo **gerou** (acumulado na conversa). **Não** é a janela de contexto; é um chip separado (`↑ … saída`).

**Custo — aviso de que não é cobrança real** — o chip `$` (`.tok.cost`) mostra `total_cost_usd` do SDK, que é uma **estimativa pelo preço da API avulsa** (pay-as-you-go). Quem usa um **plano de assinatura** (Pro/Max) não é cobrado por esse valor — o uso já está incluído no plano. O visual (`~$X.XX`, o `~` como pista permanente) e o `title` deixam isso explícito, sem precisar abrir nada.

**Uso da conta (5h / semana) — `UsageBadge`, GLOBAL, não por conversa** — o SDK emite `SDKRateLimitEvent` (`type: 'rate_limit_event'`, um `rate_limit_info` por vez: `status`, `rateLimitType` — `five_hour` | `seven_day` | `seven_day_opus` | `seven_day_sonnet` | `seven_day_overage_included` | `overage` —, `utilization` 0..1, `resetsAt`) **só para contas por assinatura** (claude.ai Pro/Max); uma chave de API avulsa nunca dispara isso. `agentSession.ts` trata `case 'rate_limit_event'` e emite `{ kind: 'rate-limit', limits }` (`shared/ipc.ts` → `RateLimitStatus`). No `App.tsx`, esse evento **não passa por `patchConv`** — é tratado logo no início do `onEvent` (`return` cedo), atualizando um estado próprio `usageLimits: Record<rateLimitType, RateLimitStatus>` que **não é da conversa ativa** e por isso **sobrevive trocar de conversa** (diferente do `ContextBar`/custo, que resetam por conversa). `UsageBadge.tsx` (novo componente, na **topbar** — sempre visível, sem depender de sessão conectada) reaproveita a **mesma linguagem visual** do `ContextBar` (classes `.ctx-bar*`: track+fill, âmbar ≥80%/`allowed_warning`, vermelho ≥95%/`rejected`); **renderiza `null`** se `limits` estiver vazio (conta por API key, ou nenhum evento ainda) — nunca mostra uma barra vazia/0% enganosa.

O `rate_limit_event` é **espontâneo** (o backend só manda quando quer), então o badge podia ficar desatualizado por muito tempo numa conversa parada. `AgentSession.refreshUsage()` faz um **poll manual** do endpoint experimental do SDK (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`) e emite os mesmos eventos `rate-limit` — chamado (1) ao fim de cada turno (`void this.refreshUsage()`, sem bloquear a resposta) e (2) a cada **5 minutos** pelo `App.tsx` numa sessão conectada (`window.api.refreshUsage(convId)` → IPC `agent:refresh-usage`), mesmo sem o agente responder. Esse poll usa o endpoint de uso da conta do SDK — **não** é uma chamada ao modelo, então **não consome tokens** nem conta no uso. `RateLimitStatus.updatedAt` marca quando o snapshot foi produzido. **Zero espúrio:** uma sessão recém-aberta às vezes reporta `0%` / "já resetou" antes de ter número real, apagando um badge válido; `isSpuriousUsageZero(prev, next)` (App.tsx, testada em `App.test.tsx`) descarta um snapshot com utilização ~0 **enquanto** o snapshot salvo ainda diz que a janela não resetou (`resetsAt` no futuro) — um reset de verdade (horário já passado) segue zerando o badge normalmente. A mesma regra vale no *seed* da abertura do app (o valor salvo vence um zero espúrio que chegou ao vivo primeiro). O `App.tsx` também **persiste** `usageLimits` em `storage.ts` (`loadUsageLimits`/`saveUsageLimits`, chave `agentcode.usage-limits.v1`) a cada mudança, e o carrega na abertura do app — só como *seed* se nada tiver chegado ao vivo ainda — para o badge já aparecer com o último valor conhecido, sem esperar o 1º evento da sessão.

**Consumo do GPT no mesmo badge** — o backend Codex devolve o uso do plano ChatGPT em headers de resposta (`x-codex-primary-used-percent`, `x-codex-primary-window-minutes`, `x-codex-primary-resets-in-seconds` ou `-reset-after-seconds`, e os `secondary` equivalentes — os mesmos que o Codex CLI lê para o `/status`). `parseCodexRateLimitHeaders` (`codexProxy.ts`) os transforma em `RateLimitStatus` com `rateLimitType` `gpt_primary`/`gpt_secondary` e `windowMinutes`; o proxy é único no processo, então `onCodexRateLimit` (registrado em `index.ts`) recebe cada snapshot e o envia como `rate-limit` pelo canal `agent:event` com `convId: 'codex'` — o renderer já ignora o `convId` desse evento. `usageProviderOf(type)` (`shared/ipc.ts`) diz a que assinatura cada janela pertence. O `UsageBadge` agrupa por assinatura (**Claude** / **GPT**) e a barra compacta mostra só as marcadas em `UiState.usageProviders` (persistido em `agentcode.ui.v1`); um chevron discreto abre um popover com todas as assinaturas, seus limites (ou "sem dados ainda") e o toggle "mostrar na barra". Na recuperação automática de turno (`scheduleFailure`), só as janelas da assinatura do modelo da conversa entram no cálculo do reset — uma janela do GPT não agenda o retry de um chat Claude. Os nomes dos headers vêm do código do Codex CLI e o parser aceita as duas grafias do reset; sem header, nenhum badge de GPT aparece.

**Esforço de raciocínio (`EffortPicker`)** — cada conversa guarda um `effort?: EffortLevel` (`low`/`medium`/`high`/`xhigh`/`max`, default `high`); `MODEL_EFFORT` (`shared/ipc.ts`) define quais níveis cada modelo aceita (Haiku vai só até `high`; Ollama não tem entrada — o seletor some, `effortLevelsFor` devolve `[]`). É repassado a `Options.effort` do SDK em `agentSession.ts`. Ao trocar de modelo (`changeModel`), se o nível atual não existir no `MODEL_EFFORT` do novo modelo, cai pro `DEFAULT_EFFORT`. O `ChatPanel` renderiza um popover (não um `<select>` nativo) com um `<input type="range">` — mesma ideia visual do modelo (botão + seta que gira), mas com slider "Mais rápido" ↔ "Mais inteligente" em vez de lista.

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

> A auto-aprovação por prefixo cobre as ferramentas do navegador e do Android; o gate real continua sendo a escrita no projeto (`Write`/`Edit`, que ainda pergunta).

### Auto-resolução por tempo (7 min) + barrinha

Todo pedido que vai ao usuário (permissão **ou** `AskUserQuestion`) tem um **prazo**: a constante `PERMISSION_TIMEOUT_MS = 7 * 60_000` em `agentSession.ts`. Ao registrar a pendência (`registerPending`), arma-se um `setTimeout` (com `.unref()` para não segurar o processo) e o `PermissionRequest` carrega um `deadline` (epoch ms). Se o usuário **não responder a tempo**, `expirePermission(id)`:

- **Permissão de ferramenta** → resolve `deny` ("Sem resposta do usuário (tempo … esgotado). A ferramenta NÃO foi autorizada…") — nunca auto-permite algo que o usuário não viu;
- **`AskUserQuestion`** → resolve `deny` com a mensagem "O usuário não respondeu em 7 minutos. Siga … assuma a opção mais sensata e continue" — ou seja, o modelo **prossegue** sem a resposta;
- emite `agent:permission-expired` (`{convId, id}`) → o renderer fecha o modal daquela conversa (`onPermissionExpired`).

Responder a tempo (`resolvePermission`) e ligar "Permitir tudo" (`setBypass`) **limpam o timer** (`clearTimeout`). O timeout é **autoritativo no main**, então funciona mesmo se o modal não estiver montado (conversa em background).

A contagem aparece como uma **barrinha** (`src/renderer/src/ui/CountdownBar.tsx`) no rodapé dos dois modais (`PermissionModal`/`QuestionModal`), que **esvazia da direita para a esquerda** via uma única transição CSS (`transform: scaleX(1→0)` com `transform-origin: left`, duração = `deadline - now`) — sem re-render por frame. É só visual; quem resolve de fato é o main.

---

## Modal de pergunta interativa (AskUserQuestion)

Quando o agente chama a ferramenta **`AskUserQuestion`** (pergunta de múltipla escolha ao usuário), o CLI embutido **não** consegue renderizá-la sem um terminal. O gate de permissão (`src/main/agentSession.ts`) então a **intercepta** e a trata de forma especial: ela **não é uma permissão**, é uma pergunta que precisa de resposta, então é roteada para a UI própria **mesmo com "Permitir tudo" ligado** (não dá para auto-responder uma pergunta — e o `setBypass` explicitamente **pula** qualquer `AskUserQuestion` pendente ao resolver as demais).

- `handlePermission` detecta `toolName === 'AskUserQuestion'`, gera um `id`, extrai as perguntas com `parseAskQuestions(input)` (tolerante a dados ruins: mapeia `questions[]` para o shape tipado `AskQuestion` — `header`, `question`, `multiSelect`, `options[]` com `label`/`description`) e envia `agent:permission-request` com o campo extra `questions`. A Promise fica pendente em `pendingPermissions`.
- No renderer (`src/renderer/src/App.tsx`), um pedido **com** `questions` renderiza o `src/renderer/src/ui/QuestionModal.tsx` (em vez do `PermissionModal`): opções clicáveis (single ou **multi-select**), uma opção **"Outro…"** sempre presente com campo de texto livre, e o botão **Responder** habilitado só quando toda pergunta tem ao menos uma escolha. A escolha vai em `answerQuestion(answers)` → `respondPermission` com `{ behavior: 'allow', answers }`.
- De volta no main, `resolvePermission` vê o campo `answers` e devolve a resposta ao modelo. Como o `PermissionResult` do SDK só permite `allow`/`deny` e não aceita a saída estruturada da ferramenta, a resposta é embutida num **`deny` com `message`** (`"The user answered your question(s):\n- <header>: <picks>"`) — o modelo lê isso e segue. Os tipos `AskQuestion`/`AskQuestionOption`/`QuestionAnswer` ficam em `src/shared/ipc.ts`.
- **No chat, a `AskUserQuestion` NÃO é pintada como erro.** Como a resposta volta sempre como um `deny` (`is_error: true`), o card da ferramenta apareceria vermelho mesmo respondido corretamente. Por isso o `ToolCard` (`MessageList.tsx`, e o equivalente em `smartfone-remote/www/app.js`) trata `AskUserQuestion` como caso especial: ignora o `tool-error` e mostra o badge **"respondido"** (ou **"sem resposta"** quando a mensagem indica timeout). O verbo do card vira **"Pergunta"** (detalhe = `header` da 1ª pergunta).

**Clicar fora ou Esc MINIMIZA, não cancela** — só o botão **"Cancelar"** do `QuestionModal` descarta a pergunta de verdade (`respond('deny', false)`). Clicar no overlay ou apertar Esc chama `onMinimize` em vez de `onCancel`: a pergunta continua pendente em `permissions[convId]` (nada é respondido nem descartado), só o modal some. `App.tsx` guarda esse estado por conversa em `minimizedQuestions: Record<string, boolean>` (resetado sempre que uma pergunta **nova** chega, para nunca nascer minimizada por acidente; limpo junto de `permissions` em todo ponto que hoje descarta uma pergunta — responder, cancelar, expirar por timeout, excluir/parar a conversa). Enquanto minimizada, um **chip evidente** (`.pending-question-chip`, ícone de interrogação + cor de destaque + leve pulso) aparece no `ChatPanel` entre o histórico de mensagens e o composer; clicar nele desminimiza e reabre o mesmo pedido pendente (`permissions[convId]` nunca mudou). O `QuestionModal` **desmonta** ao minimizar (`!questionMinimized && <QuestionModal/>` em `App.tsx`) — então as opções que o usuário já tinha marcado num rascunho de resposta **não** sobrevivem ao ciclo minimizar→reabrir (o React reinicia o `useState` local do componente); só a pergunta em si (o pedido pendente) persiste, não o preenchimento parcial.

---

## Vigia — o observador que questiona premissas

O agente principal executa o que foi pedido. Quando a **premissa** está errada — uma medida que só o usuário conhece, uma intenção ambígua, uma restrição não declarada — o erro só aparece na entrega, e o trabalho inteiro é refeito. O `critico` do registro de tarefas não cobre isso: ele confere entregáveis contra critérios, e antes da primeira linha de código não existe entregável.

O **vigia** (`src/main/vigia/`) é uma segunda sessão, barata, com uma pergunta só: *alguma premissa deste trabalho depende de algo que só o usuário sabe e não foi confirmado?* Ele **não fala com o agente**, não interrompe turno e não decide nada — levanta um chip na tela e o usuário resolve. Design em `docs/superpowers/specs/2026-09-12-vigia-questionador-paralelo-design.md`.

**Não é subagente, de propósito.** Um subagente devolve a resposta *para o agente principal* e morre no fim do turno — seria um segundo dono da decisão, exatamente o que não se quer, amarrado ao ciclo de vida de quem observa. O vigia vive no main e lê o **mesmo tee de eventos** que abastece a ponte do celular e a allowlist de download (`emit`, em `index.ts`).

**Quando roda** — uma análise por turno do usuário, no primeiro destes: `VIGIA_CALL_TRIGGER` (3) chamadas de ferramenta acumuladas, ou o `result` do turno. Antes das primeiras ações só existe o pedido; muito depois, o aviso chega tarde. `noteUserMessage` é chamado no `agentSend`, então retomada de sessão e recuperação de turno **não** disparam nada: sem pedido do usuário não há premissa do usuário para questionar. Turno que morre em `error` não é analisado — aquilo é falha, não premissa errada.

**Por que ele fala pouco** — cooldown de 60 s por conversa, digest capado (2000 caracteres do pedido, até 12 chamadas, 200 por chamada) e **dedupe por conteúdo** (`alertFingerprint`, insensível a caixa/acento/pontuação): uma premissa não resolvida geraria o mesmo texto a cada turno, e repetir o aviso é exatamente como se perde o usuário — a mesma lição dos dois limiares do watchdog de travamento.

**A chamada** é um `query()` avulso no molde do `visionRelay`: `tools: []`, `maxTurns: 1`, modelo da config (`vigia.model`, default `claude-sonnet-5`). Sem ferramentas **é** parte do contrato: se a dúvida pode ser respondida lendo o projeto, não é dúvida para o usuário. O digest carrega só o alvo de cada ação (`summarizeCall` devolve o `file_path`, nunca o `new_string`) — conteúdo de arquivo, imagem e segredo do cofre não entram. Falha de rede/SDK **degrada em silêncio**: o observador não pode derrubar o observado.

**Dois cortes de relevância antes de alertar** (no `VIGIA_SYSTEM_PROMPT`): o usuário consegue responder em uma frase, sem pesquisar? e a resposta **muda o que o agente vai fazer**? Se as duas respostas possíveis levam ao mesmo trabalho, a pergunta é irrelevante e o veredito é `OK`. A pergunta é escrita **direto ao usuário** (uma só, curta, concreta, sem "confirma?") porque é ele quem vai digitar a resposta.

**A resposta é uma linha**, `OK` ou `ALERTA: <pergunta> | <resposta provável> | <resposta provável>`. A **pergunta** falha **fechada** — o que não casa com o formato vira silêncio, nunca um alerta inventado. As **opções** falham **abertas**, e por outro motivo: uma lista malformada não invalida a pergunta, e sem opção legível sobram a pergunta e o campo de texto (o comportamento que existia antes delas). `cleanOptions` descarta vazio e repetido, capa em `VIGIA_MAX_OPTIONS` (4) e `VIGIA_MAX_OPTION_CHARS` (60), e **uma opção sozinha vira nenhuma** — uma escolha só não é escolha. O prompt exige que sejam respostas que o usuário daria de verdade, excludentes e já no formato de resposta ("12 mm"), nunca rótulos vagos ("sim", "outro"); e proíbe inventar precisão: quando a resposta é aberta (uma medida, um nome, um caminho), o vigia manda **só a pergunta** e o usuário digita. Medido contra o modelo real (`scripts/vigia-probe.ts`): pedido com medida do mundo real ("prender o eixo da extrusora… grosso pra não quebrar") → alerta perguntando o diâmetro do eixo e dos furos; pedido fechado (renomear função e atualizar chamadas) → `OK`.

**A saída não é um `ChatEvent`.** Vai por um canal próprio (`Channels.vigiaAlert`), por dois motivos: o cliente do celular tem um conjunto `STATE_ONLY` e um `push` final, então um `kind` desconhecido engordaria a lista de mensagens a cada ocorrência, invisível e acumulando; e alerta no stream de eventos é, por construção, algo que também entra no histórico que o modelo relê — e este aviso é para o **usuário**.

**O fluxo na tela é: ele pergunta ao USUÁRIO, o usuário responde ali, a resposta vai ao agente** (`VigiaChip.tsx`, entre o histórico e o composer, em âmbar e sem pulso). O card **nasce aberto e com o campo focado** — é uma pergunta, não um aviso que o usuário precisa ir buscar — com a dúvida, os **atalhos de resposta** (quando houver), uma caixa de texto (Enter envia, Shift+Enter quebra linha) e duas ações: **Dispensar** e **Responder**. Os atalhos seguem o molde do `AskUserQuestion` do agente: clicar escolhe, digitar desfaz a escolha e escolher apaga o que foi digitado — **uma resposta só**, porque duas com uma regra implícita de precedência seria pior do que perder a escolha.

A resposta sai pelo **caminho normal de envio**: com o agente ocupado ela entra na fila e é entregue **na próxima chamada ao modelo**, sem interromper o turno em andamento. Ela vai acompanhada da pergunta, porque o agente **nunca viu a dúvida** (ela é do vigia, para o usuário) — uma resposta solta chegaria sem referente.

Uma versão anterior tinha o botão "Perguntar ao agente", e ele invertia o papel: transformava a dúvida numa decisão do usuário sobre *repassá-la*, em vez de uma pergunta que ele responde. O chip não é modal em nenhum dos casos — dá para ignorar e seguir digitando no composer. O estado (`vigiaAlerts` no `App.tsx`) é por conversa e **não persiste**: é pergunta viva, não dado da conversa.

**Configuração** em **Configurações → Geral**: interruptor (**desligado** por padrão; quem quer o vigia liga em Configurações) e seletor de modelo (`VIGIA_MODELS`). A config é lida **a cada análise**, então desligar vale na hora, sem reiniciar sessão.

---

## Memorista — o observador que grava memória sozinho

O acervo de memórias só era escrito em três situações: o usuário pedir ("salva isso"), o agente principal lembrar de delegar ao subagente `memoria`, ou a varredura diária do curador encontrar uma correção explícita. O resultado medido foi: **conhecimento que o usuário ensinou numa conversa normal não virava memória nenhuma** — ninguém tinha errado nada, então nada qualificava.

O **memorista** (`src/main/memoria/`) é o terceiro observador do app, no mesmo molde do vigia e do PO: vive no main, lê o **mesmo tee de eventos** (`emit`, em `index.ts`), não fala com o agente, não interrompe turno e falha em silêncio. A diferença é o destino da saída — ela vai para o **acervo de memórias**, nunca para o chat.

**Quando roda** — uma análise por turno, no `result`. `noteUserMessage` marca o começo do turno no `agentSend` (retomada e recuperação não disparam nada); turno que morre em `error` não é analisado, porque falha não é conhecimento. Cooldown de 60 s por conversa, como o vigia — mas aqui o turno pulado **não some**: ele entra numa fila e é lido junto no próximo digest desta conversa, já que um turno nunca lido é exatamente o conhecimento que o recurso existe para não perder.

**A régua é mais larga que a do curador**, e é essa a razão de ele existir. O curador aceita só **correção explícita** — "o usuário ensinou algo que o modelo não teria acertado". O memorista aceita seis categorias, validadas no parser: `instrucao`, `preferencia`, `conhecimento` (domínio, não código), `decisao` **com o motivo**, `infra` e também `correcao`. Decisão sem motivo vira dogma; o motivo é o que permite rever depois.

**A divisão de trabalho com o curador diário** (`memoryCurator.ts`, 1×/24 h) — e por que os dois continuam valendo:

| | memorista | curador diário |
|---|---|---|
| Quando | todo turno, ao vivo | 1×/24 h, em lote |
| O que lê | o digest do turno (pedido + alvo das ações) | as **transcrições** inteiras, em blocos de 180 k caracteres |
| Régua | seis categorias do usuário | só correção explícita |
| Teto | 3 operações por análise | o que a varredura achar |
| Forte em | pegar o fato **enquanto o contexto existe** | ver o que **atravessou** várias conversas |

Um não substitui o outro: o memorista vê um turno por vez e nunca enxerga o padrão que só aparece relendo a semana; o curador relê tudo, mas com a régua estreita e um dia de atraso — e um dia depois o usuário já repetiu a instrução que ninguém guardou. Os dois escrevem pela mesma porta e o CAS do serviço resolve a corrida (o `expectedRevision` do memorista vem de uma leitura **fresca**, feita depois da consulta ao modelo, justamente porque o curador pode ter mexido no arquivo enquanto ela rodava).

**Como ele escreve** — sempre pelo serviço de memória (`propose` + um `applyPending` por lote), o mesmo caminho do `memory_propose` do chat. `Write`/`Edit` na pasta de memórias pulariam a fila de propostas, o CAS e a varredura de segredos — e a varredura é obrigatória: uma credencial que o usuário citou de passagem vai para o cofre, e no arquivo fica o marcador. `update` **complementa**, nunca apaga. Teto de 3 operações por análise: quem grava seis memórias num turno está transcrevendo a conversa, não guardando um fato. Proposta recusada (caminho inválido, colisão, CAS) não cancela as outras nem derruba a análise.

**O que entra no prompt** — o mesmo `summarizeCall` do vigia e do PO (o **alvo** da ação, nunca o conteúdo do arquivo), até 20 chamadas, e 4000 caracteres do texto do usuário: o digest mais folgado de todos os observadores, porque é do pedido dele que sai instrução e conhecimento. O índice do acervo entra só como título + gancho (até 40 memórias), o bastante para o modelo dizer "isso já está salvo".

**Provedor e diagnóstico** — Claude primeiro, GPT Luna como reserva, como o PO. O andamento sai por um canal próprio (`Channels.memoristaProviderDiagnostic`), com **tipo próprio** e não o do PO reaproveitado: o painel do elenco precisa saber qual papel está trabalhando, e o que cada um informa no fim é diferente (`appliedOps` no quadro, `savedMemories` no acervo). O diagnóstico **nunca leva o conteúdo** da memória — só qual provedor rodou e quantas foram propostas.

**No elenco**, ele acende o cartão do papel `memoria` que já existe (`crew.ts`), em vez de ganhar um próprio: para o usuário é o mesmo papel — quem cuida do que o app lembra. Uma delegação em cena ganha do observador no mesmo cartão, então o slot nunca duplica nem muda de posição. `savedMemories: 0` é o caso **normal** e aparece como "nada a guardar", não como falha: a maioria dos turnos não ensina nada que valha guardar.

**Configuração** em **Configurações → Geral**, ao lado do vigia e do PO: interruptor (**ligado** por padrão — uma memória que depende de o usuário lembrar de ligar é uma memória que não acontece) e seletor de modelo (`MEMORISTA_MODELS`, default `claude-sonnet-5`). A config é lida uma vez por análise, então mudar na tela não redireciona uma análise em voo.

---

## Quadro de tarefas do projeto (trava do plano + agente PO)

O `TodoPlanCard` acima do composer mostra o plano do turno e some do campo de visão assim que a
conversa rola. O que faltava era um lugar onde **o trabalho do projeto inteiro** fique visível e
se marque sozinho conforme o agente conclui — e que continue certo depois de fechar o app.

O quadro é a aba **Quadro** do painel da direita, ao lado de Navegador e Agentes. A visão
"Tarefas" do painel de agentes (a fila do registro multi-agente) saiu de lá e o lugar dela virou
o **atalho** para cá: tirar o botão sem deixar rastro faria quem já usava concluir que o recurso
sumiu.

**Três peças, e cada uma existe porque as outras duas não cobrem o buraco dela.**

### 1. O esqueleto é determinístico (`board/boardService.ts`)

A entrada é o `ChatEvent` **`task-list`** — o snapshot autoritativo que a sessão lê dos arquivos
do próprio CLI (`sessionTasks.ts`), o mesmo que já corrige o card do chat. Os eventos incrementais
(`TaskCreate`/`TaskUpdate`) foram descartados de propósito: incremento perdido congela o quadro
num estado antigo, e o quadro do projeto é justamente o que precisa continuar certo depois de o
app ter ficado fechado.

O serviço lê o mesmo **tee de eventos** do vigia (`emit`, em `index.ts`) e grava. Duas amarrações:
**uma escrita por vez por conversa** (o snapshot chega em rajada, e duas sincronizações
concorrentes se atropelariam no `DELETE` do que sumiu) e **falha silenciosa** — banco fora do ar
ou identidade de projeto que não resolve degradam sem derrubar a conversa.

**Snapshot vazio não apaga o quadro.** "Esta sessão nunca usou tarefas" e "o plano ficou vazio"
são indistinguíveis na leitura; tratar o primeiro como o segundo torraria o quadro inteiro de uma
conversa por causa de uma leitura sem sorte.

**Fim de turno: o que continuou "fazendo" volta para "a fazer".** "Em andamento" só quer dizer
alguma coisa enquanto existe trabalho acontecendo, e o snapshot do CLI não tem noção de "agora":
o cartão que o agente marcou ao começar e esqueceu de fechar ficaria em andamento para sempre,
e o quadro passaria a mostrar um trabalho que ninguém está fazendo. Nos **dois** jeitos de um
turno acabar (`result`, o fim normal, e `error`, o que morreu no meio) o serviço relê o quadro
daquela conversa e devolve para "a fazer" o que sobrou em andamento, gravando o motivo — que diz
o fato ("o turno terminou sem concluir esta tarefa"), não uma intenção: o quadro não tem como
saber se o agente desistiu ou esqueceu. Aqui não entra LLM nenhum, porque não há o que julgar.

A **ordem** é a parte delicada, e é ela que a dependência `poSettled` compra: primeiro a fila de
escrita da conversa (reabrir sem o último snapshot gravado reabriria em cima de um estado velho),
**depois a auditoria do PO** (reabrir antes desfaria o "concluído" que ele ainda ia gravar), e só
então a reabertura. A espera pelo PO tem teto de 30 s — análise pendurada não pode segurar para
sempre o conserto que existe justamente para o quadro não ficar errado. A reabertura é idempotente
porque olha o status **efetivo** (`po_status ?? source_status`): cartão já reaberto não aparece de
novo, e o "concluído" que o PO acabou de gravar não é desfeito.

**O que ela deliberadamente não faz: varrer o banco no boot.** Seria a correção óbvia para o app
fechado no meio de um turno, e é a errada aqui — com PostgreSQL compartilhado, o "fazendo" que a
varredura apagaria pode ser de um agente rodando **agora** em outro PC. Duas limitações conhecidas
saem dessa escolha:

- App fechado ou derrubado no meio de um turno deixa o cartão em andamento até o **próximo turno
  daquela conversa**, que é quando o fechamento seguinte roda. O quadro fica otimista por um
  tempo; nunca erra sobre trabalho de outra máquina.
- Existe uma janela estreita entre a reabertura e um snapshot **atrasado** do mesmo turno: se ele
  chegar depois, a ingestão lê "o agente declara em andamento" e solta o `po_status` (ver a
  invalidação, abaixo), desfazendo a reabertura. Esperar a fila de escrita antes de reabrir é o
  que estreita a janela, e o fim do turno seguinte corrige.
- A espera pelo PO (`poSettled`) também abre uma janela do OUTRO lado: enquanto a reabertura
  aguarda a auditoria de FECHAMENTO deste turno, o usuário pode já ter mandado a próxima
  mensagem, e a rodada de ABERTURA do PO promove o mesmo cartão de volta para "em andamento"
  antes de a reabertura terminar de esperar. Sem cuidado, a releitura da reabertura pegaria esse
  cartão já promovido e o derrubaria de novo — desfazendo um trabalho que já recomeçou de
  verdade. A correção é um corte por tempo: `closeTurn` carimba o instante REAL do fim do turno
  (`closedAt`, capturado na hora do evento `result`/`error`, não quando a reabertura finalmente
  executa) e `boardItemsToReopenBefore` (`board/boardModel.ts`) só reabre o cartão cujo `po_at`
  é anterior a esse carimbo — um cartão que o PO tocou DEPOIS do fim do turno tem uma decisão
  mais recente que a reabertura, e prevalece.

### 2. A trava do plano (`board/planGate.ts`)

O esqueleto só existe se o agente declarar alguma coisa. Pedir isso no prompt é instrução, e
instrução o modelo esquece — foi essa a lição que transformou o escopo de escrita no
`writeScopeGuard` em vez de uma frase no `TASKS_HINT`.

O gate de permissão recusa a **primeira escrita de arquivo do turno** enquanto o plano não foi
declarado, com uma recusa que diz exatamente o que fazer. Vale **antes do `bypassAll`**: "Permitir
tudo" é o usuário confiando no modelo para executar, não dispensa de dizer o que vai fazer.

O que ela deliberadamente **não** faz, e o porquê:

- **Não cobre `Bash`.** Rodar teste, build ou `git status` antes de planejar é investigação
  legítima; travar isso tornaria a regra um estorvo, e regra que atrapalha trabalho legítimo é
  desligada no primeiro dia (mesmo princípio do `bashWriteScan`).
- **Não vale para subagente.** Um executor trabalha dentro de uma tarefa já decomposta pelo
  supervisor; exigir um plano próprio dele duplicaria o quadro com o mesmo trabalho.
- **Não vale fora de um turno.** Sem pedido do usuário não há o que planejar.
- **Recusa uma vez por turno.** Se o agente insistir, a segunda escrita passa: o objetivo é
  lembrar, não impedir quem decidiu que a tarefa é trivial demais para um plano.
- **`declared` atravessa turnos.** O plano da conversa é reaproveitado e atualizado; exigir
  declaração nova a cada mensagem transformaria a trava em ruído.

### 3. O PO (`po/po.ts`, `po/poPrompt.ts`)

Sobra um buraco que nem a trava nem o snapshot alcançam: **o agente fez e esqueceu de marcar**.
Isso não tem momento fixo para travar — só dá para auditar depois.

O PO é irmão do vigia, no mesmo molde e pelos mesmos motivos: `query()` avulso com `tools: []` e
`maxTurns: 1`, modelo barato configurável (`board.po.model`, default `claude-sonnet-5`), digest
capado, cooldown por conversa, e **falha em silêncio**. Difere do vigia em escrever no **quadro**
em vez de perguntar ao usuário. Turno que morreu em erro não é auditado: aquilo é falha, não
esquecimento — mas o fechamento determinístico do quadro roda assim mesmo, e é ele que evita o
cartão preso em andamento.

**Ele roda duas vezes por turno, e as duas rodadas respondem a perguntas opostas.**

- **Abertura**, quando o pedido chega (`po.noteUserMessage`, no mesmo ponto em que o turno do vigia
  começa): *o que vai começar?* O pedido precisa virar cartão **antes** de o agente trabalhar —
  auditar só no fim não alcança o pedido que o agente nunca declarou, porque quando o PO olha ele
  já passou e não sobrou o que reconhecer. Operações: **`ANDAMENTO <id>`** (um cartão que já existe
  cobre o pedido) e **`NOVA`** (cria o cartão **já em andamento**, porque o trabalho está começando
  agora — não é intenção para depois). O prompt insiste que pergunta, dúvida e pedido de status
  **não** viram cartão: responder não é trabalho de quadro.
- **Fechamento**, no `result`: *o que terminou?* Só aqui existe turno para julgar, com as ações
  como evidência. Operações: **`CONCLUIR <id>`**, **`TITULO <id>`**, **`FEITA`** (o trabalho
  aconteceu neste turno e nenhum cartão o registra — o cartão nasce concluído) e **`NOVA`** (ficou
  faltando — nasce pendente).

São **prompts separados** de propósito: um prompt que faz as duas perguntas ao mesmo tempo convida
o modelo a responder a errada. O **cooldown é por fase** pelo mesmo motivo — com um contador só, a
abertura gastaria a janela do minuto e o fechamento daquele turno nunca rodaria. E turno que o
cooldown do fechamento pulou não se perde: pedido e ações entram no digest da próxima auditoria
daquela conversa, dentro dos mesmos tetos, e voltam para a fila se a análise que os levou não
chegar ao fim — um pedido que nunca passou pelo PO é exatamente o buraco que ele existe para
fechar.

**Ele não é o autor do quadro, e a separação é física.** As duas camadas vivem em colunas
diferentes: `source_*` (o que o agente declarou, escrito só pela ingestão) e `po_*` (o que o PO
pôs por cima). O PO nunca toca a primeira — é o que garante que um PO errado jamais apague o fato.

**A segunda não é intocável: o `po_status` expira quando o agente volta a falar do estado.**
Preservá-lo sempre travaria o cartão — depois da primeira correção, nada que o agente declarasse
voltaria a aparecer. A distinção que `planBoardSourceSync` faz é entre **reemitir o mesmo
snapshot** e **mudar de estado**. Releitura idêntica não refuta nada e a camada do PO fica de pé;
mas há dois casos em que ela cai:

1. O `source_status` **mudou de valor** — quem falou por último foi o agente.
2. O cartão está "a fazer" **por reabertura** e o agente declara `in_progress`. Aqui o
   `source_status` pode nem ter mudado: a reabertura não mexe nele, então o cartão continua
   `in_progress` na lista do CLI e o agente que retoma o trabalho reemite exatamente esse valor.
   A reabertura é uma afirmação sobre um **momento** ("no fim daquele turno ninguém estava
   trabalhando nisto") e expira assim que alguém volta a trabalhar; sem esta metade, o cartão
   ficaria travado em "a fazer" com o agente mexendo nele.

`po_title` e `po_note` sobrevivem aos dois casos: título legível não é estado e não envelhece
quando o trabalho anda. E um "concluído" do PO não cai por releitura — aquilo é afirmação sobre o
**trabalho**, e snapshot velho reemitido não a refuta. A regra mora em `boardModel.ts`, e não no
SQL de cada repositório, porque SQLite e PostgreSQL precisam decidir a mesma coisa: em duas
versões, o quadro divergiria conforme o PC e nenhum teste quebraria.

**As barreiras antes de o palpite virar escrita**, porque um modelo pequeno vai errar alguma hora:

1. `parsePoVerdict` falha **fechada** por linha — o que não casa com o formato vira silêncio, nunca
   uma operação inventada; a operação precisa citar um **id que está no quadro**, então o PO não
   alcança um cartão que não viu; e precisa ser da **fase certa**. Um `CONCLUIR` na abertura
   falaria de trabalho que ainda não começou e um `ANDAMENTO` no fechamento reabriria o que acabou
   de terminar: nos dois casos o modelo respondeu a pergunta errada, e resposta errada não vira
   escrita.
2. `rejectUnsafeOps` descarta o que contraria o esqueleto — e recebe a **fase**, porque um dos casos
   abaixo só faz sentido numa delas. **Título duplicado não cria cartão** — a comparação é
   normalizada (sem acento, minúscula, espaços colapsados, a mesma regra de busca do resto do
   projeto) e roda contra as **duas** camadas, porque o cartão pode ter sido renomeado pelo PO e
   comparar só com o título do agente deixaria passar a cópia. Sem isso o PO recria o mesmo cartão a
   cada turno: ele não lembra do que criou ontem. **`ANDAMENTO` só no que ainda está pendente**
   (remarcar o que já começou é escrita à toa, e "reabrir" o concluído é o PO desfazendo um fato).
   **`CONCLUIR` em tudo que não está concluído**: uma versão anterior exigia cartão pendente e isso
   matava o recurso, porque o caso central ("fez e esqueceu de marcar") deixa o cartão exatamente em
   `in_progress` — o agente marcou o início e não marcou o fim. Quem segura o exagero é a exigência
   de evidência no prompt, não uma proibição que também barra o caso certo.
   **Na ABERTURA, um `create` rejeitado pelo dedupe de título vira `ANDAMENTO` — não silêncio —
   quando o cartão colidido ainda está `pending`.** Esse é o segundo caminho para o bug "o PO criou
   a tarefa mas deixou em 'a fazer' enquanto o agente trabalhava": quando o pedido é uma
   continuação ("continua", "pode", "sim") de um trabalho que já tem cartão, o modelo às vezes tenta
   `NOVA` de novo para o mesmo assunto — o dedupe corretamente rejeita a duplicata, mas descartar em
   silêncio perdia a intenção real ("isso está começando agora"), e nada promovia o cartão existente.
   A conversão preserva o **motivo** do `create` original e não duplica quando o próprio modelo já
   emitiu um `start` para o mesmo id na mesma resposta (evita chamar `applyPo` duas vezes no mesmo
   cartão). Fora da abertura, ou quando o cartão colidido já está `in_progress`/`completed`, a
   duplicata continua simplesmente descartada — não existe `ANDAMENTO` no fechamento.
3. **Antes de criar, o quadro é relido.** Entre a lista que montou o digest e a escrita passou a
   consulta ao modelo — segundos em que a **outra fase do mesmo turno** pode ter criado o cartão
   que este está prestes a criar de novo. Criar é a única operação irreversível daqui (cartão
   duplicado fica lá e ninguém sabe qual seguir), então as barreiras de título são reaplicadas
   contra a lista fresca. Sem lista fresca, falha fechada: não cria, e o que ficou de fora volta na
   próxima auditoria.
4. Toda escrita exige **motivo**, gravado com carimbo e mostrado no cartão. Correção automática que
   não dá para auditar é pior do que nenhuma — quando ele errar, dá para ver que foi ele.

### Persistência: por projeto, não por conversa

Tabela nova (`board_items`, migration **5** no SQLite / **7** no PostgreSQL) em vez de reaproveitar
`tasks`: são ciclos de vida diferentes. `tasks` é contrato de delegação (lease, fence, tentativas,
escopo de escrita); um cartão do quadro é um passo que se marca sozinho. Espremer os dois na mesma
tabela daria a um `status` dois significados.

Como em toda migração deste projeto, só `CREATE TABLE IF NOT EXISTS` — o `sqliteRepository`
reexecuta o schema inteiro a cada escrita como guarda idempotente, e um `ALTER TABLE` quebraria
toda escrita a partir da segunda. No PostgreSQL a migration **substitui a função do change feed**,
porque o ramo `ELSE` lê `fencing_epoch`/`owner_installation_id`, colunas que `board_items` não tem.

A chave é o **`project_id` estável** (remote do git + commit raiz), não o `project_cwd` local: é o
que faz o mesmo repositório clonado em dois PCs ter **um** quadro. Sem git, cai num id derivado do
caminho — degrada para "dois quadros", que é o lado certo de errar; o contrário misturaria
projetos.

### A tela (`components/BoardPanel.tsx`)

Duas visões (**Quadro** em três colunas, **Lista** agrupada por conversa de origem), recorte entre
**esta conversa** e **projeto inteiro**, e o detalhe do cartão com a trilha do PO. O rótulo da aba
carrega `concluídas/total` mesmo com a aba fechada — é o contador que avisa que existe trabalho lá
dentro.

**O motivo é o que torna a correção automática auditável, então ele aparece.** No detalhe, a trilha
diz quem mexeu e por quê — inclusive o motivo da reabertura, que é a resposta para "por que este
cartão voltou para *A fazer*?". Na face do cartão, um selo distingue o que o PO acrescentou, o que
ele corrigiu e o que ele reescreveu; e existe um quarto caso, fácil de perder: quando o status do
PO **coincide** com o do agente (o cartão que ele abriu em andamento e a reabertura devolveu para
"a fazer", onde o snapshot já estava), não há divergência para marcar, mas há trilha para ler — sem
o selo, o mesmo cartão apareceria marcado na Lista e limpo no Quadro, e ninguém teria motivo para
clicar.

O detalhe também tem um bloco de **metadados** (criado em, atualizado em, quem criou, nº da
revisão) e uma **linha do tempo** completa — não só o último `poReason`. `po_reason`/`po_status`
guardam só o ÚLTIMO fato; para o histórico inteiro existe `board_item_events` (migration **6** no
SQLite / **8** no PostgreSQL, mesmo padrão do `task_events`): uma linha por acontecimento (criação,
mudança de status por agente ou por PO, retitular, mudar observação, dispensar/restaurar), nunca
sobrescrita. `board_item_events.board_item_id` referencia `board_items(id)` com `ON DELETE CASCADE`
— o cartão de origem `agent` que sumiu do snapshot do CLI é apagado por `syncBoardItems`, e sem
cascade esse `DELETE` bateria na FK assim que o cartão tivesse qualquer evento (o próprio "created"
já basta). A tela busca a timeline **preguiçosamente**, só quando o detalhe abre (mesmo padrão do
`TaskRow` em `TasksBoard.tsx`), e degrada em silêncio — consulta falhando ou repositório indisponível
devolve `[]`, nunca quebra a tela; a timeline é aditiva, não substitui a trilha do `poReason` já
existente.

Além de arquivar um cartão, o usuário também pode **arrastar** um cartão entre as três colunas do
Quadro (`draggable` nativo do HTML5, sem biblioteca — só quando o recorte é "esta conversa" e a
visão é "Quadro"; em "projeto inteiro" e na visão Lista o cartão não é arrastável, porque mover
exige saber sem ambiguidade a conversa dona do cartão). O drag-and-drop controla o agente de
verdade, não só o quadro:

- soltar em **Fazendo**, vindo de outra coluna: manda uma mensagem para o agente daquela conversa
  começar a tarefa — reaproveitando o MESMO `AgentSession.send()` do Composer, que já enfileira
  sozinho se o agente estiver ocupado. Sem sessão viva (conversa nunca aberta nesta execução do
  processo), nada é gravado: a tela mostra o motivo e desfaz a posição do cartão.
- sair de **Fazendo** para qualquer outra coluna: interrompe de verdade o turno em andamento, pelo
  mesmo caminho de `Channels.agentInterrupt`.
- troca direta entre **A fazer** e **Concluído** (sem passar por Fazendo): só grava.

A escrita usa o MESMO caminho do PO (`BoardService.applyPo`/`BoardRepository.applyBoardPo`), com
`actor: 'user'` no evento do histórico — um terceiro tipo de escritor, distinto de `agent` e `po`
(`board_item_events.actor`, migration **7** no SQLite / **9** no PostgreSQL, aditiva sobre a
migration 6/8). O canal `board:move` (`BoardService.move`) decide a ação a partir do status EFETIVO
atual do cartão; `sendToSession`/`interruptSession` são injetados em `BoardServiceDeps` porque o
`Map` de sessões é privado de `main/index.ts` e o serviço do quadro não pode importá-lo.

**Tarefa pendente não se auto-conclui quando a conversa acaba**: ela fica na lista, agrupada pela
conversa de origem, e o usuário dispensa se quiser — senão o quadro durável acumularia pendência
morta para sempre.

Atualiza por evento (`board:changed`, o caminho rápido) **e** por poll (rede de segurança para a
mudança que veio de outro PC pelo change feed do PostgreSQL).

**Configuração** em **Configurações → Geral**: dois interruptores (trava e PO, ambos **ligados** por
padrão) e o seletor de modelo do PO. Lidos a cada uso, então desligar vale na hora.

---

## Tela de Planejamento (Agent Manager)

Uma conversa comum mistura duas coisas que pedem posturas opostas: decidir **o que** fazer e
**fazer**. No mesmo fio, o plano vira um parágrafo que rola para fora da tela, a dúvida é resolvida
por suposição do modelo e o que foi decidido não sobrevive à conversa. A Tela de Planejamento
separa as duas: uma conversa em que um agente próprio — o **Agent Manager** — só planeja e grava o
plano em arquivos do projeto; e, com o plano pronto, uma conversa **nova** que só executa, recebendo
o plano como prompt.

### O fluxo do usuário

1. **Novo planejamento**, pelo ícone de roteiro ao lado do nome do projeto na barra lateral
   (`NewPlanningDialog`). O título vira o slug (`planningSlug.ts`: sem acento, `[a-z0-9-]`, até 64
   caracteres, com `-2`, `-3`… contra os planos que já existem na pasta) e o diálogo lista os planos
   existentes para reabrir. O main cria `docs/spec/<slug>/` (`planning:create`).
2. Nasce uma **conversa de planejamento** (`Conversation.mode === 'planning'`, com `planningSlug`), e
   ela **é** a tela: quando ativa, o `PlanningWorkspace` ocupa o lugar do workspace normal. Um plano
   que já tem conversa carregada nesta pasta volta para ela — duas sessões do Manager no mesmo plano
   só brigariam pelos arquivos.
3. A tela tem o **roteiro** à esquerda (checklist das etapas, de largura ajustável e recolhível), o
   **canvas** no resto (uma coluna por etapa, com os cards embaixo) e, flutuando sobre ele, o **chat
   do Manager** — o mesmo `<ChatPanel>` de qualquer conversa, só que em outro lugar, maximizado ou
   minimizado. O usuário conversa; o Manager separa as etapas e registra
   requisitos, decisões, sugestões e ambiguidades como cards, e a tela se atualiza sozinha. O
   usuário também edita tudo à mão: card, ligação, status da etapa.
4. **Enviar para implementação** (botão no cabeçalho, `HandoffDialog`): conferência, geração do
   prompt e revisão. Ao enviar, nasce uma conversa **nova** de implementação (`Implementação:
   <título>`, marcada com `handoffSlug`) e os prompts vão para ela, na ordem.

Por que "a conversa é a tela", e não uma aba ou um modal: o plano precisa de uma sessão do agente
viva, com histórico, retomada e fila — tudo o que a conversa já tem. Reaproveitá-la dá isso de
graça, inclusive o lugar na barra lateral (o ícone de roteiro distingue a conversa de planejamento)
e a persistência.

### O formato em disco (`planning/planningModel.ts`, `planning/planningStore.ts`)

```
docs/spec/<slug>/
  _roteiro.md                # "# título", "<!-- rev: N -->" e uma etapa por linha: "- [status] id: título"
  _canvas.json               # posições dos cards e o viewport (pan/zoom)
  cards/<id>.md              # frontmatter (id, tipo, titulo, etapa, status, links, fonte, rev) + corpo em markdown
  _handoff/AAAA-MM-DD-NN.md  # cada prompt de handoff gravado, numerado por dia
  _sandbox/                  # código de teste descartável do Manager (gitignorado)
```

O plano mora **no projeto**, em markdown, e não no banco do app: é o que deixa o git versionar o
plano junto do código, o usuário (ou outro agente) ler e editar num editor qualquer, e a conversa de
implementação consultar os cards com `Read`, sem ferramenta especial. Tipos de card: `etapa`,
`requisito`, `decisao`, `sugestao` (exige `fonte` http/https — sugestão sem fonte verificável é
opinião), `ambiguidade` (`status` `aberta`/`resolvida`) e `nota`. `[[id]]` no corpo cita outro card;
`links` são as ligações que o canvas desenha.

O que decorre de "arquivo que se edita à mão":

- O **frontmatter** é um subconjunto de YAML feito à mão: cada valor é gravado como JSON (que também
  é YAML válido), então o round-trip é exato sem dependência nova; na leitura, valor sem aspas e
  lista `[a, b]` escritos à mão também passam.
- O **rev do roteiro** é um comentário HTML (`<!-- rev: N -->`), invisível no markdown renderizado.
  Roteiro sem essa linha (gravado antes de o rev existir) vale rev 0. Título do roteiro e das etapas
  são gravados em **uma linha só** (CR/LF viram espaço): uma quebra no título forjaria a linha do rev
  ou uma etapa na próxima leitura.
- Um card **malformado não derruba o plano**: `openPlan` o põe em `invalid` com o motivo, a tela
  mostra o arquivo e o erro, e os válidos seguem. Id do frontmatter diferente do nome do arquivo
  também é inválido.
- **O layout fica fora dos `.md`.** Posição e zoom mudam a cada arrasto; no frontmatter, arrastar um
  card viraria diff no git e conflito de `rev` com o Manager editando o mesmo card por algo que não é
  conteúdo. `_canvas.json` concentra o que é só visual — e perdê-lo não perde plano nenhum: o layout
  é recalculado.
- **`_sandbox/` é gitignorado.** `createPlan` chama `ensureSandboxGitignore`, que acrescenta
  `docs/spec/*/_sandbox/` ao `.gitignore` da raiz sem duplicar nem mexer no resto: protótipo e medição
  do Manager são descartáveis e não podem entrar num commit por descuido.
- **`_handoff/` numera por dia com criação exclusiva** (`wx`): duas gravações simultâneas nunca
  pegam o mesmo número, e um prompt gravado nunca é sobrescrito.

Todo caminho passa por `resolvePlanPath`: nome fora de `[a-z0-9-]` é recusado, e também qualquer
destino que escape da pasta do plano — inclusive por symlink, conferindo o caminho real de cada
ancestral. Toda gravação é atômica (tmp + rename).

A tela chega ao store pelos canais `planning:*` (`planningIpc.ts`, a fronteira): todo payload passa
por zod antes de tocar o disco, e **nenhuma exceção atravessa o IPC** — a resposta é sempre um
`PlanningResult` (`ok: true` ou `code` `rev_conflict` / `roteiro_conflict` / `invalid` / `not_found` /
`io`). Um `_canvas.json` com JSON quebrado vira `invalid`, não falha de disco: é dado editado à mão,
e a mensagem precisa dizer isso.

### Concorrência: rev otimista + fila por arquivo

Duas mãos editam o mesmo plano ao mesmo tempo — o usuário na tela e o Manager pelas ferramentas —, e
às vezes uma terceira por fora (editor, git). Card e roteiro carregam um **`rev`**: gravar exige o rev
que está em disco (`expectedRev`), e o novo é sempre o do disco + 1. Rev velho não grava: volta
`RevConflictError`/`RoteiroConflictError` **com a versão atual**, porque quem perdeu a corrida precisa
dela para refazer — a tela avisa, recarrega e reabre o editor na versão do disco; o Manager recebe o
card ou o roteiro atual em texto e refaz. "Última gravação vence" apagaria em silêncio o que o outro
lado acabou de gravar.

Onde reaplicar é seguro, reaplica: marcar **uma** etapa é um campo só, então tanto
`plan_etapa_marcar` quanto o clique no roteiro (`toggleEtapa`, em `usePlanning`) reaplicam **uma
vez** sobre o roteiro atual que veio no conflito. `plan_roteiro_set`, não: ele substitui a lista
inteira, e reaplicar por cima apagaria a etapa que o usuário acabou de marcar — devolve o roteiro
atual para o modelo refazer.

O rev sozinho não basta dentro do processo: a tela (via IPC) e o Manager (via `plan_*`) vivem **no
mesmo main**, e dois ler-conferir-gravar intercalados leriam o mesmo rev e passariam os dois. Por
isso `saveCard`, `deleteCard` e `saveRoteiro` rodam numa **fila por arquivo** (`inFileQueue`, chave em
minúsculas no Windows); arquivos diferentes seguem em paralelo. A fila não alcança quem escreve fora
do processo, e um editor externo nem incrementa o rev; para esse caso o que existe é o vigia, que
faz a tela recarregar o que está em disco.

### O vigia de arquivos (`planningWatcher.ts`, `planningWrites.ts`, `planningEvents.ts`)

O plano aberto precisa acompanhar o disco: o usuário edita um card no editor, faz `git pull`, ou o
Manager grava. O vigia abre **um `fs.watch` recursivo por plano aberto**, com contagem de referências,
ligado por `planning:open` e solto por `planning:close`. Reabrir para recarregar depois de um aviso
não pode inflar a contagem, então o IPC lembra qual janela abriu qual plano. E abrir e fechar rápido
não pode vazar vigia: o open lê do disco antes de registrar, e um close que chega nesse meio-tempo
não tem o que soltar. Por isso o IPC conta os closes por chave (janela + plano), o open anota o
contador **antes** do primeiro await e, se ele mudou quando a leitura termina, devolve o plano sem
registrar a vigia.

- **Debounce**: salvar é tmp + rename, e um `git checkout` mexe em vários arquivos de uma vez; a
  rajada vira **um** aviso depois de 150 ms de silêncio, com teto de 1 s — uma rajada contínua não
  pode adiar o aviso para sempre.
- **Ignorados**: `_sandbox/**` (o Manager rodando teste não é mudança de plano), `_handoff/**` (não é
  parte do plano que a tela desenha; quem precisa saber de um prompt novo é avisado por quem o
  gravou) e `*.tmp`.
- **Eco das próprias gravações, por hash.** Sem isto, cada gravação do app voltaria como "mudou por
  fora" e a tela recarregaria a si mesma, às vezes no meio de um arrasto. `planningWrites` guarda,
  por caminho, o sha256 do que **o próprio app** gravou por último — anotado **antes** do rename,
  para o vigia nunca ver o arquivo novo sem o registro. O vigia relê o arquivo alterado e, se o
  conteúdo é exatamente esse, é eco. Hash, e não horário, porque só o conteúdo diz se houve mudança;
  e o registro é descartado assim que o disco diverge, para uma edição externa que depois volta ao
  mesmo conteúdo ainda ser vista como mudança. O registro fica no **store**, não na tela: toda
  gravação do app passa por ele, venha da tela ou do Manager.
- **Falha não derruba**: pasta apagada ou erro do SO deixam mudo o vigia daquele plano (com
  `console.warn`), e ele tenta de novo na próxima abertura.

Isso abre um buraco: as `plan_*` gravam pelo store, então **também** são gravações próprias, e o
vigia as ignora — a tela aberta não veria o Manager criar um card. `planningEvents` fecha o buraco:
toda ferramenta que grava chama `notifyPlanningChanged`, e o `planningIpc` registra como destino o
mesmo `send(planning:changed)` do vigia. Um canal, duas fontes. O aviso nunca lança — a gravação já
aconteceu e não pode "falhar" por causa dele. Na tela, `usePlanning` só recarrega com evento **do
mesmo plano** (o evento é global) e preserva a posição arrastada que ainda não foi gravada.

### A sessão do Manager (`planningSession.ts`, `planningPrompt.ts`, `planningTools.ts`)

É uma `AgentSession` comum com `opts.planning = { slug }`, convertida por
`applyPlanningSessionOptions`. A sessão só chama essa função; o que o Manager tem de diferente está
decidido — e testado — fora dela:

- **Servidores MCP: só `planning` + `memory`, com `strictMcpConfig`.** Browser, Android, Windows,
  app e tarefas são de quem executa. Trocar `mcpServers` não basta: com `settingSources` de usuário,
  projeto e local, o CLI ainda carregaria os MCPs do usuário, do `.mcp.json` e de plugins —
  `strictMcpConfig: true` faz valer só os que a sessão passou. O system prompt perde junto os hints
  dessas ferramentas: descrever o que ele não tem só convidaria a tentar.
- **O servidor `planning`**: `plan_read`, `plan_roteiro_set`, `plan_etapa_marcar`,
  `plan_card_create`, `plan_card_update`, `plan_card_delete`, `plan_card_link`,
  `plan_ambiguidade_abrir`, `plan_ambiguidade_resolver` e `plan_handoff_write`. O plano (pasta + slug) vem **do contexto da sessão, nunca de argumento**: o
  Manager não consegue apontar outro plano nem outra pasta. Toda gravação passa pelo store
  (validação, rev, registro de gravação própria), e toda resposta é texto em pt-BR sobre o qual o
  modelo consegue agir (`planningToolText.ts`) — conflito devolve a versão atual, nunca stack trace.
  Além do que o store valida, as ferramentas recusam o que deixaria o plano incoerente: etapa que não
  está no roteiro, ligação para card que não existe ou para si mesmo, sugestão sem fonte. No gate de
  permissão, as `plan_*` passam sem modal, como as de memória e de tarefas: o próprio servidor prende
  o caminho em `docs/spec/<slug>/`.
- **Prompt próprio** (`buildPlanningHint`): questionador (não aceita a primeira formulação); a
  primeira ação é ler o estado e separar e ordenar as etapas; pesquisa na web antes de opinar e só
  sugere com fonte; abre ambiguidade com a própria opinião e pergunta ao usuário. O texto explica os
  limites; quem os garante é a política, abaixo. Tanto ele quanto o bloco do handoff dizem que o
  conteúdo de cards, roteiro, prompts de handoff e páginas web é **dado, não instrução**
  (`PLANNING_CONTENT_IS_DATA`): um card ou uma página que "mande" ignorar regras não substitui o
  usuário.
- **Sem subagentes nem outros shells**: `Agent`, `Task`, `NotebookEdit`, `Monitor`, `PowerShell`,
  `Workflow`, `EnterWorktree`, `CronCreate` e `RemoteTrigger` vão para `disallowedTools`, e os agentes
  especialistas saem das opções. Delegar seria executar por procuração; `Monitor` roda um `command`
  de shell e `PowerShell` é o Bash por outro nome. A lista só poupa turnos do modelo — quem nega de
  fato é a allowlist (camada 1, abaixo).
- **Sem Loop e sem modo econômico**: `planningStartOptions` sobe a sessão com `loopEnabled: false` e
  `economyMode: false`, mesmo que a conversa os tenha ligados — `/loop` agenda turnos sozinho e o
  econômico manda pular verificação, e nenhum dos dois cabe numa sessão que planeja com o usuário.
- **Modelo** em Configurações → Geral, seção **Planejamento** (`AppConfig.planning`; o seletor é
  `PLANNING_MODELS` = Automático + os modelos da conversa). `planningStartOptions` resolve o par **na
  subida da sessão**, uma vez, com a primeira mensagem como `autoPrompt`; o Automático da conversa
  (revalidar a cada mensagem) nunca roda para ela, e a conversa nasce com um modelo concreto de
  placeholder para nenhum caminho `isAutoModel(conv.model)` do App pegá-la. Manual: o par da
  configuração, com o esforço recortado para o modelo. Automático (`resolvePlanningExecution`): o
  mesmo `chooseAutoExecution` do TypeSafe, restrito aos modelos do seletor do Manager e, se o usuário
  restringiu o Automático, à interseção com `typesafe.allowedAutoModels`. O **recuo** é **Sonnet 5 em
  esforço médio** (`PLANNING_AUTO_FALLBACK`), e não o `AUTO_MODEL_FALLBACK` da conversa: aquele vai no
  modelo mais caro porque a conversa não pode errar; o Manager roda por muitas mensagens de
  planejamento, e o Sonnet médio basta. Por isso só passa um par que o TypeSafe **decidiu** (`source
  === 'typesafe'`) — o recuo de lá é o par caro. TypeSafe desligado ou sem chave, interseção vazia,
  resposta fora dos candidatos, erro: recuo. Nunca lança — a mensagem do usuário tem de sair. O
  cabeçalho da tela mostra o modelo em que a sessão subiu.
- **Fora dos observadores**: vigia, quadro, PO e memorista não acompanham a conversa do Manager
  (`PlanningConversations.observed`, em `planningConversations.ts`). Não há turno de execução para o
  quadro registrar nem para o PO auditar, nem trabalho para o memorista aprender, e o vigia
  questionaria premissas que o próprio Manager existe para questionar. A trava do plano (`planGate`)
  também fica desligada: ele planeja, e a única escrita dele é código descartável no `_sandbox`.

### Segurança em camadas — e o limite honesto (`planning/planningPolicy.ts`)

O Manager lê o projeto inteiro (`Read`, `Glob`, `Grep`, git) para ancorar o plano no código real, e
pode escrever e rodar código de teste. O que ele **não** pode é implementar. Cada camada existe
porque a anterior tem um buraco:

1. **Allowlist de ferramentas** (`planningToolDenial`, `MANAGER_ALLOWED_TOOLS`). Uma lista do que
   **não** pode (a `disallowedTools`) sempre fica atrás do CLI: cada versão nova traz ferramenta nova,
   e o CLI embutido já tem `Monitor`, que roda um `command` de shell sem passar pelo escopo nem pela
   aprovação do `Bash`. O Manager só chama: `Read`, `Glob`, `Grep`, `LS`; `Write`, `Edit`,
   `MultiEdit` (com o escopo); `Bash` (escopo + aprovação), `BashOutput`, `KillShell`/`KillBash`;
   `WebFetch`, `WebSearch`; `TodoWrite` e `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet`;
   `AskUserQuestion`; `Skill` (com a camada 5); `ToolSearch`; e `mcp__planning__*`/`mcp__memory__*`.
   O resto é negado com um motivo que lista o que vale — no hook e, de novo, no topo do gate, antes do
   "Permitir tudo" e do reinício.
2. **Escopo de escrita só no `_sandbox` — pelo texto e pelo caminho real.** `planningScopedTask`
   monta um `ScopedTask` do `writeScopeGuard` com `allow: ['docs/spec/<slug>/_sandbox/**']`, holder
   `null` (vale para a sessão toda) e lease que não expira, somado aos escopos das tarefas por
   `sessionWriteScopes`. Reusar o `writeScopeDenial` das tarefas — mesmo casamento de glob, mesmo
   scanner de `Bash` — evita uma segunda regra para manter em sincronia. Roda **antes** do "Permitir
   tudo" e nega sem perguntar. Cards e roteiro ficam **fora** do escopo de propósito: só mudam pelas
   `plan_*`, que validam e carregam o rev. Mas o glob compara **texto**: `_sandbox/x/a.ts` casa mesmo
   se `_sandbox/x` for uma junction (ou symlink) para `src/`. Por isso o hook confere também o caminho
   **real** (`planningSandboxReal.ts`, o mesmo molde do `resolvePlanPath`): cada destino de
   `Write`/`Edit`/`MultiEdit` e cada alvo de escrita do `Bash` (`scanBashWrites`) é resolvido pelo
   ancestral existente mais profundo (`realpath`) e tem de continuar dentro do `realpath` do
   `_sandbox`. Link quebrado (gravar nele criaria o arquivo onde ele aponta), `_sandbox` que é ele
   mesmo um link e erro de disco na conferência também negam — falha fechada.
3. **Hook `PreToolUse`, contra as regras do `settings.json`** (`planningPreToolDecision`, assíncrono
   por causa do `realpath`; o hook o aguarda). O `canUseTool` só é consultado quando o SDK ainda não
   decidiu a permissão, e a sessão carrega as regras de usuário, projeto e local (`settingSources`):
   um `allow` de `Bash`, `Edit`, `Write` ou `Skill` de lá é aplicado **antes** do `canUseTool`, que nem
   chega a ver a chamada — as camadas 1, 2 e 5 ficariam contornadas por uma regra que o usuário
   escreveu para outro contexto. O `PreToolUse` roda antes dessas regras e o `deny`/`ask` dele
   prevalece sobre um `allow` delas, então a política é repetida ali, nesta ordem: fora da allowlist,
   skill bloqueada, escrita que o escopo recusa (inclusive `Bash` com destino fora dele ou
   indeterminável) e escrita cujo caminho real sai do `_sandbox` viram **`deny`** com o motivo; `Bash`
   que passou por tudo isso vira **`ask`**, e o SDK leva o pedido ao `canUseTool` e ao usuário. Fora
   do Manager o hook não opina.
   Um detalhe de encanamento: a chamada negada ali não entra no registro de ferramentas em voo — o
   SDK não dispara `PostToolUse` para ela, e registrá-la a deixaria presa (e o reinício do app
   bloqueado). O mesmo vale, em **qualquer** sessão, para a negada pelo `canUseTool`: o `PreToolUse`
   já a registrou, e o `canUseTool` a tira do registro (`options.toolUseID`) quando devolve `deny`.
4. **`Bash` sempre com aprovação, e é o único shell** (`planningRequiresBashApproval`): nem o
   "Permitir tudo", nem um "sempre permitir" anterior, nem a lista de leitura liberam — e ligar o
   "Permitir tudo" com um pedido pendente não aprova esse pedido. O escopo lê o destino declarado na
   linha de comando; o que o comando faz por dentro, só quem o lê sabe. `PowerShell` e `Monitor` nem
   passam da allowlist. O prompt pede parcimônia (prefira `Read`/`Glob`/`Grep`, junte comandos)
   justamente porque cada um vai ao usuário.
5. **Skills de execução e de replanejamento bloqueadas** (`planningSkillDenial`): `planejar`,
   `brainstorming`, `writing-plans`, `executing-plans`, `subagent-driven-development`,
   `finishing-a-development-branch`, `using-git-worktrees` e variantes (`base.x`, `base-x`,
   `plugin:base`), recusadas antes do "Permitir tudo" com uma mensagem que aponta as `plan_*`. O plano
   vive nos cards; uma skill que planeja em outro lugar criaria um segundo plano.

**O que não está coberto, dito com todas as letras:**

- **O que um programa escreve por dentro.** `node <sandbox>/teste.js` passa pelo escopo (a linha de
  comando não grava fora) e pelo usuário (que aprovou rodar o teste); se o script gravar em `src/`,
  nada no app vê. O scanner lê a linha de comando, não o processo. A defesa real aqui é a aprovação
  um a um: o usuário vê cada comando antes de ele rodar.
- **`/planejar` digitado pelo usuário.** Um slash command digitado no composer é expandido pelo
  próprio CLI no prompt — não passa pela ferramenta `Skill`, e o gate nunca o vê. É o usuário
  pedindo, não o modelo escolhendo; a recusa cobre só o que o modelo invoca.
- **O intervalo entre conferir e gravar.** O caminho real é conferido no hook, antes de a ferramenta
  rodar; um link criado **depois** disso (por um comando que já estava rodando) não é visto. Criar
  esse link exige um `Bash` — que o usuário aprovou lendo o comando.

### Handoff: do plano à conversa de implementação (`HandoffDialog.tsx`, `handoffReadiness.ts`, `handoffFlow.ts`)

O diálogo tem três passos, e cada um existe por um motivo:

1. **Conferir** (`handoffReadiness`, puro). **Ambiguidade aberta bloqueia**: a implementação teria de
   adivinhar justo o ponto que o plano deixou em aberto. Só passa marcando "enviar mesmo assim", e aí
   as ambiguidades vão como pendentes de confirmação do usuário. O resto só **avisa** — roteiro
   vazio, etapa sem card, etapa não concluída, card inválido: incompleto não é o mesmo que errado, e
   quem decide se basta é o usuário.
2. **Gerar**, de dois jeitos. **Pelo Manager**: o diálogo manda um pedido fixo
   (`managerHandoffRequest`) pela conversa de planejamento, pelo caminho normal de envio, e o Manager
   grava **um ou mais** prompts autocontidos com `plan_handoff_write` — mais de um só se o trabalho não
   couber numa conversa. O diálogo espera arquivos **novos** em `_handoff/`: nome que não existia antes
   do pedido **e** criado depois dele (com 2 s de folga para o relógio do disco), relistando a cada
   `planning:changed` e a cada fim de turno do Manager. Ou o **rascunho automático**
   (`buildDraftHandoff`): markdown determinístico montado do plano (mesmo plano, mesmo texto), gravado
   em `_handoff/` pela tela — sem gastar um turno do Manager.
3. **Revisar**: cada prompt é editável. **O `_handoff/` guarda exatamente o que foi enviado**: o prompt
   editado vira um **arquivo novo** antes do envio (o original fica), e se essa gravação falha nada é
   enviado. É o registro do que a implementação recebeu, e só vale se for literal. Gravado **uma vez**:
   cada rascunho lembra o último texto gravado, e uma nova tentativa só grava o que mudou desde então —
   senão cada clique em "Enviar" deixaria mais uma cópia idêntica em `_handoff/`.

Enviar cria a conversa de implementação (modelo e modos de conversa normal, `handoffSlug` marcado) e
entrega os prompts **na ordem** (`launchHandoff`): o primeiro sai já e os seguintes entram na fila
dela; se um envio falha (ou lança), os seguintes não são tentados — sairiam fora de ordem, e estão
gravados em `_handoff/`. O resultado (`HandoffSendOutcome`) separa "enviado", "conversa criada, envio
falhou" e "nada criado". No do meio, o diálogo **fecha** e o toast manda usar **"Tentar de novo"** na
mensagem que falhou, na conversa nova: ficar aberto com "Enviar" habilitado deixaria criar uma
segunda conversa de implementação para o mesmo plano. Só quando nada foi criado o diálogo continua
aberto para tentar de novo.

Na conversa de implementação, `opts.handoff = { slug }` muda duas coisas:

- **Um bloco no system prompt** (`handoffAppendBlock`): de onde ela veio, onde está o plano
  (`_roteiro.md`, `cards/`, `_handoff/`) e como trabalhar — declarar as etapas do roteiro como plano
  (TodoWrite/TaskCreate), na mesma ordem; não replanejar; consultar os cards; perguntar antes de
  desviar quando o código real contradisser o plano. O prompt enviado já diz isso, mas o system
  prompt continua valendo quando o histórico é compactado e o primeiro prompt fica para trás.
- **Sem replanejamento no primeiro turno** (`handoffSkillDenial`): `planejar`, `brainstorming` e
  `writing-plans` são recusadas até o primeiro turno terminar (`result` **ou** erro). Replanejar ali
  descartaria as decisões registradas nos cards. Depois do primeiro turno elas voltam, se o usuário
  pedir: o bloqueio é contra o reflexo do modelo, não contra o usuário. Uma sessão **retomada**
  (`opts.resume`: app reiniciado, conversa reaberta) já passou do primeiro turno e nasce liberada.
- **O mesmo aviso de prompt-injection** do Manager: cards, roteiro e páginas web são dado, não
  instrução.

Uma sessão não pode ser Manager **e** handoff: o main recusa (`planningStartOptions`) e o renderer
nem monta (`sessionStartFields`: o planejamento prevalece).

### A tela (`src/renderer/src/planning/`)

- **Colunas por etapa, sem biblioteca de layout** (`layout.ts`, puro). O fluxo é horizontal: uma
  coluna por etapa do roteiro, na ordem, e uma final "Sem etapa" para card sem etapa ou com etapa que
  saiu do roteiro. Um layout automático de grafo (dagre e afins) arrumaria pelos links e embaralharia
  a ordem das etapas, que é a informação principal; colunas fixas deixam "o que vem antes" legível da
  esquerda para a direita. Posição salva prevalece; card sem posição entra no **fim** da sua coluna,
  abaixo de tudo o que ocupa a faixa dela, e nunca cai em cima de outro. O canvas é React Flow
  (`@xyflow/react`) e não grava nada sozinho: apagar passa por `onBeforeDelete`, que sempre devolve
  `false` — quem tira o card da tela é o plano atualizado depois que o disco confirmou.
- **Piso de zoom legível** (`canvasViewport.ts`, puro). Enquadrar tudo num plano grande deixaria os
  cards ilegíveis. O piso é `FIT_MIN_ZOOM = 12/13`: o título do card (13 px) com pelo menos 12 px
  efetivos na tela — derivado, não número mágico, e um teste confere que o CSS ainda usa 13 px. Se o
  plano inteiro cabe acima do piso, enquadra tudo (sem ampliar além de 1); se não, fica no piso e
  **foca a etapa em andamento** (senão a primeira pendente, senão a primeira), sem deixar vazio antes
  da primeira coluna nem depois da última. O resto se alcança arrastando.
- **Viewport restaurado.** Pan e zoom do usuário vão para `_canvas.json` junto das posições, no mesmo
  debounce de 400 ms (arrastar não grava a cada pixel), e reabrir o plano volta exatamente como estava
  (zoom recortado aos limites do canvas). Só o movimento **do usuário** é gravado: gravar o
  enquadramento automático o congelaria, e a próxima abertura restauraria o foco antigo em vez de
  focar a etapa que está em andamento agora.
- **Roteiro redimensionável e recolhível** (`RoteiroSplitter.tsx`, `paneSizes.ts`). A borda direita
  do roteiro é uma alça (`role="separator"`, arrasto ou setas de 16 px, Home/End nos limites) entre
  180 px e 40% da área da tela; o CSS repete os dois limites, então encolher a janela nunca deixa o
  roteiro engolir o canvas. Recolhido, vira um trilho estreito com o contador e uma marca por etapa,
  sem alça, e expandir volta à última largura. Largura, recolhido e chat minimizado ficam no
  `localStorage` — síncrono, então a tela já abre como o usuário deixou, sem piscar.
- **Chat flutuante sobre o canvas** (`ManagerChatFloat.tsx`, `planningChat.css`). O chat deixou de ser
  coluna: o canvas ocupa toda a largura e o painel "Agent Manager" flutua centralizado sobre ele
  (largura `clamp(420px, 55%, 860px)` da área do canvas), com um botão de minimizar/maximizar.
  **Maximizado**, a borda de cima fica a 20% da altura da **janela** e a de baixo a 12 px do fim;
  como o painel mora na área do canvas (que começa abaixo da barra do app e do cabeçalho da tela), o
  `top` é medido — 20% de `innerHeight` menos o topo da área, refeito por `ResizeObserver` e no
  `resize`. **Minimizado**, ele desce para baixo com ~5 linhas de conversa (a lista tem 5 × o
  line-height das mensagens, 21 px) e 3 de digitação; o `useKeepEndOnResize` mantém o fim da conversa
  à vista quando a caixa encolhe. O painel é uma caixa comum, sem véu: fora dela o canvas recebe mouse
  e roda normalmente. O **minimapa** foi para o canto de cima à direita (embaixo fica o chat
  minimizado); se o painel maximizado cruzar a coluna dele (canvas estreito), o `top` desce para
  baixo do minimapa. Os controles de zoom, embaixo à esquerda, ficam fora da caixa do painel
  (`max-width: calc(100% - 112px)` em canvas muito estreito). O plano em branco virou uma faixa no
  topo do canvas, acima do painel.
- **Modo compacto do chat, por contexto** (`components/chatDisplay.ts`). Minimizado, o `ChatPanel`
  não mostra o cabeçalho de consumo (entrada/saída/custo), o painel de tokens, o quadro "Última
  resposta" nem o aviso "Controle do Windows ativo". Isso entra por um `ChatDisplayContext`
  (`{ compact }`, padrão `false`) que o painel flutuante fornece — o `ChatPanel` chega pronto do App,
  com as mesmas props de qualquer conversa, e a tela não pode (nem precisa) mexer nelas. Sem
  provider, o chat normal fica como sempre. Alternar só muda o valor do contexto e uma classe: o
  `ChatPanel` não remonta, e rolagem, rascunho e foco ficam.
- **Composer em painel estreito, por container query.** O `.chat-panel` é um container (`chat`), e
  abaixo de 560 px o composer se reorganiza: a caixa de texto ocupa a linha inteira, os botões descem
  para a linha de baixo e o quadro "Última resposta" vira uma linha só. Media query não serviria: o
  que é estreito é o **painel**, não a janela — o mesmo `ChatPanel` numa conversa comum continua como
  sempre foi. Pelo mesmo motivo o canvas esconde a dica e o minimapa quando **ele** estreita. E num
  painel estreito o rodapé do chat cresce já na primeira pintura e escondia a última mensagem:
  `useKeepEndOnResize` (`components/MessageListAnchor.tsx`) mantém no fim quem estava no fim quando a
  caixa da lista muda de tamanho, e deixa onde está quem rolou para ler o histórico.

---

## Voz no chat (OpenAI)

O chat ganha **voz** opcional via OpenAI: ditado por microfone (fala → texto) e leitura em voz alta das respostas (texto → fala). Tudo é gated por uma **API key da OpenAI** configurada na tela de Configurações. As chamadas à OpenAI rodam **no main** — a key **nunca** chega ao renderer; o renderer só envia áudio/texto por IPC e recebe texto/áudio de volta.

**Configuração** — em `src/shared/ipc.ts`, `OpenAiConfig` carrega `apiKey`, `voice` (uma de `OPENAI_VOICES` — as vozes do `gpt-4o-mini-tts`) e `speed`; o `DEFAULT_CONFIG` traz `openai: { apiKey: '', voice: 'alloy', speed: 1 }`. `src/main/config.ts` faz o **merge aninhado** de `openai` (em `loadConfig`/`updateConfig`), para salvar a key sem clobber das outras configs. A `src/renderer/src/ui/SettingsModal.tsx` tem a seção **"🎙️ OpenAI (voz no chat)"** com o campo de key (mostrar/ocultar), o seletor de **voz** e o de **velocidade** (Devagar/Normal/Rápida/Bem rápida → `0.8`/`1`/`1.25`/`1.5`); a prop `focus: 'openai'` rola até a seção, a destaca e foca o input (usado quando o usuário toca o mic/Ouvir sem key). Ao fechar Configurações, o `App` relê `voiceReady` (key presente) e `voiceSpeedRef`.

**Chamadas OpenAI no main** (`src/main/openai.ts`, usa o `fetch`/`FormData`/`Blob` embutidos do Node, sem npm):
- `transcribeAudio(apiKey, audioBase64, mimeType)` — POST em `/audio/transcriptions` com `model: 'gpt-4o-transcribe'` (o completo, não o `-mini` — bem melhor para pt-BR) e **`language: 'pt'`** (força o português); deduz a extensão pelo mime. O renderer já descarta áudio só-silêncio (VAD), então não se paga transcrição de trechos quietos que voltariam como palavras inventadas.
- `synthesizeSpeech(apiKey, text, voice)` — POST em `/audio/speech` com `model: 'gpt-4o-mini-tts'`, `response_format: 'mp3'` e uma **instrução forçando pt-BR** ("Leia sempre em português do Brasil…"); devolve `{ base64, mimeType: 'audio/mpeg' }`.
- IPC `openai:transcribe` / `openai:tts` em `src/main/index.ts` leem a key da config; sem key retornam `{ ok: false, error: 'no-key' }` (o renderer abre Configurações), e erros viram `{ ok: false, error }` para um toast.

**Microfone / ditado** (`src/renderer/src/components/Composer.tsx`) — grava **uma fala por segmento**, cortado nas **pausas naturais** por um **VAD local** (detecção de voz, `src/renderer/src/vad.ts` — sem biblioteca externa, roda em cima do `AnalyserNode` que o medidor já usa) e **transcreve cada segmento somando o texto** no campo. Dois motivos para segmentar (em vez de uma gravação única e crescente): (1) um arquivo `webm` só é decodificável depois de **finalizado** (`stop()`) — enviar o áudio ainda "aberto" fazia a API decodificar como vazio (o bug do "não aparece nada"); (2) o VAD fecha o segmento **só quando você pausa**, nunca no meio da palavra (o timer fixo de ~4 s cortava palavras → texto picotado).

**Pré-rolo rotativo — não come o início da 1ª palavra, e silêncio nunca é enviado** — a gravação usa um **pré-rolo** (`vad.ts`: `VAD_PREROLL_MS = 500`, `shouldRotatePreroll`): um rolo curto está **sempre gravando**, mesmo antes da 1ª palavra. Enquanto nenhuma fala foi detectada, cada rolo que passa de `VAD_PREROLL_MS` sem voz é **descartado e recomeçado** (rotacionado) — silêncio puro nunca chega à API. A troca em relação ao esquema antigo (armar e só começar a gravar no instante em que a voz cruza o limiar) é que, como um rolo já está rodando **antes** da fala, o ataque da primeira palavra (consoantes suaves, abaixo do limiar de RMS) **não é mais cortado**: quando a fala é detectada no meio de um rolo, ele simplesmente continua até a pausa natural (`vadStep`) em vez de ser descartado. O `Composer` reabre o próximo rolo (`startSegment` com um `VadState` novo) assim que o anterior termina — por rotação (silêncio) ou por pausa de verdade (fala).

O `runMeter` (no `requestAnimationFrame`) lê o waveform **uma vez por frame** (`getByteTimeDomainData` → `frameRms`) e usa o mesmo RMS para: (a) avançar `vadStep` do rolo atual e checar `shouldRotatePreroll`/a pausa (`VAD_SILENCE_HOLD_MS`) ou o teto de segurança (`VAD_MAX_SEG_MS`) para fechar/reabrir o segmento; (b) alimentar a **forma de onda da gravação** (ver abaixo — a forma de onda/cronômetro continuam rodando o tempo todo, mesmo em silêncio, só o que é **enviado à API** é que muda). `onstop` só transcreve se `seg.vad.hadSpeech` — rolos rotacionados sem fala caem aqui e são descartados, silêncio nunca vai pra API. O texto novo é anexado a `baseTextRef` + `transcriptRef`. Uma **setinha** (`mic-caret`) ao lado do mic abre o menu de escolha do microfone (`enumerateDevices` → `audioinput`; o `deviceId` é persistido em `localStorage` na chave `agentcode.micId`, com fallback ao padrão se o device sumir — `OverconstrainedError`). A permissão de mic é liberada no Electron (ver [Modelo de processos](#modelo-de-processos-e-segurança)).

**Parar sem cortar a última frase (`stopRecording` em `Composer.tsx`)** — `MediaRecorder.stop()` é **assíncrono**: por spec, ele enfileira uma tarefa que dispara um `dataavailable` final (esvaziando o que o encoder ainda não entregou) e só **depois** dispara o evento `stop`. Matar as faixas do `MediaStream` (`track.stop()`) logo em seguida, na mesma função síncrona, corria com essa fila — se a faixa morresse antes do encoder terminar de esvaziar, o **final do áudio era cortado** (era exatamente o que cortava a última frase ao clicar pra parar logo depois de falar). `stopRecording(rec, stream, onDone)` corrige isso: registra um listener no evento **`'stop'` de verdade** (`addEventListener('stop', ..., {once:true})`, sem sobrescrever o `onstop` que já monta/transcreve o blob) e só desliga o microfone **depois** que ele dispara; se não há gravador ativo (armado/silêncio), desliga na hora. Testado com fakes de `MediaRecorder`/`MediaStream` em `Composer.recording.test.ts` (sem precisar de APIs reais do navegador).

**Forma de onda da gravação (estilo WhatsApp)** — enquanto grava, o painel `rec-meter` mostra um **ponto vermelho** piscando, um **cronômetro** (`rec-time`, mm:ss) e uma **faixa de onda rolando** (`rec-wave`, `WAVE_BARS` barrinhas finas) — em vez das antigas 7 barras que só "balançavam" no lugar. O `runMeter` guarda o **pico de RMS desde a última amostra** e, a cada `WAVE_SAMPLE_MS` (~90 ms), empurra esse pico no histórico `levelsRef` (descartando o mais antigo), mapeia cada barra para uma posição no tempo (a mais nova na **direita**, rolando para a esquerda) e atualiza o `scaleY` direto no DOM (sem re-render por frame); no mesmo tique atualiza o `textContent` do cronômetro (`recStartRef`). O histórico/cronômetro são zerados no `startDictation`.

**Leitura em voz alta (TTS)** (`src/renderer/src/App.tsx` + `src/renderer/src/components/MessageList.tsx`) — cada resposta **final** (`answer`) ganha um botão **"Ouvir/Parar"** no rodapé da bolha. O `toggleSpeak(id, text)` trata o texto, sintetiza e toca **em pedaços (pipeline)** para latência baixa: pré-busca a síntese do pedaço `i+1` enquanto o `i` toca (`fetchChunk`), e um `speakTokenRef` cancela uma sequência em andamento ao parar ou trocar de mensagem. O texto é tratado antes por `src/shared/speechText.ts`:
- `toSpeechText(markdown)` — remove blocos de código cercados e URLs (mantém o **texto** dos links, descarta imagens), tira marcadores de heading/lista/citação/ênfase e **não lê tabelas**: cada tabela GFM vira a menção "conforme a tabela.".
- `splitForSpeech(text)` — fatia por frases numa **rampa** de tamanho (`CHUNK_RAMP = [60, 150, 260]`): o 1º pedaço é minúsculo para o primeiro áudio voltar rápido, os seguintes maiores para reduzir o número de chamadas TTS; frases acima de `HARD_MAX` são quebradas em cláusulas/palavras.

A **velocidade** é aplicada no player via `audio.playbackRate` (com `preservesPitch` para a voz não ficar de "esquilo") — determinística e instantânea, porque o `gpt-4o-mini-tts` ignora o parâmetro `speed`. Os ícones novos ficam em `src/renderer/src/components/Icons.tsx` (`IconMic`, `IconSpeaker`, `IconStopSmall`, `IconChevronDown`).

> A mesma voz roda **no celular** pela ponte LAN: o app grava/toca e o PC transcreve/sintetiza (o `RemoteServer` recebe `transcribe`/`tts`/`voiceReady` por dependência em `index.ts`, lendo a key da config). Há testes do tratamento de fala em `src/shared/speechText.test.ts`.

---

## Modelos via Ollama Cloud

Além do Claude (Opus/Sonnet/Haiku), o app pode rodar **modelos do Ollama Cloud** (DeepSeek, GLM, Qwen, Kimi, GPT-OSS…). Funciona **sem trocar de SDK**: o Ollama Cloud expõe uma **API compatível com a Anthropic Messages API**, então a própria CLI do Claude Code (que o Agent SDK sobe) é apontada para o Ollama por **variáveis de ambiente** — o mesmo truque do comando `ollama launch claude`.

**Configuração** — em `src/shared/ipc.ts`: `OllamaConfig` (`{enabled, apiKey}`; `DEFAULT_CONFIG` traz `ollama: { enabled: false, apiKey: '' }`), a lista curada `OLLAMA_MODELS` (id = **tag exata** do Ollama, ex. `nemotron-3-ultra:cloud`, `glm-5.3:cloud`), `OLLAMA_BASE_URL = 'https://ollama.com'` e `isOllamaModel(id)` (true quando o id termina em `:cloud` — assim modelos futuros funcionam sem mexer no código). `src/main/config.ts` faz o **merge aninhado** de `ollama` (igual ao `openai`).

**Roteamento** (`src/main/agentSession.ts`) — quando o modelo escolhido é Ollama, a sessão monta `options.env` com três variáveis e parte daí:
- `ANTHROPIC_BASE_URL` = `https://ollama.com`
- `ANTHROPIC_AUTH_TOKEN` = a API key do Ollama (da config)
- `ANTHROPIC_API_KEY` = `''` — **crítico**: se não for esvaziada, a CLI prefere uma key da Anthropic e ignora o `BASE_URL`.

Como o campo `env` do SDK **substitui** todo o ambiente do subprocesso (não faz merge), espalhamos `...process.env` antes. Se um modelo Ollama for escolhido sem key configurada, a sessão emite um erro amigável e não inicia.

**A quarta variável, e por que ela é obrigatória** (`cliConfigDirWithoutStoredLogin`, vale para Ollama **e** GPT) — esvaziar `ANTHROPIC_API_KEY` não basta, porque o **login do claude.ai não vem de variável de ambiente: vem do disco** (`~/.claude/.credentials.json`). Com o usuário logado no Claude, o CLI ignorava o `ANTHROPIC_AUTH_TOKEN` que passamos e mandava o `sk-ant-…` dele para o backend de fora. No proxy do Codex isso virava **401 em looping infinito**: o CLI reentrava para sempre, o turno nunca terminava, e a tela ficava "trabalhando" sem resposta e **sem erro** — o sintoma era "o app não responde", não "o login está errado". Por isso a sessão de backend externo recebe `CLAUDE_CONFIG_DIR` apontando para `<cacheDir>/cli-config-sem-login`, um diretório onde não existe credencial nenhuma; aí o CLI usa o token que passamos. O diretório é **semeado** com o `CLAUDE.md` e o `settings.json` do usuário (`CLI_CONFIG_CARRY_OVER`), copiados só quando mudam: some a credencial, não as instruções globais nem as configurações. Falha ao preparar o diretório degrada em silêncio (aviso no log) — derrubar o turno seria pior.

**UI** — a `SettingsModal.tsx` tem a seção **"🦙 Ollama Cloud"** (ativar + API key, mostrar/ocultar). Quando ativa **com key** (`ollamaReady` no `App.tsx`), os `OLLAMA_MODELS` são concatenados aos `MODELS` do Claude no **seletor de modelo** (acima do composer). O **gate de login do Claude** no `connect()` é **pulado** para modelos Ollama (`isOllamaModel`), já que a autenticação é a API key — não o OAuth da Anthropic.

> **Planos do Ollama:** GPT-OSS e Gemma 4 rodam no **plano grátis**; Nemotron 3 Ultra/Super, DeepSeek V4 Pro, GLM 5.3 (e o Flash) e Kimi K3 retornam `permission_error` e exigem **assinatura** (ollama.com/upgrade) — por isso esses aparecem no seletor marcados com "· assinatura".

## GPT via assinatura ChatGPT (OAuth Codex)

Os modelos GPT-5.6 Luna/Terra/Sol usam o **mesmo `AgentSession`, o mesmo `query()` do Claude Agent SDK e o mesmo harness do Claude Code**. O login é OAuth da conta ChatGPT; não há API key nem chamada à API faturada por chave. Para uma sessão GPT, `agentSession.ts` muda apenas o ambiente do subprocesso: `ANTHROPIC_BASE_URL` aponta para um proxy HTTP local em loopback, `ANTHROPIC_AUTH_TOKEN` recebe um segredo efêmero e `CLAUDE_CONFIG_DIR` desvia o CLI para um diretório sem credencial guardada (sem isso o login do claude.ai vence o segredo e o proxy responde 401 para sempre — ver a seção do Ollama). `systemPrompt: claude_code`, MCPs, `settingSources` e `canUseTool` continuam idênticos aos do Claude.

O proxy **não executa ferramentas**. `codexProtocol.ts` traduz definições Anthropic (`name`, `description`, `input_schema`) para functions da Responses API; converte o histórico `tool_use`/`tool_result` em `function_call`/`function_call_output`; preserva ids, imagens de entrada e imagens devolvidas por screenshots, esforço e limite de saída. `codexStream.ts` faz o caminho inverso no SSE, inclusive chamadas paralelas, recusas e deltas JSON. Ao receber `tool_use`, o próprio Claude Code pede permissão, executa `Read`/`Write`/`Bash`/MCP ou cria um filho com `Agent`, adiciona o `tool_result` ao histórico e chama o modelo novamente até a resposta final. Assim IPC, cards, trilhas de subagentes e permissões não têm um segundo fluxo específico para OpenAI.

**Loop por conversa** — o toggle **Loop** fica ao lado de **Econômico** e persiste como `Conversation.loopEnabled` no SQLite por projeto. Os dois modos são mutuamente exclusivos: Econômico ligado desativa Loop e encerra a sessão viva para matar qualquer `ScheduleWakeup` em memória; desligar Loop faz o mesmo. O `AgentSession` só autoriza a skill `loop` e `ScheduleWakeup` quando o toggle estava ligado no início da sessão, rejeita campos fora do schema (incluindo o `noop` já emitido por GPT), bloqueia wakeup usado apenas para esperar subagente e conta no máximo 100 continuações por padrão. Um limite maior só é extraído quando o prompt o liga explicitamente a vezes/ciclos/iterações (teto técnico 10.000); números incidentais como portas e datas não alteram o orçamento. Em cada iteração o system prompt exige verificar primeiro a condição do usuário e usar `stop: true` ao concluí-la. Uma iteração que termina sem novo wakeup também fecha o estado local do loop. Como os jobs dinâmicos são session-scoped, interromper, descartar, ativar Econômico ou desligar Loop elimina wakeups antigos em vez de deixá-los ressuscitar a tarefa.

**Contrato Responses Lite dos GPT-5.6** — Luna/Terra/Sol não recebem o envelope Responses convencional usado internamente pelo tradutor. Antes do `fetch`, `toCodexWireRequest()` transforma a requisição canônica no formato do backend ChatGPT: remove `tools`, `instructions` e `max_output_tokens` do topo; prefixa `input` com um item `additional_tools` de papel `developer` e, quando há system prompt, com uma mensagem `developer`; força `parallel_tool_calls: false`; adiciona `reasoning.context: "all_turns"` e usa o id estável da sessão em `prompt_cache_key`. O HTTP envia também `x-openai-internal-codex-responses-lite: true`, `session-id` e `thread-id`. Essa separação mantém a tradução Anthropic testável sem contaminar sua representação interna com detalhes do transporte Lite.

O erro `HTTP 400 / Model not found gpt-5.6-luna` observado na integração tinha dois pontos de compatibilidade. O roteador do Codex exige `originator`, `User-Agent` e o header `version` coerentes com um cliente que conheça os aliases GPT-5.6; o proxy passou a enviar `codex_cli_rs`, `codex_cli_rs/0.146.0` e `version: 0.146.0`. Depois disso, o corpo também foi alinhado ao Responses Lite descrito acima, evitando enviar as dezenas de ferramentas do harness como `tools` convencionais para um modelo configurado no modo Lite. Detalhes brutos de erro do upstream ficam separados de `Error.message`; a UI só recebe mensagens estruturadas e sanitizadas.

**GPT-6 Astra** também usa esse contrato Responses Lite. Sua integração exige a versão de protocolo **0.153.4**, agora enviada pelo proxy para todos os GPTs. A versão 0.146.0 mencionada no diagnóstico anterior era rejeitada pelo Astra com HTTP 400. O campo estruturado `detail` dessa recusa também é preservado na mensagem apresentada ao usuário. Astra, Sol, Luna e Terra foram exercitados com autenticação e ferramentas reais; veja `docs/validation/provider-failover-2026-09-05.md`.

**Regra de roteamento OpenAI** — os modelos GPT do Agent Code usam exclusivamente o login OAuth do ChatGPT pelo backend Codex e o proxy local; nunca usam a OpenAI API com chave. A OpenAI API é reservada apenas para voz.

**Modo rápido nos dois provedores, por canais diferentes** — o toggle **↯ Rápido** é um controle só, mas a capacidade é pedida de formas incompatíveis, e mandar a errada é erro duro, não no-op. `fastModeTransport(model)` (`shared/ipc.ts`) é a fonte única que decide:

- **`anthropic-setting`** (Opus 5 / Opus 4.8) → `settings: { fastMode: true }` nas `Options` do SDK.
- **`codex-priority`** (GPT-5.6 Luna/Terra/Sol) → **`service_tier: 'priority'`** no corpo da requisição Codex.

O backend Codex **valida o corpo estritamente**: qualquer parâmetro desconhecido (`fast`, `fast_mode`, `speed`, `priority`…) volta `400 Unsupported parameter`, e qualquer outro valor de tier (`fast`, `auto`, `flex`, `scale`) volta `400 Unsupported service_tier`. Só existem `default` e `priority` — foi o que permitiu enumerar a superfície inteira em vez de adivinhar. Headers do tipo `x-openai-internal-codex-fast` são aceitos e **ignorados** (sem efeito).

**Duas armadilhas, ambas medidas em 03/09/2026 contra `gpt-5.6-sol`:**

1. **O eco mente.** A resposta traz `service_tier: "default"` mesmo quando `priority` foi aplicado. Confiar nesse campo levaria à conclusão errada de que não funciona — o único sinal confiável é o tempo.
2. **Não vem ligado por padrão.** Sem mandar o campo, a conta cai em `default`. Medido em 10 execuções pareadas (~900–1200 tokens de saída), com as duas ordens de execução para descartar efeito de conexão quente: **mediana 13,0 s vs 18,5 s de total e ~254 vs ~157 tok/s** — ~30% menos tempo, ~1,6× o throughput, `priority` vencendo em 10 de 10.

Como o proxy é um **servidor único do processo, compartilhado por todas as conversas**, e o modo rápido é **por conversa**, a opção não pode ser um campo do proxy (vazaria entre chats). Ela viaja no **`ANTHROPIC_AUTH_TOKEN`**, o único valor por sessão que o app controla ponta a ponta: `agentSession` anexa o sufixo `FAST_MODE_TOKEN_SUFFIX` (`+fast`) e `parseProxyCredential` o separa de volta. O sufixo **não é credencial** — só é honrado sobre um segredo exato; um segredo errado com `+fast` continua sendo `401`, sem tocar o upstream.

> Custo: no Claude, o modo rápido cobra mais por token. Nos GPT **não há cobrança por token** (é a assinatura ChatGPT) — o tooltip do botão muda conforme o provedor por isso, e avisa que o limite do plano pode ser consumido mais rápido. Se `priority` de fato consome cota mais depressa não foi medido; por isso o toggle nasce **desligado**, como no Claude.

**Documentação do projeto no contexto** — a sessão é iniciada com o preset `claude_code`, `settingSources: ['user', 'project', 'local']` e o diretório de trabalho do projeto. Isso permite ao CLI carregar as instruções `CLAUDE.md` das fontes aplicáveis. Além disso, `AgentSession.send()` chama `buildProjectOutline(cwd)` em **todo envio efetivo** e insere um bloco `[PROJECT_DOCS_OUTLINE]` entre o carimbo de origem e a mensagem: ele lista recursivamente todos os arquivos, diretórios (inclusive vazios) e links de `docs/`, com headings de Markdown, sem anexar os conteúdos integrais. O índice é refeito quando uma mensagem sai da fila, portanto enxerga documentação criada/alterada no turno anterior e funciona igual em sessão nova, retomada, PC, celular e mensagens com imagem.

**O bloco não é reenviado idêntico** — o índice ia *inteiro* dentro de cada mensagem do usuário, e a mensagem fica no histórico: numa conversa de N mensagens o contexto carregava N cópias do mesmo texto. Medido neste repo: os Markdown da raiz de `docs/` somam **210 KB** (~60–70k tokens), então 15 mensagens sozinhas encostavam no limite de 1M — não pelo conteúdo, pela repetição. Agora a sessão guarda o `outlineDigest` (SHA-1) do bloco que **de fato enviou**; se o índice recalculado for byte a byte igual, o envio leva `unchangedOutlineNote()` — uma linha dizendo que o bloco anterior continua autoritativo e que nada em `docs/` mudou. Qualquer alteração muda o hash e o bloco completo volta na hora. Três detalhes que sustentam a corretude: o índice **continua sendo relido a cada envio** (só o que é *enviado* muda, então uma edição no turno anterior é vista na hora); o digest é marcado **no momento do enfileiramento**, então um envio que falhou antes de chegar ao modelo não conta como entregue; e o estado é **por sessão** — sessão nova ou retomada tem contexto vazio e recebe o bloco completo de novo.

A lista de caminhos não é truncada silenciosamente. Apenas a leitura de headings é limitada por arquivo aos primeiros 64 KiB, 32 títulos e 160 caracteres por título; qualquer corte é marcado no próprio índice. Arquivos não-Markdown entram por caminho e tipo, sem OCR, parsing de PDF/zip ou conteúdo binário. Links simbólicos são listados, mas não seguidos. Pasta ausente, item ilegível ou falha inesperada gera um marcador compacto e o envio continua (fail-open). O relay de visão ainda recebe somente o texto cru do usuário como pista; o índice é anexado depois, no payload final ao modelo. A sessão recebe também os hints fixos e o índice resumido de memória construídos pelo Agent Code; retomar a sessão carrega o histórico pelo SDK, e o outline fresco acompanha cada nova mensagem.

Modelos de raciocínio stateless precisam receber de volta seus itens `reasoning` junto do resultado da ferramenta. O proxy pede `reasoning.encrypted_content` e guarda esses itens opacos em memória, isolados por `accountId + x-claude-code-session-id + call_id`; nunca os expõe como pensamento no chat nem os reutiliza em outra conta ChatGPT. Se o app foi reiniciado e esse estado opaco já não existe, ciclos antigos de ferramenta são rebaixados para uma transcrição multimodal segura em vez de inventar um `function_call` inválido. Os aliases Sonnet/Opus/Haiku/Fable usados pelo `Agent` são fixados no GPT escolhido para um filho não escapar para um modelo Claude. O caminho GPT usa `maxTurns: 64` e o proxy repete o limite por rodada do turno atual; Anthropic e Ollama não recebem esse limite novo.

Falhas 401 fazem no máximo um refresh OAuth antes de o proxy responder; se outra requisição já renovou o token capturado, ele é reutilizado sem girar o refresh token outra vez. Refresh antigo não pode atravessar logout/troca de conta, e uma sessão viva fica vinculada ao `accountId` com que começou durante toda a vida do proxy. 403/429, recusa, JSON/SSE malformado, fim prematuro e cancelamento viram erro estruturado ou abortam o upstream — não são encerrados como falsa resposta bem-sucedida. A compatibilidade depende do backend Codex da assinatura ChatGPT, que não é a API pública com chave e pode mudar. Testes cobrem o protocolo puro, o envelope Responses Lite, headers HTTP, o servidor loopback e o Claude Agent SDK real executando ferramenta/subagente contra um upstream Codex simulado. Na correção do 400, a suíte focada terminou com **54 testes aprovados**, seguida de `npm run typecheck` e `npm run build` bem-sucedidos.

**Trocar de modelo sem parar a sessão na mão** — o SDK fixa o modelo pela vida da sessão (não dá pra trocar no meio de uma requisição). O seletor (`ChatPanel`, `modelLocked`) fica travado **só enquanto o agente está OCUPADO** (`showBusy`, mid-turn) — não enquanto está só *conectado*. Trocar o modelo com a conversa **ociosa mas conectada** (`changeModel` em `App.tsx`) atualiza `Conversation.model` e encerra a sessão atual **em silêncio** (`stopSession(id, {silent:true})` — mesmo `interrupt`+`disposeAgent` do botão "Parar sessão", só sem o toast de "sessão encerrada"); a **próxima mensagem** reconecta sozinha já com o modelo novo. Trocar com a sessão **desconectada** só atualiza o campo (nada pra encerrar). Testes: `App.test.tsx` → "trocar de modelo sem precisar parar a sessão manualmente".

### Vision Relay (`vision_fallback_router`) — imagem para modelo sem visão

A maioria dos modelos do Ollama Cloud da lista (`OLLAMA_MODELS`) é **texto-only** — se uma imagem chegasse até eles, o Ollama rejeitaria ou o modelo simplesmente ignoraria o anexo. Em vez de bloquear o envio ou avisar o usuário, o app **intercepta** a imagem antes do SDK e a troca por uma **descrição técnica estruturada**, de forma **transparente** (mesma conversa, mesma resposta, o usuário não percebe a troca).

- **Quem suporta visão de verdade** (`modelSupportsVision(model)` em `shared/ipc.ts`): todo modelo Claude, sempre; no Ollama, só o que estiver em `OLLAMA_VISION_MODELS`. Essa lista não é baseada em ficha técnica — foi **verificada com um probe real** (`POST https://ollama.com/v1/messages` com uma imagem, pra cada um dos 6 modelos de `OLLAMA_MODELS`): só o tag do Kimi respondeu 200 (processou a imagem de verdade; hoje `kimi-k3:cloud`, multimodal nativo, que herdou o slot do antigo `kimi-k2.7-code:cloud` e ainda não foi reprobado); os outros cinco (Nemotron 3 Ultra, gpt-oss 120B/20B, DeepSeek V4 Pro, GLM) responderam 400 `this model does not support image input`. Os cinco passam pelo relay; o Kimi vai direto. Reverifique da mesma forma antes de marcar qualquer outro modelo como `true` aqui — um `true` errado manda a imagem crua pra um modelo que dá 400 (foi exatamente o bug relatado: o app antigo, antes deste feature existir, mandava a imagem direto pra qualquer modelo).
- **O relay** (`src/main/visionRelay.ts`): `describeImages(images, userText)` dispara um `query()` **avulso** do SDK (não é a sessão principal) contra um modelo multimodal fixo (`claude-sonnet-5`), com `tools: []` (sem ferramentas — é só um intérprete, não um agente) e `maxTurns: 1`. O prompt pede uma extração estruturada em 8 seções fixas: **Texto visível (OCR completo)**, **Erros encontrados**, **Elementos de interface**, **Layout visual**, **Contexto técnico**, **Logs ou stack traces**, **Componentes relevantes**, **Possíveis problemas identificados**. `buildVisualContextBlock` envolve o resultado em `[VISUAL_CONTEXT]\n…\n[/VISUAL_CONTEXT]`; `mergeUserTextWithVisualContext` monta o texto final ("Mensagem original do usuário: …" + o bloco + "Agora responda considerando a análise visual acima.").
- **Interceptação** (`AgentSession.send`, agora `async`): se há imagens **e** `!modelSupportsVision(this.opts.model)`, chama o relay e envia **só o texto mesclado** pra fila do SDK — a imagem em si nunca chega ao modelo principal. Se o relay falhar (rede, etc.), degrada sem travar o envio: acrescenta uma nota curta ao texto avisando que a imagem não pôde ser analisada, e segue. Com um modelo que já vê imagem (Claude ou Kimi K3), ou sem nenhuma imagem anexada, o fluxo é **idêntico ao anterior** — os blocos de imagem vão direto no `content` da mensagem, sem relay.
- Testes: `visionRelay.test.ts` (prompt/parsing do relay isolado, com `query` mockado) e `agentSession.test.ts` → "vision_fallback_router" (os 5 ramos: sem visão + sucesso, sem visão + falha do relay degradando, Claude pulando o relay, Kimi K3 pulando o relay, sem imagem).

---

## Reiniciar o app pelo agente

O agente roda **dentro** do app: ele não consegue se fechar e reabrir sozinho — matar o processo mataria a própria sessão no meio. Por isso o reinício é feito por um script **externo e destacado**, `scripts/relaunch-agent-code.ps1`.

```powershell
Start-Process powershell -WindowStyle Hidden -ArgumentList `
  '-NoProfile','-ExecutionPolicy','Bypass','-File','scripts\relaunch-agent-code.ps1'
```

Sequência: **confere o guarda → espera 5 s → fecha → espera 5 s → reabre**.

**Só reinicia se nenhum agente estiver rodando.** Essa é a regra central, e ela **não é decidida pelo script**: um script enxerga processos, nunca conversas. Quem sabe é o main, que já tem essa lógica no `AppRestartCoordinator` (a mesma que sustenta a ferramenta `app_restart`): `blocker()` recusa enquanto qualquer conversa estiver ocupada, houver estado `unsafe` ou um start/send pendente.

- `AppRestartCoordinator.status()` expõe essa resposta para fora, **sem isentar ninguém** — no `app_restart` a conversa que pede é exceção (senão ela bloquearia a si mesma); para o script externo não há quem isentar, então toda conversa ocupada conta.
- `restartGuardFile.ts` grava esse retorno em `<userData>/restart-guard.json` **a cada 2 s**, por temporário + `rename` (o script nunca lê um arquivo pela metade).
- O carimbo `at` transforma o arquivo num **heartbeat**. Se o app travar ou morrer, o timestamp para de andar; o script trata estado com mais de 15 s, ausente ou ilegível como **desconhecido e recusa** (`exit 2`). Falhar fechado é o único comportamento seguro: assumir "ocioso" mataria um turno em andamento. Pelo mesmo motivo o arquivo é **apagado no shutdown** — um snapshot "ocioso" deixado por um app morto seria exatamente a resposta errada.
- Agente ocupado → `exit 3`, com o motivo no log. `-Force` pula o guarda (uso manual do usuário, não do agente).

**Incerteza vem de trabalho não terminado, não de "usou shell alguma vez".** `AgentSession` marca cada chamada de ferramenta fora de `VERIFIED_TOOLS` como opaca **enquanto está em voo** (`restartOpaqueCalls`, alimentado por `PreToolUse` e esvaziado por `PostToolUse`/`PostToolUseFailure`) — uma ferramenta que retornou, com sucesso ou erro, é prova de que terminou.

Antes isso era um booleano de mão única: a **primeira** chamada de `Bash` de qualquer conversa marcava a sessão como "trabalho autônomo sem prova de término" e nunca desmarcava. Pior, `dispose()` só desregistra a sessão quando ela não está `unsafe`, então o registro sobrevivia à conversa e **bloqueava o reinício pelo resto da vida do processo**, para o `app_restart` e para o script externo. O recurso era inalcançável na prática: bastava um comando de terminal.

O latch permanente continua existindo, mas só para o caso que o justifica — trabalho **destacado**, que segue vivo depois de a chamada retornar (`startsDetachedWork`: `run_in_background: true`, `CronCreate`, `RemoteTrigger`, `Workflow`). Aí o retorno realmente não prova nada.

Os dois atrasos de 5 s têm função. O primeiro dá tempo de o agente terminar a resposta que disparou o pedido. O segundo é obrigatório: o Electron usa **trava de instância única por `userData`**, então reabrir com o processo antigo ainda vivo faz o novo se ver como segunda instância e fechar na hora, **sem erro na tela** (foi assim que o teste do exe portátil pareceu "quebrado" quando o app de dev estava aberto). O fechamento usa `CloseMainWindow` antes de forçar, para o app salvar o que precisa.

Tudo vai para `%TEMP%\agent-code-relaunch.log`, com o motivo de cada recusa — silêncio não é prova de que reabriu.

O `restart-guard.json` é publicado **antes** de inicializar o armazenamento, e a ordem é deliberada: ocupação é sobre conversas, não sobre banco. Se a inicialização falhar, o app continua vivo na tela de recuperação — e é exatamente aí que reiniciar resolve. Publicado depois, um app nesse estado nunca escreveria o arquivo e o script recusaria para sempre, sem ninguém entender por quê.

> **Testar o guarda: use `dist/win-unpacked/Agent Code.exe`, não o portátil.** O exe portátil é um stub que se descompacta e relança o app, e **não repassa os argumentos de linha de comando** — um `--user-data-dir=<sandbox>` é silenciosamente ignorado, então o teste observa uma pasta que nunca virou `userData` e conclui que o guarda não funciona. O app descompactado é um Electron normal e honra a flag, o que permite validar sem tocar na instância que o usuário está usando (é obrigatório isolar: sem `--user-data-dir` próprio, a trava de instância única faz a cópia de teste fechar na hora).

> A ferramenta `app_restart` continua sendo o caminho **interno** (com relançador armado, flush do histórico e verificação pós-commit). O script é a rota externa, útil quando o app é o **exe portátil**: ele fecha e reabre o executável, sem depender do relançador.

---

## Painel de agentes: três visões do mesmo trabalho

O painel do lado direito (`AgentsPanel`) alterna entre **Equipe**, **Tarefas** e **Projeto** — três recortes do mesmo trabalho, e a diferença entre eles é a fonte. **Equipe** é o elenco (abaixo). **Tarefas** lê o registro durável (ver [A fila na tela](#a-fila-na-tela-tasksboardtsx)): a fila do projeto, que sobrevive a fechar o app e enxerga o que outra conversa deixou em revisão. **Projeto** **não usa store nenhum** — deriva tudo das mensagens do chat.

### Equipe — o elenco (`crew.ts`, `AgentCrew.tsx`)

Antes havia aqui uma **lista de trilhas**: uma linha por delegação, que nascia e morria. Ela respondia "o que aconteceu", e era a pergunta errada — o usuário queria **ver quando alguém começa a trabalhar**, e uma lista que só cresce não tem transição para notar de canto de olho.

O eixo mudou de *delegação* para **papel**. Todo agente está sempre em cena: parado, fica recuado (opacidade 48%); ao começar, **acende** na cor do papel, com anel girando, cronômetro correndo, varredura na borda e um pulso de chegada que toca 2× e para. **É o contraste com o estado parado que faz a transição ser percebida** — por isso o parado continua listado em vez de sumir.

Quatro estados, e só quatro: **parado**, **trabalhando**, **esperando você** (âmbar, exclusivo do vigia — o único que pede ação) e **falhou/devolveu** (vermelho, com o motivo na própria linha). Uma cor por papel, e a mesma cor reaparece no cartão, no chip da topbar e na faixa da linha do tempo.

A linha "o que está fazendo" é **composta**, não uma string: a ferramenta sai na cor do papel e os contadores de linha em verde/vermelho, e a posição de cada pedaço muda com o caso (`delegando · Agent → critico` contra `começou agora · task_get`).

**Nada disso inventa fonte nova.** Os quatro especialistas vêm do `agentTracks.ts`; o Principal, do `busy`/`busySince` que a faixa "está trabalhando" já usa; o vigia, do `vigia:alert`; o PO, do `po:provider-diagnostic`. Duas regras que o modelo puro carrega: a **ordem dos papéis é fixa** (o cartão de um agente não pode pular de lugar quando outro começa) e duas trilhas do mesmo papel viram **um** cartão com "N em paralelo", em vez de duplicar a linha.

O **PO ganhou um evento de fim** (`audit-finished`, com quantos cartões corrigiu). Ele já anunciava o início; sem o fim, o cartão dele ficaria auditando para sempre. O vigia continua sem evento de início — ele só aparece quando tem dúvida, que é o único momento em que depende de você.

Fora do painel, o **chip do elenco** (`CrewChip`) empilha os mini-avatares de quem trabalha agora — **logo acima da barra de digitação**, que é onde o usuário está olhando enquanto espera. Sem ele, saber que um agente entrou em campo exigiria manter a aba aberta, que é justamente o que não acontece. Um clique abre o elenco. O chip **some quando ninguém trabalha**: um chip permanente com "0" vira mobília e para de ser lido.

Ele substituiu a linha "N subagentes trabalhando" que ocupava esse lugar: mesma informação, com o papel de cada um — e duas faixas dizendo o mesmo seria ruído.

> **O cartão de etapas saiu do chat.** O `TodoPlanCard` mostrava o plano do turno fixo acima do composer; com o Quadro, a mesma informação passou a ter um lugar próprio, durável e por projeto. O dado (`Conversation.todoPlan`) continua vivo: alimenta a faixa de etapas do mapa **Projeto** e o quadro.

A segunda visão, **Linha do tempo**, mostra uma faixa por agente sobre a janela do turno: quem rodou junto de quem, e quem ainda está vivo.

> As classes CSS levam prefixo `crew-`. O mockup usava `.agent`, `.badge`, `.step` — genéricos demais para uma folha de 6,5 mil linhas. A aparência é a mesma; o risco de colisão, não.

### Visão "Projeto" — o mapa do repositório

Um grafo no estilo Obsidian com **os 100 arquivos modificados mais recentemente** (+ as pastas que levam até eles): cada pasta é uma bolinha com nome, cada arquivo uma bolinha menor. Mostrar o repo inteiro foi a primeira versão e era a imagem errada — centenas de arquivos parados havia meses, com o trabalho vivo perdido no meio.

**O que se mexe e o que fica parado.** Enquanto o agente trabalha, o layout **não** se agita: nenhuma chamada acorda a física, e as arestas são todas cinzas. As duas coisas juntas (empurrão de `alpha` por chamada + arestas acendendo em volta do nó quente) davam a leitura de "mancha se espalhando pelos galhos", que é justamente o que não se quer — a física só volta quando a **árvore** muda (arquivo criado/apagado). O que se mexe é o nó: ele **pisca clareando** (o pico do pulso clareia a cor da ação, em vez de um halo crescendo) e a linha da chamada, que é a única coisa colorida em movimento.

**`Read` traz o arquivo de volta.** Toda chamada desenha a ida (raiz → … → arquivo). Para `Read` — e só para ele (`FETCHING`) — vem uma **segunda perna**: uma folha de papel desliza do arquivo de volta até a raiz, com um rastro curto, e some ao entregar. É o que distingue no mapa "fui buscar o conteúdo" de "fui alterar". Não roda quando a chamada deu erro (não trouxe nada). Quando o agente mexe num arquivo, uma **linha luminosa sai da raiz e percorre o caminho real da árvore** (`agent-code → src → renderer → components → AgentFlow.tsx`) até ele; o nó só acende **quando a linha chega** — se acendesse na hora da chamada, a viagem viraria enfeite. Ao chegar, o nó **fica aceso para sempre**, na cor daquela ação: o mapa é o histórico da sessão, e não um mapa de calor que se apaga sozinho (o `heat`, que antes decidia a cor e esfriava com meia-vida de ~16s, hoje só controla o pulso do "agora").

- **De onde vêm os dados** (`projectActivity.ts`): das **mesmas `Conversation.messages` que o chat renderiza** — cada `tool-use` já carrega o resultado (`App.tsx`). Essa é a razão de o mapa mostrar tudo o que o chat mostra sem um segundo store pra manter em sincronia. `fileTouches()` resolve cada chamada num ponto da árvore e `describeCall()` gera o texto do balão por ferramenta (`Bash` → o comando, `Edit` → `arquivo +2 −1`, `Grep` → o padrão…). `toRelative()` casa o caminho absoluto do Windows (`C:\…\src\main\index.ts`) com o relativo da árvore (`src/main/index.ts`), **sem diferenciar maiúscula** — caminho do Windows não diferencia, e um mismatch de caixa acenderia nó nenhum, silenciosamente.
- **A árvore** vem do canal `projectTree` (`main/index.ts` → `readProjectTree`): varre (teto de 8000 entradas, reusando o `MENTION_IGNORE` do autocomplete do "@"), dá `stat` em cada arquivo — em paralelo **por pasta**, uma rodada de I/O por diretório e não uma por arquivo —, ordena por `mtime` e fica com os N mais recentes. A varredura roda com o painel aberto e **de novo ~1,2s depois de cada atividade**, senão um arquivo recém-criado só apareceria reabrindo o painel.
- **Ciclo de vida do nó** (`NodePhase` em `projectGraph.ts`, animado por `advancePhases`): `arriving` (o agente abriu um arquivo que estava **fora** do filtro dos recentes — ele entra voando do fundo, grande e translúcido, em vez de simplesmente pipocar), `building` (criado agora — fragmentos convergem e fundem na bolinha) e `dying` (apagado — a bolinha se parte e só então sai do grafo). `ensureNode()` põe no mapa, na hora, qualquer caminho que o agente toque e que não esteja na lista, criando as pastas do caminho; `removeNode()` reencaixa os filhos no avô, senão sobrariam arestas apontando para um nó que não existe mais.
- **Apagado ≠ saiu do ranking.** Um arquivo pode cair fora dos 100 mais recentes continuando vivo no disco, e do ponto de vista da lista os dois casos são idênticos. Por isso o renderer manda em `keep` os caminhos que está exibindo e o main devolve `ProjectTree.missing` — os que realmente **sumiram do disco**. A animação de destruição só toca para esses; inferir pela ausência na lista mostraria arquivos explodindo com eles ali, parados.
- **O balão tem vida própria, curta** (`SAY_*`): entra em 160ms, fica ~2,1s e apaga em 700ms subindo um pouco — desacoplado do `heat`. Amarrado ao calor (16s), sobravam três balões velhos estacionados sobre o mapa enquanto o agente já estava em outro arquivo. O verde responde *onde* o trabalho aconteceu e deve durar; o texto é *o que* está sendo feito agora, e é passageiro.
- **Etapas no topo:** o `todoPlan` da conversa aparece numa faixa acima do mapa (concluídas riscadas, a atual pulsando), então dá pra ver *o plano* e *onde ele está pegando no código* na mesma tela. Clicar na faixa **minimiza** para uma pílula com a contagem e só as bolinhas — nesse estado o texto **sai do DOM** em vez de ser escondido por CSS, senão continuaria sendo lido por leitor de tela e achado pela busca da página.
- **Layout** (`projectGraph.ts`): os nós nascem numa **árvore radial** (cada pasta dona de um setor angular, dividido entre os filhos por peso da subárvore) e a física só **relaxa** esse arranjo. Semear aleatoriamente não funciona: com ~1200 nós vira um bolo denso, e a repulsão em grade só alcança células vizinhas — o bolo não tem como se abrir sozinho (foi exatamente o que aconteceu neste repo na primeira tentativa).
- **Duas armadilhas de física, ambas medidas neste repo:**
  1. A repulsão `700/d²` vira catapulta quando dois nós nascem quase no mesmo pixel. Medido: nós arremessados a **raio 5784** enquanto a massa real cabia em 400 — e o auto-enquadramento então emoldurava os foguetes e amassava o mapa num canto. Corrigido com piso na distância (`d² ≥ 64`) e teto na força; depois disso, os bounds caíram de ~8000 pra ~1000.
  2. Com piso na distância, dois nós **exatamente** sobrepostos ficam com força zero e nunca se separam — por isso a semeadura aplica um deslocamento determinístico derivado do hash do caminho.
- **Custo de desenho:** as arestas frias vão num **único `beginPath()`/`stroke()`**; um `stroke()` por aresta é o que derruba um grafo desse tamanho. Nós fora da viewport são pulados, e a física congela quando `alpha` decai (o grafo assenta e para de consumir CPU).
- **Rótulos:** pasta até profundidade 2 sempre nomeada (num painel estreito a escala fica bem abaixo de 0.35 e um mapa de bolinhas anônimas não diz *onde* o agente está) e **todo arquivo que o agente mexeu**, para sempre — o nome é metade da informação que o mapa existe pra dar. Os rótulos são desenhados **depois dos nós**, com desvio de colisão: arquivo marcado escolhe lugar primeiro e nome de pasta cede; quem não acha lugar em 3 tentativas fica de fora (a bolinha colorida continua lá). Enquanto um balão está aberto, o rótulo daquele nó some — o balão já traz o caminho.
- **Balões:** no máximo 3 (os mais quentes), texto limitado a 38 caracteres, com **desvio de colisão** — sem isso um balão cobre o outro e ainda tapa o nome de um terceiro nó.
- **Cor por tipo de ação** (`ACTION_COLORS` em `projectActivity.ts`): ler = azul, editar = âmbar, criar = verde, rodar = roxo, procurar = verde-água, web = amarelo, subagente = rosa, **erro = vermelho** (sobrepõe a cor da ferramenta). Vale para o nó, a linha da viagem, o balão e a legenda — que lista só as famílias presentes no passo selecionado. Antes era tudo verde: o mapa dizia "algo aconteceu aqui" sem dizer *o quê*.
- **Filtro por tipo de modificação:** a própria legenda é o filtro — cada família é um botão que liga/desliga (um segundo menu repetiria a mesma lista, e a cor ali já explica o que cada uma quer dizer). Desligada, aquela ação para de acender nó (`markFor` recebe um `allow`, e o nó passa a valer pela ação anterior que sobrou — ou apaga, se era a única), e também não desenha viagem nem balão. Some com o contador e persiste em `agentcode.pgraph.hidden-kinds.v1`. As famílias desligadas continuam listadas: sumir com o botão seria tirar o caminho de voltar atrás.
- **Filtro por mensagem enviada** (`ProjectFilters.tsx`): cada chamada carrega o `turnId` da mensagem do usuário que a originou (`fileTouches`), e `turnsOf()` monta a lista do seletor. Escolhendo uma mensagem, só os arquivos daquele turno acendem (`markFor(n, turnId)`) — é o que permite acompanhar etapa por etapa o que o agente fez em cada pedido. O vínculo é **derivado das mensagens**, não guardado à parte: as `tool-use` já são persistidas junto da conversa. Duas consequências: conversa **compactada** (mais de 15 dias — ver `compactOldConversations`) perde as chamadas e fica sem filtro, e mensagem que não gerou nenhuma ação não vira item.
- **Filtro por tipo de arquivo:** chips por extensão (`fileType()`), ordenados por frequência. Desligar um tipo tira aqueles arquivos do desenho (pasta nunca some, senão o galho ficaria solto). A escolha é salva em `agentcode.pgraph.hidden-types.v1` via `kvSet`, então sobrevive a reinício.
- Testes: `projectActivity.test.ts` (caminho/rótulo por ferramenta, agrupamento por turno, paleta, tipo de arquivo) e `projectGraph.test.ts` (montagem da árvore, rota da animação, determinismo, estabilidade da física, marcas por turno).

---

## Pasta de dados (cache) e SQLite

A persistência **por usuário** vive numa **pasta de cache** que o usuário escolhe na tela de Configurações. `src/main/store.ts` gerencia o banco **global** (config/UI/uso) usando o **SQLite embutido** do Node (`node:sqlite` — nenhuma dependência nativa/npm); `src/main/projectStore.ts` gerencia um banco **por projeto** só para as conversas (ver [Conversas, projetos e persistência](#conversas-projetos-e-persistência) para o porquê e a migração).

**Layout:**

```
~/.agent-code/location.json      ← ponteiro: SÓ o caminho da pasta de cache
<escolhida>/agent-code/          ← pasta de cache (nome fixo = nome do projeto)
  ├─ agent-code.db               ← SQLite: tabela kv(key → JSON) — config do sistema
  │                                (API keys OpenAI/Ollama, "permitir tudo", token Android,
  │                                UI state, snapshot de uso); a chave antiga de
  │                                conversas (agentcode.conversations.v1) é APAGADA
  │                                daqui assim que a migração pro storage por
  │                                projeto termina — não fica como lixo morto
  ├─ agent-code.db.bak           ← cópia do banco antigo, feita uma vez, na 1ª
  │                                migração para o storage por projeto (só se havia
  │                                dado legado pra migrar) — essa cópia É o backup;
  │                                pode ser apagada manualmente quando o usuário
  │                                confirmar que a migração preservou tudo
  ├─ data/                       ← UM arquivo SQLite por projeto — só conversas
  │  ├─ <slug-do-projeto>-<hash8>.db    (slug = nome da pasta; hash8 = SHA-1 do
  │  ├─ <slug-do-projeto>-<hash8>.db     caminho ABSOLUTO — dois projetos de nome
  │  └─ sem-projeto.db                   igual em locais diferentes nunca colidem)
  └─ memories/                   ← arquivos .md da memória persistente (1 fato por arquivo)
     ├─ MEMORY.md                 ←   índice (1 bullet por memória) pré-carregado no system prompt
     └─ <slug>.md                 ←   um fato por arquivo
```

- **Ponteiro** — o único dado guardado fora da pasta de cache: `~/.agent-code/location.json` com `{ cacheDir }`. Nada mais é criado no home.
- **`initStore()`** roda no `app.whenReady()` antes de qualquer leitura de config: lê o ponteiro; no **primeiro uso** usa o padrão `Documentos/agent-code` e **migra** o antigo `settings.json` (de `userData`) para a chave `config` do banco global. É idempotente e as funções `kvGet`/`kvSet` chamam o init de forma preguiçosa, então a ordem de chamada não importa.
- **Trocar de pasta** (`setCacheDir`) — se o usuário escolhe uma pasta chamada `agent-code`, usa-a direto; senão cria uma subpasta `agent-code` dentro do local escolhido. Se já houver `.db`/memórias lá, **só carrega** (abre o banco existente sem apagar); a **pasta `data/` inteira** é movida junto com o resto (`moveAllContents`), então as conversas por projeto seguem a mudança de pasta. O ponteiro é reescrito.
- **`config.ts`** deixou de usar `settings.json` e passou a ler/gravar a chave `config` do SQLite global (mesma forma de `AppConfig`); o **token fixo do Android** (`remoteToken`) e as API keys da OpenAI/Ollama vivem aqui.
- **Conversas** vivem em `data/`, um banco por projeto — ver a seção seguinte. **Estado da UI e snapshot de uso** continuam no banco global (`storage.ts`, chaves `agentcode.ui.v1`/`agentcode.usage-limits.v1` via `kv:get`/`kv:set`), **migrando** o que houver no `localStorage` antigo na primeira leitura.
- **IPC:** `cache:get-info` (caminho atual), `cache:choose-dir` (diálogo nativo `openDirectory`+`createDirectory` → troca e recarrega), `kv:get`/`kv:set` (store key→JSON, config/UI/uso) e `conversations:load-all`/`conversations:save-all` (conversas, fanned out por projeto — ver abaixo). A tela `SettingsModal` mostra o caminho e o botão "Trocar…".

> Fase atual: **configs/API key/token, conversas (por projeto) e a memória persistente** já estão no disco da pasta de cache. Ver [Memória persistente](#memória-persistente).

---

## Memória persistente

O agente tem uma **memória de longo prazo por usuário**, em arquivos Markdown na pasta `memories/` da [pasta de cache](#pasta-de-dados-cache-e-sqlite) — privada por usuário/máquina e **persistente entre conversas**. A *mecânica* (onde fica, como salvar, como recall) é injetada no system prompt; o *conteúdo* é o que o agente acumula com o uso.

**Como é montada** (`buildMemoryHint(memoriesDir)` em `agentSession.ts`, chamado a cada `start()`):

- O texto da instrução **acompanha o projeto** (todo install se comporta igual), mas o **caminho** é resolvido em runtime via `getCacheInfo().memoriesDir`, porque é per-usuário/per-máquina.
- O índice `MEMORY.md` é **pré-carregado** (lido do disco e embutido no prompt), do mesmo jeito que o Claude Code expõe o seu — assim o modelo já "sabe" passivamente o que lembrou, sem precisar listar a pasta. Num install novo o índice vem vazio (`(no memories saved yet)`); se o arquivo não existir ou não for legível, é tratado como vazio.

**Convenção de gravação** (instruída ao agente):

- **Um fato por arquivo**, `<slug-curto>.md` dentro de `memories/`; e um índice `MEMORY.md` com um bullet por memória (`- [Título](arquivo.md) — gancho curto`).
- Antes de criar, conferir o índice e **atualizar** um arquivo existente do mesmo tema em vez de duplicar; apagar a memória (e o bullet) se virar falsa.
- **Não** salvar o que já é evidente do código, do histórico do git ou do `CLAUDE.md`.
- Disparado por pedidos do tipo "lembra disso", "salva na memória", "anota", "memorize", "remember this".

**Acesso ao disco** — a pasta fica fora do `cwd` do projeto, então `start()` a libera via `additionalDirectories: [memoriesDir]`; sem isso o limite do workspace bloquearia a leitura/escrita dos `.md`. As ferramentas de arquivo (`Read`/`Write`/`Glob`…) agem nela normalmente.

### Cofre de senhas e a opção de mandá-las no prompt

Chave, token ou senha que apareça numa memória é detectada, **redigida do texto** e guardada num cofre cifrado; a memória fica só com um marcador. O que o modelo recebe depende de um interruptor em **Configurações → Dados**, **desligado por padrão**.

- **Chave e senhas no MESMO arquivo**, `<pasta de dados>/vault/secret-vault.json` (`vaultKey.ts` + `secretVault.ts`, AES-256-GCM). Não é o `safeStorage` do sistema operacional, e não é o banco.
- **Por que juntos, e não a chave no banco:** os dois só valem em par. Em lugares diferentes, migrar leva um e deixa o outro — e senha cifrada sem chave é perda definitiva, não há recuperação. Num arquivo só, dentro da pasta de dados (do lado do `agent-code.db` e das memórias), **copiar a pasta leva tudo**, e uma corrupção do banco não alcança as senhas. Isso não é hipótese: o `agent-code.db` de um usuário real já corrompeu 3× em um mês (`agent-code.db.corrupt-*` na pasta dele).
- **O preço, aceito explicitamente pelo usuário:** quem tem o arquivo tem a chave. O que a criptografia entrega aqui é a senha nunca em texto puro no disco, em backup ou em sincronização — não proteção contra alguém com acesso à máquina.
- **GCM e não CBC:** o modo autentica, então arquivo adulterado falha na abertura em vez de devolver lixo silenciosamente. O IV é aleatório por gravação, então dois campos com a mesma senha não produzem o mesmo texto cifrado (senão dava para saber que são iguais sem abrir nenhum).
- **A chave vai em toda gravação do envelope.** `persist()` a reescreve sempre, inclusive ao **apagar** um segredo — a versão anterior regravava `{version:1, records}` e teria descartado a chave, transformando o resto do cofre em lixo cifrado.
- **Chave truncada/ilegível no arquivo não é substituída.** Gerar outra por cima tornaria todo segredo já salvo indecifrável em silêncio; o cofre falha e preserva o arquivo.
- **Nada é assíncrono no caminho da chave:** ela sai do próprio arquivo do cofre, lido de forma síncrona — o que elimina a antiga dependência de carregar a chave do banco antes de qualquer uso.
- **Espelho no banco: nenhuma senha se perde em migração** (`vaultMirror.ts`). O envelope inteiro (chave + segredos cifrados) é copiado para o KV a cada gravação, e **qualquer uma das duas cópias sozinha reabre tudo**:
  - levaram só o `agent-code.db` → na inicialização, `restoreVault()` reconstrói o arquivo a partir do espelho;
  - o `agent-code.db` corrompeu → o arquivo continua íntegro (já corrompeu 3× nesta máquina);
  - levaram a pasta inteira → as duas vão juntas.
- **A restauração nunca destrói o que já existe.** Arquivo íntegro vence o espelho (pode ter uma senha mais nova); arquivo ilegível é **movido para `.corrupt-<timestamp>`** antes de ser substituído, nunca sobrescrito. Espelho inválido é ignorado, e lixo nunca é espelhado por cima de uma cópia boa.
- **Apagar um segredo reespelha na hora** — sem isso, a próxima restauração ressuscitaria a senha apagada.
- Espelhar é redundância: falha ao gravar o espelho **não** derruba a gravação que já aconteceu no arquivo; a próxima tenta de novo.
- **O interruptor governa a entrega.** Ligado, `buildSecretsHint()` injeta as senhas **em texto puro no system prompt** de cada conversa nova. Isso é o que permite o agente usá-las — e significa que elas vão ao provedor do modelo e ficam no histórico da conversa. Vai no system prompt, e não anexado a cada mensagem, para a senha aparecer **uma vez por sessão** em vez de ser recopiada em todo turno.
- **Ligar vale só na sessão seguinte**, porque o system prompt já foi enviado — e não há como retirar da janela do modelo o que já entrou nela. Desligar também não apaga o que já foi enviado numa conversa anterior; a tela diz isso.
- Falha do cofre **não impede a conversa de abrir**: degrada para "sem senhas" e segue.
- A tela lista **só nome e data**, nunca o valor, e o único botão é apagar.

### Registro de tarefas — a fila do time de agentes

O objetivo maior do projeto é deixar de ter **um agente com contexto gigante** e passar a ter um **time coordenado de especialistas** (supervisor/tech lead que delega e cobra evidência, crítico, agente de memória, navegador de código). O primeiro subprojeto aprovado para isso é o **registro durável de tarefas** (`TaskLedger`, `src/main/tasks/`), no SQLite/PostgreSQL — não RabbitMQ — e a ferramenta MCP `tasks` é a **porta de entrada** dele para o modelo.

- **Tabelas**: `tasks`, `task_steps`, `task_deliverables`, `task_events` (migration 2 no SQLite, 4 no PostgreSQL). Toda mutação gera um `task_events`; no PostgreSQL, `task_events` alimenta o `change_log` para o outro PC enxergar.
- **Máquina de estados** (imposta pelo repositório, não pela ferramenta): `pending→running`; `running→blocked|review|failed|cancelled`; `blocked→running|cancelled`; `review→done|running|failed`; `failed→pending` só por retomada explícita e enquanto `attempts < max_attempts`. Fora disso é `TASK_INVALID_TRANSITION`.
- **Lease + fence**: `task_claim` pega a `pending` mais antiga sem lease vivo (`FOR UPDATE SKIP LOCKED` no PostgreSQL — duas instalações reivindicando juntas pegam tarefas diferentes) e devolve `lease_token` + `fencing_epoch`. Enquanto o lease vive, **toda escrita exige o fence**; fence velho ou ausente é `TASK_FENCE_STALE`. O lease impõe posse atual, não exactly-once de efeitos externos; e é por tarefa — não tranca recurso compartilhado por tarefas diferentes.
- **`review` e `blocked` SOLTAM o lease** (`LEASE_RELEASING_STATUSES`, maior que o conjunto dos terminais). O lease protege *um escritor ativo*; em `review` o executor já entregou e quem age é o crítico, em `blocked` ninguém está escrevendo. Enquanto só os estados terminais soltavam, o crítico — que é outro agente e nunca teve o fence — levava `TASK_FENCE_STALE` em `review → done` e a tarefa ficava **intransponível até o lease expirar**; com o TTL de 15 min isso trava o ciclo do time inteiro, e era pior justamente por causa do TTL maior. Depois do handoff as ferramentas da tarefa são chamadas **sem** `lease_token`/`fencing_epoch` — é assim que o crítico fecha. Reusar o fence velho é recusado, e a mensagem diz exatamente isso (dizer só "reivindique de novo" mandaria o crítico a um `task_claim` que nunca funciona, porque só tarefa `pending` é reivindicável).
- **O retrabalho volta pela fila, não por `review → running`.** Só `pending` é reivindicável, então mandar de volta para `running` deixa a tarefa **encalhada**: o subagente que a executou já terminou e ninguém consegue assumi-la. Quando quem vai refazer é um executor novo — o caso comum —, o crítico faz `review → failed` com o motivo e `failed → pending`; aí ela volta a ser distribuível e o orçamento de `attempts` (gasto a cada claim) é o anti-loop. `review → running` só serve para o mesmo executor vivo continuar na hora.
- **TTL do lease é 15 min, e cada escrita renova.** Era 60 s — e `assertTaskFence` rejeita lease expirado *do próprio dono*. Um modelo passa minutos entre duas chamadas (raciocínio, build, testes), então depois do primeiro minuto **toda** escrita voltava `TASK_FENCE_STALE`: o registro era inutilizável no uso real, e nenhum teste unitário pegava porque nenhum esperava 60 s. Agora a ferramenta renova o lease depois de cada escrita com fence que deu certo (`touch`, best-effort) — a prova de vida é o trabalho, não uma chamada de `task_renew_lease` que o modelo nunca lembraria de fazer. O TTL vira o silêncio máximo antes de outro agente poder assumir uma tarefa cujo executor morreu.
- **Claim é por projeto.** `claimTask` pegava a `pending` mais antiga de **qualquer** projeto: um supervisor no projeto A levava, em silêncio, trabalho do projeto B. `TaskClaimFilter` (`projectCwd`, `taskId`) entrou na interface e nos dois repositórios; `task_claim` filtra pelo projeto da conversa por padrão, e `task_id` atravessa o filtro — é como o subagente delegado pega **a sua** tarefa, e não uma qualquer.
- **Escopo de escrita imposto fora do LLM** (`writeScopeGuard.ts`). A definição do multi-agent pede que escopo e permissão sejam "determinísticos, fora do modelo": pedir "só mexa em `src/tasks`" é instrução, e instrução o modelo esquece. Quando esta sessão reivindica uma tarefa com `write_scope` (gancho `onClaim` do servidor MCP), o gate de permissão passa a recusar `Write`/`Edit`/`MultiEdit`/`NotebookEdit` fora do `allow` ou dentro do `deny` — **antes do `bypassAll`**: "Permitir tudo" é o usuário confiando no modelo, não o modelo dispensado do contrato da tarefa. A recusa volta como texto acionável (registrar `task_event` "blocker" e devolver a tarefa ao supervisor, que abre outra com o escopo certo). Solta nos mesmos estados em que o repositório solta o lease (`onRelease`) — escopo e posse morrem no mesmo instante.

  Duas amarrações que o tornam utilizável com subagentes: o escopo **vale só enquanto o lease vale** (`leaseExpiresAt`, reemitido a cada renovação pelo gancho `onHold`) — sem isso, um subagente que morre sem transicionar deixaria a sessão restrita **para sempre** e o supervisor nunca mais escreveria fora daquele escopo; e o escopo **pertence a quem reivindicou** (`holder`), lido do `agentID` que o SDK passa ao `canUseTool` (`undefined` = agente principal). Escopo do supervisor vale para todos; escopo de um subagente prende só aquele subagente — senão um executor trabalhando em `src/tasks/**` impediria o supervisor de escrever em qualquer outro lugar **enquanto delega**. O `agentID` não chega ao servidor MCP, então o gate o registra no instante em que autoriza o `task_claim`, imediatamente antes de a ferramenta rodar. Matcher de glob próprio (`**`, `*`, `?`; glob sem barra vale em qualquer pasta; pasta nomeada cobre os filhos); no Windows, sem diferenciar maiúscula.

  **`Bash` também passa pelo gate** (`bashWriteScan.ts`). Enquanto ele ficou de fora, o escopo era uma sugestão: bastava `echo x > outro/arquivo`. O scanner extrai os destinos que o comando grava — redirecionamento (`>`, `>>`, `2>`, inclusive colado no nome), `cp`/`mv`/`rsync` (o **último** operando, não a origem), `rm`/`rmdir`/`mkdir`/`touch`/`tee`/`ln`, `sed -i`, `dd of=` — e cada um passa pela mesma checagem de `allow`/`deny` do `Write`. Comando cujo destino **não dá para fixar** é recusado com o motivo, em vez de passar batido: alvo vindo de variável ou de substituição de comando, caminho relativo depois de um `cd` (a base deixou de ser o projeto — caminho absoluto continua conferível), `git checkout/restore/clean/apply/stash/merge/rebase` (mexem na árvore inteira e não declaram destino) e `eval`/`source`.

  **O que ele deliberadamente não é:** um sandbox. Interpretar shell por completo é indecidível, e qualquer interpretador (`python -c`, `node -e`) escreve onde quiser. O que o scanner **não** reconhece como escrita continua passando — e essa é a regra de falha certa: recusar todo comando não reconhecido tornaria impossível rodar teste, build ou `git status` sob uma tarefa com escopo, e uma trava que atrapalha o trabalho legítimo é desligada no primeiro dia. Ele fecha o caminho que de fato acontece — descuido e deriva —, e contra quem quer contornar vale o contrato do `TASKS_HINT`. Metade dos testes (`bashWriteScan.test.ts`) existe justamente para provar o que **não** pode ser confundido com escrita.
- **Protocolo do time** (`TASKS_HINT`): **supervisor** decompõe em tarefas com aceite verificável e `write_scope`, delega cada uma a um subagente pela ferramenta `Agent` passando o `task_id`, e não implementa o que delegou; **executor** reivindica por `task_id`, `running`, passos, evidência, `review` — nunca declara `done`; **crítico** (o supervisor ou um segundo subagente) confere cada critério contra os entregáveis (roda os testes se um `test_run` foi alegado) e fecha `done`, ou devolve pelo caminho certo conforme quem vai refazer (acima). Pedidos triviais não passam pelo registro.
- **Ferramentas** (`src/main/tasks/taskTools.ts`, servidor MCP `tasks`): `task_create`, `task_list`, `task_get`, `task_claim`, `task_renew_lease`, `task_transition`, `task_step_start`, `task_step_finish`, `task_deliverable_add`, `task_event`. Cada resposta é **texto em pt-BR que o modelo consegue agir em cima** — uma recusa por fence velho diz "reivindique de novo com task_claim", uma transição inválida aponta para `task_get`. Nunca um stack trace.
- **Só com repositório autoritativo**: `taskRuntime.ts` segue o `memoryRuntime` — o ciclo de vida do armazenamento publica o repositório ativo em toda troca de backend, e a sessão só registra o servidor MCP (e o `TASKS_HINT` no system prompt) quando o registro está ligado. Sem banco, a ferramenta aceitaria a tarefa e a perderia em silêncio.
- **Auto-aprovado** no gate de permissão (`mcp__tasks__`), como o `memory`: é contabilidade interna do time, só escreve no banco do próprio app, e as regras duras vivem no repositório — um modal aqui só ensinaria o usuário a clicar sem ler.
- **Evidência antes de "done"**: o hint instrui a registrar `task_deliverable_add` (diff, test_run, note, file, screenshot) antes de fechar. É o que o supervisor vai avaliar; "done" sem entregável é só uma afirmação.
- **Testes** (`taskTools.test.ts`) rodam contra um `SqliteRepository` **real**, de propósito: um dublê que aceitasse tudo provaria só que a ferramenta repassa argumentos, não que o modelo recebe uma recusa legível quando erra o fence ou a transição.

#### Cadastro de especialistas (`src/main/agents/specialists.ts`)

Supervisor, executor e crítico existiam só como texto de prompt: qualquer subagente nascia genérico e o protocolo dependia de o modelo lembrar. Agora `Options.agents` leva quatro papéis tipados, e o `TASKS_HINT` delega por nome (`subagent_type: "executor"` / `"critico"`).

- **`executor`** — reivindica pelo `task_id`, trabalha dentro do `write_scope`, registra evidência, entrega em `review`. Herda todas as ferramentas: ele implementa.
- **`critico`** — confere critério por critério contra os entregáveis e fecha ou devolve. **Não tem `Write` nem `Edit`**, de propósito: um crítico que conserta o que revisa vira o segundo executor. Tem `Bash` porque precisa rodar o teste que o entregável alega.
- **`navegador-de-codigo`** — só `Read`/`Glob`/`Grep`; responde onde algo está como `caminho:linha` sem gastar o contexto principal.
- **`memoria`** — consulta e propõe no acervo (`memory_propose`), sem duplicar.

Dois detalhes que não são acidentais: **não existe subagente "supervisor"** (quem supervisiona é a thread principal — um segundo dono da decomposição só brigaria com ela), e cada papel só é anunciado quando o serviço de que depende está no ar (executor/crítico exigem o registro; `memoria` exige o serviço de memória). Anunciar um crítico sem registro seria oferecer ao modelo um papel que falha na primeira chamada.

**A superfície de ferramentas é o contexto por especialidade.** Toda requisição carrega o schema de cada ferramenta exposta, então quem não implementa não recebe o harness inteiro: crítico, navegador e agente de memória têm listas explícitas — nenhum deles enxerga `mcp__browser`, `mcp__android`, `mcp__windows` ou `mcp__app`. O **executor herda** o resto, porque implementa tarefa arbitrária e uma lista de permitidos viraria uma corrida atrás do que faltou; mas duas famílias não pertencem ao papel em hipótese nenhuma e entram em `disallowedTools`: `mcp__windows` (dirigir OUTROS aplicativos não faz parte de implementar uma tarefa com escopo declarado, e é a permissão mais perigosa do app) e `mcp__app` (reiniciar o app é decisão de quem enxerga todas as conversas — um executor reiniciando mata o supervisor que o delegou, no meio do trabalho dos outros). O único lugar onde **adicionar** contexto paga é o crítico: ele já nasce com a skill `code-review` pré-carregada, em vez de inventar um método de revisão por tarefa.

> O que **não** está feito: selecionar *quais memórias e quais arquivos* cada especialista recebe. Isso depende de recuperação por relevância — a "busca semântica de memórias", que a spec também deixou para um subprojeto próprio.

Ficam em **código, e não em `.claude/agents/`**, porque `.claude/` é gitignorado neste projeto — foi por isso que o kit de skills passou a morar em `.agents/skills` com sincronização própria. Repetir aquela máquina para quatro definições estáticas seria custo sem retorno: aqui elas são versionadas, tipadas, testáveis e já vão no exe portátil sem passo de cópia.

#### O reaper: a primeira regra do time fora do modelo (`taskReaper.ts`)

Só tarefa `pending` é reivindicável. Um executor que some no meio do trabalho — subagente que estourou o turno, app fechado, PC suspenso — deixava a tarefa parada em `running` com lease vencido e **ninguém conseguia assumi-la**. O orçamento de `attempts` não salvava: ele só é gasto no claim, então a tarefa nunca voltava a ser distribuída. Sem isso o TTL do lease era só um número no banco.

A cada minuto o main procura tarefa em `running` com lease vencido há mais que `REAP_GRACE_MS` (5 min além dos 15 do TTL — folga para quem está voltando de um build longo) e a devolve por `running → failed → pending`, com o motivo no histórico e `agent: "app:reaper"`. O desvio por `failed` não é rodeio: `running → pending` não existe na máquina de estados, e é a passagem por `failed` que registra o porquê. **Sem tentativas restantes ela fica em `failed`** — redistribuir para sempre é o loop que o orçamento existe para cortar.

Não toca `review` nem `blocked`: ali o handoff foi deliberado e quem age é o crítico ou o supervisor. E não há como adiantar o relógio: o repositório avalia a validade do lease pelo relógio **dele**, então com lease ainda vivo a transição sem fence é recusada — foi o teste que revelou isso, e é o comportamento certo.

#### A fila na tela (`TasksBoard.tsx`)

O painel de agentes ganhou uma terceira visão, ao lado de Lista e Projeto, que lê o registro por dois canais novos (`tasks:board`, `tasks:detail`). Ela é **somente leitura**: a máquina de estados vive no repositório, e um botão aqui que movesse tarefa seria um segundo dono das mesmas regras.

O que ela mostra e a lista de subagentes não tem é justamente o que o registro sabe: **dono**, **lease**, **tentativas** e **evidência**. A ordem é por quem precisa de ação (revisão → executando → bloqueadas → fila), não por data. Estados terminais (`done`, `failed`, `cancelled`) aparecem por padrão para preservar o histórico; o chip **Terminadas** desliga esse recorte e pede apenas estados abertos. Os chips de estado restantes são filtros visuais locais: escondem cartões já carregados sem disparar nova consulta. "sem evidência" aparece em vermelho só onde a ausência é acionável (`review`/`done`) — em tarefa da fila seria acusação sobre trabalho que nem começou, então ali o contador é `null`, que significa "não contei" e não "zero".

A atualização continua em polling (5 s enquanto há trabalho, 30 s parado). Diferentemente do quadro de cartões, o registro de tarefas não tem um evento IPC/change-feed seguro que carregue o recorte correto de projeto e filtro; adicionar um evento incremental poderia perder snapshots e exibir uma fila velha. Por isso não há transição imediata: o polling é a rede de segurança autoritativa.

Um detalhe que só apareceu rodando: soltar o lease **não limpa o token**, o repositório grava `lease_expires_at = agora`. Então "expirado" sozinho não distingue handoff limpo de executor morto — quem distingue é o estado, e é por isso que `review` mostra "lease solto" e `running` mostra "lease expirado há X" em vermelho.

#### Identidade estável de projeto entre PCs (`projectScope.ts`)

`tasks.project_cwd` é o caminho **local**. No PostgreSQL compartilhado, o mesmo repositório clonado em `C:\GitHub\agent-code` e em `D:\dev\agent-code` parecia dois projetos: cada máquina só enxergava a própria fila, e a tarefa que um PC deixou pendente nunca era reivindicada pelo outro — justamente o cenário que o registro compartilhado existe para servir.

A identidade estável já existia para as conversas (`resolveProjectIdentity`: remote do git normalizado + commit raiz, com o nome da pasta como último recurso). Faltava o registro de tarefas usá-la, e o obstáculo era **onde guardá-la**.

**Por que uma tabela de mapeamento, e não uma coluna em `tasks`.** O primeiro instinto — `tasks.project_id` — esbarra num invariante do SQLite aqui: `sqliteRepository.ts` re-executa **o schema inteiro a cada escrita** como guarda idempotente (`db.exec(SQLITE_SCHEMA)`), e o SQLite não tem `ADD COLUMN IF NOT EXISTS`. Um `ALTER TABLE` numa migração passaria na primeira vez e quebraria **toda escrita** a partir da segunda; fazer certo exigiria separar "SQL de migração" de "SQL de guarda" no framework de persistência inteiro. `CREATE TABLE IF NOT EXISTS` é idempotente por construção e atravessa a guarda sem tocar em nada disso — por isso a solução é a tabela `task_project_identity` (migration 4 no SQLite, 6 no PostgreSQL), e não a coluna.

Como funciona: cada PC **grava a própria linha** (`project_cwd` local → `project_id` estável) e **lê os irmãos** (todos os caminhos sob o mesmo `project_id`). Nenhuma máquina precisa conhecer o caminho da outra de antemão. `TaskQuery.projectCwds` e `TaskClaimFilter.projectCwds` recebem essa lista e **vencem** o `projectCwd` único; lista vazia significa "nenhum projeto" e não devolve nada — o oposto seria vazar a fila de outro projeto, que é o bug que o filtro existe para impedir.

Três decisões que sustentam isso:

- **Cache de 60 s** (`PROJECT_SCOPE_TTL_MS`). `resolveProjectIdentity` roda `git` como processo externo e o painel consulta em poll; a lista só muda quando **outro PC aparece**, então esperar um minuto por isso é barato e pagar `git rev-list` a cada 6 s não é.
- **Degrada para o caminho local, nunca lança.** Pasta que sumiu, git ausente, banco fora do ar: volta a valer só o `projectCwd` — "vejo menos" é o lado certo de errar.
- **Sem gatilho de change feed.** Ninguém precisa ser acordado quando outro PC registra o caminho dele; a leitura acontece sob demanda, no claim e no painel.

> O `TaskLedger` foi removido por engano num passo anterior por "não ter consumidor"; ele **não tinha consumidor porque este era o próximo passo**. Fundação antes do consumidor não é código morto.

#### O que está no ar e o que falta (medido em 12/09/2026)

A infraestrutura do time está ligada; o **protocolo** ainda não foi exercitado em trabalho real. A distinção importa: teste unitário prova a regra do repositório, não prova que o modelo segue o combinado.

**Observado em runtime** (não inferido do código):

- **Os quatro especialistas são tipos reais de subagente.** Depois que o app recarregou com o commit, `executor`, `critico`, `memoria` e `navegador-de-codigo` passaram a aparecer na lista de agentes do harness — isso é o `Options.agents` valendo em runtime, não só o cadastro compilando.
- **O registro responde com repositório autoritativo.** `task_list` devolve "nenhuma tarefa nesses estados" em vez de erro. Sem banco, o servidor MCP `tasks` nem chega a ser registrado (`agentSession.ts` só o monta `if (ledger)`), então a resposta vazia **é** a prova de que ele está ligado.

**Entregue e coberto por teste, mas ainda não visto rodando:** o reaper (sobe com o armazenamento — `startTaskReaper` só é chamado sob `storageAvailable`), a terceira visão do painel e a gravação/leitura da identidade de projeto. Nada aqui é suposição sobre o código; é que ninguém observou o comportamento na tela ou em produção.

**O protocolo rodou numa tarefa real** (12/09/2026) — e é isso que separa "implementado" de "funciona".

A tarefa foi o próprio item 3 desta lista (a suíte PostgreSQL que ninguém rodava). Ciclo completo em uma tentativa: supervisor cria com aceite verificável e `write_scope` → executor reivindica **pelo `task_id`** (que atravessa o filtro de projeto) → passos → entregáveis → `review` → crítico confere e fecha `done`. O crítico **reexecutou** cada número alegado em vez de aceitar o relatório; o executor respeitou o escopo e registrou um `blocker` como `note` em vez de escrever fora dele. Nada do protocolo foi contornado.

O que só apareceu no uso real:

- **`task_get` mentia sobre o lease depois do handoff.** Soltar o lease não limpa o token (o repositório grava `lease_expires_at = agora`), e o ramo era binário: token presente → "vivo até \<data já vencida\>, escritas exigem o fence". O crítico é justamente quem lê isso primeiro, nunca teve fence, e concluiria que precisa de um — parando numa tarefa que ele consegue fechar. O painel já separava os três casos; o texto que o modelo lê não. Corrigido em `describeLeaseLine` (vivo / solto no handoff / expirado), com teste que falha se o ramo binário voltar.
- **O TTL de 15 min não distingue executor morto de build longo.** A renovação automática é a escrita com fence (`touch`), e durante uma suíte pesada não há escrita nenhuma — o executor precisou de `task_renew_lease` manual no meio. Funciona, mas depende de o modelo lembrar; o mesmo motivo pelo qual o `touch` existe. Não foi mexido: o conserto certo (renovar enquanto uma ferramenta longa está em voo) é maior que o problema observado, e o reaper ainda tem os 5 min de folga por cima.
- **Escopo de escrita tem efeito colateral de inventário.** `docs/REFERENCIA.md` não estava no `write_scope`, então o script novo nasceu fora do inventário que se declara completo. É o comportamento certo do gate — mas quem decompõe precisa lembrar que documentar a mudança também é escrita.

**Ligado, mas ainda não visto:**

- **O gate de escopo não chegou a recusar nada** nesta rodada: o executor trabalhou dentro do escopo do começo ao fim. A recusa continua provada só em unidade.
- **O reaper nunca foi visto agindo**: precisa de um lease morto há mais de 20 min (15 de TTL + 5 de folga), e nenhum executor foi abandonado até agora.

**Falta fazer:**

1. **Selecionar quais memórias e quais arquivos cada especialista recebe.** Hoje "contexto por especialidade" é só a superfície de ferramentas. O resto depende de recuperação por relevância — a busca semântica de memórias, que a spec deixou como subprojeto próprio. É o maior item aberto do multi-agent.
2. **Histórico completo em `task_get`.** Os eventos são truncados com "(N anteriores omitidos)" e não há como paginar. Não atrapalhou aqui porque os entregáveis bastaram, mas numa disputa sobre *quando* o executor decidiu algo, o crítico não tem como puxar a trilha inteira.

> **O teste que ficou quebrado por dois commits.** `taskLedger.test.ts` reusava o fence depois de `review`, que passou a **soltar** o lease em `5b6250a`. O código estava certo e o teste é que mentia; ele nunca acusou porque o caminho PostgreSQL fica desligado por padrão. Corrigido em `abe0530` — agora ele prova a recusa **e** fecha sem fence, como o crítico faz de verdade. O caso equivalente no SQLite (`review → done` sem fence) já estava certo, então o contrato nunca esteve sem cobertura: o que faltava era a cobertura **rodar**.
>
> Hoje ela roda com **um comando**: `npm run test:pg` sobe o container, espera o Postgres aceitar conexão, roda os cinco arquivos em série e derruba o container inclusive quando o teste falha — órfão segurando a porta é o que faz a execução seguinte falhar sem motivo aparente. Um ritual de três passos documentado é um ritual que ninguém executa; foi essa a lição, e ela virou a primeira tarefa real da fila.

**Adoção do acervo já existente** — quando o banco vira a autoridade da memória, um acervo que já estava em disco precisa entrar nele. `configureMemoryRuntime` dispara um `reconcile()` a cada ligação de repositório (`memoryRuntime.ts`), então a adoção acontece na inicialização e em toda troca de backend.

A alternativa era esperar o `reconcile` que o `memory_propose` já provoca — e isso deixava o acervo **invisível ao banco até um agente por acaso salvar algo**. Medido num acervo real de 162 memórias: os arquivos estavam lá e o banco vazio.

O que a adoção faz e o que ela deliberadamente não faz:

- **Importa** todo `.md` que existe em disco e não no banco, recursivamente (subpasta de agrupamento incluída). Título e gancho vêm do bullet curado do `MEMORY.md` quando o caminho casa; só quando não casa é que são derivados do corpo.
- **Não reescreve corpo.** Arquivo cujo conteúdo divergiu do banco é **preservado e reportado** como conflito, nunca sobrescrito nem importado por cima.
- **Não apaga nada** para "ficar igual" a um banco vazio. Remoção só acontece por entrada marcada como retirada no banco.
- O único arquivo regenerado é o `MEMORY.md`, e o original vai antes para `.memory-legacy-index.md`. Os títulos de seção escritos à mão são capturados no journal e sobrevivem; a ordem passa a ser alfabética por caminho.
- **Idempotente** — a segunda passada importa 0, então religar o repositório não duplica.
- **Não bloqueia o boot e nunca o derruba:** roda em segundo plano e só registra a falha. Importar memória se recupera na passada seguinte; abrir o app, não.

Validado contra uma **cópia** do acervo real antes de rodar no original: 162 importadas, 0 conflitos, 0 corpos alterados, 162 bullets no índice antes e depois, as duas seções preservadas, backup do índice idêntico ao original, 2,4 s. Testes em `memoryRuntime.test.ts`.

> A pasta é sincronizada por OneDrive na máquina onde isso foi medido, e o serviço **não** protege contra um segundo escritor mexendo nos arquivos ao mesmo tempo. Backup antes de importar não é zelo excessivo.

> Como o código do main agora puxa `node:sqlite` (via `config → store`), o teste `agentSession.test.ts` roda no ambiente **node** (`// @vitest-environment node`) em vez do `jsdom` padrão (que não externaliza o builtin `node:sqlite` e tentaria empacotá-lo).

---

## Conversas, projetos e persistência

O estado central vive em `src/renderer/src/App.tsx`.

**Modelo** — uma lista de `Conversation` (ver [REFERENCIA.md](REFERENCIA.md#tipos-de-dados)) e um `activeId`. Os **projetos** da barra são derivados (memoizados) agrupando as conversas por `cwd`; os **recentes** são as 15 conversas mais recentes por `updatedAt`.

**Sessões paralelas por conversa** — cada conversa tem a sua própria sessão de agente no main; elas rodam **em paralelo**, então trocar de conversa ou enviar em outra **não cancela** o que estava rodando. O renderer rastreia, em *Sets*, `connectedIds` (conversas com sessão viva) e `busyIds` (as que estão no meio de um turno), além de `permissions` (pedido pendente por conversa). *Refs* (`connectedRef`, `busyRef`, `activeIdRef`) mantêm o valor atual para o listener (registrado uma vez) e o caminho de envio assíncrono. `connect()` chama `agent:start` (com `cwd`, `model`, `skipPermissions`, `resume`) e **deduplica** chamadas concorrentes via `connectingRef` (um `Map` de promessas em voo), para dois envios simultâneos compartilharem **um** start em vez de recriar a sessão e perder mensagem.

**Fila de mensagens** — se o usuário envia algo enquanto o agente está **ocupado naquela conversa** (`busyIds.has(id)`), a mensagem **não** vai pro SDK (que a trataria como *steering*, cancelando/atrapalhando o turno): entra numa fila no renderer (`queue`). A próxima é despachada quando chega o `result` do turno (em `onEvent`); a conversa segue "ocupada" durante o *handoff*. A fila aparece acima do composer e cada item pode ser **removido** antes de enviar (`deleteQueued`). **Interromper** (botão ■) também limpa a fila daquela conversa. É descartada ao excluir a conversa; não é persistida. **Se a sessão cair com a fila cheia**, esses itens **não somem**: cada um vira uma bolha de usuário marcada com erro + "Tentar de novo" (o `id` da fila é reaproveitado como `id` da mensagem e o payload vai pro `failedRef`).

**Rascunho por conversa** — o texto digitado mas **não enviado** é guardado por conversa em `Conversation.draft`. O `Composer` mantém seu `value` local **sem** persistir a cada tecla (salvar em toda tecla cascateava um re-render do `App` inteiro a cada letra — lento ao digitar rápido); `onDraftChange(convId, text)` só é chamado em 4 pontos, sempre com o **`convId` explícito** (nunca "a conversa ativa agora" — evita gravar o rascunho na conversa errada numa troca):
- **Blur** do campo (o usuário clica em outra coisa);
- **Troca de conversa** com texto não salvo — o efeito que detecta `convIdRef.current !== props.convId` faz o *flush* do texto da conversa que está **saindo** antes de carregar o `draft` da nova;
- **Enviar mensagem** (`submit()`) — limpa a caixa **e** grava explicitamente o rascunho vazio, senão o texto já enviado reapareceria se o usuário voltasse a essa conversa depois;
- **A janela perder o foco** (`window` `blur`, ex. Alt+Tab) — rede de segurança para o caso do app fechar antes de qualquer blur do campo acontecer.

O `App` grava o `draft` na conversa (persistido no SQLite pelo *debounce* das conversas, com um *flush* extra no `beforeunload`). Assim, **trocar de conversa ou fechar/reabrir o app não perde o que estava digitado**, sem pagar o custo de salvar a cada tecla.

**Mensagem nunca se perde no erro + "Tentar de novo"** — a bolha do usuário é mostrada **na hora** (síncrono, antes de qualquer `await`). O `App` rastreia a mensagem **em voo** por conversa (`inflightRef`). Se o turno falhar — `kind:'error'` (erro fatal da sessão) ou um `result` com `isError` que **não** veio de uma interrupção do próprio usuário (rastreada em `interruptedRef`, setada por `interrupt`/`stopSession`) — a bolha recebe `UserMessage.error` e o payload original (texto + anexos) é guardado em `failedRef`. A `MessageList` então mostra a linha de erro + botão **"↻ Tentar de novo"** → `retryMessage(convId, msgId)` reenvia o **mesmo** payload sem criar bolha nova (reconecta se preciso). Se nem chegou a enviar (falha no `connect`/`agent:send`), o `catch` do `dispatch` faz o mesmo. O `error` é persistido com a conversa, então após reabrir o app a mensagem continua lá com o retry (que reenvia o texto; anexos só dentro da mesma sessão, via `failedRef` em memória).

**O que o Stop para, fica parado** — duas coisas faziam o botão "não parar". (1) Um Stop costuma render **dois eventos terminais** (o `result` do CLI e o `error` do fim do stream) e o `interruptedRef` era **consumido** no primeiro (`delete`): o segundo passava por falha genuína, a recuperação automática entrava e **reenviava sozinho** o turno que o usuário acabara de parar. Agora a marca é **consultada** (`has`) e só cai quando começa um turno novo — no despacho de `sendMessage`/reenvio, ou, quando o turno novo **não** veio do app (uma mensagem que sobreviveu ao Stop), no mesmo ponto que religa `busy` ao ver atividade numa conversa ociosa. (2) O Stop pode pegar a mensagem **antes** de o turno começar: o SDK a descarta e nunca emite terminal nenhum — esperando por ele, a conversa ficava com o "…" e o botão vermelho para sempre. `goIdleAfterStop` desliga `busy`/`busySince`/`stalledSince`/`inflightRef` assim que o recibo volta **sem sobreviventes** (com sobreviventes o turno continua de verdade, e quem encerra é o `result` dele). Desligar cedo é seguro por causa do mesmo autocorretor: se o agente ainda estiver produzindo, a primeira atividade religa tudo.

**Indicadores de atividade** — o conjunto `busyIds` (passado à `Sidebar` e ao `ChatPanel`) governa a sinalização visual de processamento: na barra lateral, a conversa em execução troca o ícone de chat por um **anel girando** (estilo Windows) e o projeto que tem qualquer conversa ocupada gira no lugar do ícone de pasta; no topo do chat ativo, uma faixa **"Claude está trabalhando…"** (anel + reticências animadas + barra varrendo a borda) aparece enquanto `busy`. A criação de novas conversas saiu do botão fixo no topo da barra para um **"+" ao lado de cada projeto** (`onNewChatIn(path)` → `createConversation`, herdando o modelo já usado naquele `cwd`).

**Hierarquia visual projeto → conversas** — um projeto **aberto** vira um "painel" visível (`.project-item.open`: fundo + borda, `var(--bg-2)`/`var(--line)`), deixando claro que as conversas abaixo estão **contidas** nele, não só indentadas; cada conversa aninhada ganha um **conector em árvore** (`.conv-row.nested::before`/`::after`: uma guia vertical contínua ligada ao ícone da pasta, com um "cotovelo" arredondado em cada linha — a última da lista não estende a guia pra baixo). Fechado, o projeto volta a ficar flat, sem painel nem linhas soltas.

**Ícone do projeto** — depois que os projetos aparecem na barra, o `App` pede uma vez por pasta o `app:project-icon` e, havendo um ícone lá dentro, ele substitui o glifo de pasta ao lado do nome (e no trilho recolhido). O acerto é por **convenção** (ver `projectIcon.ts` em [REFERENCIA.md](REFERENCIA.md#srcmain--processo-principal)): não existe manifesto para ler, e errar para o lado de "não achei" só devolve o glifo de sempre. Dois detalhes sustentam isso: a busca **não é cancelada no cleanup** do efeito (a lista re-renderiza enquanto as conversas chegam em lotes, e um `alive = false` abortaria a consulta em voo com o caminho já marcado como pedido — o ícone nunca chegaria), e uma imagem que não decodifica volta ao glifo (`ProjectGlyph`), porque um quadrado de imagem quebrada na barra é pior que ícone nenhum.

**Recolher todos e busca que filtra a árvore** — o cabeçalho **Projetos** tem um botão que recolhe/expande **todos** de uma vez (`allCollapsed` = todo projeto em `collapsedProjects`; o título alterna entre "Recolher todos os projetos"/"Expandir todos os projetos"). O padrão é tudo expandido — `collapsedProjects` guarda só o que o usuário fechou à mão. A **busca** (campo no topo, `query`) **filtra a própria árvore** em vez de virar uma lista de resultados separada: projeto cujo **nome** casa mantém todas as suas conversas; nos outros, ficam só as conversas que casam por **título ou prompt** (com o trecho do prompt exibido sob o título). Com busca ativa, todo projeto visível é renderizado aberto (`open = q ? true : !collapsedProjects.has(path)`), então o recolhimento manual não esconde um resultado. A comparação é *case*- e acento-insensível (mesmo `norm` do padrão global de busca — "selênio" acha "selenio" e vice-versa).

**Permissões por conversa** — cada pedido de ferramenta fica em `permissions[convId]`; o modal só renderiza o da **conversa ativa**. Se um pedido chega para uma conversa **em segundo plano**, um toast avisa que aquele chat está aguardando (senão a sessão dele congelaria sem o usuário perceber). "Permitir tudo" aplica `setBypass` a **todas** as sessões vivas (interruptor global).

**Permissões/perguntas também no celular** — `permissions[c.id]` vira o campo `permission` no snapshot publicado por `publishRemoteState` (mesmo padrão do `recovery`), então `/api/state` já entrega o pedido pendente pro celular sem canal SSE novo. O celular responde via `POST /api/permission-respond` (`smartfone-remote/www/app.js`, `renderPermission()`), que cai em `RemoteServer.onPermissionResponse` → `remote:permission-response` → o `App.tsx` chama o mesmo `respondToPermission` que o desktop usa, então **qualquer um dos dois lados que responder primeiro fecha o modal do outro** (extraído de `respond`/`answerQuestion`, agora parametrizado por `convId` em vez de fixo em `activeId`).

**Roteamento de eventos** — cada evento chega ao renderer como `AgentEventMsg` (`{ convId, event }`); `onEvent` aplica o `ChatEvent` à conversa indicada pelo `convId` (não à ativa), então respostas vão para a conversa certa mesmo com várias rodando ao mesmo tempo. `reduceMessages` é um reducer puro que:

- atualiza o texto ao vivo do assistente (mesmo `id`),
- anexa o `result` a um `tool-use` existente,
- marca a última fala como "resposta" no `result`,
- e dedup­lica a nota de "sessão pronta".

**Persistência** (`src/renderer/src/storage.ts`) — **assíncrona**, backed pela [pasta de cache](#pasta-de-dados-cache-e-sqlite), não mais no `localStorage`:

- **Conversas** — na abertura, `App.tsx` busca apenas as **6 conversas vivas mais recentes por projeto** (`updated_at DESC`, `id` como desempate), via `loadVersionedConversations({ perProject: 6 })`; SQLite e PostgreSQL fazem a paginação no banco com `ROW_NUMBER()` e tombstones não ocupam vagas. Em paralelo, `countConversationsByProject()` fornece o total real por `cwd`, que a Sidebar mostra separado da quantidade carregada. O botão discreto **"Mostrar mais N"**, abaixo da última conversa do projeto, chama `loadVersionedConversations({ cwd })` e faz o merge por ID para carregar o restante sob demanda. Consultas de CAS/change feed usam `{ ids, includeDeleted: true }`, sem reintroduzir leitura integral. O salvamento por registro não interpreta a ausência de uma conversa não carregada como exclusão.
  - O contrato legado sem query continua disponível para operações que realmente precisam de todas as conversas; por baixo, os bancos ficam agrupados por `cwd` em `data/<projeto>-<hash>.db`.
  - **Carregar tudo** = abrir todo `.db` de `data/` e concatenar as conversas de cada um — usado apenas onde o contrato legado exige o conjunto completo.
  - **Salvar** = agrupar a lista completa por projeto, regravar o arquivo de cada projeto presente e **apagar** o arquivo de qualquer projeto que não apareça mais na lista (todas as conversas dele foram excluídas) — evita "fantasmas" ressurgindo num load futuro.
  - **Migração automática, uma única vez:** a primeira vez que `data/` não existe ainda, o antigo blob único (chave `agentcode.conversations.v1`, no SQLite global) é lido, um **backup do banco inteiro** (`agent-code.db.bak`) é feito, as conversas são divididas por projeto e **a chave antiga é apagada** do banco global — o `.bak` é o backup de verdade, não uma chave morta guardada pra sempre dentro do banco que continua em uso (a versão inicial deste recurso fazia isso, e um usuário real acumulou dezenas de MB de lixo morto no `agent-code.db` até ser limpo manualmente).
  - `saveConversations` continua fazendo o **debounce de 400ms** (o streaming muda o estado muitas vezes por segundo) e descartando o campo `images` ao persistir.
- `agentcode.ui.v1` — `{ collapsed, activeId, browserMinimized, browserWidth }` — continua no banco **global** (`kv:get`/`kv:set`), não migrou para os bancos por projeto (não é dado de projeto).
- **Migração do `localStorage`** (herdada de instalações bem antigas, anteriores até ao SQLite) — na primeira leitura de cada chave, se não houver dado algum (nem no SQLite global, nem em nenhum banco de projeto), o valor antigo do `localStorage` é copiado (e mantido como backup inofensivo, nunca reconsultado depois — evitar isso é o que garante que uma conversa **de verdade** apagada não "ressuscite" de um `localStorage` velho). A hidratação do `App` virou `async` (carrega em paralelo e só então marca `hydrated`, que evita sobrescrever antes de carregar).
- As **configs do sistema** (API keys OpenAI/Ollama, "permitir tudo", token do Android) ficam na chave `config` do banco global (`config.ts` → `store.ts`), não mais no `settings.json`.

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

**Envio de imagens** — botão 🖼, **colar** (`onPaste`) ou **arrastar** (`onDrop`) lê os arquivos no renderer via `FileReader` (data URL → base64) e os guarda como `ImageAttachment[]` (`{ mediaType, data }`) com miniaturas. No envio, `sendMessage` passa as imagens por `agent:send`; `AgentSession.send` monta um **array de blocos** (`{ type: 'image', source: { type: 'base64', media_type, data } }` + bloco de texto) em vez de uma string. As miniaturas aparecem na bolha do usuário, mas **não são persistidas** (descartadas em `saveConversations` — são grandes e só valem durante a sessão).

**Anexar qualquer arquivo** — além de imagens, o composer aceita **qualquer arquivo** (Excel, Word, PDF, txt, zip, código…) por colar/arrastar/botão. Arquivos não-imagem são **salvos em disco pelo main** (`src/main/attachments.ts`) e referenciados por **caminho** no texto enviado, para o agente abrir com suas próprias ferramentas (`Read`/etc.); cada anexo vira um card colorido por tipo (badge + nome + tamanho) no composer e na bolha. Imagens seguem indo como blocos base64 (visão do modelo).

**Ícones** — a UI usa ícones **SVG de linha** (`src/renderer/src/components/Icons.tsx`) no lugar de emojis/símbolos na topbar, abas, composer e navegador.

**Baixar arquivo gerado** — um `tool_use` de **`Write`** cujo arquivo é um **entregável** (extensão em `DOWNLOADABLE_EXTS`: apk, zip, pdf, imagem, doc…) ganha um chip **"⬇️ Baixar"** no card; clicar chama `app:file-download`, que copia o arquivo para a pasta Downloads e o revela no Explorer. Ver [Baixar arquivos pelo chat](#baixar-arquivos-pelo-chat).

**Painel da direita: Navegador ⇄ Agentes** — os dois painéis ocupam o **mesmo slot** (`.right-pane`, largura = `browserWidth`, redimensionado pelo `splitter`), com uma barra de abas fixa no topo (`RightPaneTabs.tsx`: "Navegador" com a contagem de abas de preview, "Agentes" com o badge de subagentes em execução, e um botão de recolher). No `App.tsx`, `agentsOpen` é a aba selecionada e `browserMinimized` recolhe o painel inteiro; `selectRightPane(pane)` troca a aba e reabre. Recolhido, um trilho vertical (`.right-rail`) mostra um botão por aba, então qualquer uma volta com um clique. O botão de agentes na topbar e o link do composer só pré-selecionam a aba. `BrowserPanel`/`AgentsPanel` recebem `width` opcional — dentro do `.right-pane` quem dimensiona é o wrapper. O estado de recolhido persiste em `agentcode.ui.v1`.

---

## Baixar arquivos pelo chat

Dois caminhos levam um arquivo do agente até um botão **Baixar** na conversa (no PC **e** no app Android):

1. **Entregável criado por `Write`** — `MessageList` mostra o chip só em `Write` (criação) cujo `file_path` tem extensão entregável (`isDownloadableFile` / `DOWNLOADABLE_EXTS` em `src/shared/ipc.ts`). Código-fonte/config editado não ganha chip.
2. **Marcador `[[download:CAMINHO]]`** — para arquivos que **não** vieram de um `Write` (ex.: um APK compilado pelo Gradle via Bash), o agente emite o marcador no texto (orientado pelo `DOWNLOAD_HINT`). `parseDownloads(text)` remove o marcador do texto exibido e devolve os caminhos, que viram botões. Funciona em qualquer extensão (o agente declarou explicitamente).

**No PC** o clique chama `app:file-download` (`src/main/index.ts`): valida que é um arquivo, copia para `Downloads` (sem sobrescrever — acrescenta `(1)`, `(2)`…) e revela no Explorer.

**No celular** o botão aponta para `GET /api/file?path=…&token=…` da ponte LAN. O servidor só serve caminhos da **allowlist** do snapshot atual — arquivos criados por `Write` com extensão entregável **ou** expostos por um marcador `[[download:]]` numa mensagem do assistente (`downloadablePaths()` em `remoteServer.ts`) — e nunca um caminho arbitrário.

**No app instalado, o download é uma CHAMADA ao nativo, não uma navegação.** A versão anterior confiava só no `setDownloadListener` do WebView, e ele **nunca era alcançado**: medido no emulador, tocar em "Baixar" com um `<a download href="http://<pc>/api/file…">` fazia o Capacitor **externalizar** a navegação (host diferente do dele) — o toque **saía do app e abria o Chrome**, e nada chegava na pasta Downloads. O `MainActivity` (instalado pelo `buildApk.ts`) agora expõe um `@JavascriptInterface` **`AgentDownload.enqueue(url, nome)`**, e `triggerDownload` (`www/app.js`) o chama diretamente quando existe; sem navegação, não há o que ser sequestrado, e a URL vai direto para o **DownloadManager**, que salva em Downloads com notificação. O `DownloadListener` continua registrado só como rede de segurança para navegações internas, e o `<a download>` segue valendo no navegador comum (o cliente em `/app`).

A URL recebida pela ponte nativa **não é aceita por confiança**: só `http`/`https` terminando em `/api/file` é enfileirado, e o nome do arquivo é sanitizado — senão a interface viraria um downloader arbitrário para qualquer página carregada no WebView.

**A regra de "o que pode ser baixado" é uma só** (`src/main/downloadAllowlist.ts`), usada pela ponte **e** pelo desktop. Antes cada lado tinha a sua: a ponte filtrava por allowlist e o `app:file-download` do desktop copiava **qualquer** caminho que recebesse (achado da revisão adversarial). Dois critérios para a mesma pergunta é como um deles vira o frouxo sem ninguém notar.

- `downloadablesFromEvent` / `downloadablesFromMessages` aplicam as duas fontes de sempre (`Write` com extensão entregável, marcador `[[download:]]`) sobre um evento ao vivo ou sobre mensagens persistidas.
- `canonicalPath` normaliza e, **no Windows, compara sem diferenciar maiúscula** — caminho do Windows não diferencia, e um mismatch de caixa negaria o arquivo certo sem erro visível.
- A `DownloadAllowlist` do desktop é alimentada no **tee de eventos** do `index.ts`, não dentro da ponte: o download tem de ser autorizado com a ponte desligada, que é o caso comum.
- Caminho que o conjunto vivo não conhece **não é recusado de imediato** — pode vir de conversa restaurada do disco depois de reiniciar o app. Aí as conversas persistidas são varridas uma vez e o resultado fica em cache curto (`PERSISTED_TTL_MS`). A varredura é preguiçosa: custa uma leitura do banco e só acontece quando o usuário clica num download anterior a esta sessão.
- Falha do armazenamento **nega**, não libera: um download recusado o usuário refaz; um `allow` errado é justamente o que o módulo existe para impedir.

---

## Preview: abas (web + Android)

O painel da direita é **multi-aba**, **um por conversa** — o main mantém `Map<convId, BrowserController>` + `activeConvId` (a conversa exibida). `getBrowser(convId)` cria sob demanda; os *callbacks* (`onFrame`/`onState`/`onPicked`/`onAndroidProgress`) só repassam ao renderer quando `convId === activeConvId`. Trocar de conversa manda `browser:set-active` (→ `refreshView()`); excluir manda `browser:dispose`. A sessão do agente recebe `getBrowser(opts.convId)`, então as ferramentas agem no preview da própria conversa.

Cada aba é uma superfície de um **tipo** (`TabKind`): `web` (página do Chromium) ou `android` (tela de um device/emulador). `iphone` está **reservado** (nome + ícone existem; abrir retorna "não implementado"). `TAB_KINDS` (em `src/shared/ipc.ts`) é a fonte única de rótulo/ícone/implementado, e `tabName(tab)` gera o nome exibido **e visto pelo LLM**: `web - <site>` / `android - <app>`.

**Sempre há uma aba ativa** e toda ação age sobre ela. O `BrowserController` mantém `Map<id, Tab>` + `activeTabId`; só a ativa transmite frames (as outras seguem vivas em segundo plano). Um `Tab` tem `page` (web) **ou** `device` (android), nunca os dois.

**Barra de abas** (`BrowserTabs.tsx`) — cada aba com ícone (`TabIcon`: globo/robô/telefone) + nome + "×"; o **"+"** abre o **modal de nova aba** (`NewTabModal`, renderizado na raiz do app para **não ser cortado** pela barra, que rola horizontalmente — era esse o bug do antigo dropdown). O modal lista Web / Android / iPhone (reservado, desabilitado). Canais: `browser:new-tab`, `browser:select-tab`, `browser:close-tab`.

**O LLM controla as abas** — `browser_list_tabs`, `browser_new_tab`, `browser_select_tab`, `browser_close_tab`. O system prompt orienta a **reusar a aba atual** e só abrir outra quando precisar de uma página separada. Ao usar "Select", o `PickedElement` carrega `tabId`/`tabName`, então a mensagem informa de qual aba veio.

### Aba web

O preview roda um **Chrome de verdade** (`channel: 'chrome'`, com *fallback* para o Chromium do Playwright), **headed com a janela fora da tela** (`--window-position=-32000,-32000`) e **perfil persistente por conversa** (`launchPersistentContext`), então logins/sessões sobrevivem entre execuções. As flags de automação são removidas e `navigator.webdriver` fica oculto — sites param de bloquear como "robô". O contexto usa viewport 1280×800 e `deviceScaleFactor: 2` (texto nítido). Cada aba web tem sua **sessão CDP** + `Page.startScreencast` (JPEG, qualidade **90**); o handler só pinta se a aba for a ativa, e confirma com `screencastFrameAck`.

**`bringToFront()` ao criar/trocar de aba** — flags como `--disable-backgrounding-occluded-windows` evitam o *throttling* de **janela** ocluída, mas não impedem que o Chrome trate a página como uma **aba em segundo plano de verdade** dentro da própria janela (sujeita a *Memory Saver*/descarte). Sem isso, a aba que o app considera "ativa" podia silenciosamente perder estado entre chamadas de ferramenta, sem clique/navegação nenhuma. `openWebTab` e `selectTab` chamam `page.bringToFront()` (best-effort) sempre que uma aba web vira a ativa.

**Escondida da barra de tarefas do Windows** (`src/main/windowsTaskbar.ts`) — a janela do Chrome fica fora da tela, mas o Windows ainda lista qualquer janela de topo na taskbar independente da posição, e o Chrome não tem flag de linha de comando pra isso. `hideChromeWindowFromTaskbar(userDataDir)` roda **uma vez por conversa**, logo após `launchPersistentContext` (e antes de qualquer aba/screencast existir), via um script PowerShell embutido (sem dependência nativa nova): localiza o processo pelo `--user-data-dir` único do perfil e aplica `WS_EX_TOOLWINDOW` na janela. O Windows só "aceita" essa mudança com um ciclo **esconder → mudar o estilo → reexibir sem ativar** (`SW_HIDE`→`SetWindowLong`→`SW_SHOWNA`) — confirmado empiricamente (`windowsTaskbar.test.ts`, contra uma janela WinForms descartável, nunca a janela real do app). Por isso é chamado **antes** de qualquer captura começar: esconder/reexibir uma janela em plena transmissão poderia travar frames.

**Copiar/colar e seleção** — `Ctrl+C/V/X` usam o **clipboard do sistema**; arrastar o mouse (down/move/up separados) **seleciona texto**; demais combos de teclado passam direto para a página. A barra do navegador mostra um **spinner de carregamento** (com trava de segurança que evita girar pra sempre se o evento `load` não disparar). O **picker** é um init script (`PICKER_SCRIPT`, em `src/main/picker.ts`) adicionado **no contexto** (vale para todas as abas); o callback é exposto via `context.exposeBinding('__agentPick', …)`, então `source.page` identifica a aba do clique. A lógica de página (navegar, snapshot, screenshot, click, type, getText, evaluate, select-mode, input) vive em `src/main/pageActions.ts` (funções puras sobre uma `Page`); os tipos/constantes de aba ficam em `src/main/browserTabs.ts`. Assim o `browserController.ts` só orquestra abas.

`src/main/browserTools.ts` expõe, como **servidor MCP em processo**, as ferramentas de aba + `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_get_text`, `browser_evaluate`, `browser_back`, `browser_reload` (todas na aba ativa, esquemas `zod`).

---

## Preview Android (emulador + moldura de device)

A aba Android transmite a tela de um **device físico** (se conectado) ou do **emulador** (AVD padrão) via `adb`. Tudo em `src/main/android/`.

**Toolchain sob demanda** (`androidEnv.ts`) — `detect()` localiza JDK, Android SDK, `adb`, emulador, `sdkmanager`/`avdmanager` (no SDK do próprio app em `userData`, no `ANDROID_HOME`/`ANDROID_SDK_ROOT` ou no SDK do Android Studio). `ensureInstalled()` baixa o que falta com progresso — JDK 17 (Temurin), command-line tools, platform-tools, plataforma `android-34`, build-tools, emulador, system image — aceita licenças e cria um AVD padrão. É **idempotente** (só baixa o ausente) e fica cacheado no `userData` (baixa uma vez, reusa). O Electron é importado de forma preguiçosa para o módulo rodar também em Node puro (testes/scripts).

**Device ao vivo** (`androidDevice.ts`) — `ensureBooted()` sobe o device/emulador (com a flag **`-no-window`** — a interação é toda via `adb`/`screencap`, então a janela gráfica do próprio emulador nunca é usada, só aparecia como um ícone extra na barra de tarefas do Windows); `startStreaming()` empurra frames **PNG** (~6 fps) via `adb exec-out screencap`; toques/swipes/texto/teclas vão por `adb shell input` (coordenadas normalizadas 0–1 → pixels). `setScreenSize(w,h,dpi)` aplica `wm size`/`wm density` (e `resetScreenSize()` restaura); `screenSize` expõe o tamanho atual. `install()`/`launch()` instalam e abrem um APK. Ao fechar a aba: se o device já rodava (não foi o app que subiu), a resolução nativa é restaurada; um emulador que o app subiu é encerrado (`emu kill`). `androidTab.ts` isola o boot e o mapeamento de input do device.

**Moldura + modelos** (`src/shared/devices.ts`, `BrowserPanel.tsx`) — uma **tabela** de presets (telefones e tablets) com resolução (px) e densidade. A lista exibida é **deduplicada por resolução** (`uniqueByResolution`): quando vários aparelhos compartilham a mesma resolução, fica o **mais recente** (maior `year`). O preview começa como **Galaxy S26 Ultra** (`DEFAULT_DEVICE_ID`). O usuário escolhe num seletor ou usa **"Personalizado…"** (largura×altura). Selecionar chama `browser:set-android-size` → `AndroidDevice.setScreenSize`, então o emulador renderiza **naquele tamanho real**. A UI desenha uma **moldura de celular** (bezel arredondado, câmera *punch-hole* nos telefones; bezel fino nos tablets) dimensionada para caber no painel mantendo o aspecto do device.

**Fonte única de verdade** — o tamanho atual vai em `BrowserState.androidSize` (lido do device); a UI (seletor, moldura, status) é derivada disso. Por isso **mudar pelo dropdown ou pela tool do LLM dá no mesmo** — a moldura acompanha. O controller aplica o S26 Ultra ao abrir a aba.

**Frames com `mime`** — como Android transmite PNG e a web JPEG, `BrowserFrame` carrega `mime` (`image/png`|`image/jpeg`, default JPEG) e o `<canvas>` desenha com o tipo certo.

**Ferramentas do agente** (`androidTools.ts`, servidor MCP `android`): `android_setup`, `android_open_preview`, `android_build_apk` (`gradlew assembleDebug`), `android_install_run`, `android_screenshot`, `android_tap`, `android_swipe`, `android_type`, `android_key`, `android_list_devices`, `android_list_device_models` (deduplicada) e `android_set_device` (modelo por id **ou** resolução custom; abre o preview se preciso). O progresso do boot/instalação é transmitido pelo canal `browser:android-progress`.

---

## Controle remoto (Android ↔ PC)

Um celular pode dirigir as **mesmas sessões** do Claude Code que rodam no PC: ele envia comandos e o PC executa, devolvendo os eventos do agente ao vivo. É uma **ponte LAN** (mesma Wi‑Fi) em HTTP + Server‑Sent Events, sem dependências nativas, para um broker/relay poder substituí‑la depois.

**Acesso remoto multiusuário via BROKER (VPS) — sem senha de VPS.** Para distribuir o app a vários usuários (cada um no seu PC + celular) sem compartilhar senha da VPS, o PC **disca pra fora** por **WebSocket** pro **broker** na VPS, registrando-se pelo seu **token**. O celular conecta em `https://agent-code.larchertech.com/?token=XYZ` (sem mudança no celular); o broker lê o `?token=`, acha o PC com aquele token e faz o relay HTTP↔WS (incl. SSE em streaming). Caminho: `Celular → https://DOMINIO → Cloudflare → VPS:443 (Nginx) → broker 127.0.0.1:8099 → [WS de saída] → PC do usuário → RemoteServer`.

- **Broker** (`broker/`, Node + `ws`, Docker, **stateless**): HTTP (celular) + WS `/__relay` (PCs) na mesma porta. Mapa `token → conexão`. Frames JSON: `open/data/end/abort` (broker→PC) e `head/data/end/error` (PC→broker); a `url` mantém o `?token=` original (a **auth real do RemoteServer é preservada** ponta-a-ponta). Roteia por `?token=` com fallback em cookie `relay_token`. `RELAY_KEY` opcional (default vazio = relay aberto, roteado só pelo token). Um PC por token (registro novo substitui o antigo) → **isolamento**.
- **Desktop** (`src/main/remote/relayClient.ts`, `RelayClient`): WS de saída pro broker (`REMOTE_RELAY_WS` em `shared/ipc.ts`); para cada request relayada faz um `http.request` pro `127.0.0.1:<porta>` (reaproveita 100% o `RemoteServer`), devolvendo a resposta em frames. Reconecta com backoff. Liga/desliga junto com a **"Ligar ponte"** (`index.ts`); o status (`relayConnected` em `RemoteInfo`) aparece no `RemoteModal`. Token novo passou a `randomBytes(16)` (resistência a brute force); tokens já salvos continuam.
- **VPS:** `scripts/vps-remote-broker.sh` cria **um** site no `conf.d` proxiando pro broker (8099) com **upgrade de WebSocket** (map `$agentcode_conn_upgrade`) + SSE (`proxy_buffering off`, `proxy_read_timeout 3600s`); usa cert de **origem da Cloudflare** (`/etc/ssl/cloudflare/`) na 443 quando presente, senão 80 (Cloudflare "Flexible"); **valida `nginx -t` antes de recarregar** e desfaz se inválido. Substitui o antigo túnel SSH reverso (que só servia pra um usuário). O bridge já é amigável a proxy: SSE com **heartbeat de 25s** e `Cache-Control: no-transform`.

**Fora da rede: o que quebrava e como ficou.** Três defeitos faziam o celular "funcionar só na Wi‑Fi do PC":

1. **O celular ficava preso no endereço da LAN.** Pareado na mesma Wi‑Fi, ele passava a usar o `ip:porta` local e, ao sair da rede, o `scheduleReconnect` religava o SSE nesse mesmo endereço para sempre — só reavaliava LAN × VPS ao abrir o app. Agora **toda** reconexão (`scheduleReconnect`, duas falhas seguidas do `/api/state`, cada tentativa da tela de reconexão) passa por `repickBase()`/`pickBestBase()` e só religa o stream depois de uma chamada normal responder — que, ao contrário do `EventSource`, devolve um status legível. Toda chamada tem timeout duro (`fetchApi`, 12 s): um IP de LAN morto não segura mais a tela até o TCP desistir.
2. **Conexão PC↔broker meio‑aberta.** Depois de sleep/troca de Wi‑Fi o WebSocket ficava `OPEN` sem ninguém do outro lado: o broker seguia roteando para um PC ausente (o celular via requisições penduradas) e o PC mostrava "acesso remoto pronto". O broker agora rastreia `pong`/frames por PC (`lastSeen`) e **derruba quem fica mudo por mais de 70 s** (`sweep`, exportado para os testes), responde **504** quando o PC não começa a responder em 60 s e **413** acima de 32 MB. O `RelayClient` tem heartbeat próprio (`ping` JSON a cada 20 s, `DEAD_AFTER_MS` = 65 s sem sinal → derruba e reconecta), prazo para o `ready` do `hello` (15 s) e `kick()` — chamado no `powerMonitor` `resume`/`unlock-screen` do Electron, porque nesses momentos o socket antigo quase sempre está morto.
3. **Dois PCs com o mesmo token entravam em loop de roubo** no broker (o novo substituía o antigo, o antigo reconectava e roubava de volta). Agora **o primeiro PC vence**: o `hello` leva um `instanceId` (identidade por instalação, em `remote-pairing.json` no `userData` — nunca na pasta de dados sincronizável); outro PC com o mesmo token recebe `busy` e fica tentando devagar (`BUSY_RETRY_MS` = 30 s), assumindo só quando o dono cair. O **mesmo** PC reconectando (mesmo `instanceId`) substitui a conexão velha na hora. `RemoteInfo.relayState` (`connecting`/`connected`/`busy`/`denied`) aparece no `RemoteModal`.

**Um celular por PC.** Cada PC aceita um único celular. O celular manda um `dev` (id estável em `localStorage`) e `devname` em toda chamada; o primeiro a chamar fica pareado (`remote-pairing.json`), outro recebe **409** `another-device` e mostra a tela "Outro celular pareado" com **Usar este celular** (que chama `POST /api/pair` — o mesmo que escanear o QR/digitar o endereço faz, e que **toma o lugar** do anterior, fechando o SSE dele). A auto‑conexão ao abrir o app **nunca** toma o lugar de ninguém — só o gesto explícito. O `RemoteModal` mostra o celular pareado e tem **Desparear** (`remote:unpair`). Chamadas sem `dev` (clientes antigos) continuam aceitas; o token segue sendo a autenticação.

**Paridade do app do celular com o desktop** (rotas novas, todas com `?token=`): `POST /api/interrupt` (botão **Parar** na faixa "trabalhando…", que também vira **"Sem resposta há Xs"** pelo `stalledSince` do snapshot), `POST /api/set-mode` (chips **Econ.** / **Loop** / **Rápido** ao lado do modelo; `fastModeAvailable` esconde o terceiro), `POST /api/conversation` (`create` num projeto que o PC já conhece — "+" por projeto no drawer —, `rename`, `delete`), card do **plano de tarefas** (`todoPlan`), **uso da conta e contexto** em Configurações (`usage`, `tokens`, e o evento `rate-limit` ao vivo), anexos **de qualquer arquivo** (`files` no `/api/send`, salvos em disco pelo main como no composer), *thinking* recolhido, eventos de **subagente** e de plano filtrados do feed (como o `reduceMessages` do PC), contagem regressiva local na recuperação de turno. Do lado do PC, `onRemoteInterrupt`/`onRemoteSetMode`/`onRemoteConversationAction` chamam exatamente as funções dos botões do desktop (`interruptConv`, `changeEconomyMode`/`changeLoopEnabled`/`changeFastMode`, `createConversation`/`renameConversation`/`deleteConversation`).

No `RemoteModal`, o **QR sempre aponta para a URL pública** (`REMOTE_PUBLIC_HOST` em `shared/ipc.ts` + token via `buildPublicUrl`); a **URL local** (LAN) fica só como texto. O cliente do celular aceita qualquer URL (`parseConfig`).

**Servidor** (`src/main/remote/remoteServer.ts`) — `RemoteServer` sobe um `http.createServer` em `0.0.0.0:8765` (com *fallback* de porta se ocupada), usa um **token fixo** e descobre o IP da LAN. Rotas:

- `/` — landing com QR/instruções; `/download` — o APK gerado; `/app/` — o cliente web embutido (fallback no navegador; a **barra final importa**: os assets são relativos, então os links usam `/app/`).
- `/api/state` — lista de conversas (sem as mensagens, mas com `model`/`effort` de cada uma) + `voiceReady`, `skipPerms` e o **catálogo de modelos/esforços** (`models`, `modelEffort`, `effortLabels` — alimenta os seletores do celular); `/api/history?conv=ID` — histórico de uma conversa, **capado às últimas 30 mensagens** (`conv.messages.slice(-30)`, `RemoteServer.HISTORY_LIMIT` — conversas longas com muito tool-output ficavam pesadas numa conexão móvel; só o histórico da conversa que o usuário abriu é enviado, nunca o de outras em segundo plano); `/api/search?q=…` — busca nos prompts do usuário; `/api/events` — **SSE** com os eventos do agente ao vivo; `POST /api/send` — envia um comando (com imagens opcionais) para uma conversa; `POST /api/set-model` — troca modelo/esforço de uma conversa (`{convId, model?, effort?}` → dep `onSetModel` → `remote:set-model` → o renderer aplica via `changeModel`/`changeEffort`, com eco otimista no snapshot); `POST /api/skip-perms` — liga/desliga o "Permitir tudo" global; `POST /api/transcribe` / `POST /api/tts` — voz do celular (processada no PC); `/api/file?path=…` — faz **stream de um arquivo entregável** para download (allowlist, ver [Baixar arquivos pelo chat](#baixar-arquivos-pelo-chat)).
- Tudo em `/api/*` exige `?token=` (o mesmo do QR). CORS liberado para o WebView do Capacitor.

**Token fixo** — o token **não muda mais** a cada start: é gerado uma vez e persistido (`remoteToken` em `config`, no SQLite), reusado em todas as sessões — um celular pareado continua pareado entre reinícios. A ponte recebe `loadToken`/`saveToken` por dependência (em `index.ts`).

**Imagens do celular** — `POST /api/send` aceita `images` (base64); `sanitizeImages` valida (só `image/*`, máx. 8) e o limite do corpo subiu para ~24 MB. Elas chegam ao renderer por `remote:inbound` (`RemoteInboundMsg.images`) e são despachadas no mesmo caminho do composer.

**Fluxo** (em `src/main/index.ts`): o `RemoteServer` é criado com `onInbound` (um comando do celular → `remote:inbound` → o renderer despacha na conversa certa, como se fosse digitado; agora carrega `images` também), `onSetSkipPerms` (→ `remote:set-skip-perms`), `onSetModel` (→ `remote:set-model`), `transcribe`/`tts`/`voiceReady` (voz no celular, key da config), `apkPath`/`wwwDir`, `onClientsChanged` (→ `remote:clients`) e `loadToken`/`saveToken` (token fixo). Cada evento do agente é **tee‑ado**: além de ir ao renderer, `remote.broadcast(convId, event)` envia por SSE aos celulares. O renderer publica um **snapshot** das conversas por `remote:publish-state` (debounce 400ms) para a ponte servir o histórico e montar a allowlist de download. A UI do PC (`RemoteModal`) liga/desliga a ponte, mostra o QR/endereço/token (rotulado **"fixo"**) e a contagem de celulares, e gera o APK (`remote:build-apk` → `buildApk.ts`, progresso por `remote:build-progress`).

**Cliente do celular** (`smartfone-remote/`) — um app **Capacitor** cujo `www/` (`index.html` + `app.js` + `styles.css` + `jsqr.js`) é o cliente. Recursos:

- **Pareamento** por QR (câmera + jsQR) ou endereço/token manual; **auto-conecta** na última sessão ao abrir.
- **Conexão persistente** — auto-reconexão do SSE com *backoff* (faixa "reconectando…"), **wake lock** (mantém a tela/conexão ativa) e re-checagem ao voltar do *background* (`visibilitychange`/`focus`/`online`). Ao **conectar ou reconectar** (`es.onopen`), o chat da conversa ativa é **ressincronizado** (`loadHistory` silencioso, sem apagar as mensagens já na tela — só troca quando a resposta chega) — o histórico pode ter mudado enquanto o celular ficou offline.
- **Histórico** num drawer agrupado por projeto (espelha a sidebar do PC); abre uma conversa (`/api/history` + SSE) e envia comandos. As **permissões continuam sendo aprovadas no PC**. Abrir um chat (`selectConv`) mostra um **loading** ("Carregando mensagens…", spinner) no lugar da lista enquanto `/api/history` está em voo — some ao chegar ou dar erro; um contador de requisição (`historyReq`) garante que trocar de chat rápido nunca deixa uma resposta antiga sobrescrever a tela ou o spinner "grudado". **Pull-to-refresh**: puxar a lista a partir do topo (`scrollTop === 0`) mostra "Puxe para atualizar" → "Solte para atualizar" (limiar `PULL_THRESHOLD`) → "Atualizando…" ao soltar, e recarrega a conversa inteira — silencioso, mantém as mensagens visíveis durante o refresh (mesmo motivo do resync na reconexão: essas duas ações já têm sua própria barra de progresso, não usam o loading cheio de abrir um chat).
- **Envio de imagens** (galeria/colar/arrastar; redimensionadas e enviadas em base64).
- **Markdown** nas respostas do assistente (conversor próprio, sem dependência, seguro por HTML-escape) e **cards de ferramenta recolhidos/expansíveis** iguais ao chat do PC (verbo + arquivo + `+N`/`−N` + badge), com estado de expansão preservado entre re-renders.
- **Scroll corrigido** durante o streaming (preserva a posição quando o usuário rolou pra cima; sem `scroll-behavior: smooth` que causava tremor; renders agrupados por frame com `requestAnimationFrame`).
- **Download de arquivos** no chat (chip em `Write` entregável + marcador `[[download:]]`) via `/api/file` + `DownloadListener` nativo.
- **Trocar modelo/esforço** da conversa: barra `#model-bar` acima do composer com dois `<select>` nativos, preenchidos do catálogo do `/api/state` (`renderModelBar`); a troca envia `POST /api/set-model` (`setModel`, otimista — o poll de 4s reconcilia). O esforço some em modelo sem suporte (Ollama) e ambos desabilitam com a conversa ocupada. Dois cuidados de Android: o rebuild periódico é **pulado enquanto um seletor está focado** (senão o refresh fecharia o dropdown nativo no meio da escolha) e o handler de `change` chama **`blur()`** logo após escolher (o Android mantém o `<select>` focado depois que o dialog fecha — sem o blur, o guard travaria a reconciliação para sempre).

O `www/` é servido em `/app` (atualiza na hora) e empacotado no APK por `scripts/build-apk.mjs` (precisa **regerar o APK** para o app instalado pegar mudanças no `www/`). O `buildApk.ts` reaplica de forma idempotente as customizações nativas do diretório `android/` (gitignorado/regenerado): permissão de câmera, ícone adaptativo e o `MainActivity` com o `DownloadListener` + permissão de armazenamento.

---

## Skills (kit portátil)

O projeto versiona um **kit de skills** do Claude Code para que, ao clonar em outra máquina, elas funcionem sem reinstalar nada da internet.

- **Fonte da verdade:** `.agents/skills/<nome>/` (arquivos reais, versionados). O que veio do `npx skills add` fica registrado em `skills-lock.json` na raiz (hoje `3d-print-modeling`, `adversarial-review`, `brainstorming`, `copywriting`, `frontend-design`, `landing-page-design`); as demais foram escritas à mão ou copiadas do upstream e **não** entram no lockfile. `.claude/` segue **gitignorado**.
- **Persistência ativa:** na inicialização, `skillManager.ts` sincroniza as skills empacotadas de `.agents/skills/` para `<cacheDir>/skills/`. Skills externas adicionadas diretamente ao cache são preservadas. Ao trocar **Pasta de dados (cache)**, essa sincronização roda novamente no novo destino.
- **Ativação nativa — o que o CLI realmente lê (medido em 01/09/2026, SDK 0.3.278):** o Claude Code dirigido pelo Agent SDK, com `skills: 'all'` e `settingSources: ['user','project','local']`, descobre skills em `<cwd>/.claude/skills` e em `<dirAdicional>/.claude/skills` de cada entrada de `additionalDirectories` — e **não lê `~/.claude/skills`**. Foi verificado com quatro experimentos (home real com 14 skills, home falsa só com `caveman`+`rtk`, pasta adicional com `.claude/skills` real, pasta adicional com `.claude/skills` como junction): só os dois últimos carregaram. Por isso `skillManager.ensureNativeSkillRoot` cria **`<cacheDir>/native/.claude/skills` como junction para `<cacheDir>/skills`** e `agentSession` passa `<cacheDir>/native` em `additionalDirectories` — uma cópia só das skills, e o acesso extra do agente fica restrito a essa pasta. `exposeCacheSkills` continua materializando cópias reais em `%USERPROFILE%\.claude\skills\` (manifesto `.agent-code-managed.json`) para o `claude` interativo e SDKs antigos, mas as sessões do app não dependem mais disso.
- **Catálogo = só o que o SDK confirmou.** Antes de anunciar o `[SKILL_CATALOG_UPDATE]`, a sessão chama `reloadSkills()` e compara nomes. A regra antiga era tudo-ou-nada: **uma** skill esperada ausente (ex.: `graphify`, instalada só em `~/.claude/skills`) fazia o app injetar "nenhuma skill disponível", escondendo do modelo todo o kit — foi exatamente o que impedia o modo econômico de carregar `caveman`/`rtk`. Agora o catálogo anunciado é o descoberto **filtrado pelo que o SDK carregou**; a ausência é logada e só dispara nova recarga no próximo envio se a skill omitida vier do projeto ou do cache gerenciado (uma corrida com arquivo sendo escrito), nunca para skill só do usuário.
- **Kit atual (14):** `brainstorming` (design antes de implementar), `frontend-design` (direção visual), `copywriting` (copy de conversão), `ux-writing` (microcopy de interface), `landing-page-design` (estratégia de conversão — sem dependências externas), `adversarial-review` (revisão crítica multi-lente), `planejar` (execução guiada por tarefas — *Plan & Execute*), `code-review` (revisão de bugs de correção + oportunidades de reuse/simplificação/eficiência no diff atual), `loop` (repetir um prompt por intervalo ou com wakeup autogerido — ver o toggle **Loop**), `browser` (automação de navegador com snapshot), `3d-print-modeling` (peça imprimível como Python paramétrico), `skill-builder` (criar novas skills), **`caveman`** e **`rtk`** (as duas do modo econômico — ver abaixo).

### Modo econômico = caveman + rtk (não corta rigor)

O toggle **💰 Econômico** deixou de instruir o agente a pular typecheck/testes/validação — essa skill (`economy-mode`) foi **removida**. Com o toggle ligado, todos os recursos e todas as regras normais de qualidade continuam valendo integralmente; o `ECONOMY_HINT` (`agentSession.ts`) apenas manda o agente **carregar duas skills de compressão de tokens** e seguir as duas em paralelo:

- **`caveman`** (upstream `JuliusBrussee/caveman`, copiada à mão para `.agents/skills/caveman/`) comprime a **saída**: estilo terse, sem filler/pleonasmo/narração de tool-call, mantendo toda a substância técnica, código, números e strings de erro exatos. Ela própria manda largar o estilo em avisos de segurança, confirmação de ação irreversível e qualquer ponto onde a compressão criaria ambiguidade.
- **`rtk`** (skill própria deste projeto, escrita à mão) comprime a **entrada**: instrui a prefixar com `rtk` os comandos de Bash cobertos pelo proxy (`git`, `ls`, `grep`, `tsc`, `vitest`, `docker`, `find`, `diff`…), que roda o comando de verdade e devolve a saída condensada. **`rtk` não é uma skill upstream — é um binário Rust** (`rtk-ai/rtk`, release `x86_64-pc-windows-msvc`) instalado em `%LOCALAPPDATA%\Programs\rtk\rtk.exe` e adicionado ao PATH do usuário; a skill é só a regra de uso. Se o binário sumir, a skill manda seguir sem ele e avisar, nunca travar a tarefa.

Com o toggle **desligado**, nenhuma das duas skills é sugerida e o comportamento é o de sempre. A exclusividade com o toggle **Loop** não mudou.
- **`adversarial-review`** foi **adaptada** para spawnar **subagentes Claude nativos** (ferramenta Agent) em vez do CLI externo `codex exec --skip-git-repo-check` do upstream — funciona neste setup e sem o risco de rodar outro agente autônomo com trava desligada. As lentes (Skeptic/Architect/Minimalist), o dimensionamento e o formato de veredito ficam em `references/`.
- **`planejar`** é **própria deste projeto** (escrita à mão, **não** vem do `npx skills add` nem entra no `skills-lock.json`). Para tarefas **complexas** de código (tela/painel do zero, refatoração multi-arquivo, fluxo completo), ela obriga o agente a **planejar antes de codar**: cria `EXECUTION_PLAN.md` em `.claude/` (nunca na raiz — evita ir pro `git status` por engano) com o prompt original + tarefas atômicas em checkboxes, executa **uma por vez**, valida cada uma no terminal (checks do projeto, ex. `npm run typecheck`/`npm test`) **e** rodando o app (Passo 3.5 — UI ou backend) antes de marcar `[x]`, comita por tarefa (Passo 3.7), roda a skill **`code-review`** sobre o diff acumulado antes do commit final (Passo 5 — corrige o que ela achar antes de seguir; se o usuário pedir pra comitar antes da revisão, avisa explicitamente em vez de comitar calado), e fecha com auditoria contra o pedido original. A `description` dispara **auto-invocação** em tarefas complexas mesmo sem o usuário citá-la; tarefas **simples** são resolvidas direto, sem plano.
- **`code-review`** é **própria deste projeto** também (escrita à mão). Revisa o diff atual (por padrão `git diff` + arquivos novos relevantes) em duas frentes — **bugs de correção** (lógica, edge cases, tipos, race conditions) e **reuse/simplificação/eficiência** — com esforço configurável (`low`/`medium` = passe único, achados de alta confiança; `high`→`max` = subagentes paralelos revisando de ângulos diferentes; `ultra` = redireciona para o `/code-review ultra` multi-agente na nuvem, faturado, não é disparado pela skill). Reporta via `ReportFindings` (achados verificados, lista vazia é um resultado válido) e aceita `--fix` para aplicar as correções confirmadas. No app, o **composer tem um atalho** — botão de escudo (`IconShieldCheck`, ao lado do enviar) que chama `props.onSend('/code-review', [], [])` diretamente, sem precisar digitar.

---

## Contrato de IPC

Nomes em `src/shared/ipc.ts` (`Channels`). Tipos da API em `src/shared/api.ts`; ponte no preload.

### Renderer → Main (`ipcRenderer.invoke` / `ipcMain.handle`)

| Constante | Canal | Handler (main) | Payload |
|-----------|-------|----------------|---------|
| `pickDirectory` | `app:pick-directory` | abre `dialog.showOpenDialog` (pasta) | — → `string \| null` |
| `pickFile` | `app:pick-file` | abre `dialog.showOpenDialog` (arquivo) | — → `string \| null` |
| `pathExists` | `app:path-exists` | guarda da pasta do projeto: `fs.stat` + `isDirectory()` | `path` → `boolean` |
| `openInEditor` | `app:open-in-editor` | abre a pasta no VS Code (CLI `code`, com *fallback* `vscode://file/`) | `dir` → `{ ok, message }` |
| `openInFolder` | `app:open-in-folder` | abre a pasta do projeto no explorador do SO (`shell.openPath`) | `dir` → `{ ok, message }` |
| `mentionSearch` | `app:mention-search` | busca arquivos/pastas do projeto para o autocomplete "@" do composer | `root`, `query` → `MentionHit[]` |
| `listSkills` | `app:list-skills` | lista as skills disponíveis do projeto (menu "@") | `root` → `SkillInfo[]` |
| `projectTree` | `app:project-tree` | arquivos mais recentes do projeto para o **mapa** (+ pastas do caminho); `keep` = o que o mapa exibe hoje, para o retorno dizer quais foram **apagados** | `root`, `keep[]` → `ProjectTree` |
| `projectIcon` | `app:project-icon` | ícone achado por convenção dentro da pasta do projeto (`data:` URL) para a barra lateral; `null` quando não há | `root` → `string \| null` |
| `fileDownload` | `app:file-download` | copia um arquivo (entregável criado pelo agente) para Downloads e o revela no Explorer | `path` → `{ ok, message, saved? }` |
| `fileRead` / `fileReadBytes` | `app:file-read` / `app:file-read-bytes` | lê um arquivo como texto / bytes (visualizadores do renderer) | `path` → `string` / `FileBytes` |
| `configGet` / `configSet` | `config:get` / `config:set` | lê / grava a `AppConfig` persistida (Configurações) | — → `AppConfig` / `Partial<AppConfig>` |
| `openaiTranscribe` | `openai:transcribe` | transcreve áudio (base64) via OpenAI `gpt-4o-transcribe` (key no main) | `audioBase64`, `mimeType` → `{ ok, text?, error? }` |
| `openaiTts` | `openai:tts` | sintetiza fala (MP3 base64) de um texto via OpenAI `gpt-4o-mini-tts` | `text` → `{ ok, audioBase64?, mimeType?, error? }` |
| `authStatus` | `auth:status` | há login do Claude nesta máquina? (`claude auth status --json`) | — → `{ authenticated }` |
| `authLogin` | `auth:login` | dispara o login OAuth do Claude (abre o navegador do sistema) | — → `{ ok }` |
| `cacheGetInfo` | `cache:get-info` | caminho atual da pasta de dados (SQLite + memórias) | — → `CacheInfo` |
| `cacheChooseDir` | `cache:choose-dir` | diálogo nativo para escolher/trocar a pasta de dados e recarregar | — → `CacheInfo \| null` |
| `kvGet` / `kvSet` | `kv:get` / `kv:set` | lê/grava um valor (JSON) no store key→valor do SQLite global (config, UI, uso) | `key`(`, value`) → `string \| null` / — |
| `loadAllConversations` / `saveAllConversations` | `conversations:load-all` / `conversations:save-all` | lê/grava **todas** as conversas, um banco SQLite por projeto em `data/` (`projectStore.ts`) | — → `unknown[]` / `unknown[]` → — |
| `agentStart` | `agent:start` | substitui a sessão de `convId` em `sessions` (usa `getBrowser(convId)`) | `StartAgentOptions` `{ convId, cwd, model?, skipPermissions?, resume? }` |
| `agentSend` | `agent:send` | `sessions.get(convId).send(text, images)` | `convId`, `string`, `ImageAttachment[]?` |
| `agentInterrupt` | `agent:interrupt` | `sessions.get(convId).interrupt()` | `convId` |
| `agentSetBypass` | `agent:set-bypass` | `sessions.get(convId).setBypass(on)` | `convId`, `boolean` |
| `agentPermissionResponse` | `agent:permission-response` | `sessions.get(convId).resolvePermission(res)` | `convId`, `PermissionResponse` |
| `agentRefreshUsage` | `agent:refresh-usage` | força um poll do uso da conta (5h/semana) numa sessão conectada | `convId` |
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
| `planningList` | `planning:list` | slugs dos planos de `<cwd>/docs/spec/` (só pastas com `_roteiro.md`) — `planningIpc.ts` | `{ projectCwd }` → `PlanningResult<{ slugs }>` |
| `planningCreate` | `planning:create` | cria `docs/spec/<slug>/` (roteiro rev 1, `_canvas.json`, `cards/`, `_sandbox/` + linha no `.gitignore`); recusa plano que já existe | `PlanningRef` + `titulo` → `PlanningResult<{ plan }>` |
| `planningOpen` | `planning:open` | abre o plano e passa a vigiá-lo (idempotente por janela: reabrir para recarregar não infla a contagem do vigia) | `PlanningRef` → `PlanningResult<{ plan: OpenedPlanningDto }>` |
| `planningClose` | `planning:close` | solta a vigia aberta por esta janela (não exige a pasta existir) | `PlanningRef` → `PlanningResult` |
| `planningSaveCard` / `planningDeleteCard` | `planning:saveCard` / `planning:deleteCard` | grava / apaga um card com rev otimista (`rev_conflict` devolve o card em disco) | `PlanningRef` + `card`/`id` + `expectedRev` → `PlanningResult` |
| `planningSaveRoteiro` | `planning:saveRoteiro` | grava o roteiro com rev otimista (`roteiro_conflict` devolve o roteiro em disco) | `PlanningRef` + `roteiro` + `expectedRev` → `PlanningResult<{ roteiro }>` |
| `planningSaveLayout` | `planning:saveLayout` | grava `_canvas.json` (posições + viewport) | `PlanningRef` + `layout` → `PlanningResult` |
| `planningListHandoffs` / `planningWriteHandoff` | `planning:listHandoffs` / `planning:writeHandoff` | lista os prompts de `_handoff/` na ordem em que foram gravados / grava um novo `AAAA-MM-DD-NN.md` | `PlanningRef` (+ `conteudo`) → `PlanningResult<{ handoffs }>` / `PlanningResult<{ name }>` |

> Os controles manuais do painel (`launch`/`navigate`/`back`/`forward`/`reload`/`set-select-mode`/`input`/`close`) agem sempre no navegador da **conversa ativa** (`activeConvId`).

### Main → Renderer (`webContents.send` / `ipcRenderer.on`)

| Constante | Canal | Payload |
|-----------|-------|---------|
| `agentEvent` | `agent:event` | `AgentEventMsg` `{ convId, event: ChatEvent }` |
| `agentPermissionRequest` | `agent:permission-request` | `PermissionRequestMsg` `{ convId, req: PermissionRequest }` (com `questions?` quando é um `AskUserQuestion`) |
| `agentPermissionExpired` | `agent:permission-expired` | `PermissionExpiredMsg` `{ convId, id }` (pedido auto-resolvido por timeout → fecha o modal) |
| `browserFrame` | `browser:frame` | `BrowserFrame` `{ data, width, height, mime? }` (mime = `image/png` no Android) |
| `browserStateChanged` | `browser:state` | `BrowserState` (inclui `tabs[]` e, no Android, `androidSize`) |
| `browserPicked` | `browser:picked` | `PickedElement` (com `tabId`/`tabName`) |
| `androidProgress` | `browser:android-progress` | `AndroidProgressMsg` `{ convId, line }` (progresso do boot/instalação) |
| `remoteInbound` | `remote:inbound` | `RemoteInboundMsg` `{ convId, text, images? }` (comando vindo de um celular, com imagens opcionais) |
| `remoteBuildProgress` | `remote:build-progress` | `RemoteBuildProgressMsg` `{ line, done?, ok? }` |
| `remoteClients` | `remote:clients` | `RemoteInfo` (mudou a contagem de celulares / estado da ponte) |
| `remoteSetSkipPerms` | `remote:set-skip-perms` | `{ on }` (um celular alternou o "Permitir tudo" global) |
| `remoteSetModel` | `remote:set-model` | `RemoteSetModelMsg` `{ convId, model?, effort? }` (um celular trocou modelo/esforço da conversa) |
| `remoteRecoveryAction` | `remote:recovery-action` | `{ convId, action: 'retry' \| 'cancel' }` (um celular agiu no cartão de recuperação de turno) |
| `remotePermissionResponse` | `remote:permission-response` | `RemotePermissionResponseMsg` `{ convId, res: PermissionResponse }` (um celular respondeu uma permissão/`AskUserQuestion` pendente; o renderer chama `respondToPermission` — o mesmo caminho de `window.api.respondPermission` que o desktop usa — pra fechar o modal dos dois lados) |
| `planningChanged` | `planning:changed` | `PlanningChangedMsg` `{ projectCwd, slug }` — arquivos de um plano aberto mudaram por fora do app (vigia, com o eco das gravações próprias descartado por hash) ou pelas `plan_*` do Agent Manager (`planningEvents`); a tela recarrega só se for o plano dela |

---

## Notificações e modais

`src/renderer/src/ui/UiProvider.tsx` provê o contexto `useUI()` com:

- **`notify(tipo, msg)`** — adiciona um toast ao array de estado. Cada `ToastItem` se auto-remove após `TOAST_MS` (4500ms): marca `leaving` (animação de saída ~280ms) e então chama `onClose`. Fecha também no clique. Três tipos com cor: `sucesso`/`erro`/`aviso`.
- **`confirm(opts)`** — guarda `{ opts, resolve }` no estado e renderiza o `ConfirmDialog`; o clique resolve a `Promise<boolean>`. `Enter` confirma, `Esc`/clique no overlay cancela; `danger: true` deixa o botão de confirmar vermelho.

O valor do contexto é memoizado (`useMemo`) para os consumidores não re-renderizarem a cada toast. O `App` é envolvido pelo `UiProvider` em `main.tsx`, então qualquer componente (incl. `Sidebar`) usa `useUI()`.

`PermissionModal` reusa o mesmo visual de modal para o pedido de permissão do agente, com 3 ações (Negar / Permitir uma vez / Sempre permitir). `QuestionModal` (ver [Modal de pergunta interativa](#modal-de-pergunta-interativa-askuserquestion)) usa o mesmo padrão para o `AskUserQuestion` — opções clicáveis, multi-select e "Outro…"; o `App` escolhe entre os dois conforme o pedido carrega `questions`. `NewTabModal` usa o mesmo padrão (`.modal-overlay`/`.modal-card`) para escolher o tipo da nova aba de preview (Web / Android / iPhone reservado) — renderizado na raiz do app, então nunca é cortado pela barra de abas.

---

## Build, tipos e ferramentas

- **electron-vite** (`electron.vite.config.ts`): três alvos. Main e preload usam `externalizeDepsPlugin()` para **não empacotar** o Agent SDK nem o Playwright (eles abrem subprocessos/navegadores nativos). A renderer usa o plugin do React e o alias `@shared → src/shared`.
- **TypeScript** com *project references* (`tsconfig.json` → `tsconfig.node.json` + `tsconfig.web.json`). `node` cobre `src/main`, `src/preload`, `src/shared`; `web` cobre `src/renderer` + `src/shared` (com `lib: DOM`, `jsx: react-jsx`). Ambos `strict`, `moduleResolution: Bundler`, alias `@shared/*`.
- **Vitest** (`vitest.config.ts`): ambiente `jsdom`, `globals`, alias `@shared`, plugin do React; inclui `src/**/*.test.{ts,tsx}`.
- **Ícone** (`scripts/make-icon.mjs`): usa o Playwright para renderizar `build/icon.svg` e salvar `icon.png` (512) e `icon.ico` (256, ICO de uma imagem PNG). Rodar com `npm run icon`.
- **Scripts auxiliares** (`scripts/`): `screenshot.mjs` (gera o print do README dirigindo o app via `_electron`), `ui-tab-test.mjs` (smoke test do sistema de abas) e `android-probe.mjs` (verifica o caminho do preview Android). São utilitários de desenvolvimento, executados com `node scripts/<arquivo>.mjs`.
- **Controle do Windows** (`src/main/windowsControl/`): as ferramentas `windows_*` (`windows_list_windows`/`list_apps`/`launch_app`/`activate_window`/`get_state`/`click`/`click_element`/`type_text`/`press_key`/`scroll`/`drag`/`set_value`/`secondary_action`) falam com um **helper nativo em C#** (`native/`, .NET 8, UI Automation + input) por um cliente de linha de comando (`client.ts`). O helper é compilado por `scripts/build-windows-control.mjs` (`dotnet publish`, `win-x64`, *self-contained*, single-file) para `out/windows-control/` — rodado automaticamente por `npm run dev` e `npm run build`, e **ignorado fora do Windows**. `resolveHelperPath()` procura o exe em `resources/windows-control` (empacotado), `out/windows-control` (dev) e no `bin/Release` do projeto .NET, nessa ordem; se não achar, lança pedindo `npm run windows-control:build`. A capacidade é *gated* pela config `windowsControlEnabled` (não é ligada por padrão).
- **Instalador Windows** (`npm run package:win` → `electron-builder.yml`): roda `npm run build`, depois `scripts/stage-chromium.mjs` e por fim `electron-builder --win` (alvo `nsis`, artefato `dist/AgentCode-setup.exe`). Instala os arquivos uma vez em disco (com atalho de desktop/menu iniciar) em vez de autoextrair a cada abertura — era isso que tornava o antigo exe portátil lento para abrir (300 MB reextraídos para um diretório temp novo toda vez). Três decisões que não podem ser desfeitas sem quebrar o pacote:
  - **`asar: false`** de propósito — o `claude.exe` do Agent SDK e o Playwright **executam binários de dentro de `node_modules`**, e dentro do asar eles não rodam.
  - **Chromium embutido** — `stage-chromium.mjs` copia o Chromium do Playwright (e o `winldd` opcional) de `%LOCALAPPDATA%\ms-playwright` para `out/ms-playwright/`, e o `extraResources` o leva para `resources/ms-playwright`. Em produção, `index.ts` aponta `PLAYWRIGHT_BROWSERS_PATH` para lá (`app.isPackaged` e a env ainda não definida) — o pacote não tem acesso ao cache da máquina de build. O caminho no `extraResources.from` é **relativo**: um caminho absoluto é resolvido contra a raiz do projeto pelo electron-builder e falha **em silêncio**.
  - **Skills no pacote** — `.agents/skills/**` entra em `files`, porque no exe `app.getAppPath()` é `resources/app`, exatamente a raiz de onde o `skillManager` sincroniza para `<cacheDir>/skills` (ver [Skills](#skills-kit-portátil)). O helper do controle do Windows e o Chromium são **excluídos de `files`** (`!out/windows-control/**`, `!out/ms-playwright/**`) porque vão como `extraResources`, onde o código os procura.
- **Organização do `BrowserController`**: para manter o arquivo enxuto, a parte de página web está em `pageActions.ts`, os tipos/constantes de aba em `browserTabs.ts`, o init script do picker em `picker.ts` e a parte Android em `android/` (`androidEnv`, `androidDevice`, `androidTab`, `androidTools`).
- **App remoto** (`smartfone-remote/`): projeto **Capacitor** separado (próprio `package.json`). O cliente é o `www/` (HTML/JS puro, sem build). `scripts/build-apk.mjs` gera o APK; o `.gitignore` ignora `smartfone-remote/{node_modules,android,dist,.gradle}`. O **ícone do app** reaproveita a arte do desktop: `scripts/make-icons.mjs` rasteriza `build/icon.svg` em `resources/` (`icon-only`/`-foreground`/`-background` + `splash`), e o build roda `@capacitor/assets generate --android` para gerar mipmaps + ícone adaptativo. Trocar o ícone do desktop e regerar reflete nos dois.

---

## Fluxo ponta a ponta de uma mensagem

1. Usuário digita no `Composer` e envia → `App.sendMessage(text)`.
2. Se houver *chips* (elementos selecionados na página), eles são anexados ao texto.
3. **Guarda da pasta do projeto** — antes de conectar/enviar, `ensureProject(conv)` verifica via `app:path-exists` que a `cwd` da conversa **ainda existe e é uma pasta** (no main, `fs.stat` + `isDirectory()`). Se não existir (pasta movida/excluída), um toast de erro avisa e o envio é **abortado** — nunca chega ao LLM com um `cwd` inválido. (O envio enquanto a conversa já está ocupada pula a guarda, pois a mensagem só entra na fila local.) Além disso, o `App` checa a existência da pasta **antes mesmo de digitar** (`projectMissing`, reavaliado ao trocar de conversa e no `focus` da janela): quando a pasta sumiu, o `Composer` fica **read-only** e qualquer clique/foco mostra o erro — não dá para escrever a mensagem (o campo nem aceita texto).
4. Se a conversa ativa não está conectada, `connect()` faz o [gate de login do Claude](#autenticação-login-do-claude) e dispara `agent:start` (com `resume` se houver) → o main cria uma `AgentSession` e começa o loop do SDK.
5. A mensagem do usuário é adicionada à conversa (e vira o título, se ainda for o padrão) e enviada por `agent:send` → entra na `AsyncQueue`.
6. O SDK processa: emite `system` (init, captura `sessionId`), textos em streaming, `thinking`, `tool_use`.
7. Cada `tool_use` passa pelo gate de permissão: auto-aprovado (com `updatedInput`), pede no modal, ou (se for `AskUserQuestion`) abre o [modal de pergunta](#modal-de-pergunta-interativa-askuserquestion).
8. Ferramentas `browser_*` dirigem o Chromium; os frames aparecem ao vivo no `BrowserPanel`.
9. `tool_result` e a resposta final chegam como `ChatEvent`; o `MessageList` renderiza os cartões e a resposta; o medidor de tokens/custo é atualizado pelo `result`. Cada resposta final pode ser ouvida pelo botão **"Ouvir"** ([voz no chat](#voz-no-chat-openai)). **Se o turno falhar** (`error`/`result.isError`), a mensagem do usuário **continua na bolha**, marcada com erro e com **"Tentar de novo"** (ver "Mensagem nunca se perde no erro", na seção de sessões/fila acima).
10. Tudo é persistido (debounce) na [pasta de cache](#pasta-de-dados-cache-e-sqlite) — **conversas** num banco SQLite **por projeto** em `data/`, estado da UI e as configs do sistema (API key, token Android, "permitir tudo") no banco global — e reaparece no próximo início.
