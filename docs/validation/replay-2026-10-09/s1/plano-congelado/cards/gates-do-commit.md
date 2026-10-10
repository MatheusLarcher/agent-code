---
id: "gates-do-commit"
tipo: "requisito"
titulo: "Quando NÃO commitar"
etapa: "regras-commit"
status: "aprovado"
links: ["commit-como-flag"]
rev: 2
---
**Aprovado pelo usuário em 09/10/2026.** O commit só acontece se tudo abaixo for verdade. Senão a skill **não commita e diz o motivo** (o usuário decide o que fazer):
1. Há diff para commitar. Diff vazio ou trivial: nada a fazer, sem commit.
2. Todo achado confirmado foi corrigido. Se algum ficou em aberto, a skill avisa e não commita (alinhado ao Step 3 da skill).
3. Depois das correções, passaram os checks que o projeto exige antes de commitar, conforme o AGENTS.md/CLAUDE.md dele. No agent-code isso é **typecheck + test + build** (o build inclui o binário .NET). O usuário aceitou o custo de tempo para seguir a regra do AGENTS.md.

Se não houver achados, ainda vale: com diff não vazio e checks verdes, commita.

Ver [[Commit como flag --commit, ligado só pelo botão]].
