---
id: "dec-silencio-aborta"
tipo: "decisao"
titulo: "Silêncio além do limite aborta o turno e vira falha retomável"
etapa: "deteccao"
status: "aceita"
links: ["causa-2-silencio-so-avisa","req-identificar-erro","req-retomar-de-onde-parou","sug-watchdog-stream-cli"]
fonte: "src/main/stallWatch.ts:10"
rev: 2
---
**O quê:** o vigia que já existe ganha um segundo limiar, o de **abortar**:
- aviso "Sem resposta" continua igual (60 s sem ferramenta / 5 min com ferramenta);
- **abortar** em 3 min sem ferramenta em voo / 20 min com ferramenta em voo (constantes em `stallWatch.ts`, testadas como as de hoje);
- **nunca** aborta com permissão ou pergunta pendente esperando o usuário (`pendingPermissions.size > 0`): isso não é travamento.

**Como abortar** (a parte delicada):
1. `q.interrupt()` **sem** ligar `canceledPending`. Ligado, a próxima mensagem diria ao modelo para desconsiderar o pedido cancelado, o oposto de "continue de onde parou" (`agentSession.ts:1807`);
2. sem recibo em `INTERRUPT_ACK_TIMEOUT_MS`, fechar a query (`q.close()` mata o CLI) e marcar a sessão morta (`queryDied`), para o próximo `connect` subir outra com `resume`;
3. emitir `error` com `outcome: 'falhou'`, `reason: 'sem_resposta'` e os `turnIds` do turno, e gravar `stall_abort` no log.

**Por quê:** é o único jeito de "identificar que foi erro" quando o CLI não manda erro nenhum. A partir daí, o fluxo de retomada é o mesmo de qualquer falha transitória ([[Um dono só para a retentativa]]).

**Risco:** ferramenta legítima e longa, sem saída nenhuma por mais de 20 min (build gigante, emulador). Se acontecer, ela é abortada e retomada, e a retomada reexecuta. Os 20 min são folga sobre o teto do Bash (10 min).
