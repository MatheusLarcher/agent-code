---
name: planejar
description: >-
  Execução guiada por tarefas (Plan & Execute) para tarefas COMPLEXAS de código. Use
  OBRIGATORIAMENTE — mesmo que o usuário NÃO peça — sempre que a tarefa for: criar uma
  tela/página/painel inteiro do zero, refatorar em VÁRIOS arquivos, ou implementar um fluxo
  completo (frontend + integração/estado, ou endpoint/schema/worker no backend). Também quando
  o usuário disser "planejar", "passo a passo", "use a skill de tarefas" ou "faça por etapas".
  Garante que você NÃO seja preguiçoso em mudanças complexas (ex.: telas de PDV, dashboards,
  endpoints com efeitos colaterais) gerando tudo de uma vez. NÃO use em tarefas simples (1
  arquivo, ajuste pontual de CSS/Tailwind, bug rápido, dúvida) — nesses casos resolva direto,
  sem plano.
---

# Planejar — Execução Guiada por Tarefas (Plan & Execute)

Você é um agente de terminal. Esta skill define como você trata pedidos de código: **sem
preguiça** em tarefas complexas (telas completas de PDV, painéis de gestão, fluxos inteiros,
endpoints/migrações/workers) e **sem cerimônia** em tarefas simples.

## 🚦 Triagem — faça ANTES de codar

Avalie o pedido:

- **Tarefa SIMPLES** (edição em um único arquivo, ajuste pontual de CSS/Tailwind, correção de um
  bug rápido, dúvida conceitual): **resolva imediatamente e direto. NÃO crie `EXECUTION_PLAN.md`,
  não fragmente em etapas.** Se você entrou nesta skill por engano numa tarefa simples, saia do
  modo de tarefas e apenas resolva. Mesmo assim, valide rodando (Passo 3.5) antes de dizer
  "pronto".

- **Tarefa COMPLEXA** (tela/página/painel do zero, refatoração em múltiplos arquivos, fluxo
  completo frontend + integração, ou mudança de backend com efeito colateral real — endpoint,
  schema, worker, integração externa) **OU pedido explícito** ("planejar", "passo a passo",
  "skill de tarefas"): siga o **protocolo** abaixo. Você está **PROIBIDO de gerar todo o código
  de uma vez**.

---

## ⚙️ Protocolo (somente para tarefa complexa)

### Passo 1 — Planejamento estrito
1. Crie/sobrescreva **`.claude/EXECUTION_PLAN.md`** (nunca na raiz do repo — a raiz vaza pro
   `git status` e pode ser commitada por engano). Se o arquivo já existir, **leia antes** de
   sobrescrever: se parecer de uma sessão anterior não concluída, pergunte ao usuário se é
   continuação antes de descartar.
2. No **topo** dele, cole o **prompt original do usuário** (verbatim).
3. Quebre o pedido em **tarefas atômicas** com checkboxes. Heurística de "atômica": a tarefa dá
   pra **validar isoladamente** (passa nos checks + comportamento observável) e **commitar
   sozinha**. Se não dá pra validar sozinha, está grande ou pequena demais. Exemplo:
   - `[ ]` Tarefa 1: Estrutura base e grids (layout/Tailwind).
   - `[ ]` Tarefa 2: Componentes individuais isolados (estilizados).
   - `[ ]` Tarefa 3: Lógica de estado e integração.
4. Antes de cada tarefa, liste os **"fluxos de uso a validar"** dela (o que será checado no
   Passo 3.5).
5. Se a tarefa envolve arquivos que você não criou, ou muda um contrato existente (API/schema/
   payload de integração), **mostre o plano ao usuário e peça ok antes de codar**. Caso
   contrário, avise no chat que o plano foi criado e **inicie imediatamente a Tarefa 1**.
6. Se `.claude/` não estiver no `.gitignore` do projeto (raro, mas confira), garanta que o
   arquivo de plano não seja versionado.

### Passo 2 — Foco total (uma por vez)
1. Escreva código **exclusivamente** para a tarefa atual.
2. Empregue **máximo esforço** em design e nas regras de UI/API **do projeto** — siga as
   convenções já existentes no código e o `CLAUDE.md` (ex.: notificações via toasts; busca/filtro
   case- e acento-insensível; contratos de API já estabelecidos). **Não seja genérico.** Para
   UI, aplique também a skill `frontend-design` e a preferência de mobile+animações por padrão
   quando aplicável.
3. **Você NÃO tem permissão para começar a próxima etapa** antes de fechar a atual.
4. Descobriu trabalho novo/faltante no meio da tarefa? **Adicione como tarefa no plano** — não
   resolva "por fora" sem registrar. Bloqueou de verdade? **Pare e fale com o usuário**, não
   improvise uma solução fora do escopo combinado.

### Passo 3 — Validação no terminal
1. Concluída a escrita da tarefa, **use o terminal** para testá-la de forma autônoma.
2. Descubra os **checks reais do projeto** (não assuma stack): `package.json` → `npm run
   typecheck`/`test`/`lint`; `pyproject.toml`/`requirements.txt` → `pytest`, `ruff`, `mypy`;
   `Makefile` → alvos definidos; ou o que o `CLAUDE.md` do projeto indicar. Rode todos os que
   existirem.
