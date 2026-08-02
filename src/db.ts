import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export type Db = Database.Database

export function caminhoPadraoDb(): string {
  return process.env.ESCRITORIO_DB ?? join(homedir(), '.escritorio', 'escritorio.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id           TEXT PRIMARY KEY,
  assunto      TEXT NOT NULL,
  dono         TEXT NOT NULL,
  hops         INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'aberta',
  created_at   TEXT NOT NULL,
  closed_at    TEXT
);

CREATE TABLE IF NOT EXISTS participantes (
  thread_id TEXT NOT NULL,
  colega    TEXT NOT NULL,
  PRIMARY KEY (thread_id, colega)
);

CREATE TABLE IF NOT EXISTS mensagens (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  de         TEXT NOT NULL,
  para       TEXT NOT NULL,
  tipo       TEXT NOT NULL,
  conteudo   TEXT NOT NULL,
  reply_to   TEXT,
  lida       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_para ON mensagens (para, lida);
CREATE INDEX IF NOT EXISTS idx_msg_reply ON mensagens (reply_to);

CREATE TABLE IF NOT EXISTS board (
  chave      TEXT PRIMARY KEY,
  valor      TEXT NOT NULL,
  autor      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id          TEXT PRIMARY KEY,
  recurso     TEXT NOT NULL,
  dono        TEXT NOT NULL,
  intencao    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ativo',
  created_at  TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_claim_recurso ON claims (recurso, status);

CREATE TABLE IF NOT EXISTS sessoes_colega (
  thread_id  TEXT NOT NULL,
  colega     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, colega)
);

CREATE TABLE IF NOT EXISTS presenca (
  colega    TEXT PRIMARY KEY,
  visto_em  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auditoria (
  id         TEXT PRIMARY KEY,
  acao       TEXT NOT NULL,
  ator       TEXT NOT NULL,
  detalhe    TEXT,
  created_at TEXT NOT NULL
);
`

export function abrirDb(caminho = caminhoPadraoDb()): Db {
  if (caminho !== ':memory:') mkdirSync(dirname(caminho), { recursive: true })
  const db = new Database(caminho)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.exec(SCHEMA)
  return db
}
