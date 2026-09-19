# Árvore de consumo de tokens por chamada de LLM

## Contexto

O usuário quer inspecionar, por conversa, quanto cada chamada de LLM consumiu
de tokens (entrada/saída/cache) e, ao clicar num nó, ver o conteúdo que foi
enviado e recebido naquela chamada específica — como o trace view do Google
ADK: uma árvore onde o agente principal delega para subagentes, que podem
delegar para outros subagentes, e cada nó da árvore é uma chamada real ao
modelo.

Hoje o app já tem duas peças que resolvem metade do problema, separadas:

- `src/renderer/src/agentTracks.ts` monta uma árvore de delegação (agente
  principal → subagente) a partir de `parentToolUseId`, mas só 1 nível fundo,
  só para status ao vivo ("quem está trabalhando agora"), sem tokens, sem
  conteúdo, e descarta tudo ao fim da conversa.
- `src/main/agentSession.ts` já recebe, por mensagem `assistant` do SDK, o
  `usage` exato (input/output/cache) **daquela chamada específica**, junto
  com `parent_tool_use_id` — mas hoje só aproveita o uso da thread principal
  (`lastContextTokens`); o de subagentes é descartado, e o `result` de
  subagente (`origin.kind === 'peer'`) é ignorado por completo.

## Restrição técnica confirmada

O payload HTTP bruto real (system prompt completo + histórico serializado +
definições de ferramentas, exatamente como vai para `api.anthropic.com`) **não
é observável** pela integração atual: o SDK apenas spawna um processo CLI
filho que monta e envia essa requisição internamente. Não há opção de
config/hook/env var do SDK que exponha esse corpo. O único caminho real seria
um proxy MITM local (`ANTHROPIC_BASE_URL` apontando para um servidor nosso,
no mesmo padrão de `src/main/codexProxy.ts`) — descartado por adicionar um
componente crítico no caminho de toda chamada de rede do agente.

Consequência para este design: os **números de tokens são exatos** (vêm
prontos na resposta da API, atribuíveis por nó via `parent_tool_use_id`); o
**conteúdo mostrado por chamada é reconstruído** a partir do que o stream da
CLI já expõe (texto, `tool_use`, `tool_result`) — fiel ao que foi
efetivamente trocado, mas não uma cópia byte-a-byte do request HTTP.

## Árvore: como os nós nascem

Cada `tool-use` cujo `name` é `Task`/`Agent` abre um nó de subagente:
- `node_id` = o `id` desse tool-use.
- `parent_node_id` = o `parentToolUseId` desse mesmo tool-use (`null` quando
  quem delegou foi o agente principal; o `node_id` de outro subagente quando
  quem delegou foi um subagente — isso já dá profundidade arbitrária, ao
  contrário do `agentTracks.ts` atual, que trata só 2 níveis).

Cada mensagem `assistant` do stream pertence ao nó cujo id é o
`parent_tool_use_id` dela (ou a um nó-raiz sintético por turno, quando
`null` — o agente principal). Isso vira uma "chamada de LLM" (uma linha):
sequência dentro do nó, modelo, tokens, preview do texto/tool-calls que
entrou (mensagem do usuário / resultado de ferramenta / prompt da tarefa) e
saiu (texto + tool-calls do assistant).

## Persistência

Duas tabelas novas, replicadas nos dois backends que o app já suporta
(SQLite em `sqliteSchema.ts`/`sqliteRepository.ts`, Postgres em
`postgresMigrations.ts`/`postgresRepository.ts`):

**`llm_calls`** — uma linha por chamada de LLM:
`id, conv_id, turn_id, node_id, parent_node_id, subagent_type, task_description,
seq, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
cost_usd, input_preview, output_preview, created_at`.

**`llm_usage_totals`** — agregado incremental, atualizado a cada escrita em
`llm_calls` (não depende da poda rodar para estar correto):
`conv_id, day, model, subagent_type, sum_input, sum_output, sum_cache_read,
sum_cache_write, sum_cost, call_count`.

