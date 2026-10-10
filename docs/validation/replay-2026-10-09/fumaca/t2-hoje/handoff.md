<!-- prompt 1 -->
# Handoff — PO do quadro: pergunta de próximo passo, veredito atrasado e digest de turno longo

Projeto: `D:\agent-code-replay\t2\agent-code` (Electron + React + TypeScript). Código conferido no commit `742883d`.
Plano (consulte, não replaneje): `D:\agent-code-replay\runs\fumaca-t2-hoje\agent-code\planning\agent-code\plano-20260929-1246`. O roteiro está em `_roteiro.md` e os cards em `cards/`. Se algo do plano parecer errado ou impossível, pare e pergunte ao usuário em vez de mudar o rumo por conta própria.

## Antes de começar (obrigatório)

1. Declare as etapas como plano (TodoWrite ou TaskCreate): um item por etapa, nesta ordem, com o id entre colchetes no início:
   - `[po-perguntas] PO distingue pergunta que bloqueia a tarefa de pergunta sobre um próximo passo`
   - `[po-espera] O fim do turno não rebaixa o card antes de o PO terminar de analisar`
   - `[validacao] Validar com a conversa real (Cadastro no sistema) e com testes`
2. Tempo, sem exceção, em cada etapa:
   - Ao começar: registre a sua estimativa com `mcp__entregas__entrega_estimar` e escreva no chat `Etapa N — <título>: estimativa do plano X min (prazo), minha estimativa Z min`. Exemplo: `Etapa 1 — PO distingue pergunta que bloqueia a tarefa de pergunta sobre um próximo passo: estimativa do plano 40 min (prazo), minha estimativa Z min`.
   - Ao concluir: consulte `mcp__entregas__entrega_tempo` e escreva `levou Y min de trabalho (dentro/fora do prazo)`. Se passou do prazo, diga o motivo.
   - O prazo é a estimativa do plano (tabela abaixo). A sua estimativa não muda o prazo, e o tempo que vale é o medido pelo app.

## Etapas e estimativas

| # | Etapa | Estimativa do plano (min de trabalho do agente) |
|---|---|---|
| 1 | `po-perguntas`: PO distingue pergunta que bloqueia a tarefa de pergunta sobre um próximo passo | 40 |
| 2 | `po-espera`: O fim do turno não rebaixa o card antes de o PO terminar de analisar | 45 |
| 3 | `validacao`: Validar com a conversa real (Cadastro no sistema) e com testes | 45 |
| | **Total deste prompt** | **130 min (2 h 10 min)** |

## Objetivo

O PO é o agente que audita o quadro de tarefas em duas rodadas por turno: na abertura, o pedido vira cartão; no fechamento, o que terminou é concluído. Na conversa "Cadastro no sistema" (`cmued62agtb72r`, 10:54–12:51) ele errou de dois jeitos, e este trabalho corrige os dois.

1. **Pergunta de próximo passo travava o CONCLUIR.** Qualquer pergunta no fim da resposta do agente ("posso aplicar?") impedia o CONCLUIR. Isso valia até quando o pedido já tinha sido entregue e a pergunta só propunha um passo NOVO ("posso atualizar a VPS?").
   - Depois da correção: o PO conclui o card do pedido e abre um card "a fazer" para o passo proposto. O "pode fazer" seguinte põe esse card novo em andamento.
2. **Turno longo: rebaixamento antes do veredito e card errado.** O fechamento do turno espera o PO por no máximo 30 s (`PO_WAIT_MS`), mas o PO levou 54 s (11:54) e 46 s (12:51). Com isso, o `reopenStale` rebaixou o card do EXE para "a fazer" antes do veredito. Além disso, o PO concluiu o card errado (o do login Google): em turno longo, ele só vê as últimas 60 ações e os últimos 600 caracteres da resposta.
   - Depois da correção: o veredito atrasado do PO prevalece sobre o rebaixamento, e o teto continua em 30 s. O digest de turno longo passa a levar o início e o fim da resposta final e as tarefas `[done]` do registro.

## Mapa do código (conferido)

