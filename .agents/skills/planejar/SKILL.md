---
name: planejar
description: >-
  Execução guiada por tarefas (Plan & Execute) para tarefas COMPLEXAS de código. Use
  OBRIGATORIAMENTE — mesmo que o usuário NÃO peça — sempre que a tarefa for: criar uma
  tela/página/painel inteiro do zero, refatorar em VÁRIOS arquivos, ou implementar um fluxo
  completo (frontend + integração/estado). Também quando o usuário disser "planejar", "passo a
  passo", "use a skill de tarefas" ou "faça por etapas". Garante que você NÃO seja preguiçoso em
  front-end complexo (ex.: telas de PDV, dashboards) gerando tudo de uma vez. NÃO use em tarefas
  simples (1 arquivo, ajuste pontual de CSS/Tailwind, bug rápido, dúvida) — nesses casos resolva
  direto, sem plano.
---

# Planejar — Execução Guiada por Tarefas (Plan & Execute)

Você é um agente de terminal. Esta skill define como você trata pedidos de código: **sem
preguiça** em tarefas complexas (telas completas de PDV, painéis de gestão, fluxos inteiros) e
**sem cerimônia** em tarefas simples.

## 🚦 Triagem — faça ANTES de codar

Avalie o pedido:

- **Tarefa SIMPLES** (edição em um único arquivo, ajuste pontual de CSS/Tailwind, correção de um
  bug rápido, dúvida conceitual): **resolva imediatamente e direto. NÃO crie `EXECUTION_PLAN.md`,
  não fragmente em etapas.** Se você entrou nesta skill por engano numa tarefa simples, saia do
  modo de tarefas e apenas resolva.

- **Tarefa COMPLEXA** (tela/página/painel do zero, refatoração em múltiplos arquivos, fluxo
  completo frontend + integração) **OU pedido explícito** ("planejar", "passo a passo", "skill de
  tarefas"): siga o **protocolo** abaixo. Você está **PROIBIDO de gerar todo o código de uma vez**.

---

## ⚙️ Protocolo (somente para tarefa complexa)

### Passo 1 — Planejamento estrito
1. Crie/sobrescreva o arquivo **`EXECUTION_PLAN.md` na raiz do projeto**.
2. No **topo** dele, cole o **prompt original do usuário** (verbatim).
3. Quebre o pedido em **tarefas atômicas** com checkboxes. Exemplo:
   - `[ ]` Tarefa 1: Estrutura base e grids (layout/Tailwind).
   - `[ ]` Tarefa 2: Componentes individuais isolados (estilizados).
   - `[ ]` Tarefa 3: Lógica de estado e integração.
4. Avise no chat que o plano foi criado e **inicie imediatamente a Tarefa 1**.

### Passo 2 — Foco total (uma por vez)
1. Escreva código **exclusivamente** para a tarefa atual.
2. Empregue **máximo esforço** em design e nas regras de UI **do projeto** — siga as convenções já
   existentes no código e o `CLAUDE.md` (ex.: notificações via toasts; busca/filtro
   case- e acento-insensível). **Não seja genérico.**
3. **Você NÃO tem permissão para começar a próxima etapa** antes de fechar a atual.

### Passo 3 — Validação no terminal
1. Concluída a escrita da tarefa, **use o terminal** para testá-la de forma autônoma.
2. Rode os **checks reais do projeto** — descubra-os nos scripts do `package.json`. Neste repo:
   `npm run typecheck` e `npm test`; rode também lint/build parcial se existirem.
3. Se o terminal retornar erros, **corrija na hora**, antes de avançar.
4. Com o código passando nos checks de terminal, **faça o Passo 3.5 antes** de marcar `[x]`.
   Typecheck/teste verde **não** é "pronto" — pega o que compila, não o que funciona.

### Passo 3.5 — Validação de runtime (OBRIGATÓRIA p/ qualquer mudança de UI/fluxo)
Checks de terminal não pegam comportamento. **Rode o app** e exercite a feature **como um
usuário** (use a skill `/verify` para subir e observar). Passe por esta checklist anti-regressão:
- **Remontagem:** abrir → sair (trocar de aba/rota) → **voltar**. O estado/preview persiste?
- **Reload (F5):** recarrega correto?
- **Estado vazio** (sem dados) e **estado de erro** (rede/permissão).
- **Ações encadeadas:** criar→aparece na lista; editar→reflete; excluir→some.
- **Seleção/troca de contexto** (ex.: trocar o paciente/registro selecionado).
- **Recursos com imagem/preview/blob/object-URL/stream/áudio:** testar explicitamente
  montar→desmontar→remontar (é o caso clássico que `tsc` não pega).

Se qualquer item quebrar, **corrija na hora** e revalide. Só então marque a tarefa com `[x]` no
`EXECUTION_PLAN.md` e inicie a próxima pendente.

### Passo 4 — Auditoria e entrega
1. Quando a **última** tarefa receber `[x]`, **pare de codar**.
2. Cruze o resultado final com o **"Prompt Original"** salvo no Passo 1 — confira que tudo que foi
   pedido foi entregue.
3. Você só pode escrever **"✅ Funcionalidade concluída"** depois de ter **observado a feature
   funcionando no app rodando**, pelo fluxo real do usuário (Passo 3.5). Tipos/testes verdes **não**
   autorizam esse texto.
4. Ao usuário, aponte **apenas** julgamentos subjetivos de estética/gosto. **NUNCA** delegue a ele
   a verificação de que *funciona* — isso é sua obrigação, não dele.

---

## Regras inquebráveis
- Nunca despeje todo o código de uma vez numa tarefa complexa.
- `EXECUTION_PLAN.md` é a **fonte de verdade** do progresso: atualize o checkbox após **cada**
  tarefa validada.
- Passar em typecheck/testes **NÃO é "pronto"**. "Pronto" = comportamento **verificado rodando o
  app** no fluxo real (Passo 3.5). Tipos/testes pegam o que compila, não o que funciona.
- Antes de cada tarefa, **liste no `EXECUTION_PLAN.md` os "fluxos de uso a validar"** daquela
  tarefa. Verificação se planeja, não se improvisa.
- Em tarefa simples, o protocolo de plano não se aplica — **mas a regra de validar rodando o app
  (Passo 3.5) continua valendo**: não diga "pronto/funcionando" sem ter visto funcionar.
