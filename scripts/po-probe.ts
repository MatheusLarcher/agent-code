/**
 * Prova de campo do PO: roda o prompt REAL contra o modelo real, em casos
 * opostos, e imprime as operações já passadas pelo parser e pelas barreiras.
 *
 * Existe pelo mesmo motivo do `vigia-probe.ts`: o teste unitário prova o
 * parser, não a qualidade do prompt — e aqui a qualidade do prompt decide se o
 * quadro fica honesto ou se enche de conclusão errada. Os dois casos que mais
 * importam são os opostos de cada rodada: no FECHAMENTO o PO não pode concluir
 * o que não terminou, e na ABERTURA ele não pode deixar o pedido sem cartão.
 *
 * As DUAS rodadas são exercitadas porque são prompts diferentes — a abertura
 * pergunta "o que vai começar?" e o fechamento "o que terminou?". Provar uma só
 * deixaria a outra sem prova nenhuma da qualidade do texto.
 *
 * Bundlar com esbuild e rodar:
 *   npx esbuild scripts/po-probe.ts --bundle --platform=node --format=esm \
 *     --external:@anthropic-ai/claude-agent-sdk --outfile=out/po-probe.mjs
 *   node out/po-probe.mjs
 *
 * Rode de novo sempre que mexer em `PO_SYSTEM_PROMPT_OPEN` ou
 * `PO_SYSTEM_PROMPT_CLOSE` (src/main/po/poPromptText.ts).
 *
 * Os cinco casos "REAL" vêm da conversa "Cadastro no sistema" (po-sessions.txt):
 * a resposta que entrega e PROPÕE um passo novo (concluir o pedido e abrir o
 * cartão do passo; com o quadro real e sem o cartão que já cobria a VPS), a que
 * BLOQUEIA o pedido (não concluir), o "pode fazer" seguinte (andar o cartão do
 * passo, nunca o concluído) e o fechamento longo das 14:54 UTC, com a prova no
 * INÍCIO da resposta (concluir o cartão da geração do EXE, não o do login).
 * O que o log não guardou é reconstruído e marcado como tal em cada caso.
 * PO_PROBE_DIGEST=1 imprime também a resposta como o digest a mostrou.
 */
import type { BoardItem, BoardItemStatus } from '../src/shared/ipc'
// `askObserver` direto, e não o `askPo` de po.ts (que é só um apelido dele):
// po.ts puxa o runtime do app (agentSession → electron), e o `electron` do
// npm fora do Electron é só o caminho do binário — o bundle quebrava no
// carregamento ("Dynamic require of child_process") antes do primeiro caso.
import { askObserver as askPo } from '../src/main/observerQuery'
import {
  buildPoPrompt,
  parsePoVerdict,
  rejectUnsafeOps,
  type PoCall,
  type PoLedgerTask,
  type PoOp,
  type PoPhase
} from '../src/main/po/poPrompt'

const MODEL = 'claude-sonnet-5'

function card(id: string, title: string, status: BoardItemStatus): BoardItem {
  return {
    id,
    projectId: 'p',
    projectCwd: 'C:/proj',
    conversationId: 'conv',
    origin: 'agent',
    sourceId: id.slice(-1),
    sourceTitle: title,
    sourceStatus: status,
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: null,
    poReason: null,
    poAt: null,
    dismissedAt: null,
    revision: 1,
    createdAt: '',
    updatedAt: ''
  }
}

interface Caso {
  nome: string
  /** Qual das duas rodadas do turno este caso exercita. */
  fase: PoPhase
  /** `qualquer`: a quantidade não importa, só a conferência de `confere`. */
  espera: 'alguma operação' | 'nada' | 'qualquer'
  userText: string
  cards: BoardItem[]
  calls: PoCall[]
  /** A última resposta do agente (a do turno no fechamento, a do anterior na abertura). */
  agentReply?: string
  /** As tarefas do registro (mcp__tasks) da conversa, como o digest as mostra. */
  ledgerTasks?: PoLedgerTask[]
  /** Conferência mais fina que "alguma operação": o que as operações TÊM que ser. */
  confere?: { descricao: string; ok(ops: PoOp[]): boolean }
}