| Onde | O que é |
|---|---|
| `src/main/po/poPrompt.ts:99-134` | `PO_SYSTEM_PROMPT_OPEN` (abertura). Regra de CONTINUAÇÃO em :118-121; uso da ÚLTIMA RESPOSTA (a do turno anterior) em :130-133 |
| `src/main/po/poPrompt.ts:136-183` | `PO_SYSTEM_PROMPT_CLOSE` (fechamento). Exigência de evidência em :157-161; **a regra a mudar** em :162-164 (resposta que termina pedindo decisão → não conclui); regra de NOVA em :174-176; tarefas `[done]` do registro como evidência em :180-182 |
| `src/main/po/poPrompt.ts:42, 58-82` | `PO_COOLDOWN_MS` (60 s por fase); tetos do digest: `PO_MAX_CALLS` 60, `PO_MAX_LEDGER_TASKS` 15, `PO_MAX_REPLY_CHARS` 600 (corta pelo início) |
| `src/main/po/poPrompt.ts:190-194, 229-276` | `clampTail` e `buildPoDigest` (a resposta entra em :263-264; a seção do registro em :267-274) |
| `src/main/po/poPrompt.ts:302-363, 383-460` | `parsePoVerdict` (por fase) e `rejectUnsafeOps`. `start` só passa em card `pending` (:440-446); CONCLUIR só passa no que não está concluído (:457) |
| `src/main/po/po.ts:134-161` | `Po.observe`: acumula as ações e descarta as que passam de 60 **sem contar** (:137-140) |
| `src/main/po/po.ts:326-526` | `Po.run`. Gate em :405-416: recebe pedido, quadro, ações e registro, mas **não recebe a resposta**. Prompt em :418-425. As ops são aplicadas em :461-498 contra a lista de cards lida ANTES da consulta ao modelo |
| `src/main/po/poQueue.ts` | `PoTurnSnapshot`, `defer`, `mergeDeferred` (corta para as últimas 60 ações) |
| `src/main/po/poLedger.ts:48-61` | `listConvTasks`: chama `listTasks({ conversationId, limit: 15 })` |
| `src/main/persistence/sqliteRepository.ts:1322` / `postgresRepository.ts:1544` | `listTasks` ordena por `created_at, id` **ascendente**: com mais de 15 tarefas na conversa, o PO vê as 15 mais antigas |
| `src/main/typesafe/boardGate.ts:23-35, 37-72, 92-95, 141-157` | `BoardGateInput` (sem a resposta do agente), conta dos tetos do `state`, `BOARD_GATE_CLOSE_QUESTION`, `buildBoardGateState` |
| `src/main/board/boardService.ts:47, 212-255` | `PO_WAIT_MS` = 30 s. Sequência: `closeTurn` → `settled` → `waitForPo` (com teto) → `reopenStale`, que rebaixa o que está em andamento, com corte por `closedAt` |
| `src/main/board/boardService.ts:278-302` | `resumeTurn`/`promoteReopened`: quando chega a mensagem do usuário, promove de volta só o que o fim de turno rebaixou |
| `src/main/board/boardModel.ts:161-212` | `boardItemsToReopen`, `boardItemsToReopenBefore` e `boardItemsToResume` |
| `src/shared/ipc.ts:190-205` | `BOARD_TURN_END_REASON` e `boardItemTurnEndKind`: o card só conta como "rebaixado pelo fim de turno" se tiver esse motivo |
| `src/main/persistence/sqliteRepository.ts:1142-1188` (e `postgresRepository.ts:1052+`) | `applyBoardPo`: grava sem guarda de versão ou de tempo (a última escrita vence) e registra `status_changed` em `board_item_events` |
| `src/main/po/poLog.ts` | Diário `po-decisions.log` em `<userData>`, ou no caminho de `AGENT_CODE_PO_LOG_FILE`. Uma linha JSON por rodada, com `phase`, `outcome` (`ops=N`, `ok`, `gate-nao`, `cooldown`, `falha`…), `durationMs` e `cards` |
| Testes | `src/main/po/poPrompt.test.ts`, `src/main/typesafe/boardGate.test.ts`, `src/main/board/boardService.test.ts` e `src/main/board/boardResume.sqlite.test.ts`. Este último é um replay com SQLite real + `Po` + `BoardService` e modelo roteirizado via `ask`; o harness está em :26-68 |

## Etapa 1 — `[po-perguntas]` PO distingue pergunta que bloqueia a tarefa de pergunta sobre um próximo passo (40 min)

**Card:** [[PO conclui a tarefa e abre card para o próximo passo perguntado]] (requisito, `cards/requisito-po-conclui-a-tarefa-e-abre-card-para-o-proximo.md`).

