import { describe, it, expect, beforeEach } from 'vitest'
import { abrirDb, type Db } from '../src/db.js'
import { Correio } from '../src/correio.js'
import { coletarEventos, primeiraLinha, estadoAtual } from '../src/tail.js'

let db: Db
let correio: Correio
const INICIO = '1970-01-01T00:00:00.000Z'

beforeEach(() => {
  db = abrirDb(':memory:')
  correio = new Correio(db)
})

describe('primeiraLinha', () => {
  it('achata quebras de linha', () => {
    expect(primeiraLinha('a\n\nb   c')).toBe('a b c')
  })

  it('trunca com reticência', () => {
    expect(primeiraLinha('x'.repeat(50), 10)).toBe('x'.repeat(9) + '…')
  })

  it('não mexe no que já cabe', () => {
    expect(primeiraLinha('curto', 10)).toBe('curto')
  })
})

describe('coletarEventos', () => {
  it('mostra thread aberta e a mensagem trocada', () => {
    const t = correio.abrirThread({ assunto: 'reembolso', dono: 'icaro', participantes: ['ana'] })
    correio.enviar({ threadId: t.id, de: 'icaro', para: 'ana', tipo: 'ask', conteudo: 'e aí?' })

    const evs = coletarEventos(db, INICIO, false)
    expect(evs.filter((e) => e.tipo === 'thread-aberta')).toHaveLength(1)
    const msg = evs.find((e) => e.tipo === 'mensagem')!
    expect(msg.texto).toContain('icaro')
    expect(msg.texto).toContain('ana')
    expect(msg.texto).toContain('e aí?')
  })

  it('nada novo depois do corte — não repete o que já foi mostrado', () => {
    const t = correio.abrirThread({ assunto: 'x', dono: 'a', participantes: ['b'] })
    correio.enviar({ threadId: t.id, de: 'a', para: 'b', tipo: 'dm', conteudo: 'oi' })

    const primeiros = coletarEventos(db, INICIO, false)
    const corte = primeiros[primeiros.length - 1]!.quando
    expect(coletarEventos(db, corte, false)).toHaveLength(0)
  })

  it('registra claim e quadro', () => {
    correio.claim('src/app.ts', 'refatorar', 'ana')
    correio.boardWrite('dsg/v1:decisoes', 'usar cherry-pick', 'icaro')

    const evs = coletarEventos(db, INICIO, false)
    expect(evs.find((e) => e.tipo === 'claim')!.texto).toContain('src/app.ts')
    expect(evs.find((e) => e.tipo === 'quadro')!.texto).toContain('dsg/v1:decisoes')
  })

  it('thread fechada aparece como evento próprio', () => {
    const t = correio.abrirThread({ assunto: 'x', dono: 'a', participantes: ['b'] })
    correio.fecharThread(t.id, 'a')
    expect(coletarEventos(db, INICIO, false).some((e) => e.tipo === 'thread-fechada')).toBe(true)
  })

  it('eventos saem em ordem cronológica', () => {
    const t = correio.abrirThread({ assunto: 'x', dono: 'a', participantes: ['b'] })
    correio.enviar({ threadId: t.id, de: 'a', para: 'b', tipo: 'dm', conteudo: '1' })
    correio.enviar({ threadId: t.id, de: 'b', para: 'a', tipo: 'dm', conteudo: '2' })

    const quandos = coletarEventos(db, INICIO, false).map((e) => e.quando)
    expect([...quandos].sort()).toEqual(quandos)
  })
})

describe('estadoAtual', () => {
  it('mostra quem está presente, threads abertas e claims', () => {
    correio.registrarPresenca('icaro@v1')
    correio.abrirThread({ assunto: 'assunto vivo', dono: 'icaro@v1', participantes: ['ana'] })
    correio.claim('app.ts', 'mexer', 'ana')

    const txt = estadoAtual(db)
    expect(txt).toContain('icaro@v1')
    expect(txt).toContain('assunto vivo')
    expect(txt).toContain('app.ts')
  })

  it('escritório vazio não quebra', () => {
    const txt = estadoAtual(db)
    expect(txt).toContain('(ninguém)')
    expect(txt).toContain('(nenhuma)')
  })
})
