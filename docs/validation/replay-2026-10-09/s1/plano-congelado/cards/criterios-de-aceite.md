---
id: "criterios-de-aceite"
tipo: "requisito"
titulo: "Critérios de aceite do commit automático"
etapa: "validacao"
status: "aprovado"
links: ["gates-do-commit","conteudo-do-commit","botao-envia-fix-commit"]
rev: 1
---
Validação no app real (DoD do usuário: typecheck/test verde não basta):
1. `npm run typecheck` e `npm test` verdes.
2. App rodando, diff real com um bug plantado, clique no botão: a skill revisa, corrige, roda typecheck+test+build e cria **um** commit local. `git log -1` mostra mensagem Conventional Commits em português e sem `Co-Authored-By`. Nada de push.
3. Check falhando (ex.: erro de tipo que a correção não resolve): **nenhum commit**, e a resposta diz o motivo.
4. Diff vazio, clique no botão: nenhum commit, com aviso de que não havia nada.
5. Arquivo não relacionado/não rastreado fora do escopo (ex.: `.env` de teste): **não** entra no commit.
6. `/code-review` digitado à mão (sem `--commit`): comportamento igual ao de hoje, sem commit.
7. A skill atualizada chega ao cache: depois de editar `.agents/skills/code-review/SKILL.md`, o app recarrega a versão nova (`managedSkillSourceVersion` em `agentSession.ts:682`).

Risco a conferir: com o provedor GPT/Codex, ver se o slash command com args chega à skill do mesmo jeito.

Ver [[Quando NÃO commitar]] e [[O que entra no commit e como]].