**Requisito (do card):**
- Hoje, no fechamento, qualquer pergunta no fim da resposta ("posso aplicar?") impede o PO de usar CONCLUIR.
- O PO passa a separar dois tipos de pergunta:
  - **Bloqueia a tarefa atual:** falta um dado, uma escolha entre opções ou uma confirmação sem a qual o pedido não está entregue. Não conclui, como hoje.
  - **Propõe um passo NOVO:** o pedido foi entregue e o agente pergunta se faz outra coisa ("posso atualizar a VPS?", "quer que eu gere o instalador?"). O PO usa CONCLUIR no card do pedido e NOVA para o passo proposto. O card novo nasce "a fazer", com título claro e o motivo "aguardando sua autorização".
- Critério para decidir: o pedido do usuário foi atendido, e as AÇÕES ou a resposta provam isso?
- Na abertura seguinte, o "pode fazer" do usuário move o card NOVO para "em andamento" (ANDAMENTO), sem reabrir o card concluído.

**O que fazer:**
1. **`PO_SYSTEM_PROMPT_CLOSE`:**
   - Troque a regra de :162-164 pelas duas categorias, com um exemplo de cada caso e o critério acima.
   - Mantenha a exigência de evidência (:157-161): concluir o que não terminou continua sendo o pior erro.
   - Ajuste a regra de NOVA (:174-176) para aceitar explicitamente o passo que o AGENTE propôs na resposta, com o motivo "aguardando sua autorização". Ela não pode abrir espaço para o PO inventar uma tarefa que ele próprio acha boa ideia.
   - Use o verbo NOVA que já existe; o plano não prevê verbo novo.
2. **`BOARD_GATE_CLOSE_QUESTION` (`boardGate.ts:92-95`)** precisa considerar esse caso. Atenção: o gate **não vê a resposta do agente** (`BoardGateInput` em :23-35; a chamada está em `po.ts:405-411`). Uma pergunta que está só no texto da resposta é invisível para ele.
   - Escolha a mudança mínima que impeça o gate de dispensar o caso "pedido entregue + passo novo proposto".
   - Se incluir a resposta no `state`, corte-a antes de sair da máquina, como os outros campos, e refaça a conta dos tetos (comentário em :37-58). O teste mantém `BOARD_GATE_MAX_STATE_CHARS` em dia.
3. **Abertura:** confira que a regra de CONTINUAÇÃO (`poPrompt.ts:118-121`) e a da ÚLTIMA RESPOSTA (:130-133) levam o "pode / pode fazer / sim", em resposta a "posso <passo>?", à ANDAMENTO no card do passo proposto.
   - Já garantido por código: `rejectUnsafeOps` só aceita `start` em card `pending` (:440-446), então o card concluído não reabre.
   - A promoção determinística (`resumeTurn`) **não** pega o card novo, porque o motivo dele não é o de fim de turno (`boardItemTurnEndKind`). Quem promove o card novo é a ANDAMENTO da abertura.

**Testes:**
- **`poPrompt.test.ts`, com as respostas reais da conversa "Cadastro no sistema"** (`cmued62agtb72r`, 10:54–12:51):
  - "…Posso atualizar a VPS?" depois do pedido entregue → CONCLUIR + NOVA ("Atualizar a VPS", a fazer).
  - "Faço o setup assim?" antes de fazer → nada de CONCLUIR (a pergunta bloqueia o pedido).
  - O teste unitário só prova o que é determinístico:
    - o prompt traz a regra e os exemplos;
    - `parsePoVerdict` + `rejectUnsafeOps` transformam "CONCLUIR <id> | … / NOVA | Atualizar a VPS | aguardando sua autorização" em `complete` + `create` com status `pending` e esse motivo;
    - o digest leva a resposta real.

    O julgamento do modelo só é provado na etapa 3.
- **`boardResume.sqlite.test.ts`** (replay com modelo roteirizado): o fechamento responde CONCLUIR + NOVA; o usuário diz "pode fazer"; a abertura dá ANDAMENTO no card novo. O card do pedido continua concluído e não há card duplicado.
- **Onde estão as respostas reais:** no banco do app. Pode ser o SQLite `agent-code.db` na pasta de cache do app (tabelas `conversations_v2` e `sdk_session_entries_v2`) ou o PostgreSQL configurado. Só leitura. Se não encontrar, peça os textos ao usuário; não invente texto e chame de real.
- **Testes existentes que vão mudar** (atualize de propósito, sem apagar a intenção deles):
  - `poPrompt.test.ts:68-72` procura o texto da regra antiga ("termina pedindo uma decisão … NÃO use CONCLUIR").
  - `boardGate.test.ts:131-133` procura 'status errado' e "não só quando o turno foi conversa".
