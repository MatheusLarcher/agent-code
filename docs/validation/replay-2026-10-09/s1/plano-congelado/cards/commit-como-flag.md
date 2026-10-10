---
id: "commit-como-flag"
tipo: "decisao"
titulo: "Commit como flag --commit, ligado só pelo botão"
etapa: "skill-flag-commit"
status: "aprovada"
links: ["estado-atual-botao","botao-corrige-sozinho"]
fonte: "src/main/agents/specialists.ts:157"
rev: 2
---
**Decisão (usuário, 09/10/2026):** o commit automático vale **só no botão**. Ele vem de uma nova flag `--commit` na skill (ao lado de `--fix` e `--comment`), e o botão envia `/code-review --fix --commit`.

**Por quê:**
- A skill é pré-carregada no subagente crítico (`src/main/agents/specialists.ts:157`), que tem `Bash` e é proibido de mexer no código. Com commit padrão, ele passaria a commitar ao revisar tarefas do PO.
- A skill é instalada globalmente e usada em outros projetos (ex.: ERP ITP). Quem digita `/code-review` à mão não espera um commit.

**Efeito:** sem `--commit`, a skill se comporta exatamente como hoje. A seção nova precisa ser genérica (vale para qualquer projeto): os checks e as regras de commit vêm do AGENTS.md/CLAUDE.md do projeto revisado.

Ver [[Estado atual do botão de code review]] e [[O botão deve corrigir sozinho antes de commitar?]].