/**
 * Recorte do quadro REAL da conversa "Cadastro no sistema" no fechamento das
 * 14:03 UTC (po-sessions.txt; 10 dos 19 cartões, os ids e títulos como o
 * modelo os viu, já cortados em 90 caracteres pelo digest).
 */
const QUADRO_CADASTRO: [string, BoardItemStatus, string][] = [
  ['bi-po-e13d96f9-e46', 'in_progress', 'Auditar/remover qualquer registro em Cloudflare ou conta própria feito sem autorização ap…'],
  ['bi-po-f89af725-ca6', 'in_progress', 'Adicionar login com Google, remover senha do EXE (usar apenas email para cadastro) e exib…'],
  ['bi-po-57479a08-3cd', 'pending', 'Remover atualização vitalícia do site'],
  ['bi-po-fae60b12-250', 'pending', 'Concluir renomeação para ALCAIOS (site, exe, VPS) e publicar novamente'],
  ['bi-po-e84cf24a-919', 'pending', 'Verificar se é possível usar Argos (investigar viabilidade)'],
  ['bi-po-c745dc97-dd7', 'pending', 'Gerar logo para o nome ALCAIOS (aguardando escolha entre 3 conceitos)'],
  ['bi-po-d98a2a8a-c9a', 'pending', 'Melhorar landing page, adicionando vídeos comerciais e gifs'],
  ['bi-po-13d0e46f-187', 'completed', 'Trocar algo solicitado pelo usuário no navegador'],
  ['bi-po-aa6ffb7c-534', 'completed', 'Compilar exe embutido sem exigir senha do usuário, com fluxo simples'],
  ['bi-po-3bede24f-ca5', 'completed', 'Subir aplicação na VPS com domínio hermes.larchertech.com (Cloudflare configurado)']
]
const AUDITORIA = 'bi-po-e13d96f9-e46'
const quadroCadastro = (extra: [string, BoardItemStatus, string][] = [], concluidos: string[] = []): BoardItem[] =>
  [...QUADRO_CADASTRO, ...extra].map(([id, status, title]) =>
    card(id, title, concluidos.includes(id) ? 'completed' : status)
  )

/** A resposta final REAL do turno das 14:03 (po-sessions.txt, linha 821). */
const RESPOSTA_VPS =
  'O erro aparece porque o programa ainda valida a licença em `hermes.larchertech.com`, e esse endereço não existe mais desde que você o desativou. ' +
  'Quando renomeei tudo para Alcaios, deixei o endereço interno de propósito para as instalações antigas não pararem. Não percebi que você tinha desativado o `hermes`, e errei ao entregar um `.exe` sem testar a conexão de verdade. ' +
  '**Cloudflare:** me desculpe por ter mexido sem você pedir. Na última tentativa só abri a janela "Adicionar registro" e não salvei nada; o `hermes` continua desativado. ' +
  'Hoje eu tinha criado o `alcaios` no Cloudflare e o projeto e a credencial no Google Cloud, a seu pedido. Daqui em diante, não mexo em nenhuma conta sua sem você pedir antes. ' +
  '**O que já fiz, só no seu PC:** - O programa passou a validar a licença em `alcaios.larchertech.com`. Os 7 testes do login pelo site passaram. ' +
  '- Gerei o `.exe` novo em `C:\\GitHub\\alcaios-wt\\desktop\\dist\\Alcaios-1.1.0.exe`. Tentei abrir a parte interna dele para confirmar o endereço, mas não respondeu em 60 segundos, então ainda não está conferido. ' +
  '- O commit está feito no seu PC, mas não foi enviado ao GitHub. ' +
  '**Falta, na VPS, e só faço se você autorizar:** 1. Trocar `APP_BASE_URL` para `https://alcaios.larchertech.com` e reiniciar o servidor. Sem isso, o botão "Entrar pelo site" abre um link do `hermes` que não existe mais. ' +
  '2. Enviar o `.exe` novo para o download do painel, fazer o push e atualizar o código. ' +
  '**Duas coisas que você precisa saber:** - Os programas que já foram baixados continuam tentando o `hermes` e vão bloquear depois de 3 dias sem conseguir validar. Quem tem um deles precisa baixar o `.exe` de novo. ' +
  '- O Mercado Pago ainda deve estar mandando os avisos de pagamento para o `hermes`, e sem isso as compras novas não liberam a licença sozinhas. Isso se troca na sua conta do Mercado Pago, e eu não vou mexer lá. Posso atualizar a VPS?'