- Os replays "caso 1 completo" e "caso 2" (`boardResume.sqlite.test.ts:114-165`) continuam válidos e servem de exemplo de pergunta que **bloqueia**: "Qual você prefere que eu detalhe?" e "Posso corrigir?" num card "Investigar e corrigir…", em que corrigir faz parte do pedido.

**Pronta quando:** os testes acima passam e `npm run typecheck` está verde.

## Etapa 2 — `[po-espera]` O fim do turno não rebaixa o card antes de o PO terminar de analisar (45 min)

**Cards:** [[Fechamento do turno espera o PO antes de rebaixar]] (requisito, fonte `src/main/board/boardService.ts:230`) e [[Veredito atrasado do PO prevalece sobre o rebaixamento; digest com mais evidência]] (decisão).

**Leia antes:** o título da etapa foi escrito antes da decisão. **Vale a decisão:** `PO_WAIT_MS` continua em 30 s, o rebaixamento pode acontecer antes do veredito, e o veredito que chega depois prevalece. Não aumente o teto.

**Decisão (do card), com o porquê:**
1. Um CONCLUIR, TITULO ou FEITA do PO que chega depois do `reopenStale` vale: sobrescreve o "a fazer" que o fim do turno gravou. O `PO_WAIT_MS` continua em 30 s, para o quadro não atrasar.
2. Em turno longo, o digest do fechamento leva o início e o fim da resposta final (em vez de só os últimos 600 caracteres) e as tarefas `[done]` do registro. Assim o PO não conclui o card errado, como aconteceu às 11:54.
- Por quê: resolve a causa sem deixar o quadro mentindo por mais tempo. A alternativa descartada era subir o teto para ~90 s.

**Parte 1 — veredito atrasado. Comece pelo teste.**

Pelo código, um CONCLUIR atrasado provavelmente já vence. Dois motivos: `applyBoardPo` grava sem guarda (a última escrita vence), e o `Po` aplica as ops contra a lista lida antes da consulta ao modelo, quando o card ainda estava em andamento. Escreva o teste primeiro: se ele passar sem mudar código, esta parte é só a regressão. Se falhar, corrija o mínimo.
- **`boardService.test.ts`:** o PO responde em 50 s com o teto em 30 s; o rebaixamento acontece, e o CONCLUIR que chega depois deixa o card "concluída".
  - Escalone o tempo (ex.: teto de 30 ms e PO de 50 ms) ou use fake timers. O teste não pode esperar 50 s de verdade.
  - O fake `boardRepo` (:68-79) só registra as escritas. Para conferir o estado final, use um fake com estado.
- **Replay `boardResume.sqlite.test.ts`**, com o `applyBoardPo` de verdade. O harness usa `poWaitMs: 2_000` (:37); deixe esse valor configurável para o teste não ficar lento.
  - Um `ask` que responde CONCLUIR depois do teto deixa o status final `completed`.
  - Em `listItemEvents`, a sequência é: em andamento → a fazer (fim de turno) → concluída (PO), e nada depois disso.
- Cubra também TITULO e FEITA atrasados: o título é aplicado, e o card FEITA é criado como concluído.
- **Corrida a conferir:** o usuário responde ENTRE o rebaixamento e o veredito atrasado. O `resumeTurn` promove o card de volta; mesmo assim, o CONCLUIR que chega depois deve deixá-lo concluído, e o fim do turno seguinte não o reabre.

**Parte 2 — digest de turno longo.**
- **Definição de "turno longo":** mais de `PO_MAX_CALLS` (60) ações, como no critério de aceite.
  - Hoje o digest não sabe disso: `Po.observe` descarta as ações excedentes sem contar (`po.ts:137-140`), e `mergeDeferred` corta para as últimas 60.
  - Guarde a contagem (ex.: no `PoTurnSnapshot`, somada em `defer`/`mergeDeferred`) e entregue-a ao `buildPoDigest`.
- **Resposta final:** hoje o digest leva `clampTail(reply, 600)`.
  - Em turno longo, leve o início e o fim, com um marcador de corte no meio e teto FIXO: o custo do digest não pode crescer com a conversa (`poPrompt.ts:58`).
  - Turno curto continua como hoje, e o teste `poPrompt.test.ts:59-66` segue valendo para ele.
