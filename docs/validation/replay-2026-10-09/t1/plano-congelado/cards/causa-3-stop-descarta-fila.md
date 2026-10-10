---
id: "causa-3-stop-descarta-fila"
tipo: "nota"
titulo: "Causa 3: Stop descarta a fila inteira"
etapa: "diagnostico"
links: ["req-fila-nunca-se-perde"]
fonte: "src/renderer/src/App.tsx:3436"
rev: 1
---
**Onde:** `src/renderer/src/App.tsx:3436-3465` (`interruptConv`)

```ts
// Stop the current task AND drop anything queued for this conversation.
...
setQueue((q) => q.filter((m) => m.convId !== cid))
```

O Stop comum (sem `keepQueue`) apaga **toda a fila da conversa**, avisa a Central (`dropped`) e cancela as tarefas MCP enfileiradas. É decisão de projeto ("Stop = para tudo"), mas colide com o pedido: diante de um travamento ([[Causa 2: silêncio só acende aviso, nunca vira erro]]), a reação natural é apertar Stop, e é aí que a fila some.

Existe um caminho que mantém a fila (`keepQueue`, o "não era aqui" da Central), só que ele **solta a fila sozinho** no fim (`releaseKeptQueue`, `App.tsx:3421-3432`): pularia a tarefa travada e mandaria o 2º item. Também não é o que o usuário quer.

**Casa com o relato:** "a fila nunca pode se perder quando isso acontecer".
