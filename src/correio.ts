import { randomUUID } from 'node:crypto'
import type { Db } from './db.js'

export type TipoMensagem = 'ask' | 'dm' | 'resposta'
export type StatusThread = 'aberta' | 'fechada' | 'exhausted'

export interface Thread {
  id: string
  assunto: string
  dono: string
  hops: number
  status: StatusThread
  participantes: string[]
  createdAt: string
}

export interface Mensagem {
  id: string
  threadId: string
  de: string
  para: string
  tipo: TipoMensagem
  conteudo: string
  replyTo: string | null
  createdAt: string
}

export interface ResultadoClaim {
  ok: boolean
  claimId?: string
  conflito?: { dono: string; intencao: string; desde: string }
}

export const HOPS_PADRAO = 8

export class ErroCorreio extends Error {
  constructor(
    message: string,
    readonly codigo: string,
  ) {
    super(message)
    this.name = 'ErroCorreio'
  }
}

const agora = () => new Date().toISOString()

export class Correio {
  constructor(private db: Db) {}

  // ---------- presença ----------

  registrarPresenca(colega: string): void {
    this.db
      .prepare(
        `INSERT INTO presenca (colega, visto_em) VALUES (?, ?)
         ON CONFLICT(colega) DO UPDATE SET visto_em = excluded.visto_em`,
      )
      .run(colega, agora())
  }

  presentes(desdeMinutos = 60): string[] {
    const corte = new Date(Date.now() - desdeMinutos * 60_000).toISOString()
    return this.db
      .prepare(`SELECT colega FROM presenca WHERE visto_em >= ? ORDER BY colega`)
      .all(corte)
      .map((r) => (r as { colega: string }).colega)
  }

  // ---------- threads ----------

