---
id: "req-identificar-erro"
tipo: "requisito"
titulo: "Identificar que o turno morreu por erro"
etapa: "deteccao"
links: []
rev: 1
---
Pedido do usuário: "precisamos de uma forma de identificar que foi erro".

O app tem de distinguir, de forma confiável, **turno concluído de verdade** de **turno que morreu no meio**, seja qual for o jeito:
- erro de API depois de várias ferramentas (529, 500, conexão caída, timeout);
- processo do CLI que saiu (com ou sem código de erro);
- turno mudo: nenhuma mensagem do SDK por tempo demais (o "travou do nada").

Aceite: cada fim de turno sai do main com um desfecho explícito (`concluido` | `falhou` | `interrompido`) e um motivo legível, e esse desfecho vai para o log de sessão.
