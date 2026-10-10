---
id: "conteudo-do-commit"
tipo: "requisito"
titulo: "O que entra no commit e como"
etapa: "regras-commit"
status: "proposto (padrão)"
links: ["gates-do-commit"]
rev: 3
---
Proposta (a confirmar com o usuário):
- Entra **o diff revisado inteiro** (o trabalho + as correções), não só as correções — a review cobre o diff não commitado, e commitar só as correções deixaria o trabalho original solto.
- Stage por **caminho explícito** dos arquivos revisados; nunca `git add -A`/`git add .` — outros agentes podem estar mexendo no mesmo projeto. Nunca `.env`, credenciais ou segredos.
- Mensagem em Conventional Commits, no idioma do histórico do repo (aqui: português, ex.: `fix(codex): …`).
- Sem trailer `Co-Authored-By`, salvo se `.claude/settings.json` do projeto pedir.
- Commit no branch atual; **sem push**, sem criar branch.
