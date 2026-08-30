# Persistência opcional no PostgreSQL
## Contexto

O Agent Code persiste configuração e estado global no SQLite `agent-code.db`,
histórico renderizado em um SQLite por projeto e o contexto retomável do Agent
SDK em arquivos locais fora desses bancos. O backup Parquet executado na abertura
lê os SQLite por projeto. Esse desenho não permite compartilhar e retomar
conversas com segurança entre vários computadores.

PostgreSQL será um backend opcional e autoritativo. SQLite continuará sendo o
padrão. A ativação migrará e verificará os dados locais antes da troca; a
desativação fará o caminho inverso. Quando PostgreSQL estiver selecionado e
indisponível, o app bloqueará gravações e novas execuções em vez de cair
silenciosamente no SQLite.
## Objetivos

- Criar e atualizar automaticamente o banco PostgreSQL de nome fixo `agent-code`.
- Migrar todo histórico renderizado, configuração e KV persistente para o backend selecionado.
- Manter configurações globais e por dispositivo sem aplicar caminhos ou hardware de um PC em outro.
- Sincronizar alterações em tempo real entre vários PCs.
- Permitir a retomada da mesma sessão do Agent SDK em outro PC.
- Impedir dois PCs de continuarem a mesma conversa ao mesmo tempo.
- Fazer o backup Parquet ler o backend autoritativo.
- Preservar SQLite e PostgreSQL intactos como fontes de rollback durante as trocas.
- Não expor PostgreSQL ao agente como MCP ou ferramenta SQL.
## Fora de escopo

- Mover memórias Markdown, skills, anexos, temporários ou checkouts para tabelas.
- Dar ao agente acesso SQL ao banco interno.
- Criar fila offline ou resolver conflitos depois de gravar em dois backends.
- Fazer fallback automático para SQLite quando PostgreSQL estiver selecionado.
- Interpretar ou reescrever o formato privado dos transcripts do Agent SDK.
## Decisões

- O mesmo banco poderá ser usado simultaneamente por vários PCs.
- Mudanças aparecerão ao vivo nas outras instâncias abertas.
- Configurações serão divididas em globais e por instalação.
- Chaves, tokens e credenciais de serviços serão por instalação e criptografados.
- O segredo de conexão PostgreSQL ficará somente no bootstrap local criptografado.
- Ativar PostgreSQL migrará o SQLite e só trocará após verificação.
- Desativar PostgreSQL migrará o snapshot atual de volta ao SQLite e só trocará após verificação.
- Indisponibilidade do PostgreSQL bloqueará escrita e execução de agentes.
- Cada conversa terá um único writer, controlado por lease com fencing.
- O `SessionStore` público `@alpha` será usado com o Agent SDK fixado exatamente em `0.3.220`.
- Projetos em caminhos diferentes serão identificados por assinatura do repositório; seleção manual só ocorrerá quando não houver correspondência segura.
## Autoridade de persistência

O processo principal terá um `StorageLifecycleService`, única autoridade para
selecionar e trocar o backend. Seus estados serão:

- `booting`;
- `sqlite-ready`;
- `testing-postgres`;
- `activating-postgres`;
- `postgres-ready`;
- `postgres-offline`;
- `deactivating-postgres`;
- `fatal`.

O serviço controlará:

- o repositório ativo;
- o pool e o listener PostgreSQL;
- o snapshot validado de configuração;
- a exclusão mútua de transições;
- as escritas duráveis em andamento;
- os leases de conversa;
- os adapters do `SessionStore`;
- a fonte do Parquet;
- a reconciliação depois de falhas de listener ou conexão;
- o fechamento das conexões no encerramento do Electron.

SQLite e PostgreSQL implementarão contratos assíncronos equivalentes para KV,
configuração, conversas, sessões SDK e snapshot de exportação. O snapshot em
memória servirá apenas para consumidores hoje síncronos. Uma mutação atualizará
o snapshot somente depois do commit; falha de persistência mantém o snapshot
anterior.
## Bootstrap local

O backend precisa ser localizado antes de carregar dados. Um bootstrap pequeno,
atômico e criptografado com Electron `safeStorage` ficará sob
`app.getPath('userData')` e conterá somente:

- UUID da instalação;
- backend selecionado;
- estado e ID da transição;
- host, porta, usuário, maintenance database e TLS;
- senha PostgreSQL;
- marcador constante do banco alvo `agent-code`;
- último ID de transição confirmado.

A senha nunca será retornada ao renderer. Campo vazio no formulário significa
manter o segredo salvo; limpar exige ação separada. Se `safeStorage` não estiver
disponível, o app recusará persistir a senha em vez de gravá-la em texto puro.

