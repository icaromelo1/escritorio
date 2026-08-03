import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

export type Tier = 'advisor' | 'editor' | 'worktree'

/** Do menos poderoso pro mais poderoso. Índice menor = menos poder. */
export const ORDEM_TIER: Tier[] = ['advisor', 'editor', 'worktree']

export interface ColegaConfig {
  nome: string
  brief: string
  agentFile?: string
  caderno?: string
  tier: Tier
  cwd?: string
  modelo?: string
}

export type Roster = Record<string, ColegaConfig>

export function caminhoPadraoRoster(): string {
  return (
    process.env.ESCRITORIO_ROSTER ??
    join(homedir(), 'claude-workspace-config', 'roster.yaml')
  )
}

/**
 * Expande `~`, `${VAR}` e `$VAR`. A expansão de env é o que permite o mesmo
 * roster.yaml servir Mac e VM, onde o workspace fica em caminhos diferentes.
 */
export function expandirCaminho(p: string, base?: string): string {
  let caminho = p.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_todo, comChaves: string | undefined, semChaves: string | undefined) =>
      process.env[(comChaves ?? semChaves)!] ?? '',
  )
  if (caminho.startsWith('~/')) caminho = join(homedir(), caminho.slice(2))
  if (isAbsolute(caminho)) return caminho
  return base ? resolve(base, caminho) : resolve(caminho)
}

/** Parser puro — recebe o texto do YAML, não toca em disco. */
export function parseRoster(texto: string): Roster {
  const bruto = (parseYaml(texto) ?? {}) as Record<string, Record<string, unknown>>
  const roster: Roster = {}

  for (const [nome, cfg] of Object.entries(bruto)) {
    if (!cfg || typeof cfg !== 'object') continue
    const tier = (cfg.tier as Tier) ?? 'advisor'
    if (!ORDEM_TIER.includes(tier)) {
      throw new Error(`colega "${nome}": tier inválido "${String(cfg.tier)}"`)
    }
    if (!cfg.brief) throw new Error(`colega "${nome}": campo obrigatório "brief" ausente`)

    roster[nome] = {
      nome,
      brief: String(cfg.brief),
      agentFile: cfg.agent_file ? String(cfg.agent_file) : undefined,
      caderno: cfg.caderno ? String(cfg.caderno) : undefined,
      tier,
      cwd: cfg.cwd ? String(cfg.cwd) : undefined,
      modelo: cfg.modelo ? String(cfg.modelo) : undefined,
    }
  }

  return roster
}

export function carregarRoster(caminho = caminhoPadraoRoster()): Roster {
  const p = expandirCaminho(caminho)
  if (!existsSync(p)) return {}
  return parseRoster(readFileSync(p, 'utf8'))
}

/**
 * Um pedido pode REBAIXAR o tier de um colega, nunca ELEVAR.
 * Sem pedido, vale o tier do roster.
 */
export function resolverTier(doRoster: Tier, pedido?: Tier | null): Tier {
  if (!pedido) return doRoster
  const iRoster = ORDEM_TIER.indexOf(doRoster)
  const iPedido = ORDEM_TIER.indexOf(pedido)
  if (iPedido === -1) return doRoster
  return iPedido < iRoster ? pedido : doRoster
}

/** As tools do próprio escritório: sem elas o colega não consegue falar com ninguém. */
export const TOOLS_DO_ESCRITORIO = [
  'mcp__escritorio__roster',
  'mcp__escritorio__ask',
  'mcp__escritorio__dm',
  'mcp__escritorio__inbox',
  'mcp__escritorio__board',
  'mcp__escritorio__claim',
  'mcp__escritorio__fechar_thread',
]

/**
 * Allowlist do advisor. É allowlist e não denylist por um motivo verificado na marra:
 * negar Edit/Write deixa o buraco do Bash (`echo x > arquivo`), e `bypassPermissions`
 * ignora a negação. Com allowlist, o que eu esquecer fica negado em vez de liberado.
 */
export const FERRAMENTAS_DO_ADVISOR = [
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(git branch:*)',
  'Bash(git blame:*)',
  'Bash(grep:*)',
  'Bash(rg:*)',
  'Bash(ls:*)',
  'Bash(find:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  ...TOOLS_DO_ESCRITORIO,
]

/** Flags do CLI que impõem o tier. */
export function flagsPorTier(tier: Tier): string[] {
  switch (tier) {
    case 'advisor':
      // sem --permission-mode: no headless, o que está fora da allowlist é negado
      return ['--allowedTools', ...FERRAMENTAS_DO_ADVISOR]
    case 'editor':
    case 'worktree':
      return ['--permission-mode', 'acceptEdits']
  }
}

/** System prompt do colega: quem ele é (.agent/*.md) + o que ele aprendeu (caderno). */
export function montarSystemPrompt(input: {
  nome: string
  agentFile?: string | null
  caderno?: string | null
}): string {
  const partes: string[] = [
    `Você é "${input.nome}", um colega dentro do Escritório — um espaço onde sessões e especialistas conversam entre si.`,
    'Responda de forma direta e técnica. Sua resposta inteira volta como mensagem para quem perguntou, então não escreva saudação nem despedida.',
  ]
  if (input.agentFile?.trim()) {
    partes.push('--- Quem você é ---', input.agentFile.trim())
  }
  if (input.caderno?.trim()) {
    partes.push(
      '--- Seu caderno (o que você já aprendeu em conversas anteriores) ---',
      input.caderno.trim(),
    )
  }
  return partes.join('\n\n')
}

export function lerArquivoOpcional(caminho?: string, base?: string): string | null {
  if (!caminho) return null
  const p = expandirCaminho(caminho, base)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}
