import { describe, it, expect } from 'vitest'

process.env.ESCRITORIO_SEM_MAIN = '1'
const { aplicar, desaplicar } = await import('../scripts/instalar.mjs')

const OPTS = {
  workspace: '/ws',
  roster: '/ws/roster.yaml',
  servidor: '/app/escritorio/dist/server.js',
  comandoHook: 'node /app/escritorio/dist/hook.js 2>/dev/null || true',
}

const hooksExistentes = {
  hooks: {
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'bash ~/.claude/sync.sh' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash rtk.sh' }] }],
  },
}

describe('aplicar', () => {
  it('registra env e hooks nos dois eventos', () => {
    const s = aplicar({}, OPTS)
    expect(s.env.ESCRITORIO_WORKSPACE).toBe('/ws')
    expect(s.env.ESCRITORIO_ROSTER).toBe('/ws/roster.yaml')
    expect(Object.keys(s.hooks).sort()).toEqual(['PostToolBatch', 'Stop'])
  })

  it('NÃO escreve mcpServers — settings.json não registra MCP no Claude Code', () => {
    expect(aplicar({}, OPTS).mcpServers).toBeUndefined()
  })

  it('limpa mcpServers.escritorio deixado por versão anterior', () => {
    const s = aplicar({ mcpServers: { escritorio: { command: 'node' } } }, OPTS)
    expect(s.mcpServers).toBeUndefined()
  })

  it('NÃO apaga hooks que já existiam', () => {
    const s = aplicar(hooksExistentes, OPTS)
    const comandosStop = s.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command))
    expect(comandosStop).toContain('bash ~/.claude/sync.sh')
    expect(comandosStop).toContain(OPTS.comandoHook)
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('bash rtk.sh')
  })

  it('rodar duas vezes não duplica o hook', () => {
    const s = aplicar(aplicar(hooksExistentes, OPTS), OPTS)
    const nossos = s.hooks.Stop.flatMap((g: any) => g.hooks).filter((h: any) =>
      h.command.includes('escritorio/dist/hook.js'),
    )
    expect(nossos).toHaveLength(1)
  })

  it('preserva outras chaves das settings', () => {
    const s = aplicar({ model: 'opus', enabledPlugins: { x: true } }, OPTS)
    expect(s.model).toBe('opus')
    expect(s.enabledPlugins).toEqual({ x: true })
  })

  it('preserva outros mcpServers que por acaso existam ali', () => {
    const s = aplicar({ mcpServers: { context7: { command: 'npx' } } }, OPTS)
    expect(s.mcpServers.context7).toEqual({ command: 'npx' })
  })
})

describe('desaplicar', () => {
  it('remove tudo que instalamos', () => {
    const s = desaplicar(aplicar({}, OPTS))
    expect(s.mcpServers).toBeUndefined()
    expect(s.env).toBeUndefined()
    expect(s.hooks).toBeUndefined()
  })

  it('devolve as settings ao estado original quando havia outras coisas', () => {
    const original = { model: 'opus', ...structuredClone(hooksExistentes) }
    const voltou = desaplicar(aplicar(original, OPTS))
    expect(voltou).toEqual(original)
  })

  it('é idempotente em settings que nunca tiveram escritório', () => {
    const original = structuredClone(hooksExistentes)
    expect(desaplicar(original)).toEqual(original)
  })
})
