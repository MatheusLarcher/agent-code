/**
 * Caminho local → URL file:/// (aba de arquivo do navegador embutido, ícone de
 * projeto). Barras invertidas viram '/', e TODAS as barras do começo saem antes
 * do prefixo: 'C:\a\b.png' → 'file:///C:/a/b.png'; '/home/u/x' → 'file:///home/u/x'.
 */
export function fileUrl(path: string): string {
  return 'file:///' + path.replace(/\\/g, '/').replace(/^\/+/, '')
}
