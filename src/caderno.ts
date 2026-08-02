import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Correio } from './correio.js'
import { acordarColega, type Runner } from './colega.js'
import { expandirCaminho, type ColegaConfig } from './roster.js'

export const PEDIDO_DESTILACAO = [
  'A conversa acabou. Escreva APENAS o que dessa conversa vale guardar no seu caderno para consultas futuras.',
  'Regras: fatos e conclusões destiladas, nunca transcrição. Bullets curtos. Nada que já esteja no caderno.',
  'Se nada novo valer a pena, responda exatamente: NADA.',
].join(' ')

/** Monta a entrada do caderno. Puro — é o que o teste verifica. */
export function montarEntradaCaderno(input: {
  delta: string
  data: string
  quem: string
  assunto: string
}): string | null {
  const delta = input.delta.trim()
  if (!delta || delta.toUpperCase() === 'NADA') return null

  const corpo = delta
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .join('\n')

  return `\n## ${input.data} — ${input.assunto} (com ${input.quem})\n\n${corpo}\n`
}

export function cabecalhoCaderno(nome: string): string {
  return `# Caderno — ${nome}\n\n> Conhecimento destilado das conversas no Escritório. Editável à mão.\n`
}

export function anexarAoCaderno(caminho: string, entrada: string, nome?: string): void {
  const p = expandirCaminho(caminho)
  mkdirSync(dirname(p), { recursive: true })
  if (!existsSync(p)) writeFileSync(p, cabecalhoCaderno(nome ?? nomeDoArquivo(p)), 'utf8')
  appendFileSync(p, entrada, 'utf8')
}

function nomeDoArquivo(p: string): string {
  return (p.split('/').pop() ?? 'colega').replace(/\.md$/, '')
}

/**
 * Fecho da thread: pergunta ao colega o que virou aprendizado, anexa ao caderno
 * e esquece a sessão (ela morre; o que sobrevive é o caderno).
 */
export async function destilarCaderno(opts: {
  correio: Correio
  colega: ColegaConfig
  threadId: string
  assunto: string
  quem: string
  runner?: Runner
  hoje?: string
}): Promise<string | null> {
  const { correio, colega, threadId } = opts
  if (!colega.caderno) return null
  if (!correio.sessaoDe(threadId, colega.nome)) return null

  const resposta = await acordarColega({
    correio,
    colega,
    threadId,
    mensagem: PEDIDO_DESTILACAO,
    tierPedido: 'advisor',
    runner: opts.runner,
  })

  const entrada = montarEntradaCaderno({
    delta: resposta.texto,
    data: opts.hoje ?? new Date().toISOString().slice(0, 10),
    quem: opts.quem,
    assunto: opts.assunto,
  })

  if (entrada) {
    anexarAoCaderno(colega.caderno, entrada, colega.nome)
    correio.auditar('caderno_atualizado', colega.nome, `thread=${threadId}`)
  }

  correio.esquecerSessao(threadId, colega.nome)
  return entrada
}
