# Registro de tarefas e serviço único de memória

Subprojeto 1 da preparação do Agent Code para um time de agentes especializados. Os subprojetos seguintes (contexto por escopo, gate de escrita por agente, especialistas, supervisor, crítico, tela nova) dependem deste e ficam fora daqui.

## Contexto

Hoje o app trabalha por conversa e turno. Não existe registro durável de "tarefa" separado da conversa, e a memória persistente é gravada diretamente pelo modelo com `Write`/`Edit` (sessão e curador). Fatos verificados no código:

- `AgentSession` instrui o modelo a criar `.md` e editar `MEMORY.md` por conta própria (`src/main/agentSession.ts:227-256`). Arquivo e índice são gravações separadas; nada garante consistência.
- `memoryCurator.ts` também grava via modelo (`tools: Write/Edit`, :250-257) e avança `lastRunAt` no `finally` mesmo quando a extração falha (:364-373); usa a hora de término como marca, não a de início. Transcrições não processadas ficam fora da próxima janela.
- `reconcileMemoryIndex` (:280-296) só acrescenta links ausentes; não remove links quebrados nem atualiza descrições, e só roda quando houve chunks.
- Não há outbox nem fila durável. O único análogo a "claim" é o lease de conversa (`persistence/types.ts:108-117`, `conversation_leases` com `fencing_epoch`).
- Persistência tem interface única `PersistenceRepository` (`persistence/types.ts:160-189`) com implementações SQLite e PostgreSQL, migrations versionadas no Postgres (`postgresMigrations.ts:229-233`) e schema declarativo com checksum no SQLite (`sqliteSchema.ts`). Chaves KV fora do `PERSISTED_KEY_REGISTRY` são rejeitadas (`keyRegistry.ts:48-51`).

## Objetivos

1. Um registro durável de **tarefa, execução, etapa e entrega**, com estados, responsável, lease e escopo de escrita, nos dois backends.
2. Um **único caminho de gravação de memória**: agentes e curador propõem; um serviço no main valida e grava arquivo + índice de forma consistente, com versão e detecção de escrita concorrente.
3. Corrigir o curador: marca d'água só avança em sucesso e usa o instante de início da varredura.
4. Nenhum agente novo, nenhuma UI nova além do mínimo para não quebrar o que existe.

## Fora de escopo

Seleção de contexto por especialidade, gate de escrita por agente, cadastro de especialistas, supervisor, crítico, painel visual novo, busca semântica de memórias, migração de PostgreSQL LISTEN para fila distribuída.

## Decisões

- **Fila no banco, não broker externo.** O app é distribuído como exe portátil, mas Electron e workers do SDK usam múltiplos processos. RabbitMQ ou similar seria um serviço separado a mais para o usuário manter. O registro vive no mesmo repositório das conversas.
- **Modelo propõe, serviço grava.** A garantia de consistência não depende do LLM. O modelo perde `Write`/`Edit` sobre `memories/`; ganha uma ferramenta MCP `memory_propose`.
- **Arquivos Markdown continuam sendo a forma canônica de leitura.** Nada muda para quem lê a pasta; muda quem escreve. `MEMORY.md` passa a ser **gerado** a partir do banco, nunca editado à mão pelo modelo.
- **Uma tarefa tem um único escritor por vez.** Reaproveita o padrão de lease + fencing já existente.

## Modelo de dados

Migrations incrementais preservam os checksums históricos: SQLite v2 para tarefas e v3 para memória; PostgreSQL v4 para tarefas e v5 para memória. Tarefas, etapas, entregas e entradas de memória têm revisão; eventos são append-only com `at`, e propostas usam status/lease e timestamps. Não há tabela separada de versões imutáveis de memória nesta etapa.

### `tasks`
| coluna | tipo | notas |
|---|---|---|
| id | text pk | uuid |
| conversation_id | text null | conversa de origem, quando houver |
| project_cwd | text | projeto |
| title | text | |
| goal | text | pedido normalizado |
| acceptance | text json | critérios de aceite, lista |
| status | text | `pending` · `running` · `blocked` · `review` · `done` · `failed` · `cancelled` |
| owner_agent | text null | identidade do agente responsável (livre nesta fase; sem cadastro) |
| write_scope | text json | `{ allow: string[], deny: string[] }` globs relativos ao `project_cwd` |
| parent_task_id | text null | subtarefas |
| attempts | int | |
| max_attempts | int | default 3 |
| lease_token / lease_expires_at / fencing_epoch | | mesmo contrato de `ConversationLease` |

### `task_steps`
`id`, `task_id`, `seq`, `kind` (`analyze` · `implement` · `verify` · `review` · `handoff`), `status` (mesmos de tarefa), `agent`, `sdk_session_id`, `started_at`, `finished_at`, `error` (json estruturado).

