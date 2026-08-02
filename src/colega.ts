import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Correio } from './correio.js'
import {
  flagsPorTier,
  lerArquivoOpcional,
  montarSystemPrompt,
  resolverTier,
  expandirCaminho,
  type ColegaConfig,
  type Tier,
} from './roster.js'
import { caminhoPadraoDb } from './db.js'

const execFileAsync = promisify(execFile)

export interface RespostaHeadless {
  texto: string
  sessionId: string | null
  erro: boolean
}

/** Executor injetável — os testes trocam isso pra não chamar o CLI de verdade. */
export type Runner = (
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<string>

export const runnerReal: Runner = async (args, opts) => {
  const { stdout } = await execFileAsync('claude', args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    maxBuffer: 32 * 1024 * 1024,
    timeout: Number(process.env.ESCRITORIO_SPAWN_TIMEOUT_MS ?? 10 * 60_000),
  })
  return stdout
}

export function parseSaidaHeadless(stdout: string): RespostaHeadless {
  try {
    const json = JSON.parse(stdout) as Record<string, unknown>
    const texto =
      typeof json.result === 'string'
        ? json.result
        : typeof json.content === 'string'
          ? json.content
          : stdout.trim()
    return {
      texto,
      sessionId: typeof json.session_id === 'string' ? json.session_id : null,
      erro: json.is_error === true,
    }
  } catch {
    return { texto: stdout.trim(), sessionId: null, erro: false }
  }
}

export function mcpConfigDoEscritorio(idDoColega: string): string {
  const servidor = process.env.ESCRITORIO_SERVER_PATH ?? join(pastaDoPacote(), 'server.js')
  return JSON.stringify({
    mcpServers: {
      escritorio: {
        command: 'node',
        args: [servidor],
        env: { ESCRITORIO_ID: idDoColega, ESCRITORIO_DB: caminhoPadraoDb() },
      },
    },
  })
}

function pastaDoPacote(): string {
  return new URL('.', import.meta.url).pathname
}

/** Monta os argumentos do `claude -p`. Puro — é o que os testes verificam. */
export function montarArgs(input: {
  mensagem: string
  systemPrompt: string
  tier: Tier
  sessionId?: string | null
  modelo?: string
  idDoColega: string
}): string[] {
  const args = ['-p', input.mensagem, '--output-format', 'json']

  if (input.sessionId) {
    args.push('--resume', input.sessionId)
  } else {
    args.push('--append-system-prompt', input.systemPrompt)
  }

  args.push(...flagsPorTier(input.tier))
  if (input.modelo) args.push('--model', input.modelo)
  args.push('--mcp-config', mcpConfigDoEscritorio(input.idDoColega))

  return args
}

export interface OpcoesAcordar {
  correio: Correio
  colega: ColegaConfig
  threadId: string
  mensagem: string
  tierPedido?: Tier | null
  runner?: Runner
  baseArquivos?: string
}

/**
 * Acorda um colega: primeira mensagem da thread cria sessão nova com
 * .agent/*.md + caderno; as seguintes retomam com --resume.
 */
export async function acordarColega(opts: OpcoesAcordar): Promise<RespostaHeadless> {
  const { correio, colega, threadId, mensagem } = opts
  const runner = opts.runner ?? runnerReal
  const tier = resolverTier(colega.tier, opts.tierPedido)

  if (tier === 'editor') {
    const claims = correio.claimAtivoDe(colega.nome)
    if (claims.length === 0) {
      correio.auditar('spawn_recusado', colega.nome, 'tier editor sem claim ativo')
      throw new Error(
        `colega "${colega.nome}" é tier editor e não tem claim ativo — o correio recusa acordá-lo para escrita`,
      )
    }
  }

  const sessionId = correio.sessaoDe(threadId, colega.nome)
  const systemPrompt = montarSystemPrompt({
    nome: colega.nome,
    agentFile: lerArquivoOpcional(colega.agentFile, opts.baseArquivos),
    caderno: lerArquivoOpcional(colega.caderno, opts.baseArquivos),
  })

  const cwd = await resolverCwd(colega, tier, threadId)
  const args = montarArgs({
    mensagem,
    systemPrompt,
    tier,
    sessionId,
    modelo: colega.modelo,
    idDoColega: colega.nome,
  })

  const stdout = await runner(args, { cwd })
  const resposta = parseSaidaHeadless(stdout)

  if (resposta.sessionId) correio.guardarSessao(threadId, colega.nome, resposta.sessionId)
  correio.auditar('colega_acordado', colega.nome, `thread=${threadId} tier=${tier}`)

  return resposta
}

async function resolverCwd(
  colega: ColegaConfig,
  tier: Tier,
  threadId: string,
): Promise<string | undefined> {
  const base = colega.cwd ? expandirCaminho(colega.cwd) : undefined
  if (tier !== 'worktree' || !base) return base

  const destino = join(homedir(), '.escritorio', 'worktrees', `${colega.nome}-${threadId.slice(0, 8)}`)
  mkdirSync(join(homedir(), '.escritorio', 'worktrees'), { recursive: true })
  try {
    await execFileAsync('git', ['-C', base, 'worktree', 'add', '-b', `escritorio/${colega.nome}-${threadId.slice(0, 8)}`, destino])
    return destino
  } catch {
    // worktree já existe (thread retomada) ou não é repo git — segue no cwd normal
    return destino !== base && existeDir(destino) ? destino : base
  }
}

function existeDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
