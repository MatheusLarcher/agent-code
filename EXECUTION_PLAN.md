# EXECUTION_PLAN — Auto-timeout das perguntas/permissões + barrinha + bugfix card

## Prompt Original (verbatim)
> pode fazer, mas aproveita, e corrige uma coisa, quando o usuario responder a pergunta do llm, aqui no chat aparece a tarefa q foi excutada, mas aparece com erro, mesmo o ususario repondendo corretamente.
>
> (contexto anterior) auto-resposta: quando o agent llm perguntar algo, se eu demorar muito, o llm responde automático — modal por no máximo 7 min; se demorar, fecha e o llm trabalha sem minha resposta. Barrinha embaixo, da direita pra esquerda.

## Decisões
- Pergunta (AskUserQuestion): timeout → prosseguir (modelo avisado "sem resposta em 7 min, siga com o mais sensato").
- Permissão de ferramenta: timeout → auto-NEGAR (seguro).
- Timeout autoritativo no main; barra no renderer guiada por `deadline`. 7 min fixo.

## Tarefas (todas concluídas)
- [x] Tarefa 1: Tipos + IPC (`deadline?`, canal `agentPermissionExpired`, `PermissionExpiredMsg`, preload + api).
- [x] Tarefa 2: Main — timeout no `agentSession.ts` + callback `onPermissionExpire` no `index.ts` (+ testes).
- [x] Tarefa 3: Renderer — App escuta `onPermissionExpired` e fecha o modal.
- [x] Tarefa 4: Barrinha — `CountdownBar` (direita→esquerda) nos dois modais + CSS.
- [x] Tarefa 5: Bugfix — `AskUserQuestion` não aparece como erro (MessageList + app.js do celular).
- [x] Tarefa 6: Validação — typecheck (node+web), build, test (45/45 OK).
