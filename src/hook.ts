#!/usr/bin/env node
import { abrirDb } from './db.js'
import { Correio, type Mensagem } from './correio.js'
import { identidade } from './identidade.js'

/**
 * Entrega de correspondência para uma sessão VIVA.
 * Roda fora do modelo (custo zero de token) e só aciona a sessão quando há carta.
 * Silencioso e exit 0 em qualquer falha — correio fora do ar nunca trava uma sessão.
 */

export function formatarEntrega(mensagens: Mensagem[]): string {
  const linhas = mensagens.map((m) => {
    const rotulo = m.tipo === 'resposta' ? 'resposta de' : m.tipo === 'ask' ? 'PERGUNTA de' : 'recado de'
    return [
      `--- ${rotulo} ${m.de} (thread ${m.threadId}) ---`,
      m.conteudo.trim(),
    ].join('\n')
  })

  return [
    `📮 Escritório — ${mensagens.length} mensagem(ns) para você:`,
    '',
    ...linhas,
    '',
    'Para responder, use a tool `dm` com o mesmo `thread`. Uma PERGUNTA está bloqueando quem perguntou — responda antes de seguir.',
  ].join('\n')
}

export function montarSaidaHook(
  evento: string,
  entrega: string,
  stopHookAtivo: boolean,
): Record<string, unknown> {
  const base = {
    hookSpecificOutput: { hookEventName: evento, additionalContext: entrega },
  }
  // Só o Stop bloqueia — e nunca duas vezes seguidas (guarda de loop).
  if ((evento === 'Stop' || evento === 'SubagentStop') && !stopHookAtivo) {
    return { ...base, decision: 'block', reason: entrega }
  }
  return base
}

async function lerStdin(): Promise<string> {
  const pedacos: Buffer[] = []
  for await (const p of process.stdin) pedacos.push(Buffer.from(p))
  return Buffer.concat(pedacos).toString('utf8')
}

async function main(): Promise<void> {
  const eu = identidade()

  let evento = 'Stop'
  let stopHookAtivo = false
  try {
    const bruto = await lerStdin()
    if (bruto.trim()) {
      const entrada = JSON.parse(bruto) as Record<string, unknown>
      if (typeof entrada.hook_event_name === 'string') evento = entrada.hook_event_name
      stopHookAtivo = entrada.stop_hook_active === true
    }
  } catch {
    /* entrada malformada — segue com os defaults */
  }

  const db = abrirDb()
  const correio = new Correio(db)
  correio.registrarPresenca(eu)

  const mensagens = correio.inbox(eu)
  if (mensagens.length === 0) {
    db.close()
    return
  }

  process.stdout.write(
    JSON.stringify(montarSaidaHook(evento, formatarEntrega(mensagens), stopHookAtivo)),
  )
  db.close()
}

main()
  .catch(() => {
    /* silêncio: nenhuma sessão pode travar por causa do correio */
  })
  .finally(() => process.exit(0))