### `task_deliverables`
`id`, `task_id`, `step_id`, `kind` (`diff` · `test_run` · `note` · `file` · `screenshot`), `summary`, `payload_path` (arquivo em `<cacheDir>/tasks/<taskId>/`), `payload_hash`, `verified` (bool), `verified_by`.

### `task_events`
Append-only: `id`, `task_id`, `step_id null`, `at`, `kind`, `data json`. É a fonte para o supervisor futuro e para a tela nova. Postgres: trigger `agent_code_record_change('task','global')` como as demais entidades.

### `memory_entries`
| coluna | notas |
|---|---|
| id | uuid |
| rel_path | caminho relativo em `memories/` (único) |
| title, hook | o que vai no bullet do índice |
| scope | `user` · `project` · `domain`; `project_cwd` e `domain` opcionais |
| body | conteúdo Markdown canônico |
| body_hash | sha256 |
| revision | CAS |
| status | `active` · `retired` |
| origin_conversation_id, origin_message_id, origin_agent | proveniência |
| supersedes_id | quando substitui outra entrada |

### `memory_proposals`
Fila: `id`, `entry_id null`, `op` (`create` · `update` · `retire`), `rel_path`, `title`, `hook`, `body`, `scope`, `origin_*`, `status` (`pending` · `applied` · `rejected` · `conflict`), `reason`, `proposed_by` (`session:<convId>` · `curator`), `expected_revision null`, `attempts`, `lease_*`.

## Serviços no main

### `TaskLedger` (`src/main/tasks/taskLedger.ts`)
Sobre `PersistenceRepository`, métodos novos na interface: `createTask`, `claimTask(agentId)` (transação: escolhe `pending` mais antiga sem lease válido, grava lease + `fencing_epoch`, retorna ou `null`), `renewTaskLease`, `transitionTask(id, from → to, fence)` (rejeita se `from` não bate ou fence antigo — `TASK_FENCE_STALE`), `appendStep`, `finishStep`, `addDeliverable`, `appendEvent`, `listTasks(query)`. Toda transição gera um `task_events`.

Máquina de estados válida: `pending→running`, `running→blocked|review|failed|cancelled`, `blocked→running|cancelled`, `review→done|running|failed`, `failed→pending` (só via retomada explícita e `attempts < max_attempts`). Qualquer outra transição é erro.

### `MemoryService` (`src/main/memory/memoryService.ts`)
- `propose(p)`: valida (path dentro de `memories/`, `.md`, slug kebab, body não vazio), grava em `memory_proposals` como `pending`, retorna id. Segredos detectados no corpo (regex de token/chave/senha, mesma lista em `secretScan.ts`) **não rejeitam** a proposta: seguem o fluxo do cofre abaixo.
- `applyPending()`: worker no main, serial por processo, com lease na proposta. Para cada proposta:
  1. `create`: se `rel_path` já existe → `conflict` com `reason`. Senão insere `memory_entries`, escreve o arquivo, regenera `MEMORY.md`.
  2. `update`: exige `expected_revision`; se divergente → `conflict`. Senão nova revisão, reescreve arquivo, regenera índice.
  3. `retire`: marca `retired`, move o arquivo para `memories/.retired/<rel_path>`, regenera índice.
  **Banco primeiro:** a atualização CAS da entrada e o resultado da proposta são confirmados na mesma transação. Só depois os arquivos são projetados por temporário + rename. Banco, arquivo e índice NÃO formam uma transação única: uma queda pode deixar a projeção atrasada, que deve ser reaplicada sem repetir a revisão já confirmada. Falha da projeção não transforma aplicação confirmada em proposta pendente.
  **Índice gerado, títulos preservados:** o `MEMORY.md` passa a ser projeção do banco (ordem alfabética por caminho), mas o texto de cada bullet e os **títulos de seção escritos à mão** (`## 2D — NF-e e banco`) são mantidos — o título é lido do índice atual e guardado no diário local, então não se perde nas regerações seguintes. Ensaio contra uma cópia do acervo real (162 memórias): 162 bullets antes e depois, nenhum perdido, 0 conflitos, seções idênticas.
- `reconcile()`: importa arquivos legados desconhecidos, mas nunca promove automaticamente divergência de entrada existente ou arquivo reaparecido de entrada aposentada. O histórico local de hashes distingue projeção anterior de alteração externa; divergências manuais são preservadas e reportadas, não sobrescritas. Arquivo ausente pode ser refeito a partir do banco. O índice é uma projeção das entradas ativas, com agrupamento por pasta. A etapa 2 permanece desconectada do startup e do acervo real até concluir integração, cofre e transições de backend.
- Propostas em `conflict` ficam visíveis (lista em Configurações → Dados, só leitura, com botão "descartar"); não travam as demais.

