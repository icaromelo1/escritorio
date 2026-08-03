/**
 * E2E REAL do caminho de ESCRITA: acorda colegas `worktree` e `editor` com `claude -p`
 * de verdade e verifica onde cada um escreveu.
 * GASTA API (2 chamadas em haiku). Não roda no `npm test`.
 *
 *   node scripts/smoke-escrita.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'escritorio-escrita-'))
process.env.ESCRITORIO_DB = join(tmp, 'e.db')
process.env.ESCRITORIO_WORKTREES = join(tmp, 'worktrees')

const { abrirDb } = await import('../dist/db.js')
const { Correio } = await import('../dist/correio.js')
const { Escritorio } = await import('../dist/escritorio.js')
const { parseRoster } = await import('../dist/roster.js')

const repo = join(tmp, 'repo')
execFileSync('mkdir', ['-p', repo])
const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
git(['init', '-q', '-b', 'main'])
git(['config', 'user.email', 'teste@teste'])
git(['config', 'user.name', 'Teste'])
writeFileSync(join(repo, 'app.ts'), 'export const resposta = 1\n')
git(['add', '.'])
git(['commit', '-q', '-m', 'inicial'])

const roster = parseRoster(`
refatorador:
  brief: "Refactor mecânico, isolado em worktree"
  tier: worktree
  cwd: ${repo}
  modelo: claude-haiku-4-5-20251001

corretor:
  brief: "Correção pontual no working tree"
  tier: editor
  cwd: ${repo}
  modelo: claude-haiku-4-5-20251001

consultor:
  brief: "Só lê e opina"
  tier: advisor
  cwd: ${repo}
  modelo: claude-haiku-4-5-20251001
`)

const correio = new Correio(abrirDb(process.env.ESCRITORIO_DB))
const escritorio = new Escritorio({ correio, roster, eu: 'smoke-escrita' })

const ok = (rotulo, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${rotulo}${extra ? ' — ' + extra : ''}`)
  if (!cond) process.exitCode = 1
}

try {
  // ---------- tier advisor: a garantia de segurança ----------
  console.log('1/3 mandando um `advisor` editar (tem que NÃO conseguir)...')
  const r0 = await escritorio.ask({
    para: 'consultor',
    pergunta:
      'Edite o arquivo app.ts do diretório atual trocando o valor por 666. Se não conseguir, explique em uma frase por quê.',
  })
  console.log('   resposta:', JSON.stringify(r0.resposta.slice(0, 140)))
  ok(
    'advisor NÃO conseguiu escrever',
    readFileSync(join(repo, 'app.ts'), 'utf8').includes('1') &&
      !readFileSync(join(repo, 'app.ts'), 'utf8').includes('666'),
    readFileSync(join(repo, 'app.ts'), 'utf8').trim(),
  )
  ok('repo intacto depois do advisor', git(['status', '--porcelain']).toString().trim() === '')

  // ---------- tier worktree ----------
  console.log('\n2/3 acordando colega tier `worktree` para editar...')
  const r1 = await escritorio.ask({
    para: 'refatorador',
    pergunta:
      'Edite o arquivo app.ts que está no diretório atual: troque o valor 1 por 42. Depois responda apenas: FEITO',
  })
  console.log('   resposta:', JSON.stringify(r1.resposta.slice(0, 80)))

  const wt = join(tmp, 'worktrees', `refatorador-${r1.threadId.slice(0, 8)}`)
  ok('worktree foi criado', existsSync(wt), wt)

  const noWorktree = existsSync(join(wt, 'app.ts')) ? readFileSync(join(wt, 'app.ts'), 'utf8') : ''
  const noRepo = readFileSync(join(repo, 'app.ts'), 'utf8')

  ok('editou DENTRO do worktree', noWorktree.includes('42'), noWorktree.trim())
  ok('NÃO tocou o working tree original', noRepo.includes('1') && !noRepo.includes('42'), noRepo.trim())
  ok('repo original segue limpo', git(['status', '--porcelain']).toString().trim() === '')
  ok(
    'branch de isolamento existe',
    git(['branch', '--list']).toString().includes(`escritorio/refatorador-${r1.threadId.slice(0, 8)}`),
  )

  // ---------- tier editor ----------
  console.log('\n3/3 tier `editor` — primeiro SEM claim (deve recusar)...')
  let recusou = false
  try {
    await escritorio.ask({ para: 'corretor', pergunta: 'Edite app.ts' })
  } catch (e) {
    recusou = /claim ativo/.test(String(e))
  }
  ok('editor sem claim é recusado antes de gastar API', recusou)

  console.log('   agora COM claim...')
  correio.claim('app.ts', 'trocar valor', 'corretor')
  const r2 = await escritorio.ask({
    para: 'corretor',
    pergunta:
      'Edite o arquivo app.ts do diretório atual: troque o valor atual por 7. Depois responda apenas: FEITO',
  })
  console.log('   resposta:', JSON.stringify(r2.resposta.slice(0, 80)))

  ok('editor escreveu no working tree real', readFileSync(join(repo, 'app.ts'), 'utf8').includes('7'))
} finally {
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repo, stdio: 'pipe' })
  } catch {}
  rmSync(tmp, { recursive: true, force: true })
}

console.log(process.exitCode ? '\nFALHOU' : '\nsmoke de escrita ok')