O cache local continuará contendo recursos de filesystem e o SQLite preservado.
Em modo PostgreSQL ele não será fonte de configuração, KV ou conversas.
## Escopos de configuração e KV
### Global

Preferências que não dependem da máquina e metadados compartilhados de projetos
e conversas.
### Por instalação

- caminhos de cache, memórias, skills, anexos e temporários;
- voz, velocidade, engine e modelo de transcrição;
- Windows control e auto-start;
- ponte remota e token;
- estado da UI, filtros do grafo e cursor de mudanças;
- mapeamentos dos projetos para pastas locais;
- timestamp do curador;
- todos os segredos de provedores e autenticações locais.

Segredos por instalação serão criptografados pelo `safeStorage`; PostgreSQL
armazenará apenas ciphertext vinculado à instalação. O `codexAuth` continuará
não portátil entre máquinas.

Um registro de chaves declarará o escopo de cada KV. A migração preservará
chaves desconhecidas já existentes no escopo do dispositivo. Depois da migração,
uma chave nova sem escopo declarado será rejeitada por contrato/teste.
## Provisionamento do PostgreSQL

1. Validar host, porta, usuário, maintenance database e TLS no processo principal com Zod.
2. Usar opções discretas do `pg`, nunca uma connection string criada no renderer.
3. Conectar ao maintenance database, padrão `postgres`.
4. Obter advisory lock de provisionamento.
5. Consultar `pg_database` com o valor parametrizado `agent-code`.
6. Se ausente, executar o DDL constante `CREATE DATABASE "agent-code" ENCODING 'UTF8' TEMPLATE template0`.
7. Tratar `duplicate_database` como corrida de criação e reconferir.
8. Conectar ao banco alvo e aplicar migrations sob advisory lock.

O nome do banco não será editável. Como PostgreSQL não parametriza
identificadores, o único identificador criado dinamicamente será a constante de
código `agent-code`. Entrada do usuário nunca será interpolada em DDL.

Se a role não tiver `CREATEDB`, a tela distinguirá essa situação de falha de
autenticação e informará que um administrador deve criar exatamente o banco
`agent-code`.
## Migrations

Migrations serão módulos pequenos, ordenados e imutáveis. A tabela
`schema_migrations` registrará versão, nome, checksum, versão do app, data e
instalação aplicadora.

Regras:

- cada migration roda em transação;
- migrations concorrentes são serializadas por advisory lock;
- migration publicada nunca é editada;
- reaplicar a versão atual é no-op;
- checksum divergente bloqueia a abertura;
- schema mais novo que o app bloqueia a abertura;
- backfills são migrations novas e verificáveis.
## Modelo de dados
### Infraestrutura

- `schema_migrations`: versões e checksums.
- `installations`: dispositivos, versão do app e heartbeat.
- `migration_runs` e `migration_items`: auditoria, status, hashes e recuperação de transições.
### Configuração e KV

- `global_kv`: chave, valor, revisão, hash, timestamp e autor.
- `device_kv`: instalação, chave, valor, revisão, hash e timestamp.

O blob único `config` deixa de ser contrato durável. A configuração pública será
composta a partir de campos globais e por dispositivo.
### Projetos e conversas

- `projects`: identidade estável do projeto.
- `project_devices`: caminho local e assinatura por instalação.
- `conversations`: payload compartilhado JSONB, revisão, hash, timestamps, tombstone e autor.
- `conversation_device_state`: draft e estado estritamente local.
- `conversation_leases`: owner, token, fencing epoch, heartbeat e expiração.

A conversa inteira pode continuar sendo a unidade inicial de gravação, mas com
CAS por revisão. O save da lista completa deixa de ser o contrato. Exclusão cria
tombstone e escritor com revisão antiga não pode ressuscitá-la.
### Sessões do Agent SDK

- `sdk_sessions`: head, summary, versão do SDK, hash verificado e `resume_ready`.
- `sdk_session_entries`: conversa, sessão, subpath, sequência, UUID opcional, entry JSONB opaco e hash.

Entries com UUID serão idempotentes. Entries sem UUID serão preservados na ordem
de commit. Subpaths representarão transcripts de subagentes.
### Mudanças ao vivo

- `change_log`: ID crescente, entidade, ID, escopo, revisão, autor e timestamp.
- `installation_change_cursors`: último change ID aplicado por instalação.

Triggers gravarão `change_log` e chamarão `pg_notify` com payload pequeno. A
notificação será apenas um sinal; o log durável será a fonte para recuperar
notificações perdidas.
## Hashes e verificação