### Cofre de segredos (`src/main/memory/secretVault.ts`)

O usuário às vezes precisa que o agente guarde chaves. Em vez de recusar, a memória guarda um **marcador** e o valor vai para um cofre criptografado, com um interruptor em Configurações que corta o acesso do modelo.

- **Armazenamento:** arquivo dedicado e versionado com `name` único, `ciphertext`, `createdAt` e `updatedAt`, cifrado por `safeStorage.encryptString` por meio do adapter já usado pelo bootstrap. Não usa o KV/repositório geral: o escopo `device` desse repositório também é transferido ao PostgreSQL, portanto não garante armazenamento somente local. O diretório do cofre deve ser local, independente do cache móvel e das transferências de banco; o caminho de integração ainda será fixado. O cofre manual do usuário em disco continua intocado. Não há fallback para texto puro se a criptografia estiver indisponível.
- **Ao propor memória:** `secretScan(body)` acha valores que parecem segredo. Cada um vira uma entrada no cofre dedicado com um `name` derivado (`<slug-da-memoria>.<n>`, ou o nome que o modelo passar em `secrets: [{name, value}]`) e o corpo salvo no `.md` recebe `{{secret:<name>}}` no lugar do valor. O texto em claro nunca vai para o Markdown nem para o índice.
- **Interruptor** `secretVaultEnabled` em `AppConfig` (Configurações → Dados), **ligado por padrão** conforme o padrão do projeto, com a explicação "o agente pode salvar e ler chaves no cofre criptografado do app".
  - Ligado: `memory_secret_get({ name })` devolve o valor em claro ao modelo autorizado, para uso em comando, `.env` ou requisição. A auditoria própria registra somente o nome; a apresentação direta da ferramenta deve mascarar o valor. Isso **não garante** ausência em transcrições do SDK, contexto enviado ao provedor, comandos posteriores, respostas do modelo ou backups desses históricos. Criptografia do cofre protege armazenamento em repouso, não todos os usos posteriores do segredo.
  - Desligado: **cada chamada** de leitura e gravação verifica a configuração atual no servidor e é recusada, inclusive em sessões já abertas; apenas remover a ferramenta do catálogo não basta. Não apaga segredos existentes. Uma proposta com novo segredo não deve persistir o valor em claro na fila; o retorno precisa explicar que ele não foi salvo. Desligar não remove valores já enviados ao contexto do modelo nem revoga credenciais no serviço externo.
- **UI mínima:** em Configurações → Dados, lista de nomes do cofre com data e botão "apagar" (nunca mostra o valor). Sem edição por ali nesta fase.
- **Fora:** exportar/importar cofre, sincronizar entre PCs, mostrar valor na tela.

**Estado (10/09/2026):** implementado. O servidor MCP `memory` expõe `memory_propose`, `memory_list`,
`memory_status` e — só com o cofre ligado — `memory_secret_get`. Sessão e curador usam o mesmo caminho;
`Write`/`Edit`/`MultiEdit`/`NotebookEdit` e comando de shell que cite a pasta são negados **antes** do
"Permitir tudo". O cofre vive em `<userData>/vault/secret-vault.json`, fora do cache móvel e das
transferências de banco. Configurações → Dados tem o interruptor do cofre (aplica na hora), a lista de
nomes/datas com "apagar" e a lista de propostas em conflito com "descartar". Falta a validação do
portátil com `safeStorage` real.

### Ferramenta MCP `memory_propose`
Servidor MCP em processo `memory` registrado em `agentSession` ao lado de `browser`/`android`. Ferramentas: `memory_propose({ op, rel_path?, title, hook, body, scope, expected_revision?, secrets? })` e, só com o cofre ligado, `memory_secret_get({ name })`. Auto-aprovada no gate (não altera código do projeto). O `buildMemoryHint` passa a dizer: "para salvar, use `memory_propose`; nunca escreva em `memories/` diretamente". `memories/` sai de `additionalDirectories` para escrita — continua legível via `Read`/`Glob`; a implementação prática é negar `Write`/`Edit`/`Bash` cujo alvo resolva dentro de `memoriesDir` no `handlePermission` (o SDK não separa leitura de escrita por diretório), reaproveitando `realPathInside` do curador.

**Limite do gate:** validar caminhos de `Write`/`Edit` não impede um shell, script, ferramenta desktop ou outro MCP de escrever na mesma pasta. Analisar texto de `Bash`/PowerShell por regex não é uma barreira completa. Antes da ativação, a integração precisa escolher isolamento efetivo de filesystem/capacidades ou declarar explicitamente a proteção parcial; não prometer que o supervisor ou o prompt garante exclusividade de escrita.

