#!/usr/bin/env node
// Publica o trio da atualização (AgentCode-setup.exe, .blockmap e latest.yml) numa
// Release do GitHub, na tag v<versão do package.json>.
//
// Fluxo: valida dist/ contra a versão → apaga rascunho antigo da mesma tag (release
// publicada aborta) → cria RASCUNHO → sobe os 3 anexos em stream → confere tamanhos
// e o latest.yml byte a byte → só então torna a release pública (draft: false).
//
// Flags: --dry-run (valida token, versão e arquivos; não cria nada)
//        --draft-only (cria e confere o rascunho, imprime id/URL e para)
//
// O token vem de GH_TOKEN ou do `git credential fill` (github.com) e NUNCA é impresso.
// Sem dependência nova: só Node >= 20 (fetch nativo com body em stream).

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';

export const OWNER = 'MatheusLarcher';
export const REPO = 'agent-code';
export const EXE_NAME = 'AgentCode-setup.exe';
export const API_BASE = 'https://api.github.com';
const USER_AGENT = 'agent-code-publish';
const REPO_PATH = `/repos/${OWNER}/${REPO}`;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class PublishError extends Error {}

// ---------- funções puras ----------

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1);
  }
  return v;
}

// Parser mínimo do latest.yml do electron-builder (chaves planas + lista `files`).
export function parseLatestYml(text) {
  const out = { files: [] };
  let inFiles = false;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      inFiles = line === 'files:';
      if (inFiles) continue;
      const m = /^([\w-]+):\s*(.*)$/.exec(line);
      if (m) out[m[1]] = unquote(m[2]);
      continue;
    }
    if (!inFiles) continue;
    const isItem = line.startsWith('- ');
    if (isItem) out.files.push({});
    const m = /^([\w-]+):\s*(.*)$/.exec(isItem ? line.slice(2) : line);
    if (m && out.files.length) {
      const cur = out.files[out.files.length - 1];
      cur[m[1]] = m[1] === 'size' ? Number(m[2]) : unquote(m[2]);
    }
  }
  return out;
}

// Decide o que fazer com uma release já existente na mesma tag.
export function decideExistingRelease(releases, tag) {
  const found = (releases || []).find((r) => r.tag_name === tag);
  if (!found) return { action: 'none' };
  return found.draft ? { action: 'delete', release: found } : { action: 'abort', release: found };
}

// Compara os assets da API com os arquivos locais. Devolve a lista de problemas.
export function checkAssetSizes(remoteAssets, localFiles) {
  const problems = [];
  for (const file of localFiles) {
    const asset = (remoteAssets || []).find((a) => a.name === file.name);
    if (!asset) problems.push(`anexo ${file.name} não está na release`);
    else if (asset.size !== file.size) {
      problems.push(`anexo ${file.name}: ${asset.size} bytes na release, ${file.size} local`);
    }
  }
  return problems;
}

// Nomes dos anexos que a release precisa ter, derivados do latest.yml.
export function expectedAssets(latest) {
  const files = latest.files || [];
  if (!files.length || !files[0].url) {
    throw new PublishError('dist/latest.yml não lista nenhum arquivo em `files`');
  }
  if (files[0].url !== EXE_NAME || latest.path !== EXE_NAME) {
    throw new PublishError(
      `dist/latest.yml aponta para "${files[0].url}"/"${latest.path}"; o README e o ` +
        `electron-updater esperam "${EXE_NAME}" (nsis.artifactName no electron-builder.yml)`
    );
  }
  const names = [];
  for (const f of files) names.push(f.url, `${f.url}.blockmap`);
  names.push('latest.yml');
  return names;
}

export function validateVersion(latest, pkgVersion) {
  if (!latest.version) throw new PublishError('dist/latest.yml sem a linha `version:`');
  if (latest.version !== pkgVersion) {
    throw new PublishError(
      `dist/latest.yml é da versão ${latest.version}, o package.json está em ${pkgVersion}: ` +
        'rode scripts\\build-installer.bat'
    );
  }
}

// ---------- token ----------

