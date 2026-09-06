# Troca automática de provedor e paridade de contexto

Implementação: `src/main/providerFailover.ts`, `providerQuota.ts`, `promptEnvelope.ts`,
integração em `agentSession.ts` e `index.ts`, evento persistido `provider-switch` no chat.

## Comportamento

- Limite de uso/créditos esgotados em Claude troca para GPT-6 Astra; em GPT troca para
  Claude Opus 5. Se um modelo da outra família já foi usado nesta sessão lógica,
  ele é reutilizado. Cada família é tentada no máximo uma vez por solicitação.
- A conta alternativa precisa estar conectada. Falhas de autenticação, rede,
  sobrecarga e throttling genérico não são interpretadas como créditos esgotados.
- Quota explícita do GPT em HTTP 429 é traduzida em erro terminal no proxy local
  para evitar o backoff do SDK antes da troca. Um 429 genérico conserva seu tratamento.
- Antes da troca, o transcript é verificado no armazenamento selecionado. O novo
  processo retoma o mesmo ID de sessão: usuário, anexos, ferramentas e resultados
  anteriores permanecem no histórico. Uma mensagem interna pede continuação; o
  pedido original não é reenviado como uma nova tarefa.
- Permissões de ferramentas já concedidas, esforço compatível, modo econômico e
  estado/orçamento do loop são preservados. O usuário continua podendo parar.
- O aviso aparece no chat, atualiza o seletor e é persistido. A fila só avança ao
  término do novo provedor. Se ambos estiverem esgotados, a tarefa fica suspensa,
  com erro visível e sem repetição automática infinita.
- A disponibilidade de uma conta não garante disponibilidade do modelo no plano;
  uma recusa do provedor continua visível.

## O que significa paridade

Todos os modelos cadastrados usam a mesma montagem de prompt do Agent Code:
carimbo de origem/data, documentação, atualização de memória, catálogo de skills,
lembrete de modo e texto do usuário. O system append, as fontes de configuração
e os diretórios permitidos também são comuns para as mesmas opções de sessão.
Os aliases de subagentes Ollama agora permanecem no modelo selecionado, como já
ocorria no GPT.

O catálogo de skills só anuncia o que o registro nativo do SDK confirmou. Corpos
de skills e memórias continuam sendo consultados conforme a política existente;
paridade não significa carregar todos os arquivos indiscriminadamente a cada turno.

As requisições HTTP não são idênticas: Claude/Ollama usam Messages; GPT usa Responses
Lite, com instruções em mensagens developer e ferramentas em additional_tools.
Os adaptadores preservam o conteúdo do app. Não se afirma igualdade de instruções
internas dos fornecedores ou de todas as instruções geradas pelo SDK para cada modelo.
Modelos sem visão continuam recebendo a descrição do relay visual, enquanto modelos
multimodais recebem a imagem. Os testes não comprovam aderência semântica de cada LLM.

## Validação executada

- `npm test`: **701 passaram, 14 ignorados**, 69 arquivos passaram e 2 ignorados.
- `npm run build`: passou, incluindo o componente nativo .NET do Windows.
- Typecheck suplementar usando os dois tsconfigs e excluindo exclusivamente o
  arquivo preexistente `src/shared/reconcile.ts`: zero erros.
- `npm run typecheck` completo permanece bloqueado por `TS1160` em
  `src/shared/reconcile.ts:225`. Esse arquivo não rastreado já continha um bloco
  Markdown incompleto antes desta mudança e foi preservado.
- `node scripts/sqlite-v2-smoke.mjs`: instância Electron isolada; persistência,
  criar/listar/renomear/excluir conversa, F5, estado vazio, fechamento e reabertura.
