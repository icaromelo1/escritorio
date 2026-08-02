import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { abrirDb } from '../src/db.js'
import { Correio } from '../src/correio.js'
import { formatarEntrega, montarSaidaHook } from '../src/hook.js'

const execFileAsync = promisify(execFile)
const RAIZ = new URL('..', import.meta.url).pathname

describe('formatarEntrega', () => {
  it('rotula pergunta, recado e resposta de forma distinta', () => {
    const base = { id: '1', threadId: 't1', replyTo: null, createdAt: '', de: 'ana' }
    const txt = formatarEntrega([
      { ...base, para: 'icaro', tipo: 'ask', conteudo: 'me responde' },
      { ...base, id: '2', para: 'icaro', tipo: 'dm', conteudo: 'só avisando' },
      { ...base, id: '3', para: 'icaro', tipo: 'resposta', conteudo: 'aqui está' },
    ])
    expect(txt).toContain('PERGUNTA de ana')
    expect(txt).toContain('recado de ana')
    expect(txt).toContain('resposta de ana')
    expect(txt).toContain('3 mensagem(ns)')
    expect(txt).toContain('t1')
  })
})

describe('montarSaidaHook', () => {
  it('Stop bloqueia a parada e entrega o conteúdo', () => {
    const s = montarSaidaHook('Stop', 'tem carta', false)
    expect(s.decision).toBe('block')
    expect(s.reason).toBe('tem carta')
    expect((s.hookSpecificOutput as Record<string, unknown>).additionalContext).toBe('tem carta')
  })

  it('Stop NÃO bloqueia de novo se já veio de um stop hook (guarda de loop)', () => {
    const s = montarSaidaHook('Stop', 'tem carta', true)
    expect(s.decision).toBeUndefined()
    expect((s.hookSpecificOutput as Record<string, unknown>).additionalContext).toBe('tem carta')
  })

  it('PostToolBatch injeta sem bloquear nada', () => {
    const s = montarSaidaHook('PostToolBatch', 'tem carta', false)
    expect(s.decision).toBeUndefined()
    expect((s.hookSpecificOutput as Record<string, unknown>).hookEventName).toBe('PostToolBatch')
  })
})

describe('hook de verdade, rodando como processo', () => {
  let tmp: string
  let dbPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'escritorio-hook-'))
    dbPath = join(tmp, 'e.db')
  })

  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  const rodar = async (entrada: object, id = 'icaro') => {
    const filho = execFileAsync('npx', ['tsx', join(RAIZ, 'src/hook.ts')], {
      cwd: RAIZ,
      env: { ...process.env, ESCRITORIO_ID: id, ESCRITORIO_DB: dbPath },
    })
    filho.child.stdin!.end(JSON.stringify(entrada))
    return (await filho).stdout
  }

  it('sem carta: saída vazia, invisível pra sessão', async () => {
    abrirDb(dbPath).close()
    expect((await rodar({ hook_event_name: 'Stop' })).trim()).toBe('')
  })

  it('com carta: emite o JSON de bloqueio do Stop', async () => {
    const correio = new Correio(abrirDb(dbPath))
    const t = correio.abrirThread({ assunto: 'a', dono: 'ana', participantes: ['icaro'] })
    correio.enviar({ threadId: t.id, de: 'ana', para: 'icaro', tipo: 'ask', conteudo: 'urgente' })

    const saida = JSON.parse(await rodar({ hook_event_name: 'Stop', stop_hook_active: false }))
    expect(saida.decision).toBe('block')
    expect(saida.reason).toContain('urgente')
  })

  it('não reentrega na segunda parada (senão trava a sessão em loop)', async () => {
    const correio = new Correio(abrirDb(dbPath))
    const t = correio.abrirThread({ assunto: 'a', dono: 'ana', participantes: ['icaro'] })
    correio.enviar({ threadId: t.id, de: 'ana', para: 'icaro', tipo: 'dm', conteudo: 'oi' })

    expect((await rodar({ hook_event_name: 'Stop' })).trim()).not.toBe('')
    expect((await rodar({ hook_event_name: 'Stop' })).trim()).toBe('')
  })

  it('sem ESCRITORIO_ID deriva identidade da pasta e entrega o que for dela', async () => {
    const correio = new Correio(abrirDb(dbPath))
    const derivada = `${userInfo().username}@escritorio`
    const t = correio.abrirThread({ assunto: 'a', dono: 'ana', participantes: [derivada] })
    correio.enviar({ threadId: t.id, de: 'ana', para: derivada, tipo: 'dm', conteudo: 'pra você' })

    const filho = execFileAsync('npx', ['tsx', join(RAIZ, 'src/hook.ts')], {
      cwd: RAIZ,
      env: { ...process.env, ESCRITORIO_ID: '', ESCRITORIO_DB: dbPath },
    })
    filho.child.stdin!.end('{"hook_event_name":"Stop"}')
    expect((await filho).stdout).toContain('pra você')
  })

  it('entrada malformada não derruba o hook', async () => {
    abrirDb(dbPath).close()
    const filho = execFileAsync('npx', ['tsx', join(RAIZ, 'src/hook.ts')], {
      cwd: RAIZ,
      env: { ...process.env, ESCRITORIO_ID: 'icaro', ESCRITORIO_DB: dbPath },
    })
    filho.child.stdin!.end('isso não é json {{{')
    expect((await filho).stdout.trim()).toBe('')
  })
})
