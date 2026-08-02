import { basename } from 'node:path'
import { userInfo } from 'node:os'

/**
 * Quem esta sessão é no escritório.
 *
 * ESCRITORIO_ID quando declarado (caso do colega acordado e do .mcp.json por projeto).
 * Sem ele, uma sessão interativa comum ainda precisa de nome — deriva de usuário@pasta,
 * que é estável por projeto e legível pra quem for endereçar.
 */
export function identidade(cwd = process.cwd()): string {
  const declarada = process.env.ESCRITORIO_ID?.trim()
  if (declarada) return declarada
  return `${userInfo().username}@${basename(cwd) || 'raiz'}`
}
