---
id: "estado-atual-botao"
tipo: "nota"
titulo: "Estado atual do botão de code review"
etapa: "regras-commit"
links: []
fonte: "src/renderer/src/components/Composer.tsx:1297"
rev: 1
---
- O botão (ícone escudo, título "Revisar código") chama `props.onSend('/code-review', [], [], [])` — **sem `--fix`**.
- Logo, hoje ele só **reporta** os achados; a correção não acontece automaticamente (a skill só corrige com `--fix`).
- A skill vive versionada em `.agents/skills/code-review/SKILL.md` e o app a copia para o cache/raiz global de skills — então ela vale para **todos os projetos**, não só o agent-code.
- A mesma skill é pré-carregada no subagente crítico (`src/main/agents/specialists.ts:157`), que tem `Bash` e é proibido de alterar código.
- Teste que fixa o comando enviado: `src/renderer/src/components/ChatPanel.comment.test.tsx:318`.
