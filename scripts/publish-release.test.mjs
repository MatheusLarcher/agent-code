// Testes do publish-release.mjs: rode com `node --test scripts/publish-release.test.mjs`.
// Nenhuma chamada real ao GitHub: o fetch é falso e os arquivos ficam numa pasta temporária.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseLatestYml,
  decideExistingRelease,
  checkAssetSizes,
  expectedAssets,
  validateVersion,
  readToken,
  run,
  PublishError,
  API_BASE,
} from './publish-release.mjs';

const FIXTURE_YML = [
  'version: 0.1.145',
  'files:',
  '  - url: AgentCode-setup.exe',
  '    sha512: abc==',
  '    size: 563614115',
  'path: AgentCode-setup.exe',
  'sha512: abc==',
  "releaseDate: '2026-10-24T00:04:19.489Z'",
  '',
].join('\n');

test('parseLatestYml lê versão, files[] e campos planos', () => {
  const latest = parseLatestYml(FIXTURE_YML);
  assert.equal(latest.version, '0.1.145');
  assert.equal(latest.path, 'AgentCode-setup.exe');
  assert.equal(latest.sha512, 'abc==');
  assert.equal(latest.releaseDate, '2026-10-24T00:04:19.489Z');
  assert.deepEqual(latest.files, [{ url: 'AgentCode-setup.exe', sha512: 'abc==', size: 563614115 }]);
  assert.deepEqual(expectedAssets(latest), ['AgentCode-setup.exe', 'AgentCode-setup.exe.blockmap', 'latest.yml']);
});

test('validateVersion rejeita latest.yml de outra versão', () => {
  const latest = parseLatestYml(FIXTURE_YML);
  validateVersion(latest, '0.1.145');
  assert.throws(() => validateVersion(latest, '0.1.146'), /0\.1\.145.*0\.1\.146.*build-installer/);
});

test('decideExistingRelease: rascunho apaga, publicada aborta, ausente segue', () => {
  const releases = [
    { id: 1, tag_name: 'v0.1.144', draft: false },
    { id: 2, tag_name: 'v0.1.145', draft: true },
  ];
  assert.deepEqual(decideExistingRelease(releases, 'v0.1.145'), { action: 'delete', release: releases[1] });
  assert.deepEqual(decideExistingRelease(releases, 'v0.1.144'), { action: 'abort', release: releases[0] });
  assert.deepEqual(decideExistingRelease(releases, 'v0.1.146'), { action: 'none' });
});

test('checkAssetSizes aponta anexo ausente e tamanho diferente', () => {
  const local = [
    { name: 'AgentCode-setup.exe', size: 10 },
    { name: 'AgentCode-setup.exe.blockmap', size: 2 },
    { name: 'latest.yml', size: 3 },
  ];
  const remote = [
    { name: 'AgentCode-setup.exe', size: 10 },
    { name: 'latest.yml', size: 4 },
  ];
  assert.deepEqual(checkAssetSizes(remote, local), [
    'anexo AgentCode-setup.exe.blockmap não está na release',
    'anexo latest.yml: 4 bytes na release, 3 local',
  ]);
  assert.deepEqual(checkAssetSizes(local, local), []);
});

test('readToken: GH_TOKEN primeiro, depois git credential fill, senão erro', () => {
  assert.equal(readToken({ GH_TOKEN: ' tok ' }, () => assert.fail('não devia chamar git')), 'tok');
  const spawn = (cmd, args) => {
    assert.equal(cmd, 'git');
    assert.deepEqual(args, ['credential', 'fill']);
    return { status: 0, stdout: 'protocol=https\nhost=github.com\nusername=x\npassword=segredo\n' };
  };
  assert.equal(readToken({}, spawn), 'segredo');
  assert.throws(() => readToken({}, () => ({ status: 1, stdout: '' })), PublishError);
});

// ---------- fluxo completo com fetch falso ----------