export function readToken(env = process.env, spawn = spawnSync) {
  if (env.GH_TOKEN && env.GH_TOKEN.trim()) return env.GH_TOKEN.trim();
  const r = spawn('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    env: { ...env, GIT_TERMINAL_PROMPT: '0' },
  });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('password='));
  const token = line ? line.slice('password='.length).trim() : '';
  if (!token) {
    throw new PublishError(
      'Token do GitHub não encontrado: defina GH_TOKEN ou faça login no git para github.com ' +
        '(git credential fill não devolveu senha).'
    );
  }
  return token;
}

// ---------- cliente da API ----------

export function createApi(token, fetchImpl = globalThis.fetch) {
  const base = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  };

  async function handle(res, label) {
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const detail = data && data.message ? data.message : text.slice(0, 200);
      throw new PublishError(`GitHub respondeu ${res.status} em ${label}: ${detail}`);
    }
    return data;
  }

  async function json(method, path, body) {
    const init = { method, headers: { ...base } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return handle(await fetchImpl(API_BASE + path, init), `${method} ${path}`);
  }

  // Upload em stream: o setup tem centenas de MB e nunca é carregado em memória.
  // onProgress(bytesEnviados) é chamado conforme o arquivo é lido.
  async function upload(uploadUrl, name, filePath, size, onProgress) {
    const url = `${uploadUrl.replace(/\{\?[^}]*\}$/, '')}?name=${encodeURIComponent(name)}`;
    let sent = 0;
    const counted = createReadStream(filePath).pipe(
      new Transform({
        transform(chunk, _enc, cb) {
          sent += chunk.length;
          if (onProgress) onProgress(sent);
          cb(null, chunk);
        },
      })
    );
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { ...base, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
      body: Readable.toWeb(counted),
      duplex: 'half',
    });
    return handle(res, `upload de ${name}`);
  }

  // Baixa um asset: a API responde 302 para um URL assinado, que NÃO pode receber o
  // header Authorization (o S3 recusa).
  async function downloadAsset(assetId) {
    const path = `${REPO_PATH}/releases/assets/${assetId}`;
    const res = await fetchImpl(API_BASE + path, {
      headers: { ...base, Accept: 'application/octet-stream' },
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new PublishError(`GitHub redirecionou o asset ${assetId} sem Location`);
      const signed = await fetchImpl(location, { headers: { 'User-Agent': USER_AGENT } });
      if (!signed.ok) {
        throw new PublishError(`download do asset ${assetId} falhou com ${signed.status}`);
      }
      return Buffer.from(await signed.arrayBuffer());
    }
    if (!res.ok) await handle(res, `GET ${path}`);
    return Buffer.from(await res.arrayBuffer());
  }

  return { json, upload, downloadAsset };
}

// ---------- fluxo ----------

function gitHead(root) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const sha = (r.stdout || '').trim();
  if (r.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new PublishError('git rev-parse HEAD falhou; a release precisa apontar para um commit');
  }
  return sha;
}

function loadLocal(root) {
  const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const dist = join(root, 'dist');
  const latestPath = join(dist, 'latest.yml');
  if (!existsSync(latestPath)) {
    throw new PublishError('dist/latest.yml não existe: rode scripts\\build-installer.bat');
  }
  const latest = parseLatestYml(readFileSync(latestPath, 'utf8'));
  validateVersion(latest, pkgVersion);
  const files = expectedAssets(latest).map((name) => {
    const path = join(dist, name);
    if (!existsSync(path)) throw new PublishError(`dist/${name} não existe: rode scripts\\build-installer.bat`);
    return { name, path, size: statSync(path).size };
  });
  const exe = files.find((f) => f.name === EXE_NAME);
  if (exe.size !== latest.files[0].size) {
    throw new PublishError(
      `dist/${EXE_NAME} tem ${exe.size} bytes, mas latest.yml diz ${latest.files[0].size}: ` +
        'a build está inconsistente, rode scripts\\build-installer.bat'
    );
  }
  return { version: pkgVersion, files, latestPath };
}

