#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { abrirDb } from './db.js'
import { Correio } from './correio.js'
import { carregarRoster } from './roster.js'
import { Escritorio } from './escritorio.js'
import { identidade } from './identidade.js'

const eu = identidade()

const db = abrirDb()
const correio = new Correio(db)
const roster = carregarRoster()
const escritorio = new Escritorio({ correio, roster, eu })

const server = new McpServer({ name: 'escritorio', version: '0.1.0' })

const texto = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const json = (v: unknown) => texto(JSON.stringify(v, null, 2))
const erro = (e: unknown) => ({
  content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }],
  isError: true,
})

server.registerTool(
  'roster',
  {
    description:
      'Quem existe no escritório: colegas do roster (nome, o que sabem, tier) e sessões vivas vistas recentemente. Use antes de falar com alguém — devolve só uma linha por pessoa, sem carregar nenhum .md.',
    inputSchema: {},
  },
  async () => {
    try {
      return json(escritorio.listarRoster())
    } catch (e) {
      return erro(e)
    }
  },
)

server.registerTool(
  'ask',
  {
    description:
      'Pergunta a um colega e ESPERA a resposta. Use quando a resposta bloqueia seu raciocínio. Colega do roster é acordado na hora; sessão viva recebe por hook e você espera até o timeout.',
    inputSchema: {
      para: z.string().describe('nome de quem responde (ver roster)'),
      pergunta: z.string(),
      thread: z.string().optional().describe('continuar uma thread existente'),
      tier: z
        .enum(['advisor', 'editor', 'worktree'])
        .optional()
        .describe('rebaixa o poder do colega nesta consulta (nunca eleva)'),
    },
  },
  async ({ para, pergunta, thread, tier }) => {
    try {
      const r = await escritorio.ask({ para, pergunta, threadId: thread, tier })
      return json(r)
    } catch (e) {
      return erro(e)
    }
  },
)

server.registerTool(
  'dm',
  {
    description:
      'Manda uma mensagem e SEGUE trabalhando. A resposta chega depois no seu inbox(). Use também para RESPONDER uma pergunta que chegou: passe o mesmo "thread" e o correio liga a resposta a quem está esperando.',
    inputSchema: {
      para: z.string(),
      mensagem: z.string(),
      thread: z.string().optional(),
      tier: z.enum(['advisor', 'editor', 'worktree']).optional(),
      responde_a: z
        .string()
        .optional()
        .describe('id da mensagem que está sendo respondida (opcional — o correio infere pela thread)'),
    },
  },
  async ({ para, mensagem, thread, tier, responde_a }) => {
    try {
      return json(escritorio.dm({ para, mensagem, threadId: thread, tier, respondeA: responde_a }))
    } catch (e) {
      return erro(e)
    }
  },
)

server.registerTool(
  'inbox',
  {
    description:
      'Puxa sua correspondência não lida e lista suas threads abertas. Normalmente o hook já entrega sozinho — use quando quiser checar na mão.',
    inputSchema: {},
  },
  async () => {
    try {
      return json(escritorio.inbox())
    } catch (e) {
      return erro(e)
    }
  },
)

server.registerTool(
  'fechar_thread',
  {
    description:
      'Fecha uma thread que VOCÊ abriu. Cada colega que participou destila o que aprendeu no caderno dele e a sessão dele morre.',
    inputSchema: { thread: z.string() },
  },
  async ({ thread }) => {
    try {
      return json(await escritorio.fecharThread(thread))
    } catch (e) {
      return erro(e)
    }
  },
)

server.registerTool(
  'board',
  {
    description:
      'Quadro branco compartilhado: estado que qualquer sessão lê sem mandar mensagem. Sem "valor" lê; com "valor" escreve. Chave terminada em * lista por prefixo. Ex: "dsg/v1:decisoes", "global:quem-esta-fazendo-o-que".',
    inputSchema: {
      chave: z.string(),
      valor: z.string().optional().describe('omita para ler'),
    },
  },
  async ({ chave, valor }) => {
    try {
      if (valor === undefined) return json(escritorio.boardRead(chave))
      escritorio.boardWrite(chave, valor)
      return texto(`quadro atualizado: ${chave}`)
    } catch (e) {
      return erro(e)
    }
  },
)

server.registerTool(
  'claim',
  {
    description:
      'Reivindica um recurso (arquivo, módulo, banco) antes de mexer, pra outra sessão não mexer junto. Se já estiver reivindicado, devolve quem está e com que intenção. Passe claim_id para liberar.',
    inputSchema: {
      recurso: z.string().optional(),
      intencao: z.string().optional(),
      claim_id: z.string().optional().describe('libera o claim informado'),
    },
  },
  async ({ recurso, intencao, claim_id }) => {
    try {
      if (claim_id) {
        escritorio.release(claim_id)
        return texto(`claim ${claim_id} liberado`)
      }
      if (!recurso || !intencao) {
        return erro(new Error('informe recurso + intencao para reivindicar, ou claim_id para liberar'))
      }
      return json(escritorio.claim(recurso, intencao))
    } catch (e) {
      return erro(e)
    }
  },
)

await server.connect(new StdioServerTransport())
