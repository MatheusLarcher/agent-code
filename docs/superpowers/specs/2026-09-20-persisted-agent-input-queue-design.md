# Fila persistida de mensagens do agente

## Objetivo

Mensagens enviadas enquanto uma conversa está ocupada não podem desaparecer quando o Agent Code reinicia, a sessão é recriada ou uma execução falha. A fila deve ser persistida no backend configurado (SQLite ou PostgreSQL), por conversa, com FIFO estrito.

## Comportamento

- `send()` grava a mensagem completa como pendente antes de entregá-la ao `AsyncQueue` em memória.
- A menor sequência pendente é a única mensagem elegível para processamento.
- A mensagem em processamento permanece bloqueando as seguintes até concluir com sucesso.
- Em erro, o fluxo de retry existente tenta novamente a mesma mensagem; a mensagem não é removida e as seguintes continuam bloqueadas.
- Se o processo morrer ou reiniciar, registros em processamento são recuperados como pendentes e retomados na ordem original.
- Somente a confirmação de sucesso remove a mensagem da fila.
- Duplicações causadas por retry/restart não podem criar duas execuções da mesma mensagem; cada item terá uma chave idempotente.

## Arquitetura

Adicionar uma abstração específica de fila ao `PersistenceRepository`, sem reutilizar o `SessionStore` do transcript SDK. A API deve permitir enfileirar, reivindicar a próxima mensagem FIFO, marcar sucesso, devolver para pendente e recuperar itens órfãos em processamento. O payload persistido deve preservar o `SDKUserMessage` já preparado pelo `AgentSession`, junto de sequência, estado, tentativas, timestamps e último erro.

SQLite implementará as transições em transações locais (`BEGIN IMMEDIATE`). PostgreSQL usará transações e locks de linha (`FOR UPDATE SKIP LOCKED` somente para não bloquear outras conversas; dentro de uma conversa a ordenação continua estrita). Migrações devem ser compatíveis com bancos já existentes e só ativar o recurso quando o repositório estiver configurado.

## Fluxo de sessão

Na inicialização/recriação de uma conversa, a sessão primeiro recupera itens `processing` órfãos, depois hidrata o consumidor em memória a partir dos pendentes. O consumidor confirma cada item somente após a execução do turno retornar com sucesso. O erro passa pelo retry existente e atualiza tentativa/erro no registro. O dispose não apaga pendências.

A fila persistida é a fonte de verdade; `AsyncQueue` continua apenas como mecanismo de entrega para o SDK. Operações devem respeitar o lease já existente da conversa para evitar dois consumidores ativos.

## Modelo de dados

Tabela lógica `agent_input_queue`:

- `id` monotônico por banco e `conversation_id`/`sequence` para FIFO por conversa;
- `conversation_id`;
- `message_uuid` único por conversa;
- payload JSON da mensagem SDK;
- `status` (`pending` ou `processing`);
- `attempt_count`, `available_at`, `processing_started_at`, `last_error`;
- `created_at`, `updated_at`.

Índices devem cobrir `(conversation_id, status, sequence)` e a chave idempotente. Limpeza ocorre apenas após sucesso.

## Falhas e limites

Falhas de persistência impedem o envio, como já ocorre para falha de espelhamento. Falhas do agente não descartam a mensagem. Se o retry existente decidir parar, o item permanece pendente e será retomado quando a sessão voltar; não há avanço silencioso para a próxima mensagem. Mensagens inválidas devem falhar antes de serem persistidas sempre que possível.

## Testes e validação

Testar unitariamente as transições e FIFO em SQLite e PostgreSQL (quando disponível), incluindo duplicidade, recuperação de `processing`, erro/retry e remoção após sucesso. Testar integração com `AgentSession`: envio de várias mensagens, falha da primeira bloqueando a segunda, sucesso liberando a próxima, restart/remontagem e estados vazio e de erro. Rodar typecheck, testes e build; depois iniciar o app e exercitar o fluxo real com reload/recriação da conversa e erro seguido de retry.
