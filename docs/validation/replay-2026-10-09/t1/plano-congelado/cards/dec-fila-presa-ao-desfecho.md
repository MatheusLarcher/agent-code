---
id: "dec-fila-presa-ao-desfecho"
tipo: "decisao"
titulo: "Fila presa ao desfecho: só 'concluido' solta o próximo item"
etapa: "avanco-fila"
status: "aceita"
links: ["req-segundo-item-so-no-fim-real","causa-1-falha-conta-como-sucesso","dec-main-classifica-desfecho","dec-stop-pausa-fila","amb-tentativas-esgotadas"]
fonte: "src/renderer/src/App.tsx:1295"
rev: 2
---
**O quê:** no handler de terminal do `App.tsx` (1145-1300), a decisão "falhou × concluiu" passa a ser `e.outcome` vindo do main ([[O main classifica o desfecho de cada turno]]). A heurística `responseReceived` sai do cálculo de `failed` (`App.tsx:1178-1179`).

O próximo item só é despachado quando **as três** condições valem:
1. o desfecho do turno é `concluido`;
2. o main confirmou o fim real (`queueHandoff.after` / `agent:wait-turn-end`, que já existe);
3. a fila **não** está pausada ([[Stop pausa a fila, nunca descarta]]).

Por desfecho:
- `falhou` → fila retida enquanto a retentativa roda; com tentativas esgotadas ou erro fatal, continua retida até o usuário agir ([[Tentativas esgotadas: quanto insistir e o que fazer depois?]]);
- `interrompido` (Stop) → fila pausada.

**Mensagem nova com a recuperação parada** (`stalledRecovery`, `App.tsx:2636-2671`): hoje ela descarta o cartão e despacha a **cabeça da fila**, o que pula a tarefa que falhou. Passa a sair na hora como retomada guiada da tarefa, e a fila espera. Pular vira o botão "Pular esta tarefa".

**Fora disto:** tarefas MCP/Forgia que terminam em erro seguem a Regra 2 (a fila anda, quem chamou decide reenviar).