O mesmo canonicalizador será usado nos dois backends:

- ordenar recursivamente chaves de objetos;
- preservar ordem de arrays;
- serializar em UTF-8;
- separar por marcador valores JSON e strings KV;
- calcular SHA-256 por entidade;
- ordenar tuplas de entidade/ID/hash antes do hash agregado.

Nunca será usado o texto gerado diretamente por `JSONB`, pois sua ordem de
chaves não é um contrato.
## Sincronização entre PCs

Um listener dedicado receberá `NOTIFY`. Ao receber ou reconectar:

1. consultar `change_log` depois do cursor;
2. filtrar mudanças por escopo;
3. agrupar mudanças repetidas da mesma entidade;
4. recarregar somente registros afetados;
5. aplicar no renderer sem substituir draft local;
6. avançar o cursor depois da aplicação.

Se o cursor for anterior à retenção do log, o app fará reconciliação completa.
Alterações próprias já aplicadas serão ignoradas pela combinação origem/revisão.
## Escrita e fechamento

O renderer deixará de enviar a lista inteira a cada 400 ms. Ele rastreará
conversas sujas e enviará upsert/delete por ID e revisão. Mutações da mesma
conversa serão serializadas; falha mantém estado dirty e mostra erro.

`beforeunload` fire-and-forget não será considerado durável. O fechamento do
Electron terá handshake que aguarda escritas pendentes ou mostra que existe
estado ainda não salvo.
## Lease e retomada em outro PC

Antes de iniciar ou enviar para uma conversa:

1. validar o mapeamento local do projeto;
2. adquirir lease e fencing epoch;
3. confirmar `resume_ready`;
4. marcar o novo turno como não pronto para handoff;
5. construir `SessionStore` escopado à conversa;
6. iniciar `query()` com `resume`, `sessionStore`, `sessionStoreFlush: 'eager'` e timeout de load.

Durante o turno, heartbeat mantém o lease. Cada gravação de histórico e transcript
valida token e fencing epoch. Outros PCs podem acompanhar o histórico, mas não
alterar a conversa.

O Agent SDK `0.3.220` fornece publicamente, embora como `@alpha`:

- `SessionStore`;
- `importSessionToStore`;
- `getSessionInfo`;
- `getSessionMessages`;
- `listSubagents`;
- `getSubagentMessages`;
- `foldSessionSummary`;
- opções `sessionStore`, `sessionStoreFlush` e `loadTimeoutMs`.

O adapter tratará entries como objetos JSON opacos. Não lerá nem editará formatos
privados em `~/.claude/projects`.

Ao concluir o turno:

1. aguardar todos os appends;
2. detectar `mirror_error`;
3. verificar a sessão pelas APIs públicas;
4. reparar com `importSessionToStore` se o transcript local estiver íntegro;
5. persistir o histórico renderizado final;
6. marcar `resume_ready` com hash verificado;
7. liberar o lease.

`mirror_error` ou checkpoint incompleto bloqueia handoff e novas mensagens até
reconciliação. Um owner antigo não pode gravar depois que outro lease avançar o
fencing epoch.

O SDK ficará fixado em `0.3.220`. Toda atualização exigirá fixture escrita pela
versão anterior e teste real de leitura/retomada antes da troca.
## Mapeamento de projeto em outro PC

O projeto terá identidade independente do caminho absoluto, baseada em remote
Git e assinatura estável. Cada instalação manterá seu caminho local. Ao assumir
uma conversa:

- usar mapeamento existente válido;
- tentar correspondência nos diretórios conhecidos do dispositivo;
- confirmar automaticamente apenas correspondência inequívoca;
- se não encontrar, mostrar um aviso grande na área do chat informando que a pasta do projeto não foi localizada;
- incluir no próprio aviso o botão **Selecionar pasta**, que abre o seletor e grava o mapeamento deste dispositivo;
- manter composer e retomada bloqueados até uma pasta válida ser confirmada.
## Ativação SQLite → PostgreSQL

1. Testar conexão sem alterar backend.
2. Criar `agent-code` e aplicar schema.
3. Obter mutex de transição.
4. Bloquear novos agentes, writes e cache switch.
5. Aguardar turnos ativos terminarem sem interrompê-los.
6. Exigir flush do renderer e drenar escritas.
7. Criar backup e manifest dos SQLite global e por projeto.
8. Ler todas as fontes estritamente; corrupção ou JSON inválido aborta.
9. Normalizar para SQLite v2 sem apagar arquivos legados.
10. Importar dados e sessões SDK em transação PostgreSQL serializable.
11. Verificar contagens, IDs, mensagens, hashes por item, hash agregado e APIs públicas do SDK.
12. Commit e releitura pós-commit.
13. Iniciar listener e substituir o estado do renderer.
14. Só então trocar o bootstrap para PostgreSQL e liberar o app.
### Destino PostgreSQL já populado

