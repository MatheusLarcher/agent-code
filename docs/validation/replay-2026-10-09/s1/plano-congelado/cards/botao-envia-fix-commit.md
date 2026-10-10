---
id: "botao-envia-fix-commit"
tipo: "requisito"
titulo: "Botão envia /code-review --fix --commit"
etapa: "botao-envia-flags"
status: "aprovado"
links: ["commit-como-flag"]
fonte: "src/renderer/src/components/Composer.tsx:1297"
rev: 1
---
- `Composer.tsx:1297`: troca `'/code-review'` por `'/code-review --fix --commit'`.
- O `title` do botão deixa claro que ele também corrige e commita (ex.: "Revisar, corrigir e commitar (skill code-review)"). Hoje o texto é só "Revisar código".
- O teste `ChatPanel.comment.test.tsx:314-319` localiza o botão por `getByTitle(/Revisar código/)` e confere a string enviada: ajustar o regex e o `toHaveBeenCalledWith`. Manter o que o teste protege: o trecho comentado não vai junto e continua no campo.
- O texto chega ao SDK como slash command com args (`agentSession.ts:1372` só o trata como slash). Não precisa de parser novo.

Ver [[Commit como flag --commit, ligado só pelo botão]].
