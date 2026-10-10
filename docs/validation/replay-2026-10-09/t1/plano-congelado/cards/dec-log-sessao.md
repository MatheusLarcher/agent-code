---
id: "dec-log-sessao"
tipo: "decisao"
titulo: "Log de sessão: JSONL diário no main + stderr do CLI"
etapa: "logs"
status: "aceita"
links: ["nota-logs-existentes","req-identificar-erro"]
fonte: "node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2283"
rev: 2
---
**O quê:** um arquivo por dia, `<localDir>/logs/agent-sessions-AAAA-MM-DD.log` (mesma pasta do `auth-debug.log`), uma linha JSON por evento, retenção de 7 dias. Módulo pequeno e próprio (ex.: `src/main/sessionLog.ts`), sem dependência nova.

**Eventos** (só ids, tipos e motivos, nunca o conteúdo das mensagens):
- `turn_start` (convId, sessionId, turnId/uuid, origem, modelo, conta);
- `turn_end` com `outcome` + `reason` + `terminal_reason`/`api_error_status`/`subtype` crus do SDK;
- `api_retry` (attempt/max, status, error);
- `stall_warn` (o aviso de 60 s), `stall_abort`, `interrupt` (usuário ou automático) e se veio o recibo;
- `process_exit` (fim do iterador: código, sinal, ou "fim limpo") + **as últimas ~200 linhas do stderr do CLI**;
- `recovery_scheduled` / `recovery_sent` / `recovery_exhausted` (attempt, motivo, horário);
- `queue_dispatch` / `queue_hold` / `queue_drop` (convId, id do item, por quê).

**stderr:** passar o callback `stderr` do SDK em `query()` e guardar num buffer circular por sessão; o buffer vai para o log só em falha ou saída do processo, para não inchar o arquivo.

**Não** ligar `debug`/`debugFile` do CLI por padrão (verboso demais). Fica atrás de uma chave de config ou variável de ambiente para investigação pontual.

**Por quê:** hoje não há rastro nenhum de um travamento ([[Logs: o que existe hoje (quase nada para sessão)]]). Isto custa pouco e transforma o próximo "travou do nada" num motivo legível. Também é o que a validação vai ler para provar cada cenário.

**Renderer:** as decisões de fila e de retentativa acontecem no renderer, então elas também precisam chegar ao log, por um IPC fino `sessionLog.write`, validado no main (fronteira de sistema).
