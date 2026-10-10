---
id: "req-fila-nunca-se-perde"
tipo: "requisito"
titulo: "A fila nunca pode se perder"
etapa: "fila-preservada"
links: []
rev: 1
---
Pedido do usuário: "a fila nunca pode se perder quando isso acontecer".

Nenhum item enfileirado some por causa de travamento, erro, retentativa, Stop ou reinício do app. O item que estava em execução também não some nem roda duas vezes.

Aceite: depois de qualquer um desses eventos, a fila da conversa tem exatamente os mesmos itens, na mesma ordem, e continua gravada no banco (`conversation_outbox`).
