import { Correio, ErroCorreio, type Mensagem, type Thread } from './correio.js'
import { acordarColega, type Runner } from './colega.js'
import { destilarCaderno } from './caderno.js'
import type { Roster, Tier } from './roster.js'

export interface OpcoesEscritorio {
  correio: Correio
  roster: Roster
  eu: string
  runner?: Runner
  askTimeoutMs?: number
  intervaloPollMs?: number
  agendar?: (fn: () => Promise<void>) => void
}

export interface ResultadoAsk {
  threadId: string
  resposta: string
  via: 'colega' | 'sessao-viva'
  timeout?: boolean
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Escritorio {
  private correio: Correio
  private roster: Roster
  private eu: string
  private runner?: Runner
  private askTimeoutMs: number
  private intervaloPollMs: number
  private agendar: (fn: () => Promise<void>) => void

  constructor(opts: OpcoesEscritorio) {
    this.correio = opts.correio
    this.roster = opts.roster
    this.eu = opts.eu
    this.runner = opts.runner
    this.askTimeoutMs = opts.askTimeoutMs ?? Number(process.env.ESCRITORIO_ASK_TIMEOUT_MS ?? 300_000)
    this.intervaloPollMs = opts.intervaloPollMs ?? 1_000
    this.agendar = opts.agendar ?? ((fn) => void fn().catch(() => {}))
    this.correio.registrarPresenca(this.eu)
  }

  // ---------- roster ----------

  listarRoster(): {
    colegas: { nome: string; brief: string; tier: Tier }[]
    sessoesVivas: string[]
  } {
    return {
      colegas: Object.values(this.roster).map((c) => ({
        nome: c.nome,
        brief: c.brief,
        tier: c.tier,
      })),
      sessoesVivas: this.correio.presentes().filter((c) => !this.roster[c]),
    }
  }

  private ehColega(nome: string): boolean {
    return Boolean(this.roster[nome])
  }

  private garantirDestinatario(nome: string): void {
    if (this.ehColega(nome)) return
    if (this.correio.presentes(24 * 60).includes(nome)) return
    const conhecidos = [
      ...Object.keys(this.roster),
      ...this.correio.presentes(24 * 60),
    ].filter((n) => n !== this.eu)
    throw new ErroCorreio(
      `não existe ninguém chamado "${nome}" no escritório. Conhecidos: ${conhecidos.join(', ') || '(vazio)'}`,
      'DESTINATARIO_DESCONHECIDO',
    )
  }

  private resolverThread(para: string, assunto: string, threadId?: string | null): Thread {
    if (threadId) {
      const t = this.correio.getThread(threadId)
      if (!t) throw new ErroCorreio(`thread ${threadId} não existe`, 'THREAD_INEXISTENTE')
      this.correio.entrarNaThread(t.id, this.eu)
      this.correio.entrarNaThread(t.id, para)
      return this.correio.getThread(t.id)!
    }
    return this.correio.abrirThread({
      assunto: assunto.slice(0, 80),
      dono: this.eu,
      participantes: [para],
    })
  }

  // ---------- ask (síncrono) ----------

  async ask(input: {
    para: string
    pergunta: string
    threadId?: string | null
    tier?: Tier | null
  }): Promise<ResultadoAsk> {
    this.garantirDestinatario(input.para)
    const thread = this.resolverThread(input.para, input.pergunta, input.threadId)

    const msg = this.correio.enviar({
      threadId: thread.id,
      de: this.eu,
      para: input.para,
      tipo: 'ask',
      conteudo: input.pergunta,
    })

    if (this.ehColega(input.para)) {
      const texto = await this.consultarColega(input.para, thread, msg, input.tier ?? null)
      return { threadId: thread.id, resposta: texto, via: 'colega' }
    }

    const resposta = await this.esperarResposta(msg.id)
    if (!resposta) {
      return {
        threadId: thread.id,
        via: 'sessao-viva',
        timeout: true,
        resposta: `sem resposta de "${input.para}" em ${Math.round(this.askTimeoutMs / 1000)}s. A thread continua aberta — a resposta vai chegar no seu inbox().`,
      }
    }
    return { threadId: thread.id, resposta: resposta.conteudo, via: 'sessao-viva' }
  }

  private async consultarColega(
    para: string,
    thread: Thread,
    msg: Mensagem,
    tier: Tier | null,
  ): Promise<string> {
    const colega = this.roster[para]!
    const resposta = await acordarColega({
      correio: this.correio,
      colega,
      threadId: thread.id,
      mensagem: `[thread: ${thread.assunto}]\n[de: ${this.eu}]\n\n${msg.conteudo}`,
      tierPedido: tier,
      runner: this.runner,
    })

    try {
      const registrada = this.correio.enviar({
        threadId: thread.id,
        de: para,
        para: this.eu,
        tipo: 'resposta',
        conteudo: resposta.texto,
        replyTo: msg.id,
      })
      // já está sendo devolvida nesta chamada — não deve reaparecer no inbox
      this.correio.marcarLida(registrada.id)
    } catch (err) {
      this.correio.auditar(
        'resposta_nao_registrada',
        para,
        err instanceof Error ? err.message : String(err),
      )
    }

    return resposta.texto
  }

  private async esperarResposta(msgId: string): Promise<Mensagem | null> {
    const limite = Date.now() + this.askTimeoutMs
    while (Date.now() < limite) {
      const r = this.correio.respostaPara(msgId)
      if (r) return r
      await esperar(this.intervaloPollMs)
    }
    return this.correio.respostaPara(msgId)
  }

  // ---------- dm (assíncrono) ----------

  dm(input: {
    para: string
    mensagem: string
    threadId?: string | null
    tier?: Tier | null
    respondeA?: string | null
  }): { threadId: string; mensagemId: string; acordou: boolean; respondeu: boolean } {
    this.garantirDestinatario(input.para)
    const thread = this.resolverThread(input.para, input.mensagem, input.threadId)

    // Se essa pessoa está bloqueada esperando resposta minha nessa thread, este dm É a resposta.
    const pendente = this.correio.askPendente(thread.id, input.para, this.eu)
    const replyTo = input.respondeA ?? pendente?.id ?? null

    const msg = this.correio.enviar({
      threadId: thread.id,
      de: this.eu,
      para: input.para,
      tipo: replyTo ? 'resposta' : 'dm',
      conteudo: input.mensagem,
      replyTo,
    })

    // Responder a quem perguntou não deve acordar mais ninguém: o ask já está esperando.
    if (replyTo) {
      return { threadId: thread.id, mensagemId: msg.id, acordou: false, respondeu: true }
    }

    const acordou = this.ehColega(input.para)
    if (acordou) {
      this.agendar(() => this.responderEmBackground(input.para, thread, msg, input.tier ?? null))
    }

    return { threadId: thread.id, mensagemId: msg.id, acordou, respondeu: false }
  }

  private async responderEmBackground(
    para: string,
    thread: Thread,
    msg: Mensagem,
    tier: Tier | null,
  ): Promise<void> {
    try {
      const colega = this.roster[para]!
      const resposta = await acordarColega({
        correio: this.correio,
        colega,
        threadId: thread.id,
        mensagem: `[thread: ${thread.assunto}]\n[de: ${this.eu}]\n\n${msg.conteudo}`,
        tierPedido: tier,
        runner: this.runner,
      })
      this.correio.enviar({
        threadId: thread.id,
        de: para,
        para: msg.de,
        tipo: 'resposta',
        conteudo: resposta.texto,
        replyTo: msg.id,
      })
    } catch (err) {
      this.correio.auditar(
        'dm_falhou',
        para,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // ---------- inbox / threads ----------

  inbox(): { mensagens: Mensagem[]; threadsAbertas: { id: string; assunto: string }[] } {
    this.correio.registrarPresenca(this.eu)
    return {
      mensagens: this.correio.inbox(this.eu),
      threadsAbertas: this.correio
        .threadsAbertas(this.eu)
        .map((t) => ({ id: t.id, assunto: t.assunto })),
    }
  }

  async fecharThread(threadId: string): Promise<{ destilados: string[] }> {
    const thread = this.correio.getThread(threadId)
    if (!thread) throw new ErroCorreio(`thread ${threadId} não existe`, 'THREAD_INEXISTENTE')
    this.correio.fecharThread(threadId, this.eu)

    const destilados: string[] = []
    for (const nome of this.correio.colegasComSessao(threadId)) {
      const colega = this.roster[nome]
      if (!colega) continue
      try {
        const entrada = await destilarCaderno({
          correio: this.correio,
          colega,
          threadId,
          assunto: thread.assunto,
          quem: this.eu,
          runner: this.runner,
        })
        if (entrada) destilados.push(nome)
      } catch (err) {
        this.correio.auditar(
          'destilacao_falhou',
          nome,
          err instanceof Error ? err.message : String(err),
        )
      }
    }
    return { destilados }
  }

  // ---------- quadro / claims ----------

  boardWrite(chave: string, valor: string): void {
    this.correio.boardWrite(chave, valor, this.eu)
  }

  boardRead(chave: string) {
    return this.correio.boardRead(chave)
  }

  claim(recurso: string, intencao: string) {
    return this.correio.claim(recurso, intencao, this.eu)
  }

  release(claimId: string) {
    this.correio.release(claimId, this.eu)
  }
}