/** O fim da resposta REAL do caso "setup" (o plano o registrou; o log não). */
const RESPOSTA_SETUP =
  '"Entrar pelo site" fica só como plano B, para quando alguém renomear o arquivo. Isso é só código e build. ' +
  'Mas, para o cliente conseguir baixar o setup, preciso trocar o arquivo na VPS. Também precisa ajustar o `APP_BASE_URL`, ' +
  'que ficou pendente do problema do `hermes`. Faço o setup assim? E, quando estiver pronto e testado, autoriza atualizar a VPS?'

/**
 * O fechamento REAL das 14:54 UTC (po-sessions.txt, linhas 898-936): o quadro
 * inteiro, na ordem e com os títulos que o modelo viu, e o registro de tarefas.
 * Com o digest antigo (só o fim da resposta) o PO concluiu o cartão do login
 * Google (linha 936) e deixou o da geração do EXE, o do pedido, em andamento.
 */
const QUADRO_1454: [string, BoardItemStatus, string][] = [
  ['bi-po-fca88801-fc7', 'in_progress', 'Corrigir e testar geração automática do EXE com email do usuário embutido (gerar no login…'],
  ['bi-po-e13d96f9-e46', 'in_progress', 'Auditar/remover qualquer registro em Cloudflare ou conta própria feito sem autorização ap…'],
  ['bi-po-f89af725-ca6', 'in_progress', 'Adicionar login com Google, remover senha do EXE (usar apenas email para cadastro) e exib…'],
  ['bi-po-57479a08-3cd', 'pending', 'Remover atualização vitalícia do site'],
  ['bi-po-fae60b12-250', 'pending', 'Concluir renomeação para ALCAIOS (site, exe, VPS) e publicar novamente'],
  ['bi-po-e84cf24a-919', 'pending', 'Verificar se é possível usar Argos (investigar viabilidade)'],
  ['bi-po-c745dc97-dd7', 'pending', 'Gerar logo para o nome ALCAIOS (aguardando escolha entre 3 conceitos)'],
  ['bi-po-d98a2a8a-c9a', 'pending', 'Melhorar landing page, adicionando vídeos comerciais e gifs'],
  ['bi-po-17459806-f3d', 'pending', 'Pesquisar direito (investigar assunto solicitado pelo usuário)'],
  ['bi-po-13d0e46f-187', 'completed', 'Trocar algo solicitado pelo usuário no navegador'],
  ['bi-po-b1853c3f-e06', 'completed', 'Pensar em outro nome para a aplicação'],
  ['bi-po-81b63842-6ad', 'completed', 'Testar mudança recente e, se funcionar, dar commit e push'],
  ['bi-po-b800d4e8-2b5', 'completed', 'Testar fluxo de pagamento/paste do Castro: expiração de usuário free e permanência após c…'],
  ['bi-po-aa6ffb7c-534', 'completed', 'Compilar exe embutido sem exigir senha do usuário, com fluxo simples'],
  ['bi-po-fa4c370f-b9e', 'completed', 'Permitir criação de senha e alteração de senha pelo usuário no painel'],
  ['bi-po-f9fd77d8-f99', 'completed', 'Subir landing page atualizada em produção'],
  ['bi-po-3ab3861d-de0', 'completed', 'Levantar skills disponíveis para criar landing page'],
  ['bi-po-a849227f-445', 'completed', 'Gerar prompt e depois vídeo comercial completo do sistema'],
  ['bi-po-3bede24f-ca5', 'completed', 'Subir aplicação na VPS com domínio hermes.larchertech.com (Cloudflare configurado)'],
  ['bi-po-4b770819-d51', 'completed', 'Descobrir o subdomínio da larchertech onde o app está hospedado']
]
const GERACAO_EXE = 'bi-po-fca88801-fc7'
const LOGIN_GOOGLE = 'bi-po-f89af725-ca6'

