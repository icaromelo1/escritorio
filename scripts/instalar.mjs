/**
 * Liga o Escritório no Claude Code deste usuário:
 *   - registra o servidor MCP em ~/.claude/settings.json
 *   - registra o hook de entrega (Stop + PostToolBatch)
 *   - define ESCRITORIO_WORKSPACE e ESCRITORIO_ROSTER
 *
 *   node scripts/instalar.mjs           aplica (faz backup antes)
 *   node scripts/instalar.mjs --dry     só mostra o que mudaria
 *   node scripts/instalar.mjs --remover desfaz
 *   SETTINGS=/caminho/settings.json     opera em outro arquivo (usado pelos testes)
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const RAIZ = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const SETTINGS = process.env.SETTINGS ?? join(homedir(), '.claude', 'settings.json')
const dry = process.argv.includes('--dry')
const remover = process.argv.includes('--remover')

// `|| true` porque o dist pode viver num disco removível: sem ele, SSD desmontado
// viraria erro de hook em toda parada de sessão.
const COMANDO_HOOK = `node ${RAIZ}/dist/hook.js 2>/dev/null || true`
const SERVIDOR = `${RAIZ}/dist/server.js`

export function detectarWorkspace() {
  const candidatos = [
    process.env.ESCRITORIO_WORKSPACE,
    '/Volumes/icaro_ssd/projetos',
    join(homedir(), 'projetos'),
  ].filter(Boolean)
  return candidatos.find((c) => existsSync(c)) ?? homedir()
}

/** Puro: recebe as settings atuais, devolve as novas. É o que o teste verifica. */
export function aplicar(settings, opts) {
  const s = structuredClone(settings)

  s.env = { ...(s.env ?? {}) }
  s.env.ESCRITORIO_WORKSPACE = opts.workspace
  s.env.ESCRITORIO_ROSTER = opts.roster

  // O servidor MCP NÃO vai aqui: settings.json não registra MCP no Claude Code.
  // Quem registra é `claude mcp add --scope user` (grava em ~/.claude.json).
  if (s.mcpServers?.escritorio) {
    s.mcpServers = { ...s.mcpServers }
    delete s.mcpServers.escritorio
    if (Object.keys(s.mcpServers).length === 0) delete s.mcpServers
  }

  s.hooks = { ...(s.hooks ?? {}) }
  for (const evento of ['Stop', 'PostToolBatch']) {
    const grupos = (s.hooks[evento] ?? []).map((g) => ({
      ...g,
      hooks: (g.hooks ?? []).filter((h) => !ehNosso(h)),
    }))
    grupos.push({ matcher: '', hooks: [{ type: 'command', command: opts.comandoHook }] })
    s.hooks[evento] = grupos.filter((g) => g.hooks.length > 0)
  }

  return s
}

/** Puro: desfaz tudo que `aplicar` fez, sem tocar no resto. */
export function desaplicar(settings) {
  const s = structuredClone(settings)

  if (s.env) {
    delete s.env.ESCRITORIO_WORKSPACE
    delete s.env.ESCRITORIO_ROSTER
    if (Object.keys(s.env).length === 0) delete s.env
  }
  if (s.mcpServers) {
    delete s.mcpServers.escritorio
    if (Object.keys(s.mcpServers).length === 0) delete s.mcpServers
  }
  if (s.hooks) {
    for (const evento of Object.keys(s.hooks)) {
      s.hooks[evento] = (s.hooks[evento] ?? [])
        .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ehNosso(h)) }))
        .filter((g) => g.hooks.length > 0)
      if (s.hooks[evento].length === 0) delete s.hooks[evento]
    }
    if (Object.keys(s.hooks).length === 0) delete s.hooks
  }

  return s
}

function ehNosso(hook) {
  return typeof hook?.command === 'string' && hook.command.includes('escritorio/dist/hook.js')
}

if (!process.env.ESCRITORIO_SEM_MAIN) {
  const atual = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {}
  const workspace = detectarWorkspace()

  const novo = remover
    ? desaplicar(atual)
    : aplicar(atual, {
        workspace,
        roster: join(homedir(), 'claude-workspace-config', 'roster.yaml'),
        servidor: SERVIDOR,
        comandoHook: COMANDO_HOOK,
      })

  if (dry) {
    console.log(JSON.stringify(novo, null, 2))
  } else {
    const backup = `${SETTINGS}.antes-do-escritorio`
    // nunca sobrescreve: o backup só vale se for o estado ANTES da primeira instalação
    if (existsSync(SETTINGS) && !existsSync(backup)) {
      copyFileSync(SETTINGS, backup)
      console.log(`backup: ${backup}`)
    }
    writeFileSync(SETTINGS, JSON.stringify(novo, null, 2) + '\n', 'utf8')
    console.log(remover ? `escritório removido de ${SETTINGS}` : `escritório instalado em ${SETTINGS}`)

    try {
      if (remover) {
        execFileSync('claude', ['mcp', 'remove', '--scope', 'user', 'escritorio'], {
          stdio: 'pipe',
        })
        console.log('servidor MCP removido')
      } else {
        execFileSync(
          'claude',
          ['mcp', 'add', '--scope', 'user', 'escritorio', '--', 'node', SERVIDOR],
          { stdio: 'pipe' },
        )
        console.log('servidor MCP registrado (~/.claude.json)')
      }
    } catch (e) {
      console.log(
        `aviso: registre o MCP à mão — claude mcp add --scope user escritorio -- node ${SERVIDOR}`,
      )
    }

    if (!remover) console.log(`workspace detectado: ${workspace}`)
  }
}
