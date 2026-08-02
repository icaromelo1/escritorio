import { describe, it, expect, beforeEach } from 'vitest'
import { abrirDb } from '../src/db.js'
import { Correio } from '../src/correio.js'
import { Escritorio } from '../src/escritorio.js'
import type { Runner } from '../src/colega.js'
import { parseRoster } from '../src/roster.js'

const ROSTER = parseRoster(`
especialista-deposito:
  brief: "Depósito antecipado"
  tier: advisor
especialista-banco:
  brief: "Banco de dados"
  tier: advisor
`)

const runnerQueResponde = (texto: string): Runner => async () =>
  JSON.stringify({ is_error: false, result: texto, session_id: 'sess-1' })

let correio: Correio

beforeEach(() => {
  correio = new Correio(abrirDb(':memory:'))
})

function montar(eu: string, runner?: Runner, pendentes?: Promise<void>[]) {
  return new Escritorio({
    correio,
    roster: ROSTER,
    eu,
    runner,
    askTimeoutMs: 300,
    intervaloPollMs: 20,
    agendar: pendentes ? (fn) => void pendentes.push(fn()) : undefined,
  })
}

describe('roster', () => {
  it('lista colegas com brief e tier, sem carregar .md', () => {
    const e = montar('icaro')
    const r = e.listarRoster()
    expect(r.colegas.map((c) => c.nome).sort()).toEqual([
      'especialista-banco',
      'especialista-deposito',
    ])
    expect(r.colegas[0]!.brief).toBeTruthy()
  })

  it('sessões vivas aparecem separadas dos colegas do roster', () => {
    montar('icaro-terminal')
    montar('icaro-vm')
    const r = montar('icaro-terminal').listarRoster()
    expect(r.sessoesVivas.sort()).toEqual(['icaro-terminal', 'icaro-vm'])
  })
})

describe('ask em colega do roster', () => {
  it('acorda e devolve a resposta na hora', async () => {
    const e = montar('icaro', runnerQueResponde('o período é numérico'))
    const r = await e.ask({ para: 'especialista-deposito', pergunta: 'como é o período?' })

    expect(r.via).toBe('colega')
    expect(r.resposta).toBe('o período é numérico')
    expect(r.timeout).toBeUndefined()
  })

  it('a resposta já entregue não reaparece no inbox', async () => {
    const e = montar('icaro', runnerQueResponde('resposta'))
    await e.ask({ para: 'especialista-deposito', pergunta: '?' })
    expect(e.inbox().mensagens).toHaveLength(0)
  })

  it('não engole mensagem de terceiro que chegou durante o ask', async () => {
    const e = montar('icaro', runnerQueResponde('resposta'))
    const outra = correio.abrirThread({ assunto: 'outro assunto', dono: 'ana', participantes: ['icaro'] })
    correio.enviar({ threadId: outra.id, de: 'ana', para: 'icaro', tipo: 'dm', conteudo: 'recado' })

    await e.ask({ para: 'especialista-deposito', pergunta: '?' })

    const inbox = e.inbox().mensagens
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.conteudo).toBe('recado')
  })

  it('continuar a mesma thread reusa a sessão do colega', async () => {
    const chamadas: string[][] = []
    const runner: Runner = async (args) => {
      chamadas.push(args)
      return JSON.stringify({ result: 'ok', session_id: 'sess-x' })
    }
    const e = montar('icaro', runner)
    const p = await e.ask({ para: 'especialista-deposito', pergunta: 'primeira' })
    await e.ask({ para: 'especialista-deposito', pergunta: 'segunda', threadId: p.threadId })

    expect(chamadas[0]).toContain('--append-system-prompt')
    expect(chamadas[1]).toContain('--resume')
  })

  it('destinatário inexistente erra com a lista de conhecidos', async () => {
    const e = montar('icaro')
    await expect(e.ask({ para: 'fulano', pergunta: '?' })).rejects.toThrow(
      /não existe ninguém chamado "fulano"/,
    )
  })
})

describe('ask em sessão viva', () => {
  it('devolve a resposta quando a outra sessão responde', async () => {
    const ana = montar('ana')
    const icaro = montar('icaro')
    ana.inbox() // registra presença

    const pendente = icaro.ask({ para: 'ana', pergunta: 'viu aquilo?' })

    await new Promise((r) => setTimeout(r, 40))
    const recebidas = ana.inbox().mensagens
    expect(recebidas).toHaveLength(1)
    ana.dm({
      para: 'icaro',
      mensagem: 'vi sim',
      threadId: recebidas[0]!.threadId,
    })

    const r = await pendente
    expect(r.via).toBe('sessao-viva')
    expect(r.timeout).toBeUndefined()
    expect(r.resposta).toBe('vi sim')
  })

  it('sem resposta, devolve timeout sem travar e mantém a thread viva', async () => {
    montar('ana').inbox()
    const icaro = montar('icaro')

    const r = await icaro.ask({ para: 'ana', pergunta: 'oi?' })
    expect(r.timeout).toBe(true)
    expect(r.resposta).toMatch(/sem resposta de "ana"/)
    expect(correio.getThread(r.threadId)!.status).toBe('aberta')
  })
})

