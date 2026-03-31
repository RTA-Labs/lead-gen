import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { PATHS, ensureDataDir } from './paths.js';
import type { EmbedProvider } from './embeddings.js';

export interface KbLead {
  id?: number;
  company_name: string;
  email_domain?: string;
  description?: string;
  call_notes?: string;
  classification: 'good' | 'bad';
  embed_text?: string;
  embedded_at?: string;
  created_at?: string;
}

export interface KbNeighbor {
  id: number;
  company_name: string;
  email_domain?: string;
  classification: 'good' | 'bad';
  distance: number;
}

export interface KbStats {
  total: number;
  good: number;
  bad: number;
  embedded: number;
  unembedded: number;
}

let kbDb: Database.Database | null = null;

export function getKbDb(): Database.Database {
  if (!kbDb) {
    ensureDataDir();
    kbDb = new Database(PATHS.kbDatabase);
    sqliteVec.load(kbDb);
    kbDb.pragma('journal_mode = WAL');
    initKbSchema();
  }
  return kbDb;
}

function initKbSchema(): void {
  const db = getKbDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name TEXT NOT NULL,
      email_domain TEXT,
      description TEXT,
      call_notes TEXT,
      classification TEXT NOT NULL CHECK(classification IN ('good', 'bad')),
      embed_text TEXT,
      embedded_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_domain
      ON kb_leads(email_domain) WHERE email_domain IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_kb_classification ON kb_leads(classification);
  `);

  const vecTableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kb_embeddings'"
  ).get();

  if (!vecTableExists) {
    db.exec(`
      CREATE VIRTUAL TABLE kb_embeddings USING vec0(
        embedding float[768]
      );
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS import_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      classification TEXT NOT NULL,
      total_rows INTEGER NOT NULL,
      processed_rows INTEGER DEFAULT 0,
      embedded_rows INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP
    );
  `);
}

export function insertLead(lead: KbLead): number {
  const db = getKbDb();
  const stmt = db.prepare(`
    INSERT INTO kb_leads (company_name, email_domain, description, call_notes, classification, embed_text)
    VALUES (@company_name, @email_domain, @description, @call_notes, @classification, @embed_text)
  `);

  const result = stmt.run({
    company_name: lead.company_name,
    email_domain: lead.email_domain ?? null,
    description: lead.description ?? null,
    call_notes: lead.call_notes ?? null,
    classification: lead.classification,
    embed_text: lead.embed_text ?? null,
  });

  return result.lastInsertRowid as number;
}

export function insertLeadIfNew(lead: KbLead): number | null {
  const db = getKbDb();

  if (lead.email_domain) {
    const existing = db.prepare('SELECT id FROM kb_leads WHERE email_domain = ?').get(lead.email_domain) as { id: number } | undefined;
    if (existing) return null;
  }

  return insertLead(lead);
}

export function insertEmbedding(leadId: number, vector: Buffer): void {
  const db = getKbDb();
  db.prepare('INSERT INTO kb_embeddings (rowid, embedding) VALUES (?, ?)').run(BigInt(leadId), vector);
}

export function markEmbedded(leadId: number): void {
  const db = getKbDb();
  db.prepare("UPDATE kb_leads SET embedded_at = datetime('now') WHERE id = ?").run(leadId);
}

export function queryKNN(vector: Buffer, k: number = 20): KbNeighbor[] {
  const db = getKbDb();
  const rows = db.prepare(`
    SELECT l.id, l.company_name, l.email_domain, l.classification, e.distance
    FROM kb_embeddings e
    JOIN kb_leads l ON l.id = e.rowid
    WHERE e.embedding MATCH ?
      AND k = ?
    ORDER BY e.distance
  `).all(vector, k) as KbNeighbor[];

  return rows;
}

export function getUnembeddedLeads(batchSize: number = 100): KbLead[] {
  const db = getKbDb();
  return db.prepare(`
    SELECT * FROM kb_leads
    WHERE embedded_at IS NULL
    ORDER BY id
    LIMIT ?
  `).all(batchSize) as KbLead[];
}

export function getUnembeddedCount(): number {
  const db = getKbDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM kb_leads WHERE embedded_at IS NULL').get() as { count: number };
  return row.count;
}

export function getKbStats(): KbStats {
  const db = getKbDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM kb_leads').get() as { c: number }).c;
  const good = (db.prepare("SELECT COUNT(*) as c FROM kb_leads WHERE classification = 'good'").get() as { c: number }).c;
  const bad = (db.prepare("SELECT COUNT(*) as c FROM kb_leads WHERE classification = 'bad'").get() as { c: number }).c;
  const embedded = (db.prepare('SELECT COUNT(*) as c FROM kb_leads WHERE embedded_at IS NOT NULL').get() as { c: number }).c;

  return { total, good, bad, embedded, unembedded: total - embedded };
}

export function getLeadByDomain(domain: string): KbLead | undefined {
  const db = getKbDb();
  return db.prepare('SELECT * FROM kb_leads WHERE email_domain = ?').get(domain) as KbLead | undefined;
}

export function getLeadEmbedding(leadId: number): Buffer | undefined {
  const db = getKbDb();
  const row = db.prepare('SELECT embedding FROM kb_embeddings WHERE rowid = ?').get(BigInt(leadId)) as { embedding: Buffer } | undefined;
  return row?.embedding;
}

export function getKbMeta(key: string): string | undefined {
  const db = getKbDb();
  const row = db.prepare('SELECT value FROM kb_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setKbMeta(key: string, value: string): void {
  const db = getKbDb();
  db.prepare('INSERT OR REPLACE INTO kb_meta (key, value) VALUES (?, ?)').run(key, value);
}

export function getKbProvider(): EmbedProvider | undefined {
  const val = getKbMeta('embed_provider');
  if (val === 'ollama' || val === 'openai') return val;
  return undefined;
}

export function setKbProvider(provider: EmbedProvider): void {
  setKbMeta('embed_provider', provider);
}

export function ensureProviderConsistency(provider: EmbedProvider): void {
  const stored = getKbProvider();
  if (!stored) {
    setKbProvider(provider);
    return;
  }
  if (stored !== provider) {
    console.warn(
      `\n  WARNING: This KB was built with provider "${stored}" but you're using "${provider}".\n` +
      `  Mixing embedding providers produces garbage KNN results.\n` +
      `  To switch providers, re-import the KB from scratch.\n`
    );
  }
}

export function closeKbDb(): void {
  if (kbDb) {
    kbDb.close();
    kbDb = null;
  }
}
