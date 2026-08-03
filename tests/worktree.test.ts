import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abrirDb } from '../src/db.js'
import { Correio } from '../src/correio.js'
import { resolverCwd, acordarColega, nomeDoWorktree, type Runner } from '../src/colega.js'
import type { ColegaConfig } from '../src/roster.js'

let tmp: string
let repo: string
let correio: Correio

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'escritorio-wt-'))
  process.env.ESCRITORIO_WORKTREES = join(tmp, 'worktrees')

  repo = join(tmp, 'repo')
  execFileSync('mkdir', ['-p', repo])
  git(['init', '-q', '-b', 'main'], repo)
  git(['config', 'user.email', 'teste@teste'], repo)
  git(['config', 'user.name', 'Teste'], repo)
  writeFileSync(join(repo, 'app.ts'), 'export const x = 1\n')
  git(['add', '.'], repo)
  git(['commit', '-q', '-m', 'inicial'], repo)

  correio = new Correio(abrirDb(':memory:'))
})

afterEach(() => {
  delete process.env.ESCRITORIO_WORKTREES
  rmSync(tmp, { recursive: true, force: true })
})

const colega = (tier: 'advisor' | 'editor' | 'worktree', cwd?: string): ColegaConfig => ({
  nome: 'refatorador',
  brief: 'x',
  tier,
  cwd,
})

describe('resolverCwd', () => {
  it('advisor e editor trabalham no cwd do roster, sem worktree', async () => {
    expect(await resolverCwd(colega('advisor', repo), 'advisor', 't1')).toBe(repo)
    expect(await resolverCwd(colega('editor', repo), 'editor', 't1')).toBe(repo)
    expect(existsSync(process.env.ESCRITORIO_WORKTREES!)).toBe(false)
  })

  it('worktree cria pasta isolada e branch própria', async () => {
    const threadId = 'abcdef12-3456-7890'
    const destino = await resolverCwd(colega('worktree', repo), 'worktree', threadId)

    expect(destino).toBe(join(tmp, 'worktrees', nomeDoWorktree('refatorador', threadId)))
    expect(existsSync(join(destino!, 'app.ts'))).toBe(true)

    const branches = git(['branch', '--list'], repo).toString()
    expect(branches).toContain(`escritorio/${nomeDoWorktree('refatorador', threadId)}`)
  })

  it('editar no worktree NÃO toca o working tree original', async () => {
    const destino = await resolverCwd(colega('worktree', repo), 'worktree', 'thread-01')
    writeFileSync(join(destino!, 'app.ts'), 'export const x = 999\n')

    expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toBe('export const x = 1\n')
    expect(git(['status', '--porcelain'], repo).toString().trim()).toBe('')
  })

  it('thread retomada reusa o mesmo worktree em vez de explodir', async () => {
    const a = await resolverCwd(colega('worktree', repo), 'worktree', 'thread-02')
    const b = await resolverCwd(colega('worktree', repo), 'worktree', 'thread-02')
    expect(b).toBe(a)
  })

  it('threads diferentes ganham worktrees diferentes', async () => {
    const a = await resolverCwd(colega('worktree', repo), 'worktree', 'thread-aa')
    const b = await resolverCwd(colega('worktree', repo), 'worktree', 'thread-bb')
    expect(a).not.toBe(b)
  })

  it('pasta que não é repo git RECUSA em vez de cair no diretório real', async () => {
    const naoRepo = join(tmp, 'solto')
    execFileSync('mkdir', ['-p', naoRepo])

    await expect(resolverCwd(colega('worktree', naoRepo), 'worktree', 't1')).rejects.toThrow(
      /não consegui criar o worktree/,
    )
  })

  it('worktree sem cwd no roster é erro explícito', async () => {
    await expect(resolverCwd(colega('worktree'), 'worktree', 't1')).rejects.toThrow(
      /não tem "cwd" no roster/,
    )
  })
})

describe('acordarColega com tier de escrita', () => {
  const runnerOk: Runner = async () => JSON.stringify({ result: 'feito', session_id: 's1' })

  it('worktree: o colega é executado DENTRO do worktree, não no repo', async () => {
    const t = correio.abrirThread({ assunto: 'a', dono: 'eu', participantes: ['refatorador'] })
    correio.claim('repo', 'refatorar', 'refatorador')

    let cwdUsado: string | undefined
    await acordarColega({
      correio,
      colega: colega('worktree', repo),
      threadId: t.id,
      mensagem: 'refatora',
      runner: async (_args, opts) => {
        cwdUsado = opts.cwd
        return JSON.stringify({ result: 'ok', session_id: 's1' })
      },
    })

    expect(cwdUsado).toContain('worktrees')
    expect(cwdUsado).not.toBe(repo)
  })

  it('editor sem claim não chega nem a resolver o cwd', async () => {
    const t = correio.abrirThread({ assunto: 'a', dono: 'eu', participantes: ['refatorador'] })
    await expect(
      acordarColega({
        correio,
        colega: colega('editor', repo),
        threadId: t.id,
        mensagem: 'edita',
        runner: runnerOk,
      }),
    ).rejects.toThrow(/não tem claim ativo/)
  })

  it('editor com claim roda no repo real, como esperado', async () => {
    const t = correio.abrirThread({ assunto: 'a', dono: 'eu', participantes: ['refatorador'] })
    correio.claim('app.ts', 'corrigir', 'refatorador')

    let cwdUsado: string | undefined
    await acordarColega({
      correio,
      colega: colega('editor', repo),
      threadId: t.id,
      mensagem: 'edita',
      runner: async (_a, opts) => {
        cwdUsado = opts.cwd
        return JSON.stringify({ result: 'ok', session_id: 's1' })
      },
    })
    expect(cwdUsado).toBe(repo)
  })
})
