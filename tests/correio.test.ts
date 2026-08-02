import { describe, it, expect, beforeEach } from 'vitest'
import { abrirDb } from '../src/db.js'
import { Correio, ErroCorreio } from '../src/correio.js'

let correio: Correio

beforeEach(() => {
  correio = new Correio(abrirDb(':memory:'))
})

describe('thread', () => {
  it('dono entra automaticamente como participante', () => {
    const t = correio.abrirThread({ assunto: 'x', dono: 'icaro', participantes: ['ana'] })
    expect(t.participantes.sort()).toEqual(['ana', 'icaro'])
  })

  it('só o dono fecha a thread', () => {
    const t = correio.abrirThread({ assunto: 'x', dono: 'icaro', participantes: ['ana'] })
    expect(() => correio.fecharThread(t.id, 'ana')).toThrow(ErroCorreio)
    expect(() => correio.fecharThread(t.id, 'ana')).toThrow(/só o dono/)
    expect(correio.fecharThread(t.id, 'icaro').status).toBe('fechada')
  })

  it('thread fechada não aceita mensagem', () => {
    const t = correio.abrirThread({ assunto: 'x', dono: 'icaro', participantes: ['ana'] })
    correio.fecharThread(t.id, 'icaro')
    expect(() =>
      correio.enviar({ threadId: t.id, de: 'icaro', para: 'ana', tipo: 'dm', conteudo: 'oi' }),
    ).toThrow(/fechada/)
  })

  it('recusa quem não participa, nos dois sentidos', () => {
    const t = correio.abrirThread({ assunto: 'x', dono: 'icaro', participantes: ['ana'] })
    expect(() =>
      correio.enviar({ threadId: t.id, de: 'bob', para: 'ana', tipo: 'dm', conteudo: 'oi' }),
    ).toThrow(/não participa/)
    expect(() =>
      correio.enviar({ threadId: t.id, de: 'icaro', para: 'bob', tipo: 'dm', conteudo: 'oi' }),
    ).toThrow(/não participa/)
  })
})

describe('hops — o que substitui o supervisor', () => {
  it('decrementa a cada mensagem', () => {
    const t = correio.abrirThread({ assunto: 'x', dono: 'a', participantes: ['b'], hops: 3 })
    correio.enviar({ threadId: t.id, de: 'a', para: 'b', tipo: 'dm', conteudo: '1' })
    expect(correio.getThread(t.id)!.hops).toBe(2)
    correio.enviar({ threadId: t.id, de: 'b', para: 'a', tipo: 'dm', conteudo: '2' })
    expect(correio.getThread(t.id)!.hops).toBe(1)
  })

  it('zerou: marca exhausted e recusa a próxima', () => {
    const t = correio.abrirThread({ assunto: 'x', dono: 'a', participantes: ['b'], hops: 2 })
    correio.enviar({ threadId: t.id, de: 'a', para: 'b', tipo: 'dm', conteudo: '1' })
    correio.enviar({ threadId: t.id, de: 'b', para: 'a', tipo: 'dm', conteudo: '2' })

    expect(correio.getThread(t.id)!.status).toBe('exhausted')
    expect(() =>
      correio.enviar({ threadId: t.id, de: 'a', para: 'b', tipo: 'dm', conteudo: '3' }),
    ).toThrow(/esgotou os hops/)
  })

  it('ping-pong infinito entre dois agentes termina sozinho', () => {
    const t = correio.abrirThread({ assunto: 'loop', dono: 'a', participantes: ['b'], hops: 6 })
    let trocas = 0
    const tentar = () => {
      for (let i = 0; i < 100; i++) {
        const [de, para] = i % 2 === 0 ? ['a', 'b'] : ['b', 'a']
        correio.enviar({ threadId: t.id, de: de!, para: para!, tipo: 'dm', conteudo: `${i}` })
        trocas++
      }
    }
    expect(tentar).toThrow(/esgotou os hops/)
    expect(trocas).toBe(6)
  })
})