function makeDist(version) {
  const root = mkdtempSync(join(tmpdir(), 'publish-release-'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  const exe = Buffer.alloc(1000, 1);
  writeFileSync(join(root, 'dist', 'AgentCode-setup.exe'), exe);
  writeFileSync(join(root, 'dist', 'AgentCode-setup.exe.blockmap'), Buffer.alloc(40, 2));
  const yml = FIXTURE_YML.replace('0.1.145', version).replace('563614115', String(exe.length));
  writeFileSync(join(root, 'dist', 'latest.yml'), yml);
  return { root, ymlBytes: Buffer.from(yml) };
}

// GitHub de mentira: guarda releases e assets em memória e registra as chamadas.
function fakeGithub({ existing = [], ymlBytes, failFirstUpload = false }) {
  const calls = [];
  const state = { releases: [...existing], nextId: 100, failed: false };
  const json = (status, body) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status });

  async function fetchImpl(url, init = {}) {
    const method = init.method || 'GET';
    const u = new URL(url);
    calls.push(`${method} ${u.pathname}${u.search}`);
    assert.ok(!url.includes('segredo'), 'token nunca vai na URL');
    const p = u.pathname;

    if (u.host === 'signed.example') {
      assert.equal(init.headers?.Authorization, undefined, 'URL assinado não leva Authorization');
      return new Response(ymlBytes, { status: 200 });
    }
    assert.equal(init.headers.Authorization, 'Bearer segredo');

    if (method === 'GET' && p === '/repos/MatheusLarcher/agent-code') {
      return json(200, { full_name: 'MatheusLarcher/agent-code', permissions: { push: true } });
    }
    if (method === 'GET' && p === '/repos/MatheusLarcher/agent-code/releases') {
      return json(200, state.releases);
    }
    let m = /^\/repos\/MatheusLarcher\/agent-code\/releases\/(\d+)$/.exec(p);
    if (m) {
      const rel = state.releases.find((r) => r.id === Number(m[1]));
      if (!rel) return json(404, { message: 'Not Found' });
      if (method === 'DELETE') {
        state.releases = state.releases.filter((r) => r !== rel);
        return json(204);
      }
      if (method === 'PATCH') {
        Object.assign(rel, JSON.parse(init.body));
        return json(200, rel);
      }
      return json(200, rel);
    }
    if (method === 'POST' && p === '/repos/MatheusLarcher/agent-code/releases') {
      const body = JSON.parse(init.body);
      assert.equal(body.draft, true);
      assert.equal(body.target_commitish, 'deadbeef');
      const id = state.nextId++;
      const rel = {
        id,
        ...body,
        assets: [],
        html_url: `https://github.com/MatheusLarcher/agent-code/releases/tag/${body.tag_name}`,
        upload_url: `https://uploads.github.com/repos/MatheusLarcher/agent-code/releases/${id}/assets{?name,label}`,
      };
      state.releases.push(rel);
      return json(201, rel);
    }
    m = /^\/repos\/MatheusLarcher\/agent-code\/releases\/(\d+)\/assets$/.exec(p);
    if (m && method === 'POST') {
      assert.equal(u.host, 'uploads.github.com');
      assert.equal(init.duplex, 'half');
      let received = 0;
      for await (const chunk of init.body) received += chunk.length;
      assert.equal(String(received), init.headers['Content-Length']);
      const rel = state.releases.find((r) => r.id === Number(m[1]));
      const name = u.searchParams.get('name');
      if (failFirstUpload && !state.failed && name === 'AgentCode-setup.exe') {
        state.failed = true;
        rel.assets.push({ id: state.nextId++, name, size: 7 }); // parcial
        return json(502, { message: 'Bad Gateway' });
      }
      const asset = { id: state.nextId++, name, size: received };
      rel.assets.push(asset);
      return json(201, asset);
    }
    m = /^\/repos\/MatheusLarcher\/agent-code\/releases\/assets\/(\d+)$/.exec(p);
    if (m) {
      const rel = state.releases.find((r) => r.assets.some((a) => a.id === Number(m[1])));
      if (method === 'DELETE') {
        rel.assets = rel.assets.filter((a) => a.id !== Number(m[1]));
        return json(204);
      }
      assert.equal(init.headers.Accept, 'application/octet-stream');
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'https://signed.example/latest.yml' } });
    }
    return json(500, { message: `rota inesperada ${method} ${p}` });
  }
  return { fetchImpl, calls, state };
}

