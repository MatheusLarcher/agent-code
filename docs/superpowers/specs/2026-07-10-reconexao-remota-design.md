# Reconexão persistente do Agent Remote

## Objetivo

Depois do primeiro pareamento, o celular deve preservar endereço e token e tentar recuperar a conexão automaticamente. Fechar e reabrir o app móvel, a ponte ou o desktop não pode enviar o usuário ao scanner nem exigir novo QR.

## Comportamento

- Com um pareamento salvo, a abertura mostra uma tela de reconexão, não o scanner.
- O cliente tenta `GET /api/state` repetidamente, com espera progressiva e limitada entre tentativas.
- Indisponibilidade de rede, PC desligado, ponte parada e erros HTTP mantêm a tela de reconexão. Quando a ponte volta, o cliente entra no chat sozinho.
- Um `401 token inválido` é exibido como diagnóstico, mas não apaga o endereço nem o token armazenados e não abre o scanner automaticamente.
- A tela de reconexão oferece **Cancelar e escanear QR**. Somente essa ação explícita remove o pareamento local e abre o fluxo de QR/endereço manual.
- O PC continua usando o token persistido no SQLite: ele é gerado somente quando não houver token salvo e é reutilizado após parar/iniciar a ponte e reiniciar o desktop.

## Componentes

### Cliente móvel (`smartfone-remote/www/app.js`)

Separar o estado de reconexão da tela de pareamento. `showChat` deixa de converter falhas em `showPair`; em vez disso, inicia ou mantém o ciclo de reconexão. O ciclo deve possuir um único timer ativo, ser cancelado ao entrar no chat, ao sair explicitamente ou ao abrir o scanner, e reaproveitar a configuração persistida.

### Interface móvel (`index.html` e `styles.css`)

Incluir uma tela de reconexão com status, detalhe do último erro e botão de cancelamento para o scanner. O scanner permanece a primeira tela apenas quando não existe configuração salva ou quando o usuário escolhe cancelar o pareamento.

### Ponte (`src/main/remote/remoteServer.ts`)

Manter o contrato de token atual e cobri-lo com teste de reinício: duas instâncias consecutivas que recebem o mesmo token persistido devem expor exatamente o mesmo token. Nenhuma rota de renovação automática será criada.

## Tratamento de erros

O cliente preserva o pareamento em toda falha de reconexão. Em particular, o `401` informa que o token salvo não foi aceito pelo PC, mas continua tentando porque a ponte pode estar em transição de reinício; o usuário pode cancelar para parear novamente se a condição persistir.

## Validação

- Testes de unidade para o estado/timers de reconexão no cliente móvel, incluindo falha, sucesso e cancelamento.
- Teste do `RemoteServer` confirmando a reutilização de um token persistido entre reinícios.
- Exercício no app: parear uma vez, fechar/reabrir o cliente, parar/iniciar a ponte, reiniciar o desktop e observar a recuperação automática; testar Wi-Fi indisponível e `401`; cancelar para voltar ao scanner.