### Curador
- Troca `tools: [..., 'Write', 'Edit']` por `['Read','Glob','Grep', 'mcp__memory__memory_propose']`.
- Sem serviço de memória ligado (storage offline), a execução **falha explicitamente** em vez de cair
  no caminho antigo de escrita direta; a marca d'água não avança e a varredura fica para a próxima.
- Marca d'água: `runStartedAt` capturado antes de `findRecentTranscripts`; persistido em `memory-curator:last-run-at` **somente** se `runMemoryCuratorOnce` resolveu sem exceção. Chave nova `memory-curator:last-failure` (device) com `{ at, error }` para diagnóstico. Sem transcrições novas também conta como sucesso.
- `reconcileMemoryIndex` é removido; substituído por `MemoryService.reconcile()`.

## Concorrência

- Duas sessões propondo a mesma memória: ambas gravam proposta; o worker aplica a primeira, a segunda vira `conflict` (create) ou é aplicada como nova revisão se trouxe `expected_revision` correto (update). A projeção é serializada por raiz dentro do processo. Lease por proposta NÃO protege arquivos compartilhados entre processos/PCs: pasta OneDrive compartilhada exige coordenação adicional antes de suportar múltiplos escritores.
- Duas instâncias do app no mesmo cache SQLite: já não é suportado hoje; nada muda.
- Postgres com dois PCs: `claimTask` e `applyPending` usam a mesma transação + fencing das conversas; `task_events` entra no `change_log` para o outro PC enxergar.

## Erros

- Transição inválida ou fence antigo: `StorageError` com código novo (`TASK_INVALID_TRANSITION`, `TASK_FENCE_STALE`), nunca silencioso.
- Falha ao projetar arquivo após commit: proposta continua `applied`; a divergência/falha de projeção é informada separadamente e a reconciliação pode tentar novamente, sem repetir a revisão. Falha de aplicação no banco pode retornar a `pending` dentro do limite de tentativas. Resultado de commit desconhecido não é tratado como requeue confirmado.
- Backend indisponível: mesmo comportamento atual (tela de recuperação); propostas não são perdidas porque só existem no banco.

## Testes

- `taskLedger.test.ts` (SQLite em `mkdtemp`, padrão de `sqliteRepository.test.ts`): criar/claim/renovar/expirar lease, transição válida e inválida, fence antigo rejeitado, `attempts` e retomada, eventos gerados por transição.
- `memoryService.test.ts`: propose→apply cria arquivo e índice; update com revisão errada vira `conflict`; retire move arquivo; crash simulado entre banco e disco → `reconcile` repara; arquivo manual no disco é importado; índice regenerado bate com `renderMemoryIndex` atual.
- `secretVault.test.ts`: `secretScan` acha chave/token/senha e ignora texto comum; proposta com segredo grava marcador no `.md` e valor cifrado no cofre; cofre desligado grava marcador e descarta valor; `memory_secret_get` só existe com o interruptor ligado; leitura registra o nome e nunca o valor.
- `memoryCurator.test.ts`: falha na extração **não** avança a marca; sucesso grava `runStartedAt`, não o fim; curador chama `memory_propose` em vez de `Write`.
- `agentSession.test.ts`: `Write` em `memoriesDir` é negado; `memory_propose` é auto-aprovado; hint não contém mais "just write into it".
- Postgres: mesmos casos sob `AGENT_CODE_PG_INTEGRATION=1`.
- Manual: rodar o app, pedir "lembra disso" numa conversa, conferir arquivo + bullet; derrubar o app durante uma proposta pendente e reabrir.

## Critérios de aceite

1. Nenhum código do app grava em `memories/` fora do `MemoryService`.
2. Após reconciliação sem conflitos, `MEMORY.md` reflete `memory_entries.active`. Projeção atrasada ou bloqueada por alteração manual deve aparecer no resultado; não prometer consistência instantânea entre banco e arquivos.
3. Curador com exceção não avança `last-run-at`.
4. Tarefa não pode ter dois leases válidos; transições fora da máquina são rejeitadas.
5. `npm run typecheck`, `npm test` e `npm run build` passam; exe portátil gerado e aberto em cópia isolada.

## Etapas de implementação

1. Migrations + tipos + `TaskLedger` com testes SQLite.
2. `MemoryService` + `reconcile` + testes com acervos temporários. Importação do acervo real somente depois do cofre, integração e recuperação de transições de backend.
3. MCP `memory_propose`, gate de escrita em `memoriesDir`, hint novo.
3b. Cofre de segredos: `secretScan`, arquivo criptografado device-local dedicado, `memory_secret_get`, interruptor e lista em Configurações → Dados.
4. Curador: ferramentas e marca d'água.
5. Postgres: migration 4 e testes de integração.
6. Lista de conflitos em Configurações → Dados.
7. Documentação (`ARQUITETURA.md`, `REFERENCIA.md`), revisão de diff, portátil.