function deps(root, gh) {
  const lines = [];
  return {
    deps: { root, env: { GH_TOKEN: 'segredo' }, fetchImpl: gh.fetchImpl, gitHead: 'deadbeef', log: (l) => lines.push(l) },
    lines,
  };
}

test('fluxo completo: apaga rascunho antigo, cria, sobe 3 anexos, confere e publica', async () => {
  const { root, ymlBytes } = makeDist('0.1.145');
  try {
    const gh = fakeGithub({ existing: [{ id: 5, tag_name: 'v0.1.145', draft: true, assets: [] }], ymlBytes });
    const { deps: d, lines } = deps(root, gh);
    const result = await run([], d);
    assert.equal(result.draft, false);
    assert.ok(gh.calls.includes('DELETE /repos/MatheusLarcher/agent-code/releases/5'));
    const rel = gh.state.releases[0];
    assert.equal(rel.draft, false);
    assert.deepEqual(rel.assets.map((a) => [a.name, a.size]), [
      ['AgentCode-setup.exe', 1000],
      ['AgentCode-setup.exe.blockmap', 40],
      ['latest.yml', ymlBytes.length],
    ]);
    assert.ok(gh.calls.indexOf('PATCH /repos/MatheusLarcher/agent-code/releases/100') > gh.calls.indexOf('GET /repos/MatheusLarcher/agent-code/releases/assets/103'), 'publica só depois de conferir');
    assert.ok(lines.join('\n').includes('publicada'));
    assert.ok(!lines.join('\n').includes('segredo'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--draft-only para antes do PATCH e devolve id/URL', async () => {
  const { root, ymlBytes } = makeDist('0.1.145');
  try {
    const gh = fakeGithub({ ymlBytes });
    const { deps: d } = deps(root, gh);
    const result = await run(['--draft-only'], d);
    assert.equal(result.draft, true);
    assert.equal(result.id, 100);
    assert.ok(!gh.calls.some((c) => c.startsWith('PATCH')));
    assert.equal(gh.state.releases[0].draft, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release publicada com a mesma tag aborta sem criar nada', async () => {
  const { root, ymlBytes } = makeDist('0.1.145');
  try {
    const gh = fakeGithub({ existing: [{ id: 7, tag_name: 'v0.1.145', draft: false, html_url: 'x', assets: [] }], ymlBytes });
    const { deps: d } = deps(root, gh);
    await assert.rejects(run([], d), /já publicada/);
    assert.ok(!gh.calls.some((c) => c.startsWith('POST') || c.startsWith('DELETE')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upload que falha uma vez apaga o parcial e tenta de novo', async () => {
  const { root, ymlBytes } = makeDist('0.1.145');
  try {
    const gh = fakeGithub({ ymlBytes, failFirstUpload: true });
    const { deps: d } = deps(root, gh);
    const result = await run(['--draft-only'], d);
    assert.equal(result.draft, true);
    assert.ok(gh.calls.some((c) => c.startsWith('DELETE /repos/MatheusLarcher/agent-code/releases/assets/')));
    assert.deepEqual(gh.state.releases[0].assets.map((a) => a.size), [1000, 40, ymlBytes.length]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--dry-run valida token e arquivos sem criar release', async () => {
  const { root, ymlBytes } = makeDist('0.1.145');
  try {
    const gh = fakeGithub({ ymlBytes });
    const { deps: d, lines } = deps(root, gh);
    const result = await run(['--dry-run'], d);
    assert.equal(result.dryRun, true);
    assert.deepEqual(gh.calls, ['GET /repos/MatheusLarcher/agent-code']);
    assert.ok(lines.some((l) => l.includes('AgentCode-setup.exe (1000 bytes)')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('versão do package.json diferente do latest.yml falha antes de pedir token', async () => {
  const { root, ymlBytes } = makeDist('0.1.145');
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.146' }));
    const gh = fakeGithub({ ymlBytes });
    const { deps: d } = deps(root, gh);
    await assert.rejects(run([], d), /0\.1\.145.*0\.1\.146/);
    assert.deepEqual(gh.calls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('API_BASE é o endpoint oficial', () => {
  assert.equal(API_BASE, 'https://api.github.com');
});