- mesmo ID e mesmo hash: no-op;
- configuração global existente no PostgreSQL vence;
- configuração deste dispositivo é importada no escopo do dispositivo;
- uma história que seja prefixo da outra mantém o superset verificado;
- histórias divergentes geram cópia de conflito visível;
- sessão SDK divergente usa `forkSession` público para criar ID retomável, sem reescrever transcript privado.
### Falhas e crash recovery

- schema vazio já criado pode permanecer;
- import parcial nunca sobrevive à transação;
- SQLite não é apagado, movido ou truncado;
- bootstrap não seleciona PostgreSQL antes da verificação pós-commit;
- se o commit ocorreu e o bootstrap ficou em `activating-postgres`, o app localiza o `migration_run`, verifica e finaliza;
- sem run commitado, o app permanece em SQLite.
## Desativação PostgreSQL → SQLite

1. Exigir PostgreSQL online.
2. Quiescer writes e turnos.
3. Abrir snapshot consistente read-only com watermark.
4. Ler configuração global, configuração deste dispositivo, conversas, tombstones, mapeamentos e sessões SDK.
5. Escrever uma cópia temporária do SQLite v2 em uma transação.
6. Verificar hashes, contagens e sessões.
7. Substituir atomicamente o SQLite preservado.
8. Carregar o snapshot pelo `SqliteRepository`.
9. Substituir o estado do renderer.
10. Trocar bootstrap para SQLite e liberar writes.

O PostgreSQL e sua auditoria permanecem intactos. Mudanças feitas depois por
outros PCs não serão recebidas por esta instalação enquanto ela estiver em
SQLite.
## Indisponibilidade e recuperação

Se PostgreSQL estiver selecionado e não puder abrir:

- não ler SQLite como histórico/configuração;
- não retornar defaults como se fossem configuração real;
- não retornar lista vazia como se não existissem conversas;
- abrir apenas a interface de recuperação/configuração;
- oferecer retry, correção das credenciais e diagnóstico sanitizado;
- bloquear novos envios, agentes, alterações e desativação sem snapshot.

Se cair em runtime, o app bloqueia novas mutações e leva o turno ativo a uma
fronteira segura. Depois da reconexão, reaplica migrations compatíveis,
reconcilia `change_log`, repara transcript se necessário e só então libera
writes.

Erros tipados incluem autenticação, host, TLS, maintenance DB, criação negada,
schema incompatível, storage offline, lease alheio, handoff incompleto, sessão
SDK incompatível e conflito de revisão.
## Configurações

A tela terá uma seção PostgreSQL com:

- toggle de uso;
- host;
- porta;
- usuário;
- senha mascarada;
- maintenance database;
- modo TLS e CA;
- banco alvo somente leitura: `agent-code`;
- Testar conexão;
- Ativar/Migrar;
- Desativar/Migrar para SQLite;
- progresso por etapa;
- status online/offline e retry.

Testar conexão usa o draft sem salvar ou trocar backend. Ativação e desativação
são operações explícitas, não consequência silenciosa do botão geral Salvar.
Erros não incluirão stack, senha ou connection string.
## Backup Parquet

O gatilho continuará sendo a abertura do sistema. A fonte de conversas passará a
ser `repository.readExportSnapshot()`:

- SQLite selecionado: snapshot SQLite;
- PostgreSQL selecionado: snapshot consistente PostgreSQL;
- PostgreSQL indisponível: falha visível, sem backup SQLite plausível e incorreto.

O arquivo continuará incluindo memórias Markdown do filesystem. Metadados
indicarão backend e watermark. O Parquet nunca incluirá senha PostgreSQL,
parâmetros de conexão, ciphertext de credenciais ou transcript bruto do SDK.

A escrita temporária + rename continuará protegendo o snapshot anterior. O app
acompanhará a conclusão para não encerrar no meio sem diagnóstico.
## Troca de cache

Em modo PostgreSQL, trocar o cache altera apenas recursos locais por dispositivo.
Não troca história/configuração para um SQLite encontrado na pasta.

Em modo SQLite, a troca passará pelo mesmo lifecycle seguro:

