---
name: rtk
description: >
  Rode comandos de terminal através do proxy `rtk`, que filtra e comprime a saída
  antes dela entrar no contexto (até 90% menos bytes de bash). Use quando quiser
  economizar tokens em `ls`, `git`, `grep`, `test`, `tsc`, `docker`, `npm`/`pnpm`,
  leitura de arquivo e afins. Ativado junto com o modo econômico do Agent Code.
---

# RTK — proxy de terminal que corta a saída

`rtk` é um binário nativo instalado nesta máquina em
`%LOCALAPPDATA%\Programs\rtk\rtk.exe` (já no PATH do usuário). Ele executa o
comando de verdade e devolve uma versão condensada da saída.

## Regra de uso

Quando for rodar um comando de terminal coberto pelo rtk, **prefixe com `rtk`**:

```bash
rtk git status          # em vez de: git status
rtk ls src              # em vez de: ls src
rtk grep -rn "foo" src  # em vez de: grep -rn "foo" src
rtk tsc --noEmit        # erros agrupados
rtk vitest run          # só as falhas
```

Se um comando **não** estiver na lista abaixo, rode-o normalmente, sem `rtk`.

## Comandos cobertos

`ls` · `tree` · `read` · `find` · `grep` · `rg` · `wc` · `diff` · `log` · `json`
`git` · `gh` · `glab`
`test` · `jest` · `vitest` · `tsc` · `prisma` · `pnpm` · `dotnet`
`docker` · `kubectl` · `oc` · `aws` · `psql` · `wget`
`err` (roda qualquer comando e mostra só erros/warnings) · `summary` · `smart` · `deps` · `env`

Para qualquer comando barulhento fora da lista, `rtk err <comando>` já corta a
maior parte do ruído.

## Meta-comandos (sempre diretos, sem prefixo duplo)

```bash
rtk gain          # quanto de token foi economizado
rtk proxy <cmd>   # roda cru, sem filtro (debug)
rtk --version     # verificar instalação
```

## Limites — quando NÃO usar

- **Saída que você precisa exata**: conteúdo integral de arquivo para editar,
  string de erro literal que vai virar patch, hash/ID que não pode ser truncado.
  Nesses casos use a ferramenta nativa (`Read`, `Grep`) ou `rtk proxy`.
- **Ferramentas nativas do harness** (`Read`, `Glob`, `Grep`, `Edit`) já são
  eficientes — o rtk é para o que passa pelo `Bash`.
- Se `rtk --version` falhar, siga sem ele e avise o usuário; nunca trave a tarefa
  por causa do proxy.
