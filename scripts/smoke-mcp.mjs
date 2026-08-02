/**
 * Smoke do servidor MCP: sobe o dist/server.js de verdade via stdio,
 * lista as tools e exercita quadro/claim/roster. Não gasta API.
 *
 *   node scripts/smoke-mcp.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'escritorio-smoke-'))
const rosterPath = join(tmp, 'roster.yaml')
writeFileSync(
  rosterPath,
  `especialista-deposito:\n  brief: "Depósito antecipado (DSG/v1)"\n  tier: advisor\n`,
)

const servidor = new URL('../dist/server.js', import.meta.url).pathname
const cliente = new Client({ name: 'smoke', version: '1.0.0' })

const transport = new StdioClientTransport({
  command: 'node',
  args: [servidor],
  env: {
    ...process.env,
    ESCRITORIO_ID: 'smoke-session',
    ESCRITORIO_DB: join(tmp, 'e.db'),
    ESCRITORIO_ROSTER: rosterPath,
  },
})

const ok = (rotulo, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${rotulo}${extra ? ' — ' + extra : ''}`)
  if (!cond) process.exitCode = 1
}

const texto = (r) => r.content.map((c) => c.text).join('\n')

try {
  await cliente.connect(transport)

  const { tools } = await cliente.listTools()
  const nomes = tools.map((t) => t.name).sort()
  ok('servidor sobe e lista tools', nomes.length === 7, nomes.join(', '))

  const roster = JSON.parse(texto(await cliente.callTool({ name: 'roster', arguments: {} })))
  ok('roster devolve o colega do yaml', roster.colegas[0]?.nome === 'especialista-deposito')
  ok('roster não vaza .md, só o brief', Object.keys(roster.colegas[0]).sort().join() === 'brief,nome,tier')

  await cliente.callTool({
    name: 'board',
    arguments: { chave: 'dsg/v1:decisoes', valor: 'usar cherry-pick' },
  })
  const lido = JSON.parse(
    texto(await cliente.callTool({ name: 'board', arguments: { chave: 'dsg/v1:*' } })),
  )
  ok('quadro branco escreve e lê por prefixo', lido[0]?.valor === 'usar cherry-pick')
  ok('quadro registra o autor', lido[0]?.autor === 'smoke-session')

  const c1 = JSON.parse(
    texto(
      await cliente.callTool({
        name: 'claim',
        arguments: { recurso: 'src/app.ts', intencao: 'refatorar' },
      }),
    ),
  )
  ok('claim é concedido', c1.ok === true)

  const semDestino = await cliente.callTool({
    name: 'ask',
    arguments: { para: 'ninguem', pergunta: 'oi' },
  })
  ok('destinatário inexistente vira erro legível', semDestino.isError === true)
  ok('erro sugere quem existe', texto(semDestino).includes('especialista-deposito'))

  const dmFora = await cliente.callTool({
    name: 'fechar_thread',
    arguments: { thread: 'inexistente' },
  })
  ok('fechar thread inexistente não derruba o servidor', dmFora.isError === true)

  const inbox = JSON.parse(texto(await cliente.callTool({ name: 'inbox', arguments: {} })))
  ok('inbox responde vazio sem carta', Array.isArray(inbox.mensagens) && inbox.mensagens.length === 0)
} finally {
  await cliente.close().catch(() => {})
  rmSync(tmp, { recursive: true, force: true })
}

console.log(process.exitCode ? '\nFALHOU' : '\nsmoke MCP ok')
