# Mapa de perguntas da conversa

## Objetivo

Adicionar ao PC e ao Android uma régua lateral que represente todas as perguntas do usuário. O usuário pode inspecionar uma pergunta e navegar diretamente até ela.

## Índice leve

O renderer gera por conversa um índice contendo somente `messageId`, texto, horário, posição ordinal e estado opcional de fila. A ponte inclui esse índice no snapshot e em `/api/state`, sem enviar ferramentas ou respostas completas. Assim o Android representa perguntas além do corte das 30 mensagens recentes.

## PC

- Régua vertical junto à lateral do histórico.
- Um marcador por pergunta, posicionado proporcionalmente à ordem no histórico.
- Hover mostra cartão com texto, data/hora e posição.
- Clique carrega/navega para a mensagem, faz rolagem suave e aplica destaque temporário.
- A região atualmente visível fica indicada na régua.

## Android

- Régua com área de toque ampliada.
- Primeiro toque abre o cartão; tocar novamente no marcador ou no cartão navega.
- Tocar fora fecha o cartão.
- Se a pergunta estiver fora das 30 mensagens carregadas, o cliente pede à ponte uma janela de histórico centrada no `messageId`, renderiza e navega.

## Densidade

Marcadores próximos são agrupados visualmente. O grupo informa a quantidade e expande seus itens ao interagir, evitando sobreposição em conversas longas.

## Estados especiais

- Apenas mensagens do usuário entram no mapa.
- Mensagens aguardando na fila aparecem com marcador e relógio diferenciados.
- Perguntas removidas pela compactação não existem no índice; perguntas preservadas continuam navegáveis.
- Se a mensagem desaparecer entre o índice e o clique, a interface atualiza o índice sem falhar.

## Validação

- PC: hover, clique, rolagem, destaque, troca de conversa, reload e conversa vazia.
- Android: toque, segundo toque, fechar ao tocar fora, pergunta dentro e fora das últimas 30.
- Conversa longa: índice completo sem transferir histórico pesado; agrupamento utilizável.
- Fila: marcador diferenciado entra e sai conforme o snapshot do PC.
