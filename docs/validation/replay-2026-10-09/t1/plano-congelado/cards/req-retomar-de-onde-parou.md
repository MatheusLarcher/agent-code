---
id: "req-retomar-de-onde-parou"
tipo: "requisito"
titulo: "Tentar de novo a partir de onde parou"
etapa: "retomada"
links: []
rev: 1
---
Pedido do usuário: "tentar de novo de onde parou".

Quando o turno falha por motivo transitório (erro de API, CLI morto, silêncio), o app retoma sozinho **na mesma sessão do SDK** (resume), mandando a continuação, sem reenviar o pedido original do zero e sem o usuário precisar apertar nada.

Aceite: depois da falha, a conversa volta a trabalhar sozinha e o modelo continua a tarefa (o histórico da sessão traz o que já foi feito). Erro que retentativa não resolve (login, contexto estourado, pedido inválido) para e avisa, em vez de queimar tentativas.
