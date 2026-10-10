---
id: "nota-logs-existentes"
tipo: "nota"
titulo: "Logs: o que existe hoje (quase nada para sessão)"
etapa: "diagnostico"
links: []
fonte: "src/main/index.ts:1018"
rev: 1
---
**Não consegui ler os logs reais do usuário**: a pasta do app (`runs/t1-plan/userData`) e `~/.claude/projects` estão fora do que o Agent Manager pode ler. O diagnóstico abaixo vem do código, não de um log de travamento real.

O que o app grava hoje:
- `<localDir>/logs/auth-debug.log`: só autenticação (`src/main/index.ts:1018`).
- `<userData>/po-decisions.log` e `<userData>/postgres-pool-diagnostics.log`: PO e pool do Postgres.
- `console.warn` do main (`[agent-input-queue] ...`) vai para o stdout do Electron e **não fica em arquivo**.
- O **stderr do CLI não é capturado**: o SDK oferece `stderr` (callback) e `debugFile` (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2283-2293`) e o app não usa nenhum dos dois. Quando o CLI morre com código ≠ 0, só o "rabo" do stderr chega, dentro do texto do erro.

Onde ainda dá para investigar um travamento passado:
- o transcript JSONL da sessão do CLI (`<CLAUDE_CONFIG_DIR>/projects/<projeto>/<session>.jsonl`), que traz as mensagens sintéticas `API Error: ...` e o ponto exato em que parou;
- a tabela `agent_input_queue` (`last_error`, `attempt_count`) e as mensagens de erro da conversa no banco.

Consequência: sem a etapa de log, o próximo travamento continua sem rastro. Ver [[Diagnóstico: 5 buracos que explicam o travamento]].