- **Tarefas `[done]`:** a seção "TAREFAS DO REGISTRO NESTA CONVERSA" já existe, mas `listConvTasks` pede `limit: 15` e `listTasks` ordena do mais antigo para o mais novo. Numa conversa com mais de 15 tarefas, as `[done]` recentes ficam de fora.
  - Garanta que as `[done]` mais recentes entrem, dentro do teto `PO_MAX_LEDGER_TASKS` (15).
  - Resolva no PO (`poLedger.ts` ou o digest). Não mude a ordenação de `listTasks`, que tem outros consumidores (`taskReaper`, `taskBoard`, `taskTools`).
  - O critério de aceite cobra isso no turno longo. Se aplicar a todo fechamento for mais simples, pode — diga no relatório.
- **Teste (critério de aceite):** o digest de um turno com mais de 60 ações inclui o início e o fim da resposta e as tarefas `[done]`, sem passar do teto de tamanho.
- **Tamanho de arquivo** (regra do AGENTS.md: menos de 500 linhas):
  - `po.ts` já tem 530 linhas. Não o aumente; ponha a lógica nova em `poQueue.ts`, `poPrompt.ts` ou `poLedger.ts`.
  - `poPrompt.ts` tem 460. Se passar de 500 com as regras novas, mova os prompts para um módulo próprio e reexporte de `poPrompt.ts`.

**Pronta quando:** os testes das partes 1 e 2 passam e `npm run typecheck` está verde.

## Etapa 3 — `[validacao]` Validar com a conversa real (Cadastro no sistema) e com testes (45 min)

**Card:** [[Critérios de aceite e testes]] (requisito, `cards/requisito-criterios-de-aceite-e-testes.md`).

1. **Typecheck, testes e build:** `npm run typecheck`, `npm test` e `npm run build` precisam passar. O build inclui o binário .NET de controle do Windows e precisa do dotnet SDK. Se faltar algo no ambiente, diga isso; não pule a etapa em silêncio.
2. **Revalidação real no app.** A Definition of Done do usuário exige rodar o app e exercitar a mudança no fluxo real; teste verde não basta.
   - Preparação: PO ligado nas configurações, modelo disponível, num projeto de teste.
   - Para achar o diário com facilidade, suba o app com `AGENT_CODE_PO_LOG_FILE` apontando para um arquivo conhecido.
   - Deixe mais de 60 s entre mensagens. O cooldown do PO é de 60 s por fase (`PO_COOLDOWN_MS`); dentro dele a rodada é adiada e parece falha.
   - **Turno longo**, parecido com o das 11:54: um pedido que gere mais de 60 ações e cuja resposta final entregue o resultado.
     - No `po-decisions.log`, confira a rodada `close` (`outcome`, `durationMs`, `cards`).
     - Em `board_item_events`, confira que o card CERTO termina concluído e que nenhum card errado é concluído.
     - "Sem vai-e-vem" quer dizer: depois do CONCLUIR, o card não muda mais de status. Se o PO passar de 30 s, um rebaixamento intermediário (em andamento → a fazer → concluída) é o comportamento esperado pela decisão.
   - **Pergunta de próximo passo:**
     - Um pedido entregue cuja resposta termine com "posso <passo novo>?" deve deixar o card do pedido concluído e criar um card novo "a fazer", com o motivo "aguardando sua autorização".
     - Responda "pode fazer": o card novo vai para em andamento, e o concluído continua concluído.
     - Contraste: uma pergunta que bloqueia ("faço assim?", antes de fazer) não gera CONCLUIR.
   - Use passos propostos INOFENSIVOS. "Atualizar a VPS" e "gerar o instalador" são só os exemplos da conversa original: não dispare deploy, VPS, publicação nem nada fora do projeto de teste.
3. **Evidência:** registre no relatório as linhas do diário e os eventos dos cards.

## Critérios de aceite (consolidados, do card [[Critérios de aceite e testes]])

**PO: perguntas**
- Testes em `poPrompt.test.ts` com as respostas reais da conversa "Cadastro no sistema" (`cmued62agtb72r`, 10:54–12:51):
  - "…Posso atualizar a VPS?" depois do pedido entregue → CONCLUIR + NOVA ("Atualizar a VPS", a fazer).
  - "Faço o setup assim?" antes de fazer → nada de CONCLUIR (a pergunta bloqueia o pedido).