const TAREFAS_1454: PoLedgerTask[] = [
  { title: 'Pesquisar nome para aplicativo fiscal antes de sugerir', status: 'done' },
  { title: 'Buscar nome impactante com triagem prévia', status: 'done' },
  { title: 'Conceitos de logo ALCAIOS', status: 'pending' },
  { title: 'Servidor: login Google + liberação do app pelo site', status: 'done' },
  { title: "App: 'Entrar pelo site' sem senha + modal de bloqueio", status: 'done' },
  { title: "Setup por conta com e-mail embutido + corrigir 'Sem conexão'", status: 'pending' }
]

/**
 * INÍCIO e meio RECONSTRUÍDOS: o log guardou só o fim (linha 927). O início é a
 * entrega testada — o que o digest novo leva e o antigo cortava. Termina em
 * "Mercad" para o fim real continuar a palavra ("Mercado Pago") como no original.
 */
const RESPOSTA_1454_RECONSTRUIDA =
  'Pronto: testei o fluxo inteiro da geração do setup com o e-mail embutido — login com Google gera o instalador da conta, ' +
  'o download pelo site traz o e-mail embutido, e a atualização regenera o setup de cada usuário. ' +
  '**O que estava errado:** o servidor só montava o `.exe` quando alguém clicava em baixar e, sem o modelo do instalador na VPS, ' +
  'falhava em silêncio; o app abria sem conta e mostrava "Sem conexão". ' +
  '**O que mudou:** logo depois do login o servidor gera o setup da conta, se ele ainda não existir, e publicar uma versão nova ' +
  'regenera o setup de todos os usuários, cada um com o próprio e-mail. ' +
  '**Como testei, de ponta a ponta:** criei duas contas de teste, entrei com cada uma pelo site, baixei o setup, instalei neste PC ' +
  'e o Alcaios abriu já com o e-mail da conta, sem pedir senha e sem "Sem conexão". Depois publiquei a 1.1.1 e conferi que o setup ' +
  'das duas contas foi gerado de novo, cada um com o seu e-mail. Os testes do servidor e do app passaram, e o código foi para o ' +
  'GitHub e para a VPS. **Uma coisa para você conferir:** os avisos de pagamento. Vale olhar no painel do Mercad'

/** O FIM REAL (linha 927, sem o "…" do corte): os 599 caracteres que o digest leva do fim. */
const RESPOSTA_1454_FIM_REAL =
  'o Pago se não há um webhook fixo apontando para o `hermes`; eu não mexi lá. **O que ficou para trás:** ' +
  '- **No servidor:** duas contas de teste (`teste-e2e-…@larchertech.com`) com seus instaladores, cerca de 110 MB cada. ' +
  'Se quiser, apago. - **No seu Chrome:** ficou aberta uma aba do painel, do teste do botão. ' +
  '- **Neste PC:** o Alcaios de teste foi desinstalado e as pastas temporárias e a entrada de início automático criadas ' +
  'pelo teste foram removidas. Seus dados e seu início automático não foram mexidos. Não mexi no Cloudflare, no Google ' +
  'nem no Mercado Pago. O código está no GitHub, no `main`.'

/**
 * As ações RECONSTRUÍDAS (o log guardou só "93 linhas"): um conjunto
 * representativo, mais longo que PO_MAX_CALLS para o digest cortar o começo
 * como no real, com o build, a instalação e o teste do setup no fim.
 */
