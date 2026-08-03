#!/usr/bin/env node
import { abrirDb, type Db } from './db.js'

/**
 * Monitor ao vivo do escritório: segue o SQLite e imprime o que acontece entre
 * TODAS as sessões — mensagem trocada, thread aberta/fechada, claim, quadro.
 *
 *   npm run tail
 */

export interface Evento {
  quando: string
  tipo: 'mensagem' | 'thread-aberta' | 'thread-fechada' | 'claim' | 'quadro'
  texto: string
}

const C = {
  cinza: '\x1b[90m',
  verde: '\x1b[32m',
  ciano: '\x1b[36m',
  amarelo: '\x1b[33m',
  magenta: '\x1b[35m',
  vermelho: '\x1b[31m',
  negrito: '\x1b[1m',
  fim: '\x1b[0m',
}

const SETA = { ask: '→?', dm: '→ ', resposta: '←!' } as const

export function primeiraLinha(texto: string, max = 88): string {
  const limpo = texto.replace(/\s+/g, ' ').trim()
  return limpo.length > max ? limpo.slice(0, max - 1) + '…' : limpo
}

export function formatarEvento(ev: Evento, cor = true): string {
  const c = (cod: string, s: string) => (cor ? `${cod}${s}${C.fim}` : s)
  const hora = c(C.cinza, ev.quando.slice(11, 19))
  return `${hora} ${ev.texto}`
    .split('\n')
    .map((l) => l)
    .join('\n')
}

/** Eventos ocorridos depois de `desde` (ISO). Ordenados no tempo. */
export function coletarEventos(db: Db, desde: string, cor = true): Evento[] {
  const c = (cod: string, s: string) => (cor ? `${cod}${s}${C.fim}` : s)
  const eventos: Evento[] = []

  const msgs = db
    .prepare(
      `SELECT m.*, t.assunto FROM mensagens m
       LEFT JOIN threads t ON t.id = m.thread_id
       WHERE m.created_at > ? ORDER BY m.created_at`,
    )
    .all(desde) as Record<string, unknown>[]

  for (const m of msgs) {
    const tipo = m.tipo as keyof typeof SETA
    const seta = SETA[tipo] ?? '  '
    const corTipo = tipo === 'ask' ? C.amarelo : tipo === 'resposta' ? C.verde : C.ciano
    eventos.push({
      quando: m.created_at as string,
      tipo: 'mensagem',
      texto:
        `${c(C.negrito, String(m.de))} ${c(corTipo, seta)} ${c(C.negrito, String(m.para))}  ` +
        `${c(C.cinza, '[' + String(m.thread_id).slice(0, 8) + ']')}\n` +
        `        ${primeiraLinha(String(m.conteudo))}`,
    })
  }

  const abertas = db
    .prepare(`SELECT * FROM threads WHERE created_at > ? ORDER BY created_at`)
    .all(desde) as Record<string, unknown>[]
  for (const t of abertas) {
    eventos.push({
      quando: t.created_at as string,
      tipo: 'thread-aberta',
      texto: `${c(C.magenta, '⊕ thread')} ${c(C.cinza, '[' + String(t.id).slice(0, 8) + ']')} ${primeiraLinha(String(t.assunto), 60)} ${c(C.cinza, '· dono ' + String(t.dono))}`,
    })
  }

  const fechadas = db
    .prepare(`SELECT * FROM threads WHERE closed_at > ? ORDER BY closed_at`)
    .all(desde) as Record<string, unknown>[]
  for (const t of fechadas) {
    eventos.push({
      quando: t.closed_at as string,
      tipo: 'thread-fechada',
      texto: `${c(C.magenta, '⊗ thread fechada')} ${c(C.cinza, '[' + String(t.id).slice(0, 8) + ']')} ${primeiraLinha(String(t.assunto), 60)}`,
    })
  }

  const claims = db
    .prepare(`SELECT * FROM claims WHERE created_at > ? ORDER BY created_at`)
    .all(desde) as Record<string, unknown>[]
  for (const cl of claims) {
    eventos.push({
      quando: cl.created_at as string,
      tipo: 'claim',
      texto: `${c(C.vermelho, '🔒 claim')} ${String(cl.recurso)} ${c(C.cinza, 'por ' + String(cl.dono) + ' · ' + String(cl.intencao))}`,
    })
  }

  const quadro = db
    .prepare(`SELECT * FROM board WHERE updated_at > ? ORDER BY updated_at`)
    .all(desde) as Record<string, unknown>[]
  for (const q of quadro) {
    eventos.push({
      quando: q.updated_at as string,
      tipo: 'quadro',
      texto: `${c(C.ciano, '▤ quadro')} ${String(q.chave)} ${c(C.cinza, '= ' + primeiraLinha(String(q.valor), 50) + ' · ' + String(q.autor))}`,
    })
  }

  return eventos.sort((a, b) => a.quando.localeCompare(b.quando))
}

export function estadoAtual(db: Db): string {
  const presentes = db
    .prepare(`SELECT colega FROM presenca WHERE visto_em >= ? ORDER BY colega`)
    .all(new Date(Date.now() - 60 * 60_000).toISOString())
    .map((r) => (r as { colega: string }).colega)

  const abertas = db
    .prepare(`SELECT id, assunto, dono, hops FROM threads WHERE status = 'aberta'`)
    .all() as Record<string, unknown>[]

  const claims = db.prepare(`SELECT recurso, dono FROM claims WHERE status = 'ativo'`).all() as {
    recurso: string
    dono: string
  }[]

  const linhas = [
    `${C.negrito}Escritório — monitor ao vivo${C.fim}`,
    `${C.cinza}sessões vistas na última hora:${C.fim} ${presentes.join(', ') || '(ninguém)'}`,
    `${C.cinza}threads abertas:${C.fim} ${
      abertas.length === 0
        ? '(nenhuma)'
        : abertas
            .map(
              (t) =>
                `[${String(t.id).slice(0, 8)}] ${primeiraLinha(String(t.assunto), 40)} (${t.hops} hops, dono ${t.dono})`,
            )
            .join('\n                  ')
    }`,
    `${C.cinza}claims ativos:${C.fim} ${claims.map((c) => `${c.recurso} (${c.dono})`).join(', ') || '(nenhum)'}`,
    `${C.cinza}${'─'.repeat(72)}${C.fim}`,
  ]
  return linhas.join('\n')
}

async function main(): Promise<void> {
  const db = abrirDb()
  const intervalo = Number(process.env.ESCRITORIO_TAIL_MS ?? 500)

  console.log(estadoAtual(db))
  console.log(`${C.cinza}aguardando movimento… (ctrl-c para sair)${C.fim}\n`)

  let desde = new Date().toISOString()
  for (;;) {
    const eventos = coletarEventos(db, desde)
    for (const ev of eventos) {
      console.log(formatarEvento(ev))
      if (ev.quando > desde) desde = ev.quando
    }
    await new Promise((r) => setTimeout(r, intervalo))
  }
}

if (process.argv[1]?.endsWith('tail.js') || process.argv[1]?.endsWith('tail.ts')) {
  main().catch((e) => {
    console.error('tail:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
