---
id: "nota-diagnostico-resumo"
tipo: "nota"
titulo: "Diagnóstico: 5 buracos que explicam o travamento"
etapa: "diagnostico"
links: ["causa-1-falha-conta-como-sucesso","causa-2-silencio-so-avisa","causa-3-stop-descarta-fila","causa-4-cli-sai-codigo-zero","causa-5-duas-retentativas","nota-logs-existentes"]
fonte: "src/renderer/src/App.tsx:1179"
rev: 2
---
Leitura do código (commit 4c6ef6a, SDK 0.3.289). Cada buraco tem card próprio:

1. [[Causa 1: falha no meio do turno conta como sucesso]]: explica "o 2º item entrou antes de terminar".
2. [[Causa 2: silêncio só acende aviso, nunca vira erro]]: explica "trava e fica parado".
3. [[Causa 3: Stop descarta a fila inteira]]: explica "a fila se perde".
4. [[Causa 4: CLI que sai com código 0 deixa sessão zumbi]]: trava silenciosa, sem aviso de silêncio nas mensagens seguintes até cair no aviso de 60 s.
5. [[Causa 5: duas retentativas que não se conversam]]: o main reenvia o pedido original na hora, sem limite, e o renderer manda "continue" 60 s depois.

O que já existe e serve de base (não reinventar):
- vigia de silêncio no main (`src/main/stallWatch.ts`, `agentSession.ts:894-919`);
- recuperação com "Continue exatamente de onde parou" na mesma sessão (`App.tsx:2753-2815`), com cartão persistido em `conv.recovery` e timer refeito depois do reload;
- espera do fim real do turno antes de soltar a fila (`queueHandoff.ts` + `agent:wait-turn-end`);
- fila persistida em `conversation_outbox` (`useOutboxPersistence.ts`) e FIFO durável no main (`agent_input_queue`).

Sinais do SDK que o app **ignora** e que resolvem a classificação (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`):
- `result.terminal_reason` (`completed` vs `api_error`, `model_error`, `aborted_streaming`, `aborted_tools`, `turn_setup_failed`…; linha 9685) e `result.api_error_status`;
- `assistant.error` (marca a mensagem sintética "API Error: …"; linha 3618);
- `system/api_retry` (o CLI está retentando; linha 3589);
- `system/session_state_changed` (`idle` | `running` | `requires_action`; linha 5861).

**Pendente:** confirmar qual buraco pegou o usuário num travamento real (transcript ou log). Ver [[Logs: o que existe hoje (quase nada para sessão)]].
