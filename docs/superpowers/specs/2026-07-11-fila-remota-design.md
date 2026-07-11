# Fila de mensagens no Agent Remote

## Objetivo

No cliente Android, Enter deve inserir uma nova linha e apenas o botão de envio deve mandar a mensagem. Uma mensagem enviada enquanto a conversa já está ocupada deve mostrar o selo **Na fila** até o desktop a despachar.

## Fluxo

1. O celular envia uma mensagem e a mostra otimisticamente.
2. O renderer do desktop decide se ela segue imediatamente ao agente ou se entra na fila existente.
3. O snapshot remoto passa a incluir as mensagens pendentes por conversa.
4. O cliente móvel reconcilia suas mensagens otimistas com esse snapshot e marca as que ainda estiverem pendentes com **Na fila**.
5. Quando o desktop despacha ou remove uma pendência, o snapshot seguinte remove o selo no celular. O estado se recupera após reconectar porque a fonte de verdade é o desktop.

## Contrato

`RemoteConversation` ganha uma lista opcional e leve de identificadores/textos de mensagens pendentes. O renderer já publica o snapshot com debounce; a ponte apenas preserva esse campo ao resumir e servir `/api/state`.

## Interface móvel

O `textarea` não intercepta mais Enter. O botão de enviar continua chamando o envio. A mensagem otimista carregará um identificador local e receberá um selo visual enquanto houver uma pendência correspondente no snapshot remoto.

## Validação

- Enter cria uma quebra de linha sem enviar; o botão envia o texto multilinha.
- Enviar durante uma tarefa em andamento mostra **Na fila** no celular.
- Ao encerrar a tarefa, o selo desaparece quando a fila é despachada.
- Após reconectar, o selo reflete a fila atual do PC.
