# Modo sandbox e botão "Conectar conta" — design

Data: 2026-09-29 · Status: aprovado em conversa, aguardando revisão da spec

## Objetivo

1. Um **modo sandbox**: conversa que não exige escolher pasta. Cada conversa de
   sandbox ganha a sua subpasta numa pasta `sandbox` local do app, e o Agent
   Code já abre nela no primeiro uso.
2. Um botão grande **"Conectar conta"** no chat quando nenhum provedor está
   conectado, com as opções Claude, GPT e Ollama, conectando ali mesmo.

Sucesso: um usuário novo abre o Agent Code, cai numa conversa de sandbox sem
escolher pasta, conecta um dos três provedores pelo botão do chat e manda a
primeira mensagem — sem passar por Configurações.

## Decisões do usuário (2026-09-29)

- **Subpasta por conversa** (não uma pasta única compartilhada).
- **Sempre disponível**: projeto fixo "Sandbox" na barra lateral; "Nova
  conversa" sem pasta ativa vai para o sandbox; "Novo projeto" continua
  abrindo o seletor de pasta.
- **Pasta local, fora do OneDrive e fora da instalação**: a pasta interna do
  app, `<localDir>\sandbox` = `%APPDATA%\agent-code-desktop\agent-code-local\sandbox`.
  A pasta de instalação (`C:\Program Files\Agent Code`) foi descartada: sem
  permissão de escrita sem administrador, e atualizar/reinstalar a substitui.
- **Conectar tudo no chat**: Claude e GPT abrem o login no navegador com o
  card aguardando; Ollama pede a API key num campo ali mesmo.

## Restrições e o que já existe

- Pasta local do app: `getCacheInfo().localDir` (`src/main/store.ts:188`).
- Conversa nova hoje sempre exige pasta: `newChat` usa o `cwd` da ativa ou da
  primeira da lista, senão abre `pickDirectory` (`src/renderer/src/App.tsx:1893`);
  no primeiro uso não há conversa ativa e o `ChatPanel` mostra o estado vazio
  "Conecte na sua conta do Claude Code…" com **Conectar** (`ChatPanel.tsx:382`),
  que pede pasta (`connectStart`, `App.tsx:2102`).
- Os três provedores já existem, só em Configurações:
  - Claude: `claudeAuthStatus`/`runClaudeLogin` (`src/main/auth.ts`,
    `src/main/login.ts`), contas em `src/main/accounts/registry.ts`.
  - GPT: `codexStatus`/`runCodexLogin` (`src/main/codexAuth.ts`).
  - Ollama: `AppConfig.ollama {enabled, apiKey}`, pronto quando
    `ollamaSelectable()` (`src/shared/selectableModels.ts`).
- Não existe checagem "nenhum provedor conectado".
- `App.tsx` (~3.500 linhas), `ChatPanel.tsx`, `Sidebar.tsx` já passam de 500
  linhas: a lógica nova vai em módulos novos; os grandes recebem só fiação.
- **Pré-requisito**: as mudanças não commitadas de outra conversa em
  `App.tsx`/`Sidebar.tsx`/`blankConversation.ts` (reaproveitar a conversa vazia,
  `openBlankOrCreate`) precisam estar commitadas antes da implementação — o
  sandbox mexe no mesmo fluxo e reaproveita essa regra.
- Nunca reiniciar o Electron em uso para validar: typecheck, testes e build.

## Abordagem

O sandbox é um **projeto virtual identificado pelo caminho**: toda conversa com
`cwd` dentro de `sandboxRoot()` é do sandbox. Sem flag nova na conversa, sem
migração no SQLite/PostgreSQL.

Descartado: um campo `sandbox: true` na conversa — exige migração nos dois
repositórios para algo que o caminho já responde; a pasta é local ao PC, então
o flag não ajudaria em outro PC.

## Componentes

### Main — `src/main/sandbox.ts` (novo)

- `sandboxRoot(): string` → `join(getCacheInfo().localDir, 'sandbox')`.
- `isSandboxPath(cwd): boolean` → `cwd` está DENTRO de `sandboxRoot()`
  (comparação normalizada, sem diferenciar maiúsculas no Windows; a raiz em si
  não conta).
- `createSandboxDir(now = new Date()): Promise<string>` → cria
  `<sandboxRoot>\AAAA-MM-DD_HH-MM_<4 hex>` (recursivo) e devolve o caminho
  absoluto. O nome não usa o título: a conversa ainda não tem título quando
  nasce, e renomear a pasta depois quebraria a sessão.
- IPC novos (`src/shared/ipc.ts` + preload): `sandboxInfo` → `{ root }`;
  `sandboxCreate` → `{ path }`. Erros de disco viram `{ error }`, nunca lançam
  para o renderer.

### Main — `src/main/providerStatus.ts` (novo)

- `providerStatus(): Promise<{ claude: boolean; gpt: boolean; ollama: boolean }>`
  - `claude`: alguma conta Claude conectada (registro de contas / `claudeAuthStatus`).
  - `gpt`: `codexStatus().connected`.
  - `ollama`: `ollamaSelectable(loadConfig().ollama)`.
  Cada consulta que falha conta como `false`; a função nunca lança.
