---
id: "causa-2-silencio-so-avisa"
tipo: "nota"
titulo: "Causa 2: silêncio só acende aviso, nunca vira erro"
etapa: "diagnostico"
links: ["req-identificar-erro","req-retomar-de-onde-parou"]
fonte: "src/main/agentSession.ts:894"
rev: 1
---
**Onde:** `src/main/stallWatch.ts` (60 s sem ferramenta / 5 min com ferramenta em voo) e `src/main/agentSession.ts:894-901` (`checkStall`).

Ao passar do limite, o main só emite `stall-status` e o renderer mostra "Sem resposta há X" (`ChatPanel.tsx:76-90`). **Nada aborta nem retoma.** O turno fica "trabalhando" para sempre, a fila fica parada atrás dele e a única saída é o Stop, que hoje descarta a fila ([[Causa 3: Stop descarta a fila inteira]]).

Causas típicas de silêncio:
- stream da API pendurado sem fechar (o CLI tem um watchdog próprio para isso, `CLAUDE_ENABLE_STREAM_WATCHDOG`, que é tri-estado: o padrão quem decide é o CLI);
- ferramenta MCP do app que não volta (navegador, Android, Windows);
- CLI travado.

Detalhe: o vigia só conta mensagens do SDK como sinal de vida. O `system/api_retry` (CLI retentando a API) não é tratado no `handleMessage`, então uma retentativa longa do próprio CLI parece silêncio.

**Casa com o relato:** "a sessão às vezes trava e para do nada".