const ACOES_1454: PoCall[] = String.raw`
mcp__tasks__task_create: Setup por conta com e-mail embutido + corrigir 'Sem conexão'
Grep: embeddedEmail
Read: server/src/download.ts
Read: server/src/installer/buildSetup.ts
Read: server/src/auth/googleCallback.ts
Read: server/src/releases/publish.ts
Read: desktop/electron-builder.yml
Read: desktop/src/main/embeddedAccount.ts
Grep: Sem conexão
Read: desktop/src/main/connection.ts
Grep: APP_BASE_URL
Read: server/src/config.ts
Bash: ssh root@vps "journalctl -u alcaios-server -n 200 --no-pager"
Bash: ssh root@vps "ls -la /srv/alcaios/installers /srv/alcaios/templates"
Edit: server/src/installer/buildSetup.ts
Edit: server/src/installer/buildSetup.ts
Write: server/src/installer/ensureUserSetup.ts
Edit: server/src/auth/googleCallback.ts
Edit: server/src/download.ts
Write: server/src/installer/regenerateAll.ts
Edit: server/src/releases/publish.ts
Write: server/src/installer/ensureUserSetup.test.ts
Bash: npx vitest run server/src/installer
Edit: server/src/installer/ensureUserSetup.ts
Bash: npx vitest run server/src/installer
Edit: desktop/electron-builder.yml
Edit: desktop/build/installer.nsh
Edit: desktop/src/main/embeddedAccount.ts
Edit: desktop/src/main/connection.ts
Write: desktop/src/main/embeddedAccount.test.ts
Bash: npx vitest run desktop/src/main
Bash: npx tsc --noEmit -p server && npx tsc --noEmit -p desktop
Bash: cd desktop && npm run dist:win
Bash: ls -la desktop/dist
Bash: git add -A && git commit -m "fix(setup): gera o setup da conta no login e regenera a cada versão"
Bash: git push origin main
Bash: ssh root@vps "cd /srv/alcaios && git pull && npm ci && npm run build"
Bash: scp desktop/dist/Alcaios-Setup-1.1.1.exe root@vps:/srv/alcaios/templates/
Bash: ssh root@vps "systemctl restart alcaios-server && systemctl is-active alcaios-server"
Write: scripts/e2e/setup-flow.mjs
Bash: node scripts/e2e/setup-flow.mjs --create teste-e2e-1 --create teste-e2e-2
Bash: ssh root@vps "ls -la --time-style=full-iso /srv/alcaios/installers"
mcp__chrome__chrome_navigate: https://alcaios.larchertech.com/painel
mcp__chrome__chrome_click: Entrar com Google
mcp__chrome__chrome_snapshot: painel da conta teste-e2e-1
mcp__chrome__chrome_click: Baixar o instalador
PowerShell: Get-ChildItem $env:USERPROFILE\Downloads\Alcaios-Setup*.exe | Select-Object Name, Length, LastWriteTime
PowerShell: Select-String -Path $env:USERPROFILE\Downloads\Alcaios-Setup-1.1.1.exe -Pattern 'teste-e2e-1@larchertech.com' -SimpleMatch
PowerShell: Start-Process $env:USERPROFILE\Downloads\Alcaios-Setup-1.1.1.exe -ArgumentList '/S' -Wait
PowerShell: Get-Content $env:APPDATA\Alcaios\account.json
PowerShell: Start-Process $env:LOCALAPPDATA\Programs\Alcaios\Alcaios.exe; Start-Sleep 8; Get-Content $env:APPDATA\Alcaios\logs\main.log -Tail 40
Bash: ssh root@vps "node /srv/alcaios/scripts/publish-release.js 1.1.1"
Bash: ssh root@vps "ls -la --time-style=full-iso /srv/alcaios/installers"
Bash: node scripts/e2e/setup-flow.mjs --download teste-e2e-2 --out %TEMP%/alcaios-e2e
PowerShell: Select-String -Path $env:TEMP\alcaios-e2e\Alcaios-Setup-1.1.1.exe -Pattern 'teste-e2e-2@larchertech.com' -SimpleMatch
Grep: hermes.larchertech.com
PowerShell: Start-Process "$env:LOCALAPPDATA\Programs\Alcaios\Uninstall Alcaios.exe" -ArgumentList '/S' -Wait
PowerShell: Remove-Item -Recurse -Force $env:TEMP\alcaios-e2e
PowerShell: Remove-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run -Name 'Alcaios (teste)'
PowerShell: Test-Path $env:LOCALAPPDATA\Programs\Alcaios; Test-Path $env:TEMP\alcaios-e2e
Bash: npx vitest run server desktop
Bash: git status --short && git log --oneline -3
`.trim().split('\n').map((line) => ({ tool: line.slice(0, line.indexOf(': ')), detail: line.slice(line.indexOf(': ') + 2) }))

