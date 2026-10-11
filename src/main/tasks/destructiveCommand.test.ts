import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { destructiveCommandReason, destructiveTextReason } from './destructiveCommand'

const cwd = path.resolve(process.platform === 'win32' ? 'C:\\GitHub\\proj' : '/home/u/proj')
const bash = (command: string): string | null => destructiveCommandReason('Bash', { command }, cwd)
const ps = (command: string): string | null => destructiveCommandReason('PowerShell', { command }, cwd)

describe('destructiveCommandReason — destrutivos', () => {
  it.each([
    'git reset --hard HEAD~1',
    'git checkout -- src/a.ts',
    'git checkout .',
    'git restore .',
    'git clean -fdx',
    'git push --force origin main',
    'git push -f',
    'git push --force-with-lease',
    'git push origin +main',
    'git branch -D feature',
    'git stash drop',
    'git stash clear',
    'git rebase main',
    'git -C ../outro filter-branch --tree-filter x',
    'rm -rf /',
    'rm -rf ~/Documentos',
    'rm -rf ..',
    'rm -rf .',
    'rm -rf ./*',
    'rm -fr ../vizinho',
    'cd .. && rm -rf proj',
    'npm publish',
    'npx vercel --prod',
    'gh release create v1.0.0',
    'docker push org/img:1',
    'kubectl apply -f k8s.yaml',
    'kubectl -n prod delete pod x',
    'terraform destroy',
    'npx prisma migrate reset --force',
    'pnpm exec prisma migrate deploy',
    'npx typeorm migration:run -d ds.ts',
    'psql -c "DROP TABLE users"',
    'psql -c "TRUNCATE users"',
    'sqlite3 app.db "DELETE FROM users"',
    'pg_ctl stop -D /var/lib/postgres',
    'shutdown /s /t 0',
    'taskkill /F /IM node.exe',
    'bash -c "git reset --hard"',
    'sudo rm -rf /etc/app'
  ])('%s → motivo', (command) => {
    expect(bash(command)).toEqual(expect.any(String))
  })

  it.each([
    'Remove-Item -Recurse -Force C:\\Users\\x\\Desktop',
    'Remove-Item -Path .. -Recurse -Force',
    'rm -Recurse -Force C:\\Windows\\Temp\\x',
    'Restart-Computer',
    'cmd /c rd /s /q C:\\dados'
  ])('PowerShell: %s → motivo', (command) => {
    expect(ps(command)).toEqual(expect.any(String))
  })
})

describe('destructiveCommandReason — legítimos passam', () => {
  it.each([
    'git status',
    'git diff --stat',
    'git push origin main',
    'git checkout -b nova',
    'git stash list',
    'git branch -d mergeado',
    'npx vitest run src/main/x.test.ts',
    'rm -rf node_modules/.cache',
    'rm -rf build dist',
    `rm -rf ${path.join(cwd, 'out', 'tmp')}`,
    'rm -r -f dist/*',
    'pg_ctl stop -D out/postgres/data',
    'pg_ctl stop -D C:\\\\GitHub\\\\proj\\\\out\\\\postgres\\\\data',
    'npm run build',
    'git commit -m "drop unused import, truncate long lines"',
    'echo "DELETE FROM x"',
    'psql -c "DELETE FROM users WHERE id = 1"',
    'gh release list',
    'taskkill /F /PID 1234',
    'rm -rf "$TMPDIR/x"'
  ])('%s → null', (command) => {
    expect(bash(command)).toBeNull()
  })

  it('PowerShell dentro do projeto passa', () => {
    expect(ps(`Remove-Item -Recurse -Force ${path.join(cwd, 'dist')}`)).toBeNull()
    expect(ps('Remove-Item -Recurse -Force .\\out\\tmp')).toBeNull()
  })

  it('outras ferramentas e input estranho não são comando', () => {
    expect(destructiveCommandReason('Write', { command: 'git reset --hard' }, cwd)).toBeNull()
    expect(destructiveCommandReason('Bash', { command: 42 } as never, cwd)).toBeNull()
    expect(destructiveCommandReason('Bash', {}, cwd)).toBeNull()
  })
})

describe('destructiveTextReason — perguntas', () => {
  it.each([
    'Posso rodar git reset --hard para limpar?',
    'Rodar `git push --force` no main',
    'Faço force push?',
    'Apagar o banco e recriar',
    'Fazer deploy em produção agora?',
    'Rodar `npm publish`?'
  ])('%s → motivo', (text) => {
    expect(destructiveTextReason(text)).toEqual(expect.any(String))
  })

  it.each(['Qual lib usar?', 'Zod (Recommended)', 'Rodar git status antes?', 'Limpar com rm -rf dist?', ''])('%s → null', (text) => {
    expect(destructiveTextReason(text)).toBeNull()
  })
})
