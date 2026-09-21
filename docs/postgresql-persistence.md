# Persistência PostgreSQL opcional

O Agent Code inicia em SQLite e só troca de backend por uma ação explícita em
**Configurações → PostgreSQL**. O banco alvo é sempre `agent-code`; host, porta,
usuário, maintenance database e TLS são editáveis. A senha fica apenas no
bootstrap local criptografado pelo `safeStorage` do Electron e nunca retorna ao
renderer.

## Ativação e retorno ao SQLite

A ativação testa a conexão, provisiona o banco quando o usuário possui
`CREATEDB`, aplica migrations com advisory lock e checksum, bloqueia novas
gravações, espera turnos ativos, exige o flush do renderer e importa KV,
conversas, tombstones e sessões do Agent SDK em uma transação serializable. O
bootstrap só seleciona PostgreSQL depois da verificação pós-commit.

A desativação exige PostgreSQL online, cria um SQLite v2 temporário com o
snapshot do dispositivo, verifica hashes e sessões e só então substitui o
arquivo local. O banco remoto e sua auditoria permanecem intactos.

## Escopos e sincronização

Preferências portáveis declaradas como globais usam `global_kv`. Caminhos,
voz, controle do Windows, ponte remota, UI e segredos usam `device_kv`.
`cwd` e draft de conversa ficam em `conversation_device_state`; o payload
compartilhado não publica caminhos locais. Chaves novas sem entrada no registro
de persistência são rejeitadas.

Conversas usam upsert/delete por ID com revisão CAS e tombstone. O renderer
serializa gravações da mesma conversa e mantém uma falha como dirty. `LISTEN`
serve apenas como wakeup; a recuperação vem do `change_log` durável e de um
cursor por instalação.

## Sessões e indisponibilidade

Cada conversa possui lease, token e fencing epoch. O lease protege **um turno
ativo**, não uma conversa ociosa: `AgentSession` chama `onTurnComplete` assim que
o SDK emite o resultado terminal do turno e o main libera o lease (só se aquela
sessão ainda for a registrada para a conversa), e o próximo envio o readquire
(`agent:send` chama `acquireSessionLease` em vez de recusar com
`LEASE_HELD_BY_OTHER_DEVICE`). Sem isso, um writer abandonado bloqueava o outro
processo indefinidamente. O Agent SDK está fixado em
`0.3.278` (subiu de `0.3.220` para o CLI embutido reconhecer Fable 5.1, que
exige `2.1.251+`) e recebe `sessionStore`, `sessionStoreFlush: 'eager'` e
timeout de load. A versão gravada em `sdk_sessions.sdk_version` vem da
constante `SDK_VERSION` (`postgresSessionStore.ts`), fonte única também para o
importador de sessões — não repetir o literal em SQL. A retomada e a verificação usam somente as APIs públicas do SDK. Um
`mirror_error` bloqueia novos envios até reconciliação.

Se PostgreSQL estiver selecionado e indisponível, o app não abre o SQLite como
fallback e não interpreta a falha como configuração padrão ou histórico vazio.
Ele mostra apenas a recuperação, com retry e edição das credenciais.

O Parquet diário lê o repositório autoritativo e grava `backend` e `watermark`
em cada registro; memórias Markdown continuam vindo do filesystem local.

## Registro de tarefas e memórias no PostgreSQL

As migrations 4 (`tasks`, `task_steps`, `task_deliverables`, `task_events`) e 5
(`memory_entries`, `memory_proposals`) espelham o schema do SQLite, e cada uma
substitui a função de gatilho do change feed para mapear a tabela nova — o ramo
`ELSE` original só sabia ler `conversation_id`.

O que o PostgreSQL faz diferente do SQLite não é o contrato, é a concorrência
entre instalações, e é isso que os testes de integração exercitam:

- `claimTask` e `claimMemoryProposal` usam `FOR UPDATE SKIP LOCKED`: duas
  instalações reivindicando ao mesmo tempo pegam itens **diferentes**, em vez
  de uma esperar a outra e as duas acabarem no mesmo trabalho.
- `writeMemoryEntry` toma `pg_advisory_xact_lock` por `rel_path` **antes** do
  `SELECT ... FOR UPDATE`. Um lock de linha não protege uma linha *ausente*:
  sem ele, duas criações simultâneas do mesmo caminho leem "não existe" e as
  duas inserem. Com ele, uma vence e a outra recebe `REVISION_CONFLICT`.
- Leases de tarefa e de proposta comparam contra `clock_timestamp()` — o
  relógio do servidor —, não o de quem chama.

### Lista para coluna `jsonb` vai serializada

`acceptance_json` é `jsonb` e recebe uma **lista**. Passar um array JS direto
como parâmetro não funciona: o node-postgres o renderiza como array do
Postgres, então `[]` chega como `{}` (um objeto vazio, silenciosamente errado)
e `['a','b']` vira `{"a","b"}`, que falha com `invalid input syntax for type
json`. Por isso todo parâmetro `jsonb` do repositório passa por
`encodePostgresJsonParam`, que serializa com `JSON.stringify` — texto explícito
é inequívoco para qualquer forma. Um objeto funcionava por acaso (o driver o
serializa como JSON), e foi o que escondeu o problema até um teste com
`acceptance` preenchido.

### Rodar os testes de integração

Ficam desligados por padrão; `AGENT_CODE_PG_INTEGRATION=1` os liga. Um comando
só, com Docker Desktop rodando:

```bash
npm run test:pg
```

`scripts/run-postgres-tests.mjs` sobe um `postgres:16-alpine` descartável,
espera ele aceitar conexão TCP, roda `src/main/persistence/postgres*.test.ts` e
`src/main/tasks/taskLedger.test.ts` com `--no-file-parallelism` e remove o
container no fim — também quando o teste falha ou você dá Ctrl+C. Um container
órfão segurando a porta é o que faz a execução seguinte falhar sem motivo
aparente. Falha de teste sai com código diferente de zero.

O `--no-file-parallelism` não é zelo: os arquivos recriam o mesmo banco
`agent-code`, então em paralelo um derruba as conexões do outro (`FATAL 57P01`)
e a falha parece um bug do código.

A porta padrão é 15432. O Windows reserva faixas inteiras para o WinNAT/Hyper-V
(veja `netsh interface ipv4 show excludedportrange protocol=tcp`) e os 55432 que
este roteiro usava antes caem dentro de uma delas nesta máquina — o `docker run`
morre com `bind: An attempt was made to access a socket in a way forbidden by
its access permissions`. Para trocar, use as mesmas variáveis que os testes
leem, e o script alinha o container a elas:

```bash
AGENT_CODE_PG_PORT=15433 AGENT_CODE_PG_PASSWORD=outra npm run test:pg
```