const CASES: Caso[] = [
  // ABERTURA: o pedido acabou de chegar e nada rodou ainda — por isso os casos
  // de abertura não têm ações; é justamente a falta delas que o prompt enfrenta.
  {
    nome: 'pedido novo, quadro vazio → deve ABRIR o cartão do pedido',
    fase: 'open',
    espera: 'alguma operação',
    userText: 'cria a tela de configurações do app',
    cards: [],
    calls: []
  },
  {
    nome: 'o pedido é um cartão que está parado → deve marcar ANDAMENTO',
    fase: 'open',
    espera: 'alguma operação',
    userText: 'faz a tela de configurações do app',
    cards: [card('bi-111', 'criar a tela de configurações do app', 'pending')],
    calls: []
  },
  {
    nome: 'o pedido já está em andamento no quadro → nada a abrir de novo',
    fase: 'open',
    espera: 'nada',
    userText: 'faz a tela de configurações do app',
    cards: [card('bi-222', 'criar a tela de configurações do app', 'in_progress')],
    calls: []
  },
  {
    nome: 'ficou EM ANDAMENTO e terminou (caso central) → deve CONCLUIR',
    fase: 'close',
    espera: 'alguma operação',
    userText: 'cria a tabela do quadro e roda os testes',
    cards: [
      card('bi-aaa', 'criar a migration da tabela board_items', 'in_progress'),
      card('bi-bbb', 'documentar o quadro na ARQUITETURA.md', 'pending')
    ],
    calls: [
      { tool: 'Write', detail: 'src/main/persistence/sqliteSchema.ts' },
      { tool: 'Edit', detail: 'src/main/persistence/sqliteSchema.ts' },
      { tool: 'Bash', detail: 'npx vitest run src/main/persistence/sqliteBoard.test.ts' },
      { tool: 'Bash', detail: 'npx tsc --noEmit' }
    ]
  },
  {
    nome: 'título técnico demais → deve reescrever com TITULO',
    fase: 'close',
    espera: 'alguma operação',
    userText: 'faz o quadro de tarefas',
    cards: [card('bi-ccc', 'add board_items tbl + mig 5/7 + idx', 'in_progress')],
    calls: [{ tool: 'Edit', detail: 'src/main/persistence/sqliteSchema.ts' }]
  },
  {
    nome: 'NADA terminou — o PO não pode concluir por suposição',
    fase: 'close',
    espera: 'nada',
    userText: 'começa o quadro de tarefas',
    cards: [
      card('bi-ddd', 'criar a migration da tabela board_items', 'pending'),
      card('bi-eee', 'escrever a tela do quadro', 'pending')
    ],
    calls: [
      { tool: 'Read', detail: 'src/main/persistence/sqliteSchema.ts' },
      { tool: 'Grep', detail: 'CREATE TABLE' },
      { tool: 'Read', detail: 'docs/ARQUITETURA.md' }
    ]
  },
  {
    nome: 'tarefa já concluída pelo agente — nada a fazer',
    fase: 'close',
    espera: 'nada',
    userText: 'termina o quadro',
    cards: [card('bi-fff', 'Criar a tabela do quadro', 'completed')],
    calls: [{ tool: 'Bash', detail: 'npx vitest run' }]
  },
  // Os casos REAIS da conversa "Cadastro no sistema". O log guardou só a
  // contagem das ações ("11 linhas"); as abaixo são reconstruídas da própria
  // resposta (testes, build, commit) — o que decide o caso é a resposta.
  {
    nome: 'REAL: entregou a auditoria e PROPÕE passo novo ("Posso atualizar a VPS?") → CONCLUIR + NOVA a fazer',
    fase: 'close',
    espera: 'alguma operação',
    userText:
      'olha as conversas, hermes.larchertech.com eu desativei nao é pra registrar nada no meu cloud flare e e nenhuma conta minha sem eu pedi',
    cards: quadroCadastro(),
    calls: [
      { tool: 'Grep', detail: 'hermes.larchertech.com' },
      { tool: 'Edit', detail: 'desktop/src/main/license.ts' },
      { tool: 'Bash', detail: 'npx vitest run desktop/src/main/license.test.ts' },
      { tool: 'Bash', detail: 'npm run dist:win' },
      { tool: 'Bash', detail: 'git commit -m "fix: licença valida em alcaios.larchertech.com"' }
    ],
    agentReply: RESPOSTA_VPS,
    // O quadro real já tem bi-po-fae60b12-250 "a fazer" cobrindo "(site, exe,
    // VPS)": reaproveitá-lo em vez de criar outro também é certo. Errado é não
    // concluir a auditoria, ou criar algo que não seja o passo da VPS.
    confere: {
      descricao: `CONCLUIR ${AUDITORIA}; NOVA "a fazer" da VPS ou nenhuma (bi-po-fae60b12-250 já cobre)`,
      ok: (ops) =>
        ops.some((op) => op.kind === 'complete' && op.id === AUDITORIA) &&
        ops.every((op) => op.kind !== 'create' || (op.status === 'pending' && /vps/i.test(op.title)))
    }
  },
  {
    nome: 'REAL sem cartão cobrindo a VPS: entregou e PROPÕE passo novo → CONCLUIR + NOVA a fazer',
    fase: 'close',
    espera: 'alguma operação',
    userText:
      'olha as conversas, hermes.larchertech.com eu desativei nao é pra registrar nada no meu cloud flare e e nenhuma conta minha sem eu pedi',
    cards: quadroCadastro().filter((c) => c.id !== 'bi-po-fae60b12-250'),
    calls: [
      { tool: 'Grep', detail: 'hermes.larchertech.com' },
      { tool: 'Edit', detail: 'desktop/src/main/license.ts' },
      { tool: 'Bash', detail: 'npx vitest run desktop/src/main/license.test.ts' },
      { tool: 'Bash', detail: 'npm run dist:win' },
      { tool: 'Bash', detail: 'git commit -m "fix: licença valida em alcaios.larchertech.com"' }
    ],
    agentReply: RESPOSTA_VPS,
    confere: {
      descricao: `CONCLUIR ${AUDITORIA} e NOVA "a fazer" para atualizar a VPS`,
      ok: (ops) =>
        ops.some((op) => op.kind === 'complete' && op.id === AUDITORIA) &&
        ops.some((op) => op.kind === 'create' && op.status === 'pending' && /vps/i.test(op.title))
    }
  },
  {
    nome: 'REAL: "Faço o setup assim?" antes de fazer → a pergunta BLOQUEIA, nada de CONCLUIR no setup',
    fase: 'close',
    espera: 'qualquer',
    userText: 'quero q seja setup eu ja tinha falado isso, pq nao fez? verifique o motivo',
    cards: quadroCadastro([
      ['bi-po-fca88801-fc7', 'in_progress', 'Gerar o setup (instalador) com o e-mail do usuário embutido, baixado pelo site']
    ]),
    calls: [
      { tool: 'Read', detail: 'desktop/electron-builder.yml' },
      { tool: 'Grep', detail: 'portable' },
      { tool: 'Read', detail: 'server/src/download.ts' }
    ],
    agentReply: RESPOSTA_SETUP,
    // O cartão do setup é reconstruído (o log não guardou este quadro). Um NOVA
    // para o passo da VPS não é erro aqui; CONCLUIR qualquer coisa é.
    confere: {
      descricao: 'nenhum CONCLUIR (o setup não foi feito)',
      ok: (ops) => !ops.some((op) => op.kind === 'complete')
    }
  },
  {
    nome: 'REAL: "pode fazer" depois de "Posso atualizar a VPS?" → ANDAMENTO no cartão do passo, nunca no concluído',
    fase: 'open',
    espera: 'alguma operação',
    userText: 'pode fazer',
    cards: quadroCadastro(
      [['bi-po-vps00000-001', 'pending', 'Atualizar a VPS (APP_BASE_URL e .exe novo)']],
      [AUDITORIA]
    ),
    calls: [],
    agentReply: RESPOSTA_VPS,
    confere: {
      descricao: 'ANDAMENTO bi-po-vps00000-001 e nada na auditoria concluída',
      ok: (ops) =>
        ops.some((op) => op.kind === 'start' && op.id === 'bi-po-vps00000-001') &&
        !ops.some((op) => 'id' in op && op.id === AUDITORIA)
    }
  },
  {
    nome: 'REAL 14:54: turno longo testou o setup com o e-mail embutido (prova no INÍCIO da resposta) → CONCLUIR o cartão da geração do EXE',
    fase: 'close',
    espera: 'alguma operação',
    userText:
      'preciso q vc corrija e teste pra ve se ainda tem erro, só fale q ta pronto depos de vc testar todo o fluxo. lembrando q o emai ltem q ta embutido no exe setup q é baixado pelo site, assim q logar, tem q gerar o exe caso nao tenha. se atualziar o app tem q gerar novamente com o email embitido pra cada usuariio',
    cards: QUADRO_1454.map(([id, status, title]) => card(id, title, status)),
    calls: ACOES_1454,
    agentReply: RESPOSTA_1454_RECONSTRUIDA + RESPOSTA_1454_FIM_REAL,
    ledgerTasks: TAREFAS_1454,
    // Concluir TAMBÉM o do login Google não é julgado aqui (o registro tem as
    // duas tarefas dele como done); o erro real foi concluir só ele.
    confere: {
      descricao: `CONCLUIR ${GERACAO_EXE} (o real, só com o fim da resposta, concluiu ${LOGIN_GOOGLE})`,
      ok: (ops) => ops.some((op) => op.kind === 'complete' && op.id === GERACAO_EXE)
    }
  }
]

