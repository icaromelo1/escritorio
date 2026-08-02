/**
 * E2E REAL: acorda um colega com `claude -p` de verdade.
 * GASTA API (3 chamadas em haiku). Não roda no `npm test`.
 *
 *   node scripts/smoke-e2e.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'escritorio-e2e-'))
process.env.ESCRITORIO_DB = join(tmp, 'e.db')

const { abrirDb } = await import('../dist/db.js')
const { Correio } = await import('../dist/correio.js')
const { Escritorio } = await import('../dist/escritorio.js')
const { parseRoster } = await import('../dist/roster.js')

const agentFile = join(tmp, 'colega.md')
const caderno = join(tmp, 'caderno.md')
writeFileSync(
  agentFile,
  'Você é um assistente de teste. Responda sempre da forma mais curta possível.',
)

const roster = parseRoster(`
colega-teste:
  brief: "Colega de teste do smoke E2E"
  agent_file: ${agentFile}
  caderno: ${caderno}
  tier: advisor
  modelo: claude-haiku-4-5-20251001
`)

const correio = new Correio(abrirDb(process.env.ESCRITORIO_DB))
const escritorio = new Escritorio({ correio, roster, eu: 'smoke-e2e' })

const ok = (rotulo, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${rotulo}${extra ? ' — ' + extra : ''}`)
  if (!cond) process.exitCode = 1
}

try {
  console.log('1/3 acordando o colega pela primeira vez...')
  const r1 = await escritorio.ask({
    para: 'colega-teste',
    pergunta:
      'Regra deste projeto, guarde: migration é sempre gerada via CLI, nunca escrita à mão. Meu número favorito é 7. Responda apenas: OK',
  })
  ok('colega real respondeu', r1.resposta.length > 0, JSON.stringify(r1.resposta.slice(0, 60)))
  ok('veio pelo caminho de colega', r1.via === 'colega')

  const sessao = correio.sessaoDe(r1.threadId, 'colega-teste')
  ok('sessão do colega foi guardada na thread', Boolean(sessao), sessao ?? '')

  console.log('2/3 segunda pergunta na MESMA thread (testa --resume)...')
  const r2 = await escritorio.ask({
    para: 'colega-teste',
    pergunta: 'Qual é o meu número favorito? Responda apenas o número.',
    threadId: r1.threadId,
  })
  ok('colega lembrou dentro da thread', r2.resposta.includes('7'), JSON.stringify(r2.resposta.slice(0, 60)))
  ok(
    'continuou na mesma sessão',
    correio.sessaoDe(r1.threadId, 'colega-teste') === sessao,
  )

  ok('resposta não ficou pendurada no inbox', escritorio.inbox().mensagens.length === 0)

  console.log('3/3 fechando a thread (destilação do caderno)...')
  const { destilados } = await escritorio.fecharThread(r1.threadId)
  ok('destilou o caderno', destilados.includes('colega-teste'))
  ok('caderno existe em disco', existsSync(caderno))
  ok('sessão morreu depois da destilação', correio.sessaoDe(r1.threadId, 'colega-teste') === null)
  ok('thread ficou fechada', correio.getThread(r1.threadId).status === 'fechada')

  if (existsSync(caderno)) {
    console.log('\n--- caderno gerado ---')
    console.log(readFileSync(caderno, 'utf8'))
    console.log('----------------------')
  }

  console.log('\n--- auditoria ---')
  for (const a of correio.auditoriaRecente(20).reverse()) {
    console.log(`${a.acao} | ${a.ator} | ${a.detalhe ?? ''}`)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(process.exitCode ? '\nFALHOU' : '\nsmoke E2E ok')
