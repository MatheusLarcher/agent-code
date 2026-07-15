# Arquitetura — Agent Code

Este documento descreve **como o app funciona por dentro**. Para a referência arquivo por arquivo, veja [REFERENCIA.md](REFERENCIA.md). Para uso/instalação, veja o [README](../README.md).

## Como rodar

A forma padrão de iniciar o projeto é executar o **`start.bat`** na raiz da pasta (duplo-clique no Windows). Ele usa o Node do sistema ou, se não houver, **baixa um Node portátil** (v24.11.1, extraído em `.node/`, sem admin — reaproveitado depois); **linka as skills** versionadas (`.agents/skills/` → `.claude/skills/`, ver [Skills](#skills-kit-portátil)); instala as dependências na primeira vez (incluindo o Chromium do Playwright), garante o binário do Electron e então roda `npm run dev`. Não é preciso rodar `npm install`/`npm run dev` à mão — o `start.bat` cuida de tudo.

## Sumário

- [Como rodar](#como-rodar)
- [Modelo de processos e segurança](#modelo-de-processos-e-segurança)
- [Autenticação (login do Claude)](#autenticação-login-do-claude)
- [Sequência de inicialização](#sequência-de-inicialização)
- [Ciclo de vida da sessão do agente](#ciclo-de-vida-da-sessão-do-agente)
- [Tradução de mensagens do SDK em eventos de UI](#tradução-de-mensagens-do-sdk-em-eventos-de-ui)
- [Permissões de ferramentas](#permissões-de-ferramentas)
- [Modal de pergunta interativa (AskUserQuestion)](#modal-de-pergunta-interativa-askuserquestion)
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
- **Interromper:** `interrupt()` chama `q.interrupt()` (ignora erro se não houver turno ativo).
- **Encerrar:** `dispose()` fecha a fila de entrada (encerra o loop do SDK).

> **Watchdog de travamento (`src/main/stallWatch.ts`) — base pronta, ainda NÃO integrada ao `AgentSession`.** Hoje "ocupado" é 100% otimista (liga ao enviar, só desliga com `result`/`error`); quando muitos agentes rodam ao mesmo tempo e o sistema não consegue processar, não há como distinguir "ainda trabalhando" de "travou". `stallWatch.ts` traz a lógica pura pra detectar isso: `isStalled(now, lastActivityAt, toolInFlight)` compara o tempo parado contra um limiar curto (`STALL_THRESHOLD_MS = 60s`, sem ferramenta em voo) ou longo (`STALL_THRESHOLD_TOOL_MS = 5min`, com ferramenta em voo — builds/downloads legítimos não devem disparar falso positivo). O plano (pausado, não implementado): a `AgentSession` rastreia `lastActivityAt`/ferramentas em voo, um `setInterval` chama `isStalled` e emite um novo `ChatEvent` `stall-status` quando o estado muda; o `ChatPanel` trocaria o banner "trabalhando" por um aviso "sem resposta há Xs" enquanto travado.

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
- **Contexto de entrada** = `ctx` (`tokens.context`) = o que está sendo **enviado** ao modelo naquela requisição (a janela que ele recebe). É o numerador da **barra de limite de contexto** (`ContextBar`); o denominador é o limite do modelo (`contextLimitFor(model)` — `CONTEXT_LIMITS` em `shared/ipc.ts`: Opus/Sonnet/Fable 1M, Haiku 200K — valores Anthropic **autoritativos**; Ollama Cloud com a janela **nativa real** de cada modelo — Qwen3-Coder 256K, gpt-oss 128K, **DeepSeek V4 Pro e GLM-5.2 1M** (verificados contra a documentação de cada modelo — antes estavam sub-relatados em 128K/200K, o que fazia a barra parecer cheia bem antes do limite de verdade), Kimi K2.7 Code 256K; fallback `DEFAULT_CONTEXT_LIMIT`). A barra mostra `usado / limite` e a % de preenchimento. Manter o mapa em sinc ao adicionar modelo ao seletor — limite errado = barra errada.
- **Contexto de saída** = `out` (`tokens.output`) = tudo que o modelo **gerou** (acumulado na conversa). **Não** é a janela de contexto; é um chip separado (`↑ … saída`).

**Custo — aviso de que não é cobrança real** — o chip `$` (`.tok.cost`) mostra `total_cost_usd` do SDK, que é uma **estimativa pelo preço da API avulsa** (pay-as-you-go). Quem usa um **plano de assinatura** (Pro/Max) não é cobrado por esse valor — o uso já está incluído no plano. O visual (`~$X.XX`, o `~` como pista permanente) e o `title` deixam isso explícito, sem precisar abrir nada.

**Uso da conta (5h / semana) — `UsageBadge`, GLOBAL, não por conversa** — o SDK emite `SDKRateLimitEvent` (`type: 'rate_limit_event'`, um `rate_limit_info` por vez: `status`, `rateLimitType` — `five_hour` | `seven_day` | `seven_day_opus` | `seven_day_sonnet` | `seven_day_overage_included` | `overage` —, `utilization` 0..1, `resetsAt`) **só para contas por assinatura** (claude.ai Pro/Max); uma chave de API avulsa nunca dispara isso. `agentSession.ts` trata `case 'rate_limit_event'` e emite `{ kind: 'rate-limit', limits }` (`shared/ipc.ts` → `RateLimitStatus`). No `App.tsx`, esse evento **não passa por `patchConv`** — é tratado logo no início do `onEvent` (`return` cedo), atualizando um estado próprio `usageLimits: Record<rateLimitType, RateLimitStatus>` que **não é da conversa ativa** e por isso **sobrevive trocar de conversa** (diferente do `ContextBar`/custo, que resetam por conversa). `UsageBadge.tsx` (novo componente, na **topbar** — sempre visível, sem depender de sessão conectada) reaproveita a **mesma linguagem visual** do `ContextBar` (classes `.ctx-bar*`: track+fill, âmbar ≥80%/`allowed_warning`, vermelho ≥95%/`rejected`); **renderiza `null`** se `limits` estiver vazio (conta por API key, ou nenhum evento ainda) — nunca mostra uma barra vazia/0% enganosa.

O `rate_limit_event` é **espontâneo** (o backend só manda quando quer), então o badge podia ficar desatualizado por muito tempo numa conversa parada. `AgentSession.refreshUsage()` faz um **poll manual** do endpoint experimental do SDK (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`) e emite os mesmos eventos `rate-limit` — chamado (1) ao fim de cada turno (`void this.refreshUsage()`, sem bloquear a resposta) e (2) a cada **5 minutos** pelo `App.tsx` numa sessão conectada (`window.api.refreshUsage(convId)` → IPC `agent:refresh-usage`), mesmo sem o agente responder. Esse poll usa o endpoint de uso da conta do SDK — **não** é uma chamada ao modelo, então **não consome tokens** nem conta no uso. `RateLimitStatus.updatedAt` marca quando o snapshot foi produzido. **Zero espúrio:** uma sessão recém-aberta às vezes reporta `0%` / "já resetou" antes de ter número real, apagando um badge válido; `isSpuriousUsageZero(prev, next)` (App.tsx, testada em `App.test.tsx`) descarta um snapshot com utilização ~0 **enquanto** o snapshot salvo ainda diz que a janela não resetou (`resetsAt` no futuro) — um reset de verdade (horário já passado) segue zerando o badge normalmente. A mesma regra vale no *seed* da abertura do app (o valor salvo vence um zero espúrio que chegou ao vivo primeiro). O `App.tsx` também **persiste** `usageLimits` em `storage.ts` (`loadUsageLimits`/`saveUsageLimits`, chave `agentcode.usage-limits.v1`) a cada mudança, e o carrega na abertura do app — só como *seed* se nada tiver chegado ao vivo ainda — para o badge já aparecer com o último valor conhecido, sem esperar o 1º evento da sessão.

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

> A auto-aprovação por prefixo também cobre as ferramentas do **Stitch** (`mcp__stitch__`/`mcp__stitchpreview__`) — só geram/exibem mockups; o gate real é a implementação no projeto (`Write`/`Edit`, que ainda pergunta) e a aprovação explícita "Aplicar/Descartar" no preview.

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

## Voz no chat (OpenAI)

O chat ganha **voz** opcional via OpenAI: ditado por microfone (fala → texto) e leitura em voz alta das respostas (texto → fala). Tudo é gated por uma **API key da OpenAI** configurada na tela de Configurações. As chamadas à OpenAI rodam **no main** — a key **nunca** chega ao renderer; o renderer só envia áudio/texto por IPC e recebe texto/áudio de volta.

**Configuração** — em `src/shared/ipc.ts`, `OpenAiConfig` carrega `apiKey`, `voice` (uma de `OPENAI_VOICES` — as vozes do `gpt-4o-mini-tts`) e `speed`; o `DEFAULT_CONFIG` traz `openai: { apiKey: '', voice: 'alloy', speed: 1 }`. `src/main/config.ts` faz o **merge aninhado** de `openai` (em `loadConfig`/`updateConfig`, igual ao `stitch`), para salvar a key sem clobber das outras configs. A `src/renderer/src/ui/SettingsModal.tsx` tem a seção **"🎙️ OpenAI (voz no chat)"** com o campo de key (mostrar/ocultar), o seletor de **voz** e o de **velocidade** (Devagar/Normal/Rápida/Bem rápida → `0.8`/`1`/`1.25`/`1.5`); a prop `focus: 'openai'` rola até a seção, a destaca e foca o input (usado quando o usuário toca o mic/Ouvir sem key). Ao fechar Configurações, o `App` relê `voiceReady` (key presente) e `voiceSpeedRef`.

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

**Configuração** — em `src/shared/ipc.ts`: `OllamaConfig` (`{enabled, apiKey}`; `DEFAULT_CONFIG` traz `ollama: { enabled: false, apiKey: '' }`), a lista curada `OLLAMA_MODELS` (id = **tag exata** do Ollama, ex. `qwen3-coder:480b-cloud`, `glm-5.2:cloud`), `OLLAMA_BASE_URL = 'https://ollama.com'` e `isOllamaModel(id)` (true quando o id termina em `:cloud` — assim modelos futuros funcionam sem mexer no código). `src/main/config.ts` faz o **merge aninhado** de `ollama` (igual ao `stitch`/`openai`).

**Roteamento** (`src/main/agentSession.ts`) — quando o modelo escolhido é Ollama, a sessão monta `options.env` com três variáveis e parte daí:
- `ANTHROPIC_BASE_URL` = `https://ollama.com`
- `ANTHROPIC_AUTH_TOKEN` = a API key do Ollama (da config)
- `ANTHROPIC_API_KEY` = `''` — **crítico**: se não for esvaziada, a CLI prefere uma key da Anthropic e ignora o `BASE_URL`.

Como o campo `env` do SDK **substitui** todo o ambiente do subprocesso (não faz merge), espalhamos `...process.env` antes. Se um modelo Ollama for escolhido sem key configurada, a sessão emite um erro amigável e não inicia.

**UI** — a `SettingsModal.tsx` tem a seção **"🦙 Ollama Cloud"** (ativar + API key, mostrar/ocultar). Quando ativa **com key** (`ollamaReady` no `App.tsx`), os `OLLAMA_MODELS` são concatenados aos `MODELS` do Claude no **seletor de modelo** (acima do composer). O **gate de login do Claude** no `connect()` é **pulado** para modelos Ollama (`isOllamaModel`), já que a autenticação é a API key — não o OAuth da Anthropic.

> **Planos do Ollama:** Qwen3 Coder e GPT-OSS rodam no **plano grátis**; DeepSeek V4 Pro, GLM 5.2 e Kimi K2.7 Code retornam `permission_error` e exigem **assinatura** (ollama.com/upgrade) — por isso esses aparecem no seletor marcados com "· assinatura".

**Trocar de modelo sem parar a sessão na mão** — o SDK fixa o modelo pela vida da sessão (não dá pra trocar no meio de uma requisição). O seletor (`ChatPanel`, `modelLocked`) fica travado **só enquanto o agente está OCUPADO** (`showBusy`, mid-turn) — não enquanto está só *conectado*. Trocar o modelo com a conversa **ociosa mas conectada** (`changeModel` em `App.tsx`) atualiza `Conversation.model` e encerra a sessão atual **em silêncio** (`stopSession(id, {silent:true})` — mesmo `interrupt`+`disposeAgent` do botão "Parar sessão", só sem o toast de "sessão encerrada"); a **próxima mensagem** reconecta sozinha já com o modelo novo. Trocar com a sessão **desconectada** só atualiza o campo (nada pra encerrar). Testes: `App.test.tsx` → "trocar de modelo sem precisar parar a sessão manualmente".

### Vision Relay (`vision_fallback_router`) — imagem para modelo sem visão

A maioria dos modelos do Ollama Cloud da lista (`OLLAMA_MODELS`) é **texto-only** — se uma imagem chegasse até eles, o Ollama rejeitaria ou o modelo simplesmente ignoraria o anexo. Em vez de bloquear o envio ou avisar o usuário, o app **intercepta** a imagem antes do SDK e a troca por uma **descrição técnica estruturada**, de forma **transparente** (mesma conversa, mesma resposta, o usuário não percebe a troca).

- **Quem suporta visão de verdade** (`modelSupportsVision(model)` em `shared/ipc.ts`): todo modelo Claude, sempre; no Ollama, só o que estiver em `OLLAMA_VISION_MODELS`. Essa lista não é baseada em ficha técnica — foi **verificada com um probe real** (`POST https://ollama.com/v1/messages` com uma imagem, pra cada um dos 6 modelos de `OLLAMA_MODELS`): só `kimi-k2.7-code:cloud` respondeu 200 (processou a imagem de verdade); os outros cinco (Qwen3-Coder, gpt-oss 120B/20B, DeepSeek V4 Pro, GLM-5.2) responderam 400 `this model does not support image input`. Os cinco passam pelo relay; o Kimi vai direto. Reverifique da mesma forma antes de marcar qualquer outro modelo como `true` aqui — um `true` errado manda a imagem crua pra um modelo que dá 400 (foi exatamente o bug relatado: o app antigo, antes deste feature existir, mandava a imagem direto pra qualquer modelo).
- **O relay** (`src/main/visionRelay.ts`): `describeImages(images, userText)` dispara um `query()` **avulso** do SDK (não é a sessão principal) contra um modelo multimodal fixo (`claude-sonnet-5`), com `tools: []` (sem ferramentas — é só um intérprete, não um agente) e `maxTurns: 1`. O prompt pede uma extração estruturada em 8 seções fixas: **Texto visível (OCR completo)**, **Erros encontrados**, **Elementos de interface**, **Layout visual**, **Contexto técnico**, **Logs ou stack traces**, **Componentes relevantes**, **Possíveis problemas identificados**. `buildVisualContextBlock` envolve o resultado em `[VISUAL_CONTEXT]\n…\n[/VISUAL_CONTEXT]`; `mergeUserTextWithVisualContext` monta o texto final ("Mensagem original do usuário: …" + o bloco + "Agora responda considerando a análise visual acima.").
- **Interceptação** (`AgentSession.send`, agora `async`): se há imagens **e** `!modelSupportsVision(this.opts.model)`, chama o relay e envia **só o texto mesclado** pra fila do SDK — a imagem em si nunca chega ao modelo principal. Se o relay falhar (rede, etc.), degrada sem travar o envio: acrescenta uma nota curta ao texto avisando que a imagem não pôde ser analisada, e segue. Com um modelo que já vê imagem (Claude ou Kimi K2.7 Code), ou sem nenhuma imagem anexada, o fluxo é **idêntico ao anterior** — os blocos de imagem vão direto no `content` da mensagem, sem relay.
- Testes: `visionRelay.test.ts` (prompt/parsing do relay isolado, com `query` mockado) e `agentSession.test.ts` → "vision_fallback_router" (os 5 ramos: sem visão + sucesso, sem visão + falha do relay degradando, Claude pulando o relay, Kimi K2.7 pulando o relay, sem imagem).

---

## Pasta de dados (cache) e SQLite

A persistência **por usuário** vive numa **pasta de cache** que o usuário escolhe na tela de Configurações. `src/main/store.ts` gerencia o banco **global** (config/UI/uso) usando o **SQLite embutido** do Node (`node:sqlite` — nenhuma dependência nativa/npm); `src/main/projectStore.ts` gerencia um banco **por projeto** só para as conversas (ver [Conversas, projetos e persistência](#conversas-projetos-e-persistência) para o porquê e a migração).

**Layout:**

```
~/.agent-code/location.json      ← ponteiro: SÓ o caminho da pasta de cache
<escolhida>/agent-code/          ← pasta de cache (nome fixo = nome do projeto)
  ├─ agent-code.db               ← SQLite: tabela kv(key → JSON) — config do sistema
  │                                (API key do Stitch, "permitir tudo", token Android,
  │                                UI state, snapshot de uso); a chave antiga de
  │                                conversas (agentcode.conversations.v1) fica aqui
  │                                como backup INERTE pós-migração, nunca mais lida
  ├─ agent-code.db.bak           ← cópia do banco antigo, feita uma vez, na 1ª
  │                                migração para o storage por projeto (só se havia
  │                                dado legado pra migrar)
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
- **`config.ts`** deixou de usar `settings.json` e passou a ler/gravar a chave `config` do SQLite global (mesma forma de `AppConfig`); o **token fixo do Android** (`remoteToken`) e a API key do Stitch vivem aqui.
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

**Indicadores de atividade** — o conjunto `busyIds` (passado à `Sidebar` e ao `ChatPanel`) governa a sinalização visual de processamento: na barra lateral, a conversa em execução troca o ícone de chat por um **anel girando** (estilo Windows) e o projeto que tem qualquer conversa ocupada gira no lugar do ícone de pasta; no topo do chat ativo, uma faixa **"Claude está trabalhando…"** (anel + reticências animadas + barra varrendo a borda) aparece enquanto `busy`. A criação de novas conversas saiu do botão fixo no topo da barra para um **"+" ao lado de cada projeto** (`onNewChatIn(path)` → `createConversation`, herdando o modelo já usado naquele `cwd`).

**Hierarquia visual projeto → conversas** — um projeto **aberto** vira um "painel" visível (`.project-item.open`: fundo + borda, `var(--bg-2)`/`var(--line)`), deixando claro que as conversas abaixo estão **contidas** nele, não só indentadas; cada conversa aninhada ganha um **conector em árvore** (`.conv-row.nested::before`/`::after`: uma guia vertical contínua ligada ao ícone da pasta, com um "cotovelo" arredondado em cada linha — a última da lista não estende a guia pra baixo). Fechado, o projeto volta a ficar flat, sem painel nem linhas soltas.

**Permissões por conversa** — cada pedido de ferramenta fica em `permissions[convId]`; o modal só renderiza o da **conversa ativa**. Se um pedido chega para uma conversa **em segundo plano**, um toast avisa que aquele chat está aguardando (senão a sessão dele congelaria sem o usuário perceber). "Permitir tudo" aplica `setBypass` a **todas** as sessões vivas (interruptor global).

**Roteamento de eventos** — cada evento chega ao renderer como `AgentEventMsg` (`{ convId, event }`); `onEvent` aplica o `ChatEvent` à conversa indicada pelo `convId` (não à ativa), então respostas vão para a conversa certa mesmo com várias rodando ao mesmo tempo. `reduceMessages` é um reducer puro que:

- atualiza o texto ao vivo do assistente (mesmo `id`),
- anexa o `result` a um `tool-use` existente,
- marca a última fala como "resposta" no `result`,
- e dedup­lica a nota de "sessão pronta".

**Persistência** (`src/renderer/src/storage.ts`) — **assíncrona**, backed pela [pasta de cache](#pasta-de-dados-cache-e-sqlite), não mais no `localStorage`:

- **Conversas** — `loadConversations()`/`saveConversations(list)` continuam com a **mesma assinatura de sempre** (a lista completa, de todos os projetos, entra e sai como um único array — a UI/`App.tsx` não muda nada), mas por baixo chamam `window.api.loadAllConversations()`/`saveAllConversations()` (canais `conversations:load-all`/`conversations:save-all`), que no main (`src/main/projectStore.ts`) **agrupam por `cwd`** e leem/gravam **um banco SQLite por projeto** em `data/<projeto>-<hash>.db`, em vez de um único blob:
  - **Carregar** = abrir todo `.db` de `data/` e concatenar as conversas de cada um — o mesmo "carregar tudo de uma vez" de antes, só que a fonte agora é vários arquivos.
  - **Salvar** = agrupar a lista completa por projeto, regravar o arquivo de cada projeto presente e **apagar** o arquivo de qualquer projeto que não apareça mais na lista (todas as conversas dele foram excluídas) — evita "fantasmas" ressurgindo num load futuro.
  - **Migração automática, uma única vez:** a primeira vez que `data/` não existe ainda, o antigo blob único (chave `agentcode.conversations.v1`, no SQLite global) é lido, um **backup do banco inteiro** (`agent-code.db.bak`) é feito, e as conversas são divididas por projeto. A chave antiga **não é apagada** (fica como um backup inerte, nunca mais lida) — mesmo espírito da migração do `localStorage` abaixo.
  - `saveConversations` continua fazendo o **debounce de 400ms** (o streaming muda o estado muitas vezes por segundo) e descartando o campo `images` ao persistir.
- `agentcode.ui.v1` — `{ collapsed, activeId, browserMinimized, browserWidth }` — continua no banco **global** (`kv:get`/`kv:set`), não migrou para os bancos por projeto (não é dado de projeto).
- **Migração do `localStorage`** (herdada de instalações bem antigas, anteriores até ao SQLite) — na primeira leitura de cada chave, se não houver dado algum (nem no SQLite global, nem em nenhum banco de projeto), o valor antigo do `localStorage` é copiado (e mantido como backup inofensivo, nunca reconsultado depois — evitar isso é o que garante que uma conversa **de verdade** apagada não "ressuscite" de um `localStorage` velho). A hidratação do `App` virou `async` (carrega em paralelo e só então marca `hydrated`, que evita sobrescrever antes de carregar).
- As **configs do sistema** (API key do Stitch, "permitir tudo", token do Android) ficam na chave `config` do banco global (`config.ts` → `store.ts`), não mais no `settings.json`.

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

**Minimizar o navegador** — `BrowserPanel` aceita `minimized`/`onToggleMinimize`; minimizado, colapsa para uma faixa fina com botão de restaurar e o chat ocupa a largura toda. O estado persiste em `agentcode.ui.v1`.

---

## Baixar arquivos pelo chat

Dois caminhos levam um arquivo do agente até um botão **Baixar** na conversa (no PC **e** no app Android):

1. **Entregável criado por `Write`** — `MessageList` mostra o chip só em `Write` (criação) cujo `file_path` tem extensão entregável (`isDownloadableFile` / `DOWNLOADABLE_EXTS` em `src/shared/ipc.ts`). Código-fonte/config editado não ganha chip.
2. **Marcador `[[download:CAMINHO]]`** — para arquivos que **não** vieram de um `Write` (ex.: um APK compilado pelo Gradle via Bash), o agente emite o marcador no texto (orientado pelo `DOWNLOAD_HINT`). `parseDownloads(text)` remove o marcador do texto exibido e devolve os caminhos, que viram botões. Funciona em qualquer extensão (o agente declarou explicitamente).

**No PC** o clique chama `app:file-download` (`src/main/index.ts`): valida que é um arquivo, copia para `Downloads` (sem sobrescrever — acrescenta `(1)`, `(2)`…) e revela no Explorer.

**No celular** o botão aponta para `GET /api/file?path=…&token=…` da ponte LAN. O servidor só serve caminhos da **allowlist** do snapshot atual — arquivos criados por `Write` com extensão entregável **ou** expostos por um marcador `[[download:]]` numa mensagem do assistente (`downloadablePaths()` em `remoteServer.ts`) — e nunca um caminho arbitrário. O `MainActivity` do app (instalado pelo `buildApk.ts`) tem um `DownloadListener` que salva via **DownloadManager** na pasta Downloads do aparelho, com notificação.

> Revisão adversarial (skill `adversarial-review`) deste recurso apontou que o handler `app:file-download` do desktop ainda **não** confina o caminho às mesmas raízes da ponte — hardening pendente; ver o histórico da sessão.

---

## Preview: abas (web + Android)

O painel da direita é **multi-aba**, **um por conversa** — o main mantém `Map<convId, BrowserController>` + `activeConvId` (a conversa exibida). `getBrowser(convId)` cria sob demanda; os *callbacks* (`onFrame`/`onState`/`onPicked`/`onAndroidProgress`) só repassam ao renderer quando `convId === activeConvId`. Trocar de conversa manda `browser:set-active` (→ `refreshView()`); excluir manda `browser:dispose`. A sessão do agente recebe `getBrowser(opts.convId)`, então as ferramentas agem no preview da própria conversa.

Cada aba é uma superfície de um **tipo** (`TabKind`): `web` (página do Chromium) ou `android` (tela de um device/emulador). `iphone` está **reservado** (nome + ícone existem; abrir retorna "não implementado"). `TAB_KINDS` (em `src/shared/ipc.ts`) é a fonte única de rótulo/ícone/implementado, e `tabName(tab)` gera o nome exibido **e visto pelo LLM**: `web - <site>` / `android - <app>`.

**Sempre há uma aba ativa** e toda ação age sobre ela. O `BrowserController` mantém `Map<id, Tab>` + `activeTabId`; só a ativa transmite frames (as outras seguem vivas em segundo plano). Um `Tab` tem `page` (web) **ou** `device` (android), nunca os dois.

**Barra de abas** (`BrowserTabs.tsx`) — cada aba com ícone (`TabIcon`: globo/robô/telefone) + nome + "×"; o **"+"** abre o **modal de nova aba** (`NewTabModal`, renderizado na raiz do app para **não ser cortado** pela barra, que rola horizontalmente — era esse o bug do antigo dropdown). O modal lista Web / Android / iPhone (reservado, desabilitado). Canais: `browser:new-tab`, `browser:select-tab`, `browser:close-tab`.

**O LLM controla as abas** — `browser_list_tabs`, `browser_new_tab`, `browser_select_tab`, `browser_close_tab`. O system prompt orienta a **reusar a aba atual** e só abrir outra quando precisar de uma página separada. Ao usar "Select", o `PickedElement` carrega `tabId`/`tabName`, então a mensagem informa de qual aba veio.

### Aba web

O preview roda um **Chrome de verdade** (`channel: 'chrome'`, com *fallback* para o Chromium do Playwright), **headed com a janela fora da tela** (`--window-position=-32000,-32000`) e **perfil persistente por conversa** (`launchPersistentContext`), então logins/sessões sobrevivem entre execuções. As flags de automação são removidas e `navigator.webdriver` fica oculto — sites param de bloquear como "robô". O contexto usa viewport 1280×800 e `deviceScaleFactor: 2` (texto nítido). Cada aba web tem sua **sessão CDP** + `Page.startScreencast` (JPEG, qualidade **90**); o handler só pinta se a aba for a ativa, e confirma com `screencastFrameAck`.

**`bringToFront()` ao criar/trocar de aba** — flags como `--disable-backgrounding-occluded-windows` evitam o *throttling* de **janela** ocluída, mas não impedem que o Chrome trate a página como uma **aba em segundo plano de verdade** dentro da própria janela (sujeita a *Memory Saver*/descarte). Sem isso, a aba que o app considera "ativa" podia silenciosamente perder estado entre chamadas de ferramenta, sem clique/navegação nenhuma. `openWebTab`, `showStitchDesign` e `selectTab` chamam `page.bringToFront()` (best-effort) sempre que uma aba web vira a ativa.

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

- **Fonte da verdade:** `.agents/skills/<nome>/` (arquivos reais, versionados — instalados via `npx skills add`, registrados em `skills-lock.json` na raiz). `.claude/` segue **gitignorado**.
- **Ativação:** o `start.bat` linka `.agents\skills\* → %USERPROFILE%\.claude\skills\` via **junction** (`mklink /J` — não exige admin, idempotente). Só **linka**, não reinstala — preserva adaptações locais. Assim as skills ficam disponíveis para todos os projetos do usuário; o Claude Code lê `~/.claude/skills/` nativamente.
- **Kit atual (7):** `brainstorming` (design antes de implementar), `frontend-design` (direção visual), `copywriting` (copy de conversão), `landing-page-design` (estratégia de conversão — sem dependências externas), `adversarial-review` (revisão crítica multi-lente), `planejar` (execução guiada por tarefas — *Plan & Execute*) e `code-review` (revisão de bugs de correção + oportunidades de reuse/simplificação/eficiência no diff atual).
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
