import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dirname;
const result = await build({
  entryPoints: [join(root, 'scene.js')], bundle: true, write: false, minify: true,
  format: 'iife', target: 'es2022', legalComments: 'inline', supported: { 'template-literal': false },
});
const script = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>Agent Code — Escritório em U · 6 PCs</title>
<style>
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#b9b1a7}
#office{width:100%;height:100%;height:100dvh;touch-action:none}canvas{display:block;width:100%;height:100%;outline:none}
.fallback{position:fixed;inset:0;display:grid;place-items:center;padding:32px;font:16px/1.6 system-ui;color:#3f3932}
</style>
</head>
<body>
<main id="office" aria-label="Mockup do escritório em U com 6 PCs"></main>
<noscript><div class="fallback">Ative o JavaScript para visualizar o escritório 3D.</div></noscript>
<script>${script}</script>
</body>
</html>
`;
writeFileSync(join(root, 'index.html'), html, 'utf8');
console.log('HTML independente criado: ' + join(root, 'index.html'));
