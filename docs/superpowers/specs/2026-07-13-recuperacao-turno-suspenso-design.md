# Recuperação automática de turnos suspensos

## Objetivo

Quando um turno falhar por limite de uso ou erro transitório, a conversa não deve ser considerada concluída e a fila não pode avançar. O Agent Code deve reagendar a continuação, informar o usuário e retomar automaticamente.

## Estados

Cada conversa pode ter no máximo uma recuperação pendente:

- `waiting-limit`: limite de uso, aguardando o reset;
- `waiting-retry`: erro comum, aguardando nova tentativa;
- `retrying`: tentativa automática em andamento;
- sem recuperação: turno concluído, cancelado ou fila livre.

A recuperação guarda o identificador da conversa e da mensagem interrompida, motivo, texto a reenviar, número da tentativa, `scheduledAt` e um identificador único para impedir timers obsoletos.

## Classificação do erro

1. Mensagem de limite contendo horário, por exemplo `You've hit your session limit · resets 12:20am (America/Sao_Paulo)`: interpretar horário e fuso; agendar para um minuto depois.
2. Limite sem horário no texto: usar o `resetsAt` vigente recebido pelo SDK e adicionar um minuto.
3. Limite sem qualquer horário disponível: tentar em um minuto.
4. Outros erros: tentar em um minuto, até cinco tentativas. Após a quinta falha, manter a mensagem com erro e exigir ação manual.

## Fila e retomada

- Enquanto houver recuperação, a conversa continua ocupada/suspensa e nenhuma mensagem posterior da fila é despachada.
- A retomada reenvia a mensagem interrompida com a instrução `Continue exatamente de onde parou; a execução anterior foi interrompida por limite ou erro transitório.`
- Somente um resultado realmente bem-sucedido libera a próxima mensagem da fila.
- Cancelamento explícito remove a recuperação e não dispara a fila automaticamente.

## Persistência e timers

As recuperações são persistidas no SQLite junto ao estado do app. Na abertura, o renderer recria os timers; horários vencidos disparam uma única vez. Cada callback confirma o identificador da recuperação atual, a existência da conversa e da pasta antes de enviar.

## Interface

Mostrar um item semelhante à fila contendo:

- ícone de relógio;
- motivo resumido;
- horário e contagem regressiva da próxima tentativa;
- ações **Tentar agora** e **Cancelar**.

O item aparece no PC e deve integrar o snapshot remoto para o Android exibir o mesmo estado.

## Validação

- Limite com horário e fuso agenda para reset +1 minuto.
- Limite com `resetsAt` funciona sem texto parseável.
- Erro comum tenta após um minuto e para após cinco falhas.
- A fila permanece congelada durante espera/tentativa e avança somente após sucesso.
- Fechar/reabrir o app preserva e restaura o agendamento sem duplicar disparos.
- Cancelar e tentar agora funcionam em estados aguardando.
- Conversa/pasta removida impede o reenvio e informa erro.
