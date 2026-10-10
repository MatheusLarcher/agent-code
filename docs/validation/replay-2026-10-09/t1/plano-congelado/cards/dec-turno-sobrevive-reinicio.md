---
id: "dec-turno-sobrevive-reinicio"
tipo: "decisao"
titulo: "Turno em voo sobrevive ao reinício do app"
etapa: "fila-preservada"
status: "aceita"
links: ["req-fila-nunca-se-perde","causa-5-duas-retentativas","dec-um-dono-retentativa"]
fonte: "src/main/persistence/sqliteRepository.ts:1787"
rev: 2
---
**Situação hoje:**
- a fila de espera está no banco (`conversation_outbox`) e volta depois do reinício, **mas parada**: "saem quando você mandar outra mensagem ou clicar em agora" (`App.tsx:703-709`);
- o item **em execução** sai da fila no despacho e passa a viver só na memória do renderer (`inflightRef`) e na `agent_input_queue` do main. Fechar ou derrubar o app no meio do turno faz o main, na próxima subida da sessão, voltar a linha `processing` a `pending` (`recoverAgentInput`, `sqliteRepository.ts:1787`) e **rodar o pedido original inteiro de novo**, sem o renderer saber ([[Causa 5: duas retentativas que não se conversam]]).

**O quê:**
1. O item em execução continua durável até o desfecho `concluido`. O renderer persiste junto da conversa um marcador do turno em voo (msgId, uuid, payload ou referência, se o turno começou). Alternativa equivalente: o main expõe as linhas `processing` órfãs. O implementador escolhe, desde que sobreviva a um kill do processo.
2. Na subida, conversa com turno em voo não concluído vira `conv.recovery` (motivo `interrompido_no_reinicio`) e segue a regra de [[Um dono só para a retentativa]]: continuação se começou, reenvio se não. Nada roda duas vezes.
3. O main não drena linhas `processing` de um processo anterior por conta própria.
4. A fila restaurada **atrás** do turno interrompido continua presa a ele: só anda quando ele concluir ([[Fila presa ao desfecho: só 'concluido' solta o próximo item]]).

**Por quê:** a reação natural a um travamento também é fechar e abrir o app. Sem isto, o pedido de "a fila nunca pode se perder" quebra exatamente aí.