  abrirThread(input: {
    assunto: string
    dono: string
    participantes: string[]
    hops?: number
  }): Thread {
    const id = randomUUID()
    const hops = input.hops ?? HOPS_PADRAO
    const participantes = Array.from(new Set([input.dono, ...input.participantes]))
    const criadoEm = agora()

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO threads (id, assunto, dono, hops, status, created_at)
           VALUES (?, ?, ?, ?, 'aberta', ?)`,
        )
        .run(id, input.assunto, input.dono, hops, criadoEm)
      const stmt = this.db.prepare(
        `INSERT INTO participantes (thread_id, colega) VALUES (?, ?)`,
      )
      for (const p of participantes) stmt.run(id, p)
    })
    tx()

    return {
      id,
      assunto: input.assunto,
      dono: input.dono,
      hops,
      status: 'aberta',
      participantes,
      createdAt: criadoEm,
    }
  }

  getThread(id: string): Thread | null {
    const row = this.db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    const participantes = this.db
      .prepare(`SELECT colega FROM participantes WHERE thread_id = ? ORDER BY colega`)
      .all(id)
      .map((r) => (r as { colega: string }).colega)
    return {
      id: row.id as string,
      assunto: row.assunto as string,
      dono: row.dono as string,
      hops: row.hops as number,
      status: row.status as StatusThread,
      participantes,
      createdAt: row.created_at as string,
    }
  }

  entrarNaThread(threadId: string, colega: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO participantes (thread_id, colega) VALUES (?, ?)`,
      )
      .run(threadId, colega)
  }

  fecharThread(threadId: string, quem: string): Thread {
    const thread = this.getThread(threadId)
    if (!thread) throw new ErroCorreio(`thread ${threadId} não existe`, 'THREAD_INEXISTENTE')
    if (thread.dono !== quem) {
      throw new ErroCorreio(
        `só o dono da thread (${thread.dono}) pode fechá-la`,
        'NAO_E_DONO',
      )
    }
    this.db
      .prepare(`UPDATE threads SET status = 'fechada', closed_at = ? WHERE id = ?`)
      .run(agora(), threadId)
    return { ...thread, status: 'fechada' }
  }

  threadsAbertas(colega: string): Thread[] {
    const ids = this.db
      .prepare(
        `SELECT t.id FROM threads t
         JOIN participantes p ON p.thread_id = t.id
         WHERE p.colega = ? AND t.status = 'aberta'
         ORDER BY t.created_at DESC`,
      )
      .all(colega)
      .map((r) => (r as { id: string }).id)
    return ids.map((id) => this.getThread(id)!).filter(Boolean)
  }

  // ---------- mensagens ----------

  enviar(input: {
    threadId: string
    de: string
    para: string
    tipo: TipoMensagem
    conteudo: string
    replyTo?: string | null
  }): Mensagem {
    const thread = this.getThread(input.threadId)
    if (!thread) throw new ErroCorreio(`thread ${input.threadId} não existe`, 'THREAD_INEXISTENTE')
    if (thread.status === 'fechada') {
      throw new ErroCorreio(`thread "${thread.assunto}" está fechada`, 'THREAD_FECHADA')
    }
    if (thread.status === 'exhausted') {
      throw new ErroCorreio(
        `thread "${thread.assunto}" esgotou os hops disponíveis`,
        'HOPS_ESGOTADOS',
      )
    }
    if (thread.hops <= 0) {
      this.marcarExhausted(input.threadId)
      throw new ErroCorreio(
        `thread "${thread.assunto}" esgotou os hops disponíveis`,
        'HOPS_ESGOTADOS',
      )
    }
    if (!thread.participantes.includes(input.de)) {
      throw new ErroCorreio(`${input.de} não participa dessa thread`, 'NAO_PARTICIPA')
    }
    if (!thread.participantes.includes(input.para)) {
      throw new ErroCorreio(`${input.para} não participa dessa thread`, 'DESTINATARIO_FORA')
    }

    const msg: Mensagem = {
      id: randomUUID(),
      threadId: input.threadId,
      de: input.de,
      para: input.para,
      tipo: input.tipo,
      conteudo: input.conteudo,
      replyTo: input.replyTo ?? null,
      createdAt: agora(),
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO mensagens (id, thread_id, de, para, tipo, conteudo, reply_to, lida, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(
          msg.id,
          msg.threadId,
          msg.de,
          msg.para,
          msg.tipo,
          msg.conteudo,
          msg.replyTo,
          msg.createdAt,
        )
      this.db.prepare(`UPDATE threads SET hops = hops - 1 WHERE id = ?`).run(input.threadId)
      const restante = (
        this.db.prepare(`SELECT hops FROM threads WHERE id = ?`).get(input.threadId) as {
          hops: number
        }
      ).hops
      if (restante <= 0) {
        this.db.prepare(`UPDATE threads SET status = 'exhausted' WHERE id = ?`).run(input.threadId)
      }
    })
    tx()

    return msg
  }

  private marcarExhausted(threadId: string): void {
    this.db.prepare(`UPDATE threads SET status = 'exhausted' WHERE id = ?`).run(threadId)
  }

  /** Correspondência não lida. Marca como lida ao entregar (evita reentrega em loop). */
  inbox(colega: string, marcarLida = true): Mensagem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mensagens WHERE para = ? AND lida = 0 ORDER BY created_at ASC`,
      )
      .all(colega) as Record<string, unknown>[]

    if (marcarLida && rows.length > 0) {
      const stmt = this.db.prepare(`UPDATE mensagens SET lida = 1 WHERE id = ?`)
      const tx = this.db.transaction(() => {
        for (const r of rows) stmt.run(r.id as string)
      })
      tx()
    }

    return rows.map(paraMensagem)
  }

  marcarLida(mensagemId: string): void {
    this.db.prepare(`UPDATE mensagens SET lida = 1 WHERE id = ?`).run(mensagemId)
  }

  contarNaoLidas(colega: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM mensagens WHERE para = ? AND lida = 0`)
      .get(colega) as { n: number }
    return row.n
  }

  mensagensDaThread(threadId: string): Mensagem[] {
    return (
      this.db
        .prepare(`SELECT * FROM mensagens WHERE thread_id = ? ORDER BY created_at ASC`)
        .all(threadId) as Record<string, unknown>[]
    ).map(paraMensagem)
  }

  /** Pergunta feita por `de` para `para` nessa thread que ainda ninguém respondeu. */
  askPendente(threadId: string, de: string, para: string): Mensagem | null {
    const row = this.db
      .prepare(
        `SELECT m.* FROM mensagens m
         WHERE m.thread_id = ? AND m.de = ? AND m.para = ? AND m.tipo = 'ask'
           AND NOT EXISTS (
             SELECT 1 FROM mensagens r WHERE r.reply_to = m.id AND r.tipo = 'resposta'
           )
         ORDER BY m.created_at ASC LIMIT 1`,
      )
      .get(threadId, de, para) as Record<string, unknown> | undefined
    return row ? paraMensagem(row) : null
  }

  respostaPara(mensagemId: string): Mensagem | null {
    const row = this.db
      .prepare(
        `SELECT * FROM mensagens WHERE reply_to = ? AND tipo = 'resposta' ORDER BY created_at ASC LIMIT 1`,
      )
      .get(mensagemId) as Record<string, unknown> | undefined
    return row ? paraMensagem(row) : null
  }

  // ---------- quadro branco ----------

  boardWrite(chave: string, valor: string, autor: string): void {
    this.db
      .prepare(
        `INSERT INTO board (chave, valor, autor, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, autor = excluded.autor, updated_at = excluded.updated_at`,
      )
      .run(chave, valor, autor, agora())
  }

  /** Chave terminada em `*` lista por prefixo. */
  boardRead(
    chave: string,
  ): { chave: string; valor: string; autor: string; updatedAt: string }[] {
    const rows = chave.endsWith('*')
      ? (this.db
          .prepare(`SELECT * FROM board WHERE chave LIKE ? ORDER BY chave`)
          .all(chave.slice(0, -1) + '%') as Record<string, unknown>[])
      : ([this.db.prepare(`SELECT * FROM board WHERE chave = ?`).get(chave)].filter(
          Boolean,
        ) as Record<string, unknown>[])

    return rows.map((r) => ({
      chave: r.chave as string,
      valor: r.valor as string,
      autor: r.autor as string,
      updatedAt: r.updated_at as string,
    }))
  }

  // ---------- claims ----------

  claim(recurso: string, intencao: string, dono: string): ResultadoClaim {
    const ativo = this.db
      .prepare(`SELECT * FROM claims WHERE recurso = ? AND status = 'ativo' LIMIT 1`)
      .get(recurso) as Record<string, unknown> | undefined

    if (ativo) {
      if (ativo.dono === dono) return { ok: true, claimId: ativo.id as string }
      return {
        ok: false,
        conflito: {
          dono: ativo.dono as string,
          intencao: ativo.intencao as string,
          desde: ativo.created_at as string,
        },
      }
    }

    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO claims (id, recurso, dono, intencao, status, created_at)
         VALUES (?, ?, ?, ?, 'ativo', ?)`,
      )
      .run(id, recurso, dono, intencao, agora())
    this.auditar('claim_criado', dono, `${recurso}: ${intencao}`)
    return { ok: true, claimId: id }
  }

  claimAtivoDe(dono: string): { id: string; recurso: string }[] {
    return (
      this.db
        .prepare(`SELECT id, recurso FROM claims WHERE dono = ? AND status = 'ativo'`)
        .all(dono) as { id: string; recurso: string }[]
    )
  }

  release(claimId: string, quem: string): void {
    const claim = this.db.prepare(`SELECT * FROM claims WHERE id = ?`).get(claimId) as
      | Record<string, unknown>
      | undefined
    if (!claim) throw new ErroCorreio(`claim ${claimId} não existe`, 'CLAIM_INEXISTENTE')
    if (claim.dono !== quem) {
      throw new ErroCorreio(
        `claim pertence a ${claim.dono as string}`,
        'CLAIM_DE_OUTRO',
      )
    }
    this.db
      .prepare(`UPDATE claims SET status = 'liberado', released_at = ? WHERE id = ?`)
      .run(agora(), claimId)
    this.auditar('claim_liberado', quem, claim.recurso as string)
  }

  // ---------- sessões de colega ----------

  sessaoDe(threadId: string, colega: string): string | null {
    const row = this.db
      .prepare(`SELECT session_id FROM sessoes_colega WHERE thread_id = ? AND colega = ?`)
      .get(threadId, colega) as { session_id: string } | undefined
    return row?.session_id ?? null
  }

  guardarSessao(threadId: string, colega: string, sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO sessoes_colega (thread_id, colega, session_id) VALUES (?, ?, ?)
         ON CONFLICT(thread_id, colega) DO UPDATE SET session_id = excluded.session_id`,
      )
      .run(threadId, colega, sessionId)
  }

  esquecerSessao(threadId: string, colega: string): void {
    this.db
      .prepare(`DELETE FROM sessoes_colega WHERE thread_id = ? AND colega = ?`)
      .run(threadId, colega)
  }

  colegasComSessao(threadId: string): string[] {
    return this.db
      .prepare(`SELECT colega FROM sessoes_colega WHERE thread_id = ?`)
      .all(threadId)
      .map((r) => (r as { colega: string }).colega)
  }

  // ---------- auditoria ----------

  auditar(acao: string, ator: string, detalhe?: string): void {
    this.db
      .prepare(
        `INSERT INTO auditoria (id, acao, ator, detalhe, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), acao, ator, detalhe ?? null, agora())
  }

  auditoriaRecente(limite = 50): { acao: string; ator: string; detalhe: string | null }[] {
    return this.db
      .prepare(`SELECT acao, ator, detalhe FROM auditoria ORDER BY created_at DESC LIMIT ?`)
      .all(limite) as { acao: string; ator: string; detalhe: string | null }[]
  }
}

function paraMensagem(r: Record<string, unknown>): Mensagem {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    de: r.de as string,
    para: r.para as string,
    tipo: r.tipo as TipoMensagem,
    conteudo: r.conteudo as string,
    replyTo: (r.reply_to as string | null) ?? null,
    createdAt: r.created_at as string,
  }
}
