---
id: "dec-um-dono-retentativa"
tipo: "decisao"
titulo: "Um dono só para a retentativa"
etapa: "retomada"
status: "aceita"
links: ["causa-5-duas-retentativas","req-retomar-de-onde-parou","dec-main-classifica-desfecho","amb-tentativas-esgotadas"]
fonte: "src/renderer/src/App.tsx:2753"
rev: 2
---
**O quê:** quem agenda e manda a retentativa é **só o renderer**, pelo mecanismo que já existe (`conv.recovery` persistido + `runRecovery`, `App.tsx:2753-2815`; o timer é refeito depois do reload). O main **nunca reempurra sozinho** um input que falhou:
- no handler do `result` (`agentSession.ts:2666-2678`), falha **não** volta o item a `pending` com `available_at = agora`. Ele fica retido (status próprio, ex.: `held`), sem bloquear e sem rodar, e é concluído quando o turno de retomada terminar `concluido` (ou quando o usuário pular ou limpar);
- no `recoverAgentInput` da subida da sessão, itens `processing` de um processo anterior também não são drenados às cegas ([[Turno em voo sobrevive ao reinício do app]]).

**Conteúdo da retentativa** (hoje é sempre a continuação, o que está errado num caso):
- turno **começou** no CLI (`turn-start`/eco do uuid; o renderer já marca `inflight.active`) → continuação na mesma sessão: "Continue exatamente de onde parou…";
- turno **não começou** (o CLI morreu antes de ler a mensagem) → reenviar a mensagem original, mesmo payload. Mandar "continue" aqui faria o modelo retomar a tarefa **anterior**.

**Ritmo** (decidido em [[Tentativas esgotadas: quanto insistir e o que fazer depois?]]):
- transitório (`api_error`, `overloaded`, `sem_resposta`, `processo_encerrado`, conexão) → **30 s → 1 → 2 → 5 → 10 → 15 min** (6 tentativas, ~33 min). Hoje são 60 s fixos e 5 tentativas (`turnRecovery.ts`: `GENERIC_RETRY_DELAY_MS`, `MAX_GENERIC_RETRIES`); trocar por uma tabela de esperas testada;
- limite de uso → espera o reset (já existe em `turnRecovery.ts`);
- fatal (`auth`, `billing`, `invalid_request`, `model_not_found`, `contexto_cheio` depois da compactação) → para, mostra o motivo, fila retida. Não gasta tentativas.

**Esgotou ou fatal:** fila retida, cartão com "Tentar de novo", "Pular esta tarefa" e "Limpar fila". Mensagem nova do usuário sai na hora como retomada guiada (mesma sessão) e **não** pula a tarefa: isso substitui o descarte do cartão com despacho da cabeça da fila de hoje (`stalledRecovery`, `App.tsx:2636-2671`). "Pular esta tarefa" conclui o item retido no main e solta a fila.

**Mantém:** a Regra 2 das tarefas MCP/Forgia (o app não repete turno de tarefa MCP; quem chamou decide, `App.tsx:1199-1233`).

**Por quê o renderer e não o main:** toda entrada de usuário já passa por ele (PC, celular via `onRemoteInbound` em `App.tsx:3021`, Central, tarefas MCP), e o cartão de recuperação, o limite de uso por provedor e o "Tentar de novo"/"Cancelar" do celular (`onRemoteRecoveryAction`) também moram lá. Levar tudo para o main seria mais robusto a reload do renderer, mas significa reescrever a fila do `App.tsx`: custo e risco altos para pouco ganho, porque `conv.recovery` já sobrevive ao reload.
