---
id: "amb-tentativas-esgotadas"
tipo: "ambiguidade"
titulo: "Tentativas esgotadas: quanto insistir e o que fazer depois?"
etapa: "retomada"
status: "resolvida"
links: ["dec-um-dono-retentativa","req-retomar-de-onde-parou","req-segundo-item-so-no-fim-real"]
rev: 3
---
## O que está ambíguo

Hoje: erro transitório → **5 tentativas, de 60 em 60 s** (5 min no total, `turnRecovery.ts`). Depois aparece "Tentativas automáticas encerradas" e a fila fica parada. Só que uma mensagem nova do usuário descarta o cartão e despacha a cabeça da fila, ou seja, pula a tarefa que falhou sem perguntar (`App.tsx:2636-2671`).

Duas perguntas:
1. **Quanto insistir?** Instabilidade de API (529/overloaded) às vezes dura mais de 5 min. Mas cada retentativa relê o contexto inteiro da conversa: com espera maior que os 5 min do cache de prompt, uma conversa de 150 mil tokens paga a leitura cheia a cada tentativa, o que gasta cota da janela de 5 h (assinatura) ou dinheiro (API).
2. **Esgotou, e aí?**
   - **A. Fila retida** até o usuário agir: "Tentar de novo · Pular esta tarefa · Limpar fila" (no PC e no celular).
   - **B. Pula sozinho** para o próximo item depois de N falhas.

## Cards envolvidos

- [[Um dono só para a retentativa]]
- [[Tentar de novo a partir de onde parou]]
- [[2º item só entra quando a tarefa terminou de fato]]

## Opinião do Manager

1. **Espera crescente: 30 s → 1 → 2 → 5 → 10 → 15 min** (6 tentativas, ~33 min). Cobre a instabilidade típica de API, e as primeiras tentativas ainda caem dentro do cache de 5 min (baratas). O erro fatal não entra nessa conta: para na hora ([[Um dono só para a retentativa]]).

2. **A (fila retida).** B contradiz o pedido ("só pode entrar o segundo item quando a tarefa terminar de fato"). Pior: rodar o item 2 em cima de uma tarefa pela metade pode mexer nos mesmos arquivos.
   - "Pular esta tarefa" vira botão explícito.
   - **Mensagem nova do usuário, com a tarefa parada por falha, sai na hora como a retomada dela**, na mesma sessão. O modelo vê o histórico da tarefa e a orientação nova ("tenta pelo outro endpoint"). Ela não pula a tarefa nem fica presa atrás dela; os itens 2..N continuam esperando, e quando esse turno concluir a fila anda. Isso substitui o efeito colateral de hoje (descartar o cartão e despachar a cabeça da fila).

## Decisão (2026-10-09)

O usuário escolheu a opção recomendada:

1. **Erro transitório:** espera crescente de **30 s → 1 → 2 → 5 → 10 → 15 min** (6 tentativas, ~33 min). Limite de uso continua esperando o reset (como hoje). Erro fatal para na hora, sem gastar tentativas.
2. **Esgotou:** fila **retida**, com "Tentar de novo", "Pular esta tarefa" e "Limpar fila" no PC. Nunca pula sozinho.
3. **Mensagem nova do usuário** com a tarefa parada por falha sai na hora como **retomada guiada** dela, na mesma sessão. Não pula a tarefa, e os itens 2..N esperam esse turno concluir.
4. **Celular:** mantém "Tentar de novo" e "Cancelar" (agora "Cancelar" só pausa, sem descartar). Botões novos no celular exigem gerar e reinstalar o APK (`smartfone-remote/www` vai empacotado), então ficaram fora até o usuário pedir.
