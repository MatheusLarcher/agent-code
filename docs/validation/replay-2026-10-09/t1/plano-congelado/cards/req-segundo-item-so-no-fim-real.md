---
id: "req-segundo-item-so-no-fim-real"
tipo: "requisito"
titulo: "2º item só entra quando a tarefa terminou de fato"
etapa: "avanco-fila"
links: []
rev: 1
---
Pedido do usuário: "só pode entrar o segundo item da fila quando a tarefa terminar de fato".

O próximo item da fila só é despachado quando o turno atual terminou com desfecho `concluido`. Falha, silêncio, retentativa em curso ou tentativas esgotadas seguram a fila.

Aceite: nos cenários de falha, o 2º item nunca sai antes de a tarefa do 1º ser concluída (ou de o usuário decidir explicitamente pular ou limpar).