describe('inbox', () => {
  it('entrega não lidas e marca como lidas (não reentrega)', () => {
    const t = correio.abrirThread({ assunto: 'x', dono: 'a', participantes: ['b'] })
    correio.enviar({ threadId: t.id, de: 'a', para: 'b', tipo: 'dm', conteudo: 'oi' })

    expect(correio.contarNaoLidas('b')).toBe(1)
    expect(correio.inbox('b')).toHaveLength(1)
    expect(correio.inbox('b')).toHaveLength(0)
  })

  it('não entrega mensagem dos outros', () => {
    const t = correio.abrirThread({ assunto: 'x', dono: 'a', participantes: ['b'] })
    correio.enviar({ threadId: t.id, de: 'a', para: 'b', tipo: 'dm', conteudo: 'oi' })
    expect(correio.inbox('a')).toHaveLength(0)
  })

  it('respostaPara encontra a resposta pela mensagem original', () => {
    const t = correio.abrirThread({ assunto: 'x', dono: 'a', participantes: ['b'] })
    const pergunta = correio.enviar({
      threadId: t.id, de: 'a', para: 'b', tipo: 'ask', conteudo: '?',
    })
    expect(correio.respostaPara(pergunta.id)).toBeNull()
    correio.enviar({
      threadId: t.id, de: 'b', para: 'a', tipo: 'resposta', conteudo: '!', replyTo: pergunta.id,
    })
    expect(correio.respostaPara(pergunta.id)!.conteudo).toBe('!')
  })
})

describe('quadro branco', () => {
  it('escreve, sobrescreve e lê', () => {
    correio.boardWrite('dsg/v1:decisoes', 'usar cherry-pick', 'icaro')
    expect(correio.boardRead('dsg/v1:decisoes')[0]!.valor).toBe('usar cherry-pick')
    correio.boardWrite('dsg/v1:decisoes', 'mudou de ideia', 'ana')
    const [r] = correio.boardRead('dsg/v1:decisoes')
    expect(r!.valor).toBe('mudou de ideia')
    expect(r!.autor).toBe('ana')
  })

  it('chave com * lista por prefixo e não vaza outro escopo', () => {
    correio.boardWrite('dsg/v1:a', '1', 'x')
    correio.boardWrite('dsg/v1:b', '2', 'x')
    correio.boardWrite('cast/sgsa:a', '3', 'x')
    expect(correio.boardRead('dsg/v1:*')).toHaveLength(2)
    expect(correio.boardRead('cast/sgsa:*')).toHaveLength(1)
  })

  it('chave inexistente devolve vazio, não quebra', () => {
    expect(correio.boardRead('nada')).toEqual([])
  })
})

describe('claim', () => {
  it('primeiro leva; segundo recebe dono e intenção em vez de erro', () => {
    const a = correio.claim('src/app.ts', 'refatorar handler', 'ana')
    expect(a.ok).toBe(true)

    const b = correio.claim('src/app.ts', 'corrigir typo', 'bob')
    expect(b.ok).toBe(false)
    expect(b.conflito!.dono).toBe('ana')
    expect(b.conflito!.intencao).toBe('refatorar handler')
  })

  it('reivindicar de novo o que já é seu é idempotente', () => {
    const a = correio.claim('x', 'i', 'ana')
    const b = correio.claim('x', 'i', 'ana')
    expect(b.ok).toBe(true)
    expect(b.claimId).toBe(a.claimId)
  })

  it('libera e o recurso volta a ficar disponível', () => {
    const a = correio.claim('x', 'i', 'ana')
    correio.release(a.claimId!, 'ana')
    expect(correio.claim('x', 'outra', 'bob').ok).toBe(true)
  })

  it('não deixa liberar claim de outro', () => {
    const a = correio.claim('x', 'i', 'ana')
    expect(() => correio.release(a.claimId!, 'bob')).toThrow(/pertence a ana/)
  })
})

describe('presença', () => {
  it('registra e lista quem foi visto na janela', () => {
    correio.registrarPresenca('icaro-terminal')
    expect(correio.presentes()).toContain('icaro-terminal')
    // janela que começa no futuro exclui todo mundo (evita corrida de milissegundo com 0)
    expect(correio.presentes(-1)).not.toContain('icaro-terminal')
  })

  it('registrar de novo apenas atualiza o visto_em, não duplica', () => {
    correio.registrarPresenca('ana')
    correio.registrarPresenca('ana')
    expect(correio.presentes().filter((c) => c === 'ana')).toHaveLength(1)
  })
})
