import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abrirDb } from '../src/db.js'
import { Correio } from '../src/correio.js'
import { Escritorio } from '../src/escritorio.js'
import {
  montarEntradaCaderno,
  anexarAoCaderno,
  destilarCaderno,
} from '../src/caderno.js'
import { parseRoster, type ColegaConfig } from '../src/roster.js'
import type { Runner } from '../src/colega.js'

let tmp: string
let correio: Correio

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'escritorio-'))
  correio = new Correio(abrirDb(':memory:'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('montarEntradaCaderno', () => {
  it('monta a entrada datada com assunto e interlocutor', () => {
    const e = montarEntradaCaderno({
      delta: '- Período é numérico',
      data: '2026-08-02',
      quem: 'icaro-terminal',
      assunto: 'reembolso',
    })
    expect(e).toContain('## 2026-08-02 — reembolso (com icaro-terminal)')
    expect(e).toContain('- Período é numérico')
  })

  it('NADA não vira entrada', () => {
    expect(montarEntradaCaderno({ delta: 'NADA', data: 'd', quem: 'q', assunto: 'a' })).toBeNull()
    expect(montarEntradaCaderno({ delta: '  nada  ', data: 'd', quem: 'q', assunto: 'a' })).toBeNull()
  })

  it('resposta vazia não vira entrada', () => {
    expect(montarEntradaCaderno({ delta: '   \n  ', data: 'd', quem: 'q', assunto: 'a' })).toBeNull()
  })

  it('remove linhas em branco do meio', () => {
    const e = montarEntradaCaderno({ delta: '- a\n\n\n- b', data: 'd', quem: 'q', assunto: 'a' })
    expect(e).toContain('- a\n- b')
  })
})

describe('anexarAoCaderno', () => {
  it('cria o arquivo com cabeçalho na primeira vez', () => {
    const p = join(tmp, 'cadernos', 'x.md')
    anexarAoCaderno(p, '\n## entrada 1\n')
    expect(readFileSync(p, 'utf8')).toContain('# Caderno — x')
    expect(readFileSync(p, 'utf8')).toContain('entrada 1')
  })

  it('acumula sem apagar o que já havia', () => {
    const p = join(tmp, 'x.md')
    anexarAoCaderno(p, '\n## um\n')
    anexarAoCaderno(p, '\n## dois\n')
    const txt = readFileSync(p, 'utf8')
    expect(txt).toContain('## um')
    expect(txt).toContain('## dois')
    expect(txt.match(/# Caderno/g)).toHaveLength(1)
  })
})

describe('destilarCaderno', () => {
  const colegaCom = (caderno?: string): ColegaConfig => ({
    nome: 'especialista-deposito',
    brief: 'x',
    tier: 'advisor',
    caderno,
  })

  const runner = (texto: string): Runner => async () =>
    JSON.stringify({ result: texto, session_id: 'sess-1' })

  it('anexa o que o colega destilou e esquece a sessão', async () => {
    const caminho = join(tmp, 'caderno.md')
    const t = correio.abrirThread({ assunto: 'reembolso', dono: 'icaro', participantes: ['especialista-deposito'] })
    correio.guardarSessao(t.id, 'especialista-deposito', 'sess-1')

    await destilarCaderno({
      correio,
      colega: colegaCom(caminho),
      threadId: t.id,
      assunto: 'reembolso',
      quem: 'icaro',
      runner: runner('- metodoPagamento nunca é passado'),
      hoje: '2026-08-02',
    })

    expect(readFileSync(caminho, 'utf8')).toContain('- metodoPagamento nunca é passado')
    expect(correio.sessaoDe(t.id, 'especialista-deposito')).toBeNull()
  })

  it('NADA não cria arquivo, mas a sessão morre do mesmo jeito', async () => {
    const caminho = join(tmp, 'vazio.md')
    const t = correio.abrirThread({ assunto: 'a', dono: 'icaro', participantes: ['especialista-deposito'] })
    correio.guardarSessao(t.id, 'especialista-deposito', 'sess-1')

    await destilarCaderno({
      correio, colega: colegaCom(caminho), threadId: t.id,
      assunto: 'a', quem: 'icaro', runner: runner('NADA'),
    })

    expect(existsSync(caminho)).toBe(false)
    expect(correio.sessaoDe(t.id, 'especialista-deposito')).toBeNull()
  })

  it('sem caderno configurado, não faz nada nem gasta API', async () => {
    const t = correio.abrirThread({ assunto: 'a', dono: 'icaro', participantes: ['especialista-deposito'] })
    correio.guardarSessao(t.id, 'especialista-deposito', 'sess-1')

    let chamou = false
    const r = await destilarCaderno({
      correio, colega: colegaCom(undefined), threadId: t.id, assunto: 'a', quem: 'icaro',
      runner: async () => {
        chamou = true
        return '{}'
      },
    })
    expect(r).toBeNull()
    expect(chamou).toBe(false)
  })

  it('colega que nunca foi acordado nessa thread não é destilado', async () => {
    const t = correio.abrirThread({ assunto: 'a', dono: 'icaro', participantes: ['especialista-deposito'] })
    let chamou = false
    await destilarCaderno({
      correio, colega: colegaCom(join(tmp, 'c.md')), threadId: t.id, assunto: 'a', quem: 'icaro',
      runner: async () => {
        chamou = true
        return '{}'
      },
    })
    expect(chamou).toBe(false)
  })
})

describe('fechar thread dispara a destilação de quem participou', () => {
  it('escreve o caderno do colega acordado', async () => {
    const caminho = join(tmp, 'dep.md')
    const roster = parseRoster(`
especialista-deposito:
  brief: "dep"
  tier: advisor
  caderno: ${caminho}
`)
    const e = new Escritorio({
      correio,
      roster,
      eu: 'icaro',
      runner: async () => JSON.stringify({ result: '- aprendi X', session_id: 's1' }),
    })

    const r = await e.ask({ para: 'especialista-deposito', pergunta: 'e aí?' })
    const { destilados } = await e.fecharThread(r.threadId)

    expect(destilados).toEqual(['especialista-deposito'])
    expect(readFileSync(caminho, 'utf8')).toContain('- aprendi X')
  })
})
