import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import {
  parseRoster,
  resolverTier,
  flagsPorTier,
  montarSystemPrompt,
  expandirCaminho,
} from '../src/roster.js'

const YAML = `
especialista-deposito:
  brief: "Depósito antecipado (DSG/v1)"
  agent_file: dsg/.agent/especialista-deposito.md
  caderno: cadernos/especialista-deposito.md
  tier: advisor
  cwd: ~/projetos/dsg/v1

refatorador:
  brief: "Refactor mecânico"
  tier: worktree
`

describe('parseRoster', () => {
  it('lê os campos e converte snake_case', () => {
    const r = parseRoster(YAML)
    expect(Object.keys(r).sort()).toEqual(['especialista-deposito', 'refatorador'])
    expect(r['especialista-deposito']!.agentFile).toBe('dsg/.agent/especialista-deposito.md')
    expect(r['especialista-deposito']!.tier).toBe('advisor')
  })

  it('tier ausente vira advisor (o mais restrito)', () => {
    expect(parseRoster('x:\n  brief: "y"\n')['x']!.tier).toBe('advisor')
  })

  it('rejeita tier inválido em vez de assumir algo', () => {
    expect(() => parseRoster('x:\n  brief: "y"\n  tier: deus\n')).toThrow(/tier inválido/)
  })

  it('exige brief', () => {
    expect(() => parseRoster('x:\n  tier: advisor\n')).toThrow(/brief/)
  })

  it('yaml vazio não quebra', () => {
    expect(parseRoster('')).toEqual({})
  })
})

describe('expandirCaminho — é o que faz o mesmo roster servir Mac e VM', () => {
  it('expande ${VAR} e $VAR', () => {
    process.env.ESCRITORIO_TESTE_WS = '/tmp/ws'
    expect(expandirCaminho('${ESCRITORIO_TESTE_WS}/dsg/v1')).toBe('/tmp/ws/dsg/v1')
    expect(expandirCaminho('$ESCRITORIO_TESTE_WS/dsg')).toBe('/tmp/ws/dsg')
    delete process.env.ESCRITORIO_TESTE_WS
  })

  it('variável ausente vira vazio em vez de literal', () => {
    delete process.env.ESCRITORIO_NAO_EXISTE
    expect(expandirCaminho('${ESCRITORIO_NAO_EXISTE}/x')).not.toContain('$')
  })

  it('expande ~ para o home', () => {
    expect(expandirCaminho('~/x')).toBe(`${homedir()}/x`)
  })

  it('caminho absoluto passa intacto', () => {
    expect(expandirCaminho('/a/b')).toBe('/a/b')
  })

  it('relativo resolve contra a base quando dada', () => {
    expect(expandirCaminho('c.md', '/a/b')).toBe('/a/b/c.md')
  })
})

describe('resolverTier — rebaixa mas nunca eleva', () => {
  it('sem pedido, vale o roster', () => {
    expect(resolverTier('editor')).toBe('editor')
    expect(resolverTier('editor', null)).toBe('editor')
  })

  it('rebaixa quando o pedido é mais restrito', () => {
    expect(resolverTier('worktree', 'advisor')).toBe('advisor')
    expect(resolverTier('editor', 'advisor')).toBe('advisor')
  })

  it('NÃO eleva quando o pedido é mais poderoso', () => {
    expect(resolverTier('advisor', 'worktree')).toBe('advisor')
    expect(resolverTier('advisor', 'editor')).toBe('advisor')
    expect(resolverTier('editor', 'worktree')).toBe('editor')
  })

  it('pedido inválido é ignorado, não eleva por acidente', () => {
    expect(resolverTier('advisor', 'root' as never)).toBe('advisor')
  })
})

describe('flagsPorTier', () => {
  it('advisor usa ALLOWLIST — denylist deixava o buraco do Bash', () => {
    const f = flagsPorTier('advisor')
    expect(f[0]).toBe('--allowedTools')
    expect(f).not.toContain('--disallowedTools')
  })

  it('advisor não recebe nenhuma ferramenta de escrita', () => {
    const f = flagsPorTier('advisor')
    for (const proibida of ['Edit', 'Write', 'NotebookEdit']) {
      expect(f).not.toContain(proibida)
    }
  })

  it('advisor NUNCA roda em bypassPermissions (ignora restrição)', () => {
    expect(flagsPorTier('advisor')).not.toContain('bypassPermissions')
  })

  it('advisor só recebe Bash em padrões de leitura', () => {
    const bash = flagsPorTier('advisor').filter((f) => f.startsWith('Bash('))
    expect(bash.length).toBeGreaterThan(0)
    for (const padrao of bash) {
      expect(padrao).toMatch(/^Bash\((git (log|show|diff|status|branch|blame)|grep|rg|ls|find|cat|head|tail|wc):\*\)$/)
    }
  })

  it('advisor mantém as tools do escritório, senão não fala com ninguém', () => {
    const f = flagsPorTier('advisor')
    expect(f).toContain('mcp__escritorio__dm')
    expect(f).toContain('mcp__escritorio__ask')
    expect(f).toContain('mcp__escritorio__roster')
  })

  it('editor e worktree aceitam edição', () => {
    expect(flagsPorTier('editor')).toEqual(['--permission-mode', 'acceptEdits'])
    expect(flagsPorTier('worktree')).toEqual(['--permission-mode', 'acceptEdits'])
  })
})

describe('montarSystemPrompt', () => {
  it('junta identidade e caderno', () => {
    const p = montarSystemPrompt({
      nome: 'especialista-deposito',
      agentFile: 'Você conhece o fluxo de depósito.',
      caderno: '- Período é numérico.',
    })
    expect(p).toContain('especialista-deposito')
    expect(p).toContain('Você conhece o fluxo de depósito.')
    expect(p).toContain('- Período é numérico.')
  })

  it('funciona sem caderno (primeiro dia do colega)', () => {
    const p = montarSystemPrompt({ nome: 'novato', agentFile: 'x', caderno: null })
    expect(p).toContain('novato')
    expect(p).not.toContain('caderno (o que você já aprendeu')
  })

  it('ignora arquivo vazio em vez de criar seção fantasma', () => {
    const p = montarSystemPrompt({ nome: 'x', agentFile: '   ', caderno: '' })
    expect(p).not.toContain('Quem você é')
  })
})