`turn_id`: um id novo, gerado quando o usuário envia uma mensagem (mesmo
ciclo de vida do turno já rastreado em `agentSession.ts`), usado como
`node_id` do nó-raiz (agente principal) daquele turno.

### Retenção (15 dias)

`TokenUsagePruner`, mesmo formato de `src/main/persistence/changeLogPruner.ts`
(1 instância por `PostgresRepository`/`SqliteRepository`, roda 1x/dia, nunca
propaga erro para quem chamou — só loga e tenta de novo no próximo ciclo):
apaga de `llm_calls` toda linha com `created_at` mais velho que 15 dias.
`llm_usage_totals` nunca é apagada — como já foi incrementada na escrita,
sobrevive à poda sem depender dela.

*Premissa assumida*: "15 dias" contado da criação da chamada, não de último
acesso/visualização à tela — mais simples de implementar e de explicar, e é a
leitura mais comum de "manter por N dias" nesta base (mesmo critério do
`CHANGE_LOG_RETENTION_DAYS`).

## Captura (main process)

Em `agentSession.ts`, no `case 'assistant'` (por volta da linha 1978) e no
tratamento de `tool-use`/`tool-result` (onde os eventos de track já são
emitidos hoje): manter um mapa em memória `nodeId → parentNodeId` (populado
quando um `tool-use` `Task`/`Agent` é visto) e, a cada `assistant` message,
montar a linha de `llm_calls` com o `usage` que a própria mensagem já traz,
gravar (via o repositório ativo, sqlite ou postgres) e emitir um novo
`ChatEvent` (`kind: 'llm-call'`) com os mesmos dados, para quem está com a
conversa aberta ver ao vivo sem esperar reload.

## IPC e estado no renderer

- Novo `ChatEvent` `{ kind: 'llm-call', ... }` alimenta um módulo puro novo
  `tokenUsageTree.ts` (mesmo padrão de `agentTracks.ts`: sem React, sem IPC,
  testável isolado) que acumula os nós/chamadas da conversa aberta.
- Novo IPC `agent:token-usage:history` (renderer → main) busca, para uma
  conversa, as chamadas já persistidas (para reconstruir a árvore ao reabrir
  uma conversa antiga, cobrindo o que não veio pelo stream ao vivo) e os
  totais agregados de `llm_usage_totals`.

## Tela

Painel lateral da conversa (mesmo slot de `AgentsPanel.tsx`, ao lado do
"Elenco"/"Projeto"): uma aba nova, "Tokens". Conteúdo:

- Cabeçalho com o total agregado da conversa inteira (de
  `llm_usage_totals` — sobrevive à poda de 15 dias mesmo que o detalhe já
  tenha sumido).
- Árvore recolhível: raiz = turno, filhos = nós de subagente (recursivo).
  Cada linha mostra papel/label, modelo, tokens de entrada/saída/cache e
  custo (quando computável).
- Clique num nó abre a lista de chamadas de LLM daquele nó (pode ser mais de
  uma — um subagente troca várias mensagens com o modelo ao longo do seu
  trabalho).
- Clique numa chamada mostra o preview reconstruído de entrada e saída
  daquela chamada específica.

## Testes

- `tokenUsageTree.test.ts` (novo, puro): construção da árvore a partir de
  eventos `llm-call`, incluindo aninhamento de 2+ níveis.
- `agentSession.test.ts`: captura e emissão do novo `ChatEvent` a partir de
  mensagens `assistant` com `parent_tool_use_id` variado (raiz, subagente,
  subagente-de-subagente).
- Testes de repositório (sqlite e postgres): inserção, agregação incremental
  em `llm_usage_totals`, poda por `created_at`.
- Verificação manual na UI (Definition of Done): abrir a aba Tokens numa
  conversa com subagentes reais, conferir a árvore, clicar em nó e em
  chamada, fechar/reabrir a conversa e confirmar que o histórico persiste.

## Fora de escopo

- Payload HTTP bruto (ver restrição técnica acima).
- Dashboard global entre conversas (fica só por conversa, como pedido).
- Cálculo de custo quando não há tabela de preço confiável para o modelo em
  uso (`cost_usd` fica `null` nesse caso, não estimado).