1. quiescer e flush;
2. trocar a fonte;
3. resetar estado específico do repositório;
4. recarregar conversas, configuração, UI e serviços dependentes de caminho;
5. substituir o estado do renderer;
6. retomar.

Nenhuma conversa do cache anterior poderá ser salva no novo cache.
## Etapas e critérios de corte
### Etapa 0 — contratos e inventário

Definir contratos, erros, hashes e registro de chaves. Corte: todo valor atual tem
owner e escopo testados.
### Etapa 1 — facade assíncrona e SQLite v2

Colocar SQLite atrás dos contratos, normalizar conversas por registro/revisão e
mover os consumidores para a facade. Corte: app real funciona integralmente em
SQLite, incluindo CRUD, reload, remount, vazio, erro e close handshake.
### Etapa 2 — bootstrap e schema PostgreSQL

Adicionar bootstrap, `pg`, provisionamento e migrator. Corte: criação concorrente,
reaplicação no-op e erros de auth/TLS/DNS/permissão/schema testados.
### Etapa 3 — repositório PostgreSQL

Implementar KV/config global/device, projetos, conversas e tombstones. Corte: a
mesma suíte de contrato passa nos dois backends e modo PostgreSQL faz zero acesso
ao SQLite.
### Etapa 4 — SessionStore e leases

Implementar sessão opaca, import, verificação, subagentes, lease e fencing. Corte:
PC B retoma sessão do PC A em outro caminho; writer duplo e token vencido são
bloqueados; `mirror_error` impede handoff.
### Etapa 5 — ativação e desativação

Implementar quiesce, snapshots, hashes, auditoria e recuperação. Corte: fault
injection não cria backend misto; fontes de origem ficam intactas; ciclos são
idempotentes.
### Etapa 6 — UI e sincronização ao vivo

Adicionar IPC, Settings, persistência incremental e change feed. Corte: dois apps
sincronizam CRUD/config; device state não vaza; write rejeitado permanece dirty;
remount não duplica listener.
### Etapa 7 — startup, Parquet, outage e cache

Reordenar startup e integrar fonte autoritativa. Corte: servidor offline nunca
cai no SQLite; Parquet prova a fonte; cache switch não mistura estados.
### Etapa 8 — endurecimento

Adicionar integração Docker, Electron real isolado, documentação e auditoria de
arquivos abaixo de 500 linhas. Corte: typecheck, testes, integração, build e smoke
real passam.
## Validação

- PostgreSQL descartável com role criadora, role sem `CREATEDB` e TLS de teste.
- SQLite vazio/populado para PostgreSQL vazio/idêntico/divergente.
- Falha injetada antes, durante e depois do commit; recuperação após crash.
- Ativação, desativação e reativação idempotentes.
- CRUD, reload, sair/voltar, remount, vazio, erro, retry e fechamento.
- Duas instâncias Electron com `userData` isolado e o mesmo PostgreSQL.
- Config global compartilhada e configuração/segredos por dispositivo isolados.
- Conversa, update e tombstone propagados em tempo real.
- Lease da mesma conversa negado; conversas diferentes concorrentes.
- Handoff real autenticado com memória de contexto, tool call e subagente.
- Queda no startup, idle, write, stream e listener.
- Spy provando zero acesso SQLite em modo PostgreSQL/offline.
- Parquet com registros `sqlite-only`, `postgres-only` e `memory-only`.
- `npm run typecheck`, `npm test`, `npm run build` e lançamento real do `out/`.
## Critérios de aceite

- SQLite continua funcionando como backend padrão sem perda de dados.
- A UI cria o banco `agent-code`, aplica migrations e ativa PostgreSQL sem passo SQL manual quando a role tem permissão.
- Nenhum dado é considerado migrado sem contagem, hash e leitura de volta.
- PostgreSQL selecionado é a única fonte de histórico, configuração, KV e Parquet.
- Queda do PostgreSQL nunca produz fallback SQLite ou estado vazio falso.
- Vários PCs veem alterações ao vivo sem sobrescrever conversas.
- Uma conversa tem um writer; writers antigos são impedidos por fencing.
- A mesma sessão pode ser retomada em outro PC pelas APIs públicas do Agent SDK.
- Sessão incompleta ou incompatível é bloqueada e identificada, não simulada como retomada.
- Segredos PostgreSQL nunca chegam ao renderer, logs, banco remoto ou Parquet.
- Desativação só troca após criar e verificar o SQLite atual.
- Memórias e skills continuam no filesystem e o Parquet continua incluindo memórias.
- PostgreSQL não aparece na lista de ferramentas do agente.
