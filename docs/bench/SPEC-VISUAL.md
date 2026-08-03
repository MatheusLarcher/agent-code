# Desafio visual — card "Arquivadas" em vidro

Escreva UM arquivo React: `src/renderer/src/components/ArchivedCard.tsx`.

## Componente

```ts
interface ConversaArquivada { id: string; title: string; updatedAt: number }
interface Props { conversations: ConversaArquivada[]; onUnarchive: (id: string) => void }
export default function ArchivedCard(props: Props): JSX.Element
```

- Cabeçalho clicável com o texto `Arquivadas (n)` e um chevron SVG à esquerda.
- Clicar no cabeçalho expande/recolhe a lista. Começa **recolhido**.
- Cada item mostra o título e um botão `title="Desarquivar"` que chama `onUnarchive(id)`.
- `conversations` vazio → o componente não renderiza nada (`null`).

## Exigências visuais

1. **Vidro sobre fundo escuro.** O cartão fica sobre um fundo com imagem, e o efeito
   tem que ser vidro *nítido*, não borrão cinza: use `backdrop-filter` combinando
   `blur()` **com `brightness()`** — só blur num tema escuro devolve um halo apagado.
2. **Aro cromático de 1px** na borda do cartão, feito com gradiente + `mask` /
   `mask-composite` (não vale `border` de cor chapada).
3. **Expandir animado, sem biblioteca**: a altura tem que animar de verdade —
   `grid-template-rows: 0fr → 1fr` com `transition` (nada de `height: auto`
   instantâneo, nada de framer-motion).
4. **O chevron gira** 90° quando abre, com `transition`.
5. **Hover no item**: o botão "Desarquivar" só aparece ao passar o mouse na linha,
   com transição suave (é a regra de UI acessória deste projeto: discreta, fora do
   fluxo, sem empurrar o conteúdo).
6. Cores **apenas** das variáveis do tema, nunca valores fixos: `--bg`, `--bg-2`,
   `--bg-3`, `--line`, `--text`, `--muted`, `--accent`, `--radius`, `--font`.

O CSS vai no próprio arquivo, dentro de uma tag `<style>` renderizada pelo
componente. Sem dependência nova, sem import de CSS externo, TypeScript estrito.

## Tema do projeto (já existe, use como está)

```css
:root {
  --bg: #1f1e1d;
  --bg-2: #262624;
  --bg-3: #302e2c;
  --line: #3a3836;
  --text: #e8e6e3;
  --muted: #a3a09b;
  --accent: #d97757;
  --radius: 12px;
  --font: -apple-system, "Segoe UI", system-ui, sans-serif;
}
```
