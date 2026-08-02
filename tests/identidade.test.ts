import { describe, it, expect, afterEach } from 'vitest'
import { userInfo } from 'node:os'
import { identidade } from '../src/identidade.js'

const original = process.env.ESCRITORIO_ID

afterEach(() => {
  if (original === undefined) delete process.env.ESCRITORIO_ID
  else process.env.ESCRITORIO_ID = original
})

describe('identidade', () => {
  it('ESCRITORIO_ID declarado ganha', () => {
    process.env.ESCRITORIO_ID = 'especialista-deposito'
    expect(identidade('/qualquer/pasta')).toBe('especialista-deposito')
  })

  it('sem declaração, deriva de usuário@pasta', () => {
    delete process.env.ESCRITORIO_ID
    expect(identidade('/Volumes/x/projetos/dsg/v1')).toBe(`${userInfo().username}@v1`)
  })

  it('string vazia não vira identidade', () => {
    process.env.ESCRITORIO_ID = '   '
    expect(identidade('/a/b')).toBe(`${userInfo().username}@b`)
  })

  it('mesma pasta gera sempre o mesmo nome (endereçável entre sessões)', () => {
    delete process.env.ESCRITORIO_ID
    expect(identidade('/a/dsg')).toBe(identidade('/a/dsg'))
  })

  it('raiz não vira nome vazio', () => {
    delete process.env.ESCRITORIO_ID
    expect(identidade('/')).toBe(`${userInfo().username}@raiz`)
  })
})