- O "pode fazer" seguinte move o card NOVO para "em andamento" e não reabre o card concluído.

**PO: espera e evidência**
- `boardService.test.ts`: o PO responde em 50 s com o teto em 30 s. O rebaixamento acontece, e o CONCLUIR que chega depois deixa o card "concluída".
- O digest de um turno com mais de 60 ações inclui o início e o fim da resposta e as tarefas `[done]`, sem passar do teto de tamanho.
- Revalidação real: rodar um turno longo parecido com o das 11:54 e conferir no `po-decisions.log` e em `board_item_events` que o card certo termina como concluído, sem vai-e-vem.

**Gerais**
- `npm run typecheck`, `npm test` e `npm run build` passam.

## Sugestões e ambiguidades

- Sugestões registradas no plano: nenhuma.
- Ambiguidades registradas como card: nenhuma. Duas leituras deste handoff vêm direto da decisão. Se discordar de alguma, pergunte ao usuário antes de mudar:
  1. O título da etapa `po-espera` fala em "não rebaixar antes do PO", mas a decisão manda manter o teto de 30 s e deixar o veredito atrasado prevalecer. Vale a decisão.
  2. "Sem vai-e-vem" na revalidação real quer dizer: depois do CONCLUIR, o card não muda mais. O rebaixamento intermediário quando o PO passa de 30 s é esperado; o próprio critério do `boardService.test.ts` diz "o rebaixamento acontece".

## Riscos

1. **Fronteira entre bloqueio e passo novo.** "Diagnóstico pronto. Posso corrigir?" bloqueia se o pedido era "investiga e corrige", mas é passo novo se o pedido era só "investiga". Os exemplos do prompt precisam deixar essa diferença clara: um erro aqui conclui trabalho que não terminou.
2. **Gate cego para a resposta.** Num turno sem ações (só resposta) que entrega o pedido e propõe um passo novo, o gate pode responder "não", e aí o PO nem roda. Veja a etapa 1, item 2.
3. **Card novo depende só da ANDAMENTO da abertura.** Se a abertura falhar (gate, cooldown ou modelo), o card novo fica "a fazer" enquanto o agente trabalha nele. Um fallback determinístico, como o `resumeTurn`, está fora do escopo deste plano: se observar o problema, registre no relatório e não implemente sem perguntar.
4. **Corrida entre a resposta do usuário e o veredito atrasado.** Se o usuário responder antes de o fechamento criar o card NOVA, a abertura não vê esse card e pode criar outro para o mesmo passo, com título diferente (o dedupe é só por título normalizado). Verifique no replay; se duplicar, relate.
5. **Testes de prompt não provam o julgamento do modelo.** Só a revalidação real prova.
6. **Tetos fixos.** O digest e o `state` do gate têm teto fixo de propósito, por causa do custo e do limite de 32k tokens do gate. Se mudar um teto, refaça a conta.

## Regras do projeto

- Comandos: `npm run typecheck` (node + web), `npm test` (vitest) e `npm run build` (electron-vite + binário .NET). Rode typecheck e testes depois de cada mudança e confira o build antes de qualquer commit.
- Arquivos com menos de 500 linhas. Valide a entrada nas fronteiras do sistema. Arquivos de trabalho ficam fora da raiz do repositório.
- Nunca commite segredos, credenciais nem `.env`. Commit e push só se o usuário pedir; se pedir, sem trailer `Co-Authored-By`.
- Não mexa nas dependências (package.json, lockfile) nem no banco real compartilhado (PostgreSQL) sem perguntar.
- Definition of Done do usuário: typecheck e testes verdes NÃO são "pronto". Só diga "pronto" ou "funcionando" depois de exercitar a mudança no app de verdade. Se não conseguir validar, diga isso explicitamente.

## Mídias

Nenhuma mídia no plano (a pasta `midia/` está vazia).

## Relatório final

Para cada etapa, informe:
- o que mudou (arquivos);
- os testes criados ou alterados;
- a linha de tempo: prazo × tempo medido pelo `mcp__entregas__entrega_tempo`;
- as escolhas de implementação que o plano não fixou: contagem do turno longo, formato do início+fim, mudança no gate, filtro das `[done]`;
- a evidência da revalidação real: linhas do `po-decisions.log` e eventos dos cards;
- quais dos riscos acima se confirmaram.
