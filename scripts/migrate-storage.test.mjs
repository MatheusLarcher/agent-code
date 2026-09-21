import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('built migration launcher loads its artifact and migrates into the runtime local root', () => {
  const projectRoot = resolve(import.meta.dirname, '..')
  const artifact = join(projectRoot, 'out', 'main', 'storageMigration.js')
  assert.equal(existsSync(artifact), true, 'build must emit the standalone migration artifact')

  const root = mkdtempSync(join(tmpdir(), 'agent-migration-launcher-'))
  try {
    const profile = join(root, 'profile')
    const legacyRoot = join(root, 'legacy')
    const userData = join(root, 'user-data')
    mkdirSync(join(profile, '.agent-code'), { recursive: true })
    mkdirSync(legacyRoot, { recursive: true })
    writeFileSync(join(profile, '.agent-code', 'location.json'), JSON.stringify({ cacheDir: legacyRoot }))
    writeFileSync(join(legacyRoot, 'agent-code.db'), 'sandbox database')

    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const run = spawnSync(npm, ['run', 'migrate-storage', '--silent'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: profile, AGENT_CODE_USER_DATA: userData },
      shell: process.platform === 'win32'
    })

    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    const target = join(userData, 'agent-code-local', 'agent-code.db')
    assert.equal(readFileSync(target, 'utf8'), 'sandbox database')
    assert.equal(existsSync(join(legacyRoot, 'agent-code.db')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