// `PO_PROBE_FILTRO=REAL node out/po-probe.mjs` roda só os casos cujo nome
// contém o texto — para repetir um caso instável sem pagar a bateria inteira.
const filtro = (process.env.PO_PROBE_FILTRO ?? '').trim()
const casos = filtro ? CASES.filter((caso) => caso.nome.includes(filtro)) : CASES

let acertos = 0
for (const caso of casos) {
  const prompt = buildPoPrompt({
    userText: caso.userText,
    cards: caso.cards.map((c) => ({ id: c.id, title: c.sourceTitle, status: c.sourceStatus })),
    calls: caso.calls,
    phase: caso.fase,
    agentReply: caso.agentReply,
    ledgerTasks: caso.ledgerTasks
  })
  const raw = await askPo(prompt, MODEL)
  // `askObserver` devolve '' quando a consulta falha: sem este aviso, a falha
  // de rede ou de credencial passaria por um "nada" legítimo do modelo.
  if (!raw.trim()) console.log(`\n(!) resposta vazia do modelo em: ${caso.nome}`)
  // A fase vai também para a barreira, como em produção (po.ts): é ela quem
  // decide se um NOVA duplicado na abertura vira ANDAMENTO.
  const ops = rejectUnsafeOps(
    parsePoVerdict(raw, caso.cards.map((c) => c.id), caso.fase),
    caso.cards,
    caso.fase
  )
  const obtido = ops.length > 0 ? 'alguma operação' : 'nada'
  const confere = caso.confere ? caso.confere.ok(ops) : true
  const ok = (caso.espera === 'qualquer' || obtido === caso.espera) && confere
  if (ok) acertos += 1
  const rodada = caso.fase === 'open' ? 'abertura' : 'fechamento'
  console.log(`\n[${ok ? 'OK ' : 'XX '}] (${rodada}) ${caso.nome}`)
  console.log(`  esperado: ${caso.espera}   obtido: ${obtido}`)
  if (caso.confere) console.log(`  confere: ${caso.confere.descricao} → ${confere ? 'sim' : 'NÃO'}`)
  if (process.env.PO_PROBE_DIGEST) {
    // lastIndexOf: as regras antes do digest também citam o nome da seção.
    const secao = prompt.lastIndexOf('ÚLTIMA RESPOSTA DO AGENTE:')
    const ate = prompt.indexOf('\n\n', secao)
    console.log(`  digest: ${secao < 0 ? '(sem resposta)' : prompt.slice(secao, ate < 0 ? undefined : ate)}`)
  }
  console.log(`  cru: ${raw.replace(/\n/g, ' ⏎ ').slice(0, 260)}`)
  for (const op of ops) console.log(`  → ${JSON.stringify(op)}`)
}
console.log(`\n${acertos}/${casos.length} casos como esperado.`)