- `node scripts/provider-failover-smoke.mjs`: Electron, renderer, IPC, SDK/CLI e
  SQLite reais; somente autenticação e respostas dos provedores são simuladas
  numa build descartável. A build normal não contém essa simulação.
  - Claude → GPT: Write real antes da quota, Read real após a troca.
  - GPT → Claude: mesmo fluxo, incluindo HTTP 429 de quota do GPT.
  - Ambos esgotados: encerra as tentativas sem laço infinito.
  - Conta alternativa desconectada: não envia requisição para ela.
  - Stop durante a consulta de autenticação: nenhuma requisição ao substituto.
  - Aviso/modelo persistidos após desmontagem/remontagem pelo reload.
  - Prompt original transferido com igualdade exata de texto, mais marcadores
    de docs, memória, skills e resultado real de ferramenta no transporte GPT.
- Testes direcionados adicionais cobrem permissões, orçamento de loop, fila,
  eventos duplicados/atrasados, transcript inválido e preservação de imagens e
  schemas no adaptador GPT; a paridade na entrada do SDK abrange todos os modelos.

Limites da rodada inicial: não foram esgotados créditos reais de contas nem testada inferência real
de cada modelo remoto. A validação autenticada posterior está descrita abaixo.
O smoke de persistência usa SQLite; a troca sob indisponibilidade
real de PostgreSQL não foi revalidada neste trabalho. Não é uma garantia de todos os
fluxos manuais do aplicativo ou de disponibilidade dos serviços externos.

## Correção posterior: HTTP 400 do Astra e testes autenticados

O erro foi localizado na conversa salva no PostgreSQL configurado pelo usuário.
A reprodução com autenticação real retornou HTTP 400 com o campo `detail`:
`The 'gpt-6-astra' model requires a newer version of Codex.`
O Agent Code anunciava a versão de protocolo 0.146.0. O proxy foi atualizado
para 0.153.4, confirmada no catálogo do cliente local e aceita pelo backend real.
A extração de erros agora aceita o campo estruturado `detail`, além de
`error.message` e `message`, para não esconder a explicação do provedor.

`scripts/gpt-live-check.mjs` usa a build normal, Electron, renderer, IPC, SDK,
contas conectadas e o PostgreSQL reais. Cria conversa e arquivos de diagnóstico
separados. No modo padrão não substitui autenticação nem respostas de rede.

Passaram com inferência real: **GPT-6 Astra, GPT-5.6 Sol, Luna e Terra**.
Cada modelo executou Read, retornou o conteúdo correto do arquivo e o marcador
da documentação; depois passou por desmontar/remontar a conversa, reload,
Read de arquivo intencionalmente inexistente, recuperação com outro Read e
resposta final correta. Todas as chamadas GPT observadas retornaram HTTP 200.

Também passou `node scripts/gpt-live-check.mjs gpt-6-astra --failover --cleanup`:
o Astra real leu o arquivo; o teste injetou **uma** resposta HTTP 429 de quota
na chamada seguinte; o app emitiu `provider-switch` para Claude Opus 5, que
respondeu de verdade preservando arquivo e documentação do histórico. Após
reload, o Claude executou o cenário de Read inexistente/Read válido e concluiu.
Renomear, reload e excluir a conversa de diagnóstico também passaram, com
verificação no PostgreSQL. Só a quota foi simulada nesse cenário; autenticação,
inferência dos dois modelos, ferramentas e persistência foram reais. O sentido
Claude → GPT e os casos de ambas as quotas/conta ausente/Stop continuam cobertos
pelo smoke com respostas de fornecedores simuladas descrito acima.

Regressão após a correção: **702 testes passaram, 14 ignorados**; build completa
passou. O typecheck completo continua com o erro preexistente de `reconcile.ts`
descrito acima; excluindo exclusivamente esse arquivo, ambos os tsconfigs passam.

## Referência consultada

[Nexos, session.ts no commit f74b536](https://github.com/Yanngc32/Nexos/blob/f74b53632f6a748329b716600a8786d1f09397a6/apps/daemon/src/session.ts):
conjunto de provedores já tentados, continuidade com histórico e separação entre
aviso de troca e término de tarefa. Implementação adaptada à arquitetura própria
do Agent Code (um harness SDK compartilhado e transcript persistido).
