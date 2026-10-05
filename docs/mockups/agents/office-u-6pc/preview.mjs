import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dirname;
const server = createServer((req, res) => {
  if (req.method !== 'GET' || !['/', '/index.html'].includes(req.url)) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(readFileSync(join(root, 'index.html')));
});
server.listen(0, '127.0.0.1', () => console.log(`Office preview: http://127.0.0.1:${server.address().port}`));
