import { describe, it, expect, beforeEach } from 'vitest'
import { abrirDb } from '../src/db.js'
import { Correio } from '../src/correio.js'
import { montarArgs, parseSaidaHeadless, acordarColega, type Runner } from '../src/colega.js'
import type { ColegaConfig } from '../src/roster.js'

const consultor: ColegaConfig = {
  nome: 'especialista-deposito',
  brief: 'depósito',
  tier: 'advisor',
}

let correio: Correio

beforeEach(() => {
  correio = new Correio(abrirDb(':memory:'))
})

describe('montarArgs', () => {
  it('primeira mensagem carrega o system prompt', () => {
    const args = montarArgs({
      mensagem: 'oi', systemPrompt: 'VOCÊ É X', tier: 'advisor', idDoColega: 'x',
    })
    expect(args.slice(0, 4)).toEqual(['-p', 'oi', '--output-format', 'json'])
    expect(args).toContain('--append-system-prompt')
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('VOCÊ É X')
    expect(args).not.toContain('--resume')
  })

  it('com sessão existente retoma e NÃO reenvia o system prompt', () => {
    const args = montarArgs({
      mensagem: 'oi', systemPrompt: 'VOCÊ É X', tier: 'advisor',
      sessionId: 'sess-1', idDoColega: 'x',
    })
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-1')
    expect(args).not.toContain('--append-system-prompt')
  })

  it('aplica as flags do tier e o modelo', () => {
    const args = montarArgs({
      mensagem: 'oi', systemPrompt: 's', tier: 'advisor',
      modelo: 'claude-sonnet-5', idDoColega: 'x',
    })
    expect(args).toContain('--allowedTools')
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5')
  })

  it('sempre entrega o MCP do escritório pro colega poder responder', () => {
    const args = montarArgs({ mensagem: 'oi', systemPrompt: 's', tier: 'advisor', idDoColega: 'ana' })
    const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1]!)
    expect(cfg.mcpServers.escritorio.env.ESCRITORIO_ID).toBe('ana')
  })
})

describe('parseSaidaHeadless', () => {
  it('extrai texto e session_id do JSON real do CLI', () => {
    const r = parseSaidaHeadless(
      JSON.stringify({ is_error: false, result: 'a resposta', session_id: 'abc-123' }),
    )
    expect(r.texto).toBe('a resposta')
    expect(r.sessionId).toBe('abc-123')
    expect(r.erro).toBe(false)
  })

  it('marca erro quando is_error vem true', () => {
    expect(parseSaidaHeadless(JSON.stringify({ is_error: true, result: 'x' })).erro).toBe(true)
  })

  it('saída não-JSON não derruba: vira o texto cru', () => {
    const r = parseSaidaHeadless('  texto solto  ')
    expect(r.texto).toBe('texto solto')
    expect(r.sessionId).toBeNull()
  })
})

describe('acordarColega', () => {
  const runnerFake = (texto: string, sessionId = 'sess-1'): Runner => async () =>
    JSON.stringify({ is_error: false, result: texto, session_id: sessionId })

  it('guarda a sessão da thread e retoma na mensagem seguinte', async () => {
    const t = correio.abrirThread({ assunto: 'a', dono: 'eu', participantes: [consultor.nome] })

    await acordarColega({
      correio, colega: consultor, threadId: t.id, mensagem: 'primeira',
      runner: runnerFake('r1', 'sess-abc'),
    })
    expect(correio.sessaoDe(t.id, consultor.nome)).toBe('sess-abc')

    let argsVistos: string[] = []
    await acordarColega({
      correio, colega: consultor, threadId: t.id, mensagem: 'segunda',
      runner: async (args) => {
        argsVistos = args
        return JSON.stringify({ result: 'r2', session_id: 'sess-abc' })
      },
    })
    expect(argsVistos).toContain('--resume')
  })

  it('sessão é por thread — outra thread começa do zero', async () => {
    const t1 = correio.abrirThread({ assunto: 'a', dono: 'eu', participantes: [consultor.nome] })
    const t2 = correio.abrirThread({ assunto: 'b', dono: 'eu', participantes: [consultor.nome] })
    await acordarColega({
      correio, colega: consultor, threadId: t1.id, mensagem: 'x', runner: runnerFake('r'),
    })
    expect(correio.sessaoDe(t2.id, consultor.nome)).toBeNull()
  })

  it('editor sem claim é recusado antes de gastar API', async () => {
    const editor: ColegaConfig = { ...consultor, nome: 'refatorador', tier: 'editor' }
    const t = correio.abrirThread({ assunto: 'a', dono: 'eu', participantes: [editor.nome] })

    let chamou = false
    await expect(
      acordarColega({
        correio, colega: editor, threadId: t.id, mensagem: 'edita aí',
        runner: async () => {
          chamou = true
          return '{}'
        },
      }),
    ).rejects.toThrow(/não tem claim ativo/)
    expect(chamou).toBe(false)
  })

  it('editor COM claim passa', async () => {
    const editor: ColegaConfig = { ...consultor, nome: 'refatorador', tier: 'editor' }
    const t = correio.abrirThread({ assunto: 'a', dono: 'eu', participantes: [editor.nome] })
    correio.claim('src/x.ts', 'mexer', editor.nome)

    const r = await acordarColega({
      correio, colega: editor, threadId: t.id, mensagem: 'edita aí', runner: runnerFake('feito'),
    })
    expect(r.texto).toBe('feito')
  })

  it('pedido rebaixando editor para advisor dispensa o claim', async () => {
    const editor: ColegaConfig = { ...consultor, nome: 'refatorador', tier: 'editor' }
    const t = correio.abrirThread({ assunto: 'a', dono: 'eu', participantes: [editor.nome] })

    const r = await acordarColega({
      correio, colega: editor, threadId: t.id, mensagem: 'só me diga',
      tierPedido: 'advisor', runner: runnerFake('opinião'),
    })
    expect(r.texto).toBe('opinião')
  })
})