async function uploadWithRetry(api, release, file, log) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    const mb = (file.size / 1048576).toFixed(1);
    // Arquivo grande: uma linha a cada 10% para o upload longo não parecer travado.
    let nextMark = 10;
    const onProgress = (sent) => {
      const pct = Math.floor((sent / file.size) * 100);
      if (file.size < 50 * 1048576 || pct < nextMark) return;
      nextMark = pct + 10;
      log(`  ${file.name}: ${pct}% (${(sent / 1048576).toFixed(0)}/${mb} MB, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
    };
    try {
      await api.upload(release.upload_url, file.name, file.path, file.size, onProgress);
      log(`  enviado ${file.name}: ${mb} MB em ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return;
    } catch (err) {
      if (attempt === 2) {
        throw new PublishError(
          `upload de ${file.name} falhou duas vezes (${err.message}). O rascunho ` +
            `${release.html_url} ficou no GitHub para diagnóstico; apague-o ou rode de novo.`
        );
      }
      log(`  upload de ${file.name} falhou (${err.message}); limpando o parcial e tentando de novo`);
      const current = await api.json('GET', `${REPO_PATH}/releases/${release.id}`);
      const partial = (current.assets || []).find((a) => a.name === file.name);
      if (partial) await api.json('DELETE', `${REPO_PATH}/releases/assets/${partial.id}`);
    }
  }
}

export async function run(argv, deps = {}) {
  const root = deps.root || ROOT;
  const log = deps.log || ((line) => console.log(line));
  const dryRun = argv.includes('--dry-run');
  const draftOnly = argv.includes('--draft-only');

  const { version, files, latestPath } = loadLocal(root);
  const tag = `v${version}`;
  const token = readToken(deps.env || process.env, deps.spawn || spawnSync);
  const api = createApi(token, deps.fetchImpl || globalThis.fetch);

  if (dryRun) {
    const repo = await api.json('GET', REPO_PATH);
    log(`[dry-run] token OK para ${repo.full_name} (permissão push: ${Boolean(repo.permissions?.push)})`);
    log(`[dry-run] versão ${version} confere com dist/latest.yml`);
    log(`[dry-run] criaria a release ${tag} (rascunho → publicada) com os anexos:`);
    for (const f of files) log(`  ${f.name} (${f.size} bytes)`);
    return { dryRun: true, tag, files };
  }

  const releases = await api.json('GET', `${REPO_PATH}/releases?per_page=100`);
  const decision = decideExistingRelease(releases, tag);
  if (decision.action === 'abort') {
    throw new PublishError(
      `release ${tag} já publicada no GitHub (${decision.release.html_url}); suba a versão ` +
        '(scripts\\build-installer.bat) antes de publicar de novo'
    );
  }
  if (decision.action === 'delete') {
    log(`rascunho antigo de ${tag} (id ${decision.release.id}) apagado`);
    await api.json('DELETE', `${REPO_PATH}/releases/${decision.release.id}`);
  }

  const release = await api.json('POST', `${REPO_PATH}/releases`, {
    tag_name: tag,
    target_commitish: deps.gitHead || gitHead(root),
    name: tag,
    body: `Agent Code ${version}`,
    draft: true,
    prerelease: false,
  });
  log(`rascunho ${tag} criado (id ${release.id})`);

  for (const file of files) await uploadWithRetry(api, release, file, log);

  const checked = await api.json('GET', `${REPO_PATH}/releases/${release.id}`);
  const problems = checkAssetSizes(checked.assets, files);
  if (problems.length) {
    throw new PublishError(
      `conferência dos anexos falhou: ${problems.join('; ')}. O rascunho ${release.html_url} ` +
        'ficou no GitHub para diagnóstico.'
    );
  }
  const remoteLatest = checked.assets.find((a) => a.name === 'latest.yml');
  const remoteBytes = await api.downloadAsset(remoteLatest.id);
  if (!remoteBytes.equals(readFileSync(latestPath))) {
    throw new PublishError(
      `o latest.yml na release difere do dist/latest.yml local. O rascunho ${release.html_url} ` +
        'ficou no GitHub para diagnóstico.'
    );
  }
  log('anexos conferidos: tamanhos iguais aos locais e latest.yml idêntico byte a byte');

  if (draftOnly) {
    log(`[draft-only] rascunho mantido: id ${release.id}, ${release.html_url}`);
    return { draft: true, id: release.id, html_url: release.html_url, tag };
  }

  const published = await api.json('PATCH', `${REPO_PATH}/releases/${release.id}`, { draft: false });
  log(`release ${tag} publicada: ${published.html_url}`);
  return { draft: false, id: published.id, html_url: published.html_url, tag };
}

async function main() {
  try {
    await run(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof PublishError ? err.message : (err && err.stack) || String(err);
    console.error(`[ERRO] ${msg}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
