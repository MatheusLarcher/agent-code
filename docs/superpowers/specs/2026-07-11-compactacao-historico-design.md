# Compactação de conversas antigas

## Regra

Quando uma conversa completar 15 dias desde `createdAt`, sua cópia persistida e exibida será compactada. A operação é idempotente.

## Preservado

- mensagens do usuário;
- apenas mensagens `assistant-text` marcadas como resposta final (`answer: true`);
- metadados da conversa, rascunho e totais.

## Removido

- pensamentos;
- uso e resultado de ferramentas;
- mensagens de sistema;
- texto intermediário do assistente que não é resposta final;
- eventos de resultado e outros eventos de streaming.

## Limite

A compactação afeta apenas o histórico do Agent Code salvo no SQLite e mostrado na interface. Ela não altera os arquivos de sessão do Claude SDK, preservando a possibilidade de retomar a sessão.

## Validação

Testar conversa com 15 dias e uma mais nova; confirmar que a antiga mantém perguntas/respostas finais e que nova não perde eventos.
