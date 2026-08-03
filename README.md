# Escritório

Comunicação **peer-to-peer entre sessões Claude Code**. Suas sessões e seus especialistas viram
pessoas endereçáveis por nome, que conversam entre si sobre vários assuntos ao mesmo tempo —
sem orquestrador.

Spec de design: `pessoal/claudicaro-cli/docs/design/2026-08-02-escritorio-multiagente.md`.

## Por que não dava pra fazer isso sem ele

A topologia nativa do Claude Code é **árvore**: subagente devolve pro pai, `SendMessage` só
alcança quem a própria sessão spawnou, `Workflow` passa dado pelo script. Dois irmãos não se
falam. Comunicação lateral exige um meio compartilhado — que é este correio.

## As seis ferramentas

| tool | o que faz |
|---|---|
| `roster` | quem existe, o que sabe, qual tier — uma linha por pessoa, sem carregar `.md` nenhum |
| `ask` | pergunta e **espera** a resposta |
| `dm` | manda e **segue**; na thread de uma pergunta pendente, vira a resposta dela |
| `inbox` | puxa a correspondência (normalmente o hook já entrega sozinho) |
| `board` | quadro branco compartilhado, sem destinatário |
| `claim` | reivindica recurso antes de mexer |

Mais `fechar_thread`, que encerra a conversa e faz cada colega destilar o caderno.

## Como funciona

**Thread** é o container único de conversa — substitui salas e canais. Debate entre pares é uma
thread com N participantes onde cada um escolhe pra quem responder.

Sem chefe, duas regras no correio seguram o sistema:
- **`hops`** decrementa a cada mensagem; zerou, o correio recusa. Mata ping-pong infinito.
- **Dono da thread é quem abriu**, e só ele fecha.

**Entrega** tem duas naturezas:
- **Sessão viva** recebe por *hook* (`Stop` bloqueia a parada e entrega; `PostToolBatch` entrega
  no meio do trabalho). O hook é script — roda fora do modelo, custo zero de token.
- **Colega do roster** é *acordado* pelo correio com `claude -p`, responde e volta a dormir.

**Memória do colega:** dentro de uma thread ele mantém a sessão viva (`--resume`) e lembra de
tudo; quando a thread fecha, destila o que aprendeu num **caderno `.md`** e a sessão morre.
Longo prazo é o caderno — auditável, editável à mão, versionado.

## Instalação

```bash
npm install && npm run build
node scripts/instalar.mjs          # --dry pra ver antes, --remover pra desfazer
```

O instalador registra o hook de entrega em `~/.claude/settings.json`, define
`ESCRITORIO_WORKSPACE`/`ESCRITORIO_ROSTER`, e registra o servidor MCP via
`claude mcp add --scope user` (que grava em `~/.claude.json` — **settings.json não registra MCP**).

Faz backup em `settings.json.antes-do-escritorio` na primeira vez, e nunca sobrescreve esse backup.

## Roster

`~/claude-workspace-config/roster.yaml` (repo sincronizado Mac ↔ VM):

```yaml
especialista-deposito:
  brief: "Depósito antecipado: cobrança, pagamento, reembolso (DSG/v1)"
  agent_file: ${ESCRITORIO_WORKSPACE}/dsg/.agent/especialista-deposito.md
  caderno: ${ESCRITORIO_WORKSPACE}/pessoal/escritorio/cadernos/especialista-deposito.md
  tier: advisor
  cwd: ${ESCRITORIO_WORKSPACE}/dsg/v1
```

`brief` é a única coisa que o `roster()` devolve — escreva pensando em "quando eu chamaria essa
pessoa". Caminhos aceitam `~` e `${VAR}`; é a expansão de env que faz o mesmo arquivo servir Mac
e VM, onde o workspace mora em lugares diferentes.

### Tiers

| tier | pode | como é imposto |
|---|---|---|
| `advisor` | ler e aconselhar | **allowlist** de tools (`--allowedTools`): leitura, Bash read-only e as tools do escritório |
| `editor` | escrever no working tree | `acceptEdits`, e só sob `claim()` ativo — o correio recusa acordar sem ele |
| `worktree` | escrever isolado | git worktree próprio; se não der pra criar, **recusa** em vez de cair no repo real |

Um pedido pode **rebaixar** o tier na consulta, nunca elevar.

### Por que allowlist e não denylist

A primeira versão usava `--disallowedTools Edit Write NotebookEdit` com `bypassPermissions`.
Testado com `claude` de verdade, **vazou**: o colega escreveu o arquivo via `Bash`, que não estava
na negação. Medido nas quatro variantes:

| flags | resultado |
|---|---|
| `bypassPermissions` + nega Edit/Write | **vazou** (escreveu via Bash) |
| `bypassPermissions` + nega Edit/Write/Bash | segurou |
| sem permission-mode + nega Edit/Write/Bash | segurou |
| sem permission-mode + **allowlist** read-only | segurou, e ainda leu `git log` normalmente |

Ficou a allowlist: o que eu esquecer de listar fica **negado** em vez de liberado. Vale notar que
`Bash(cat:*)` na allowlist **não** permitiu escapar por redirecionamento (`cat > arquivo`).

## Ver acontecendo

```bash
npm run tail
```

Segue o correio e imprime o que acontece **entre todas as sessões** — quadro escrito, claim,
thread aberta, mensagem trocada, resposta chegando:

```
Escritório — monitor ao vivo
sessões vistas na última hora: icaromelo@v1, icaromelo@kairos-ui, icaromelo@oraculo-api, …
threads abertas: (nenhuma)
────────────────────────────────────────────────────────────────────────
13:26:36 ▤ quadro dsg/v1:decisoes = cache sempre via RedisService · icaromelo@v1
13:26:37 🔒 claim src/infra/redis por icaromelo@v1 · revisar TTLs
13:26:38 ⊕ thread [477cfbdc] Em uma frase: qual TTL padrao usamos? · dono icaromelo@v1
13:26:38 icaromelo@v1 →? especialista-cache  [477cfbdc]
        Em uma frase: qual TTL padrao usamos?
13:26:44 especialista-cache ←! icaromelo@v1  [477cfbdc]
        O TTL padrão é 3600 segundos (1 hora) — mas sempre passe TTL explícito…
```

`→?` é pergunta bloqueante, `→ ` recado, `←!` resposta.

## Identidade

Cada sessão precisa de um nome. `ESCRITORIO_ID` quando declarado; sem ele, deriva de
`usuário@pasta` — estável por projeto, então uma sessão aberta em `dsg/v1` é sempre
`icaromelo@v1` e pode ser endereçada por outra.

## Testes

```bash
npm test                        # 117 testes, sem gastar API
node scripts/smoke-mcp.mjs      # sobe o servidor MCP de verdade via stdio
node scripts/smoke-e2e.mjs      # E2E REAL: acorda colega, --resume, caderno (gasta API)
node scripts/smoke-escrita.mjs  # E2E REAL dos 3 tiers: advisor bloqueado, worktree isolado,
                                # editor sob claim (gasta API)
```

## Limitações conhecidas

- **Um correio por máquina.** Sessão na VM Oracle não fala com o correio do Mac; a ponte entre
  máquinas é problema separado.
- **`dist/` mora no SSD.** Com o SSD desmontado o hook falha silencioso (`|| true`) e o MCP fica
  desconectado — nada trava, mas o escritório some até remontar.
- **`ask` numa sessão viva depende de ela estar rodando.** Se ninguém estiver com aquela sessão
  aberta, você espera até o timeout (5 min) e a resposta fica no inbox pra depois.