- IPC `providersStatus` e o evento `providersChanged`, emitido depois de login
  ou logout Claude, conexão ou desconexão do Codex, e gravação da config do
  Ollama. Os fluxos de conexão continuam os que já existem (`authLogin`,
  `codexLogin`, gravação de config) — nada de fluxo novo de login.

### Renderer — regras do sandbox (`src/renderer/src/sandbox/sandboxFlow.ts`, novo)

Funções puras, testáveis sem montar a janela:

- `shouldOpenSandboxOnBoot(conversations)`: `true` quando, depois de carregar,
  não há nenhuma conversa (primeiro uso, ou todas apagadas).
- `newChatTarget(active, sandboxRoot)`: `'sandbox'` quando não há conversa
  ativa com pasta, ou quando a ativa é de sandbox; senão `{ folder: active.cwd }`.
  Conversa de sandbox nova **sempre** ganha subpasta nova — exceto quando já
  existe uma conversa de sandbox vazia, que é reaproveitada (mesma regra de
  `findBlankConversation`, estendida para "qualquer subpasta do sandbox").
- `groupSidebarProjects(conversations, sandboxRoot)`: as conversas de sandbox
  saem do agrupamento por pasta e formam o projeto fixo "Sandbox", sempre no
  topo, mesmo vazio.

### Renderer — fiação

- `App.tsx`: na hidratação, se `shouldOpenSandboxOnBoot`, cria a subpasta
  (`sandboxCreate`) e a conversa nela e a torna ativa, sem seletor. `newChat`
  e o "+" do "Sandbox" passam por `newChatTarget`. `newProject` inalterado.
- `Sidebar.tsx`: renderiza o projeto "Sandbox" (ícone próprio, "+" para nova
  conversa de sandbox), usando `groupSidebarProjects`.
- Conversa de sandbox em outro PC: a pasta não existe ali; comporta-se como
  qualquer conversa cuja pasta sumiu (fluxo atual de `pathExists`).

### Renderer — `ConnectAccountCard` (`src/renderer/src/components/connectAccount/`, novo)

- Aparece no chat **só** quando `claude`, `gpt` e `ollama` são todos `false`.
  Substitui o texto e o botão "Conectar" do estado vazio atual; com a conversa
  vazia fica centralizado, com mensagens fica acima do campo de mensagem.
- Botão grande **"Conectar conta"** → três opções:
  - **Claude** e **GPT**: disparam o login existente (abre o navegador); o card
    mostra "Aguardando login no navegador…" com **Cancelar**, até o
    `providersChanged` confirmar.
  - **Ollama**: campo para colar a API key (tipo senha), link "Gerar chave no
    ollama.com" (abre no navegador do sistema), **Salvar** grava
    `ollama.enabled = true` + a chave; chave vazia não habilita o Salvar.
- Conectou: toast `sucesso` ("Conta conectada: Claude|GPT|Ollama") e o card
  some. Falhou/cancelou: toast `erro`/`aviso` e o card continua. Toasts pelo
  padrão do projeto (`useUI().notify`).
- Modelo depois de conectar: se o modelo da conversa ativa for de um provedor
  não conectado, ela passa para o primeiro modelo do provedor recém-conectado
  (`CLAUDE_MODELS[0]`, `OPENAI_MODELS[0]`, `OLLAMA_MODELS[0]`). Conversas novas
  seguem a mesma regra na criação.

## Fluxo de dados

```
boot → hidratação → sem conversas? → sandboxCreate → createConversation(cwd=subpasta) → ativa
chat → providersStatus (+ providersChanged) → todos false? → ConnectAccountCard
ConnectAccountCard → authLogin | codexLogin | config.ollama → providersChanged → card some + modelo ajustado
```

## Erros

- Falha ao criar a subpasta do sandbox: toast `erro` com o motivo e cai no
  fluxo atual (seletor de pasta), para o usuário nunca ficar sem conversa.
- `providerStatus` com consulta falhando: aquele provedor conta como não
  conectado (na dúvida o card aparece; nada fica bloqueado, o login existente
  resolve).
- Login cancelado ou expirado: o card volta ao estado inicial com toast `aviso`.

## Testes

- `sandbox.test.ts`: nome da subpasta (formato e unicidade), criação recursiva,
  `isSandboxPath` (dentro, a própria raiz, fora, caixa diferente, `..`).
- `providerStatus.test.ts`: combinações dos três, falha de uma consulta vira
  `false`.
- `sandboxFlow.test.ts`: primeiro uso abre o sandbox; "Nova conversa" sem
  pasta ou a partir de uma de sandbox vai para subpasta nova; reaproveita a
  vazia; conversa de pasta real continua na pasta; agrupamento "Sandbox" no topo.
- `ConnectAccountCard.test.tsx`: aparece só com os três desconectados; Claude e
  GPT chamam o login e mostram "Aguardando…"; Ollama valida e grava a chave;
  toasts de sucesso e erro; some ao conectar.
- `npm run typecheck`, `npm test` e `npm run build`.

## Fora do escopo

- Apagar ou limpar subpastas de sandbox antigas.
- Promover uma conversa de sandbox a projeto (mover a pasta).
- Sincronizar os arquivos do sandbox entre PCs.
- Novos fluxos de login: só reaproveitar os existentes.
