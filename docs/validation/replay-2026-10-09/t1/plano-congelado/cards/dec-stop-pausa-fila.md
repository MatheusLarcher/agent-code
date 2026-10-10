---
id: "dec-stop-pausa-fila"
tipo: "decisao"
titulo: "Stop pausa a fila, nunca descarta"
etapa: "fila-preservada"
status: "aceita"
links: ["amb-stop-fila","causa-3-stop-descarta-fila","req-fila-nunca-se-perde"]
fonte: "src/renderer/src/App.tsx:3436"
rev: 1
---
**Decisão do usuário** ([[Stop numa sessão travada: a fila fica ou sai?]]): Stop para o turno e **pausa** a fila; nada some sem clique explícito.

**Implementação** (`interruptConv`, `App.tsx:3436-3465`):
- o ramo comum deixa de fazer `setQueue(q => q.filter(m => m.convId !== cid))`, `centralRef.current?.dropped(...)` e `reportMcpDropped(...)`;
- a conversa ganha um estado **persistido** de fila pausada (ex.: `conv.queuePaused = true`, salvo com a conversa, para sobreviver a F5 e reinício). Com ele ligado, nenhum caminho automático despacha a cabeça da fila: fim de turno, `mirror-repair`, `queueHandoff`, mensagem com conversa ociosa (`App.tsx:2662-2671`);
- a barra da fila mostra "Fila pausada (N)" com **Continuar** (desliga a pausa e despacha a cabeça) e **Limpar** (faz o que o Stop faz hoje: descarta, avisa a Central com `dropped` e o Forgia com `reportMcpDropped`);
- mensagem nova digitada com a fila pausada sai na hora, e a fila continua pausada;
- "agora" num item da fila pausada continua funcionando (é ação explícita);
- celular: `onRemoteRecoveryAction('cancel')` (`App.tsx:3072-3079`) liga a mesma pausa.

**Não muda:** o "não era aqui" da Central (`keepQueue`) continua soltando a fila sozinho no fim (`releaseKeptQueue`).

**Por quê:** "a fila nunca pode se perder" vale também para o botão que o usuário aperta quando trava.