3. Se o terminal retornar erros, **corrija na hora**, antes de avançar.
4. Com o código passando nos checks de terminal, **faça o Passo 3.5 antes** de marcar `[x]`.
   Typecheck/teste verde **não** é "pronto" — pega o que compila, não o que funciona.

### Passo 3.5 — Validação de runtime (OBRIGATÓRIA)
Checks de terminal não pegam comportamento. **Rode o app/serviço** e exercite a mudança **como
um usuário real** — a validação depende do tipo de tarefa.

**Se tocar UI/fluxo de frontend** (use a skill `/verify` para subir e observar):
- **Remontagem:** abrir → sair (trocar de aba/rota) → **voltar**. O estado/preview persiste?
- **Reload (F5):** recarrega correto?
- **Estado vazio** (sem dados) e **estado de erro** (rede/permissão).
- **Ações encadeadas:** criar→aparece na lista; editar→reflete; excluir→some.
- **Seleção/troca de contexto** (ex.: trocar o paciente/registro selecionado).
- **Recursos com imagem/preview/blob/object-URL/stream/áudio:** testar explicitamente
  montar→desmontar→remontar (é o caso clássico que `tsc` não pega).

**Se tocar backend** (API/schema/worker/integração externa):
- Bata no **endpoint real** (curl, cliente HTTP) — não simule a chamada — e confira o response
  e o **log ao vivo** do serviço.
- Confira o **estado persistido** no banco/storage após a operação (não confie só no retorno).
- Migração de schema: rode-a de forma **idempotente** (aplicar 2x sem erro).
- Integração com serviço de terceiro (webhook, fila, API externa): confirme que o serviço
  **realmente entrega/recebe**, observando logs ao vivo — não apenas o payload simulado.
- **Estado de erro:** falha de rede/credencial/permissão é tratada de forma graciosa, sem
  derrubar o serviço.

Se qualquer item quebrar, **corrija na hora** e revalide. Só então marque a tarefa com `[x]` no
`EXECUTION_PLAN.md`.

### Passo 3.7 — Commit por tarefa
Após marcar `[x]` numa tarefa, faça um **commit focado só nela** (apenas os arquivos daquela
tarefa). Isso dá rollback granular e histórico legível — não acumule várias tarefas num commit
só. Depois disso, inicie a próxima tarefa pendente.

### Passo 4 — Auditoria e entrega
1. Quando a **última** tarefa receber `[x]`, **pare de codar**.
2. Cruze o resultado final com o **"Prompt Original"** salvo no Passo 1 — confira que tudo que foi
   pedido foi entregue.
3. Você só pode escrever **"✅ Funcionalidade concluída"** depois de ter **observado a feature
   funcionando no app/serviço rodando**, pelo fluxo real do usuário (Passo 3.5) — UI ou backend.
   Tipos/testes verdes **não** autorizam esse texto.
4. Ao usuário, aponte **apenas** julgamentos subjetivos de estética/gosto. **NUNCA** delegue a ele
   a verificação de que *funciona* — isso é sua obrigação, não dele.
5. Remova ou arquive o `.claude/EXECUTION_PLAN.md` — não deixe plano concluído órfão no repo.

### Passo 5 — Revisão final (skill `code-review`)
1. Com a última tarefa validada (Passo 3.5) e antes de qualquer commit final, invoque a skill
   `code-review` sobre o diff acumulado de todo o plano (não só da última tarefa) — ela olha bugs
   de correção e oportunidades de reuse/simplificação/eficiência.
2. Se ela encontrar problema: **corrija na hora** e revalide (Passo 3/3.5) antes de seguir.
3. Se o usuário mandar comitar **antes** dessa revisão ter rodado (ou antes de corrigir o que ela
   achou), **avise explicitamente** que há revisão pendente/problemas encontrados — não comite
   calado presumindo que está tudo bem.

---

## Regras inquebráveis
- Nunca despeje todo o código de uma vez numa tarefa complexa.
- `EXECUTION_PLAN.md` é a **fonte de verdade** do progresso: atualize o checkbox após **cada**
  tarefa validada, e faça o commit correspondente (Passo 3.7).
- Passar em typecheck/testes **NÃO é "pronto"**. "Pronto" = comportamento **verificado rodando o
  app/serviço** no fluxo real (Passo 3.5), seja UI ou backend.
- Antes de cada tarefa, **liste no `EXECUTION_PLAN.md` os "fluxos de uso a validar"** daquela
  tarefa. Verificação se planeja, não se improvisa.
- Descobriu trabalho novo no meio? Adicione como tarefa no plano — não resolva "por fora".
  Tarefa bloqueou de verdade? Pare e fale com o usuário — não improvise.
- Mudança de contrato (API/schema) ou arquivo que você não criou: confirme o plano com o
  usuário antes de codar.
- Em tarefa simples, o protocolo de plano não se aplica — **mas a regra de validar rodando o app
  (Passo 3.5) continua valendo**: não diga "pronto/funcionando" sem ter visto funcionar.
- Nunca comite o resultado de uma tarefa complexa sem antes rodar a skill `code-review`
  (Passo 5). Se o usuário pedir pra comitar antes disso, avise que a revisão ainda não rodou ou
  que ela achou problemas — não comite em silêncio.
