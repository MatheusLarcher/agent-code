---
id: "causa-4-cli-sai-codigo-zero"
tipo: "nota"
titulo: "Causa 4: CLI que sai com código 0 deixa sessão zumbi"
etapa: "diagnostico"
links: ["req-identificar-erro"]
fonte: "src/main/agentSession.ts:1447"
rev: 1
---
**Onde:** `src/main/agentSession.ts:1447-1471` (`consumeMessages`) e `src/main/index.ts:1728-1737` (reuso da sessão viva).

O SDK só lança erro quando o processo do CLI sai com código ≠ 0 ou por sinal (`getProcessExitError` em `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`). **Com código 0, o iterador simplesmente termina.** Nesse caso:
- não sai `result` nem `error`: o turno em curso fica "trabalhando" na tela para sempre;
- `queryDied` continua `false`, então `isAlive()` diz que a sessão está viva;
- o `connect` seguinte **reaproveita** essa sessão (`index.ts:1734`), e as mensagens seguintes são empurradas num `input` que ninguém mais lê. Somem em silêncio e só aparece o "Sem resposta" depois de 60 s.

Não confirmei que o CLI realmente sai com 0 no meio de um turno (precisaria do log). É barato fechar o buraco de qualquer jeito: fim do iterador fora do `dispose` = sessão morta + erro com motivo `processo_encerrado`.
