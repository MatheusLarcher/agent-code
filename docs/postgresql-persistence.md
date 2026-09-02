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
`0.3.257` (subiu de `0.3.220` para o CLI embutido reconhecer Fable 5.1, que
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