describe('dm', () => {
  it('retorna na hora e a resposta do colega chega depois no inbox', async () => {
    const pendentes: Promise<void>[] = []
    const e = montar('icaro', runnerQueResponde('respondi depois'), pendentes)

    const r = e.dm({ para: 'especialista-banco', mensagem: 'dá uma olhada' })
    expect(r.acordou).toBe(true)
    expect(e.inbox().mensagens).toHaveLength(0)

    await Promise.all(pendentes)

    const inbox = e.inbox().mensagens
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.conteudo).toBe('respondi depois')
  })

  it('dm na thread de uma pergunta pendente VIRA a resposta (destrava quem esperava)', () => {
    const ana = montar('ana')
    const icaro = montar('icaro')
    ana.inbox()

    const t = correio.abrirThread({ assunto: 'q', dono: 'icaro', participantes: ['ana'] })
    const pergunta = correio.enviar({
      threadId: t.id, de: 'icaro', para: 'ana', tipo: 'ask', conteudo: 'responde?',
    })

    const r = ana.dm({ para: 'icaro', mensagem: 'respondo', threadId: t.id })
    expect(r.respondeu).toBe(true)
    expect(correio.respostaPara(pergunta.id)!.conteudo).toBe('respondo')
    void icaro
  })

  it('dm sem pergunta pendente continua sendo recado comum', () => {
    const ana = montar('ana')
    montar('icaro').inbox()
    const t = correio.abrirThread({ assunto: 'q', dono: 'ana', participantes: ['icaro'] })

    const r = ana.dm({ para: 'icaro', mensagem: 'só avisando', threadId: t.id })
    expect(r.respondeu).toBe(false)
    expect(correio.inbox('icaro')[0]!.tipo).toBe('dm')
  })

  it('segunda pergunta na mesma thread não é respondida pela resposta da primeira', () => {
    const ana = montar('ana')
    montar('icaro').inbox()
    const t = correio.abrirThread({ assunto: 'q', dono: 'icaro', participantes: ['ana'], hops: 10 })

    const p1 = correio.enviar({ threadId: t.id, de: 'icaro', para: 'ana', tipo: 'ask', conteudo: 'a?' })
    const p2 = correio.enviar({ threadId: t.id, de: 'icaro', para: 'ana', tipo: 'ask', conteudo: 'b?' })

    ana.dm({ para: 'icaro', mensagem: 'resposta de a', threadId: t.id })
    expect(correio.respostaPara(p1.id)!.conteudo).toBe('resposta de a')
    expect(correio.respostaPara(p2.id)).toBeNull()

    ana.dm({ para: 'icaro', mensagem: 'resposta de b', threadId: t.id })
    expect(correio.respostaPara(p2.id)!.conteudo).toBe('resposta de b')
  })

  it('dm para sessão viva não acorda ninguém, só enfileira', () => {
    montar('ana').inbox()
    const icaro = montar('icaro')
    const r = icaro.dm({ para: 'ana', mensagem: 'recado' })
    expect(r.acordou).toBe(false)
    expect(correio.contarNaoLidas('ana')).toBe(1)
  })

  it('falha do colega não derruba quem mandou — vai pra auditoria', async () => {
    const pendentes: Promise<void>[] = []
    const e = montar('icaro', async () => {
      throw new Error('CLI explodiu')
    }, pendentes)

    e.dm({ para: 'especialista-banco', mensagem: 'x' })
    await Promise.all(pendentes)

    expect(correio.auditoriaRecente().some((a) => a.acao === 'dm_falhou')).toBe(true)
  })
})

describe('debate entre pares (thread com N participantes)', () => {
  it('três participantes, cada um escolhe pra quem responder', () => {
    const t = correio.abrirThread({
      assunto: 'qual abordagem?',
      dono: 'icaro',
      participantes: ['opus-a', 'opus-b'],
      hops: 10,
    })

    correio.enviar({ threadId: t.id, de: 'icaro', para: 'opus-a', tipo: 'ask', conteudo: 'proponha' })
    correio.enviar({ threadId: t.id, de: 'opus-a', para: 'opus-b', tipo: 'dm', conteudo: 'discorda?' })
    correio.enviar({ threadId: t.id, de: 'opus-b', para: 'opus-a', tipo: 'dm', conteudo: 'discordo' })
    correio.enviar({ threadId: t.id, de: 'opus-a', para: 'icaro', tipo: 'resposta', conteudo: 'convergimos' })

    expect(correio.mensagensDaThread(t.id)).toHaveLength(4)
    expect(correio.getThread(t.id)!.hops).toBe(6)
  })
})

describe('fechar thread', () => {
  it('só o dono fecha', async () => {
    const icaro = montar('icaro', runnerQueResponde('r'))
    const r = await icaro.ask({ para: 'especialista-deposito', pergunta: '?' })
    const ana = montar('ana')
    await expect(ana.fecharThread(r.threadId)).rejects.toThrow(/só o dono/)
  })

  it('colega sem caderno configurado não destila nada', async () => {
    const icaro = montar('icaro', runnerQueResponde('r'))
    const r = await icaro.ask({ para: 'especialista-deposito', pergunta: '?' })
    const { destilados } = await icaro.fecharThread(r.threadId)
    expect(destilados).toEqual([])
    expect(correio.getThread(r.threadId)!.status).toBe('fechada')
  })
})
