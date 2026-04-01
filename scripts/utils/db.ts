import Database from 'better-sqlite3';
import { PATHS, ensureDataDir } from './paths.js';

export interface Company {
  id?: number;
  domain: string;
  name: string;
  website?: string;
  company_linkedin?: string;
  description?: string;
  city?: string;
  source?: string;
  ceo_first_name?: string;
  ceo_last_name?: string;
  ceo_title?: string;
  ceo_email?: string;
  ceo_linkedin?: string;
  employee_count?: number;
  industry?: string;
  hooks?: string; // JSON string
  match_type?: string;
  thesis_score?: number;
  thesis_reasoning?: string;
  email_subject?: string;
  email_body?: string;
  email_verified?: boolean;
  email_confidence?: number;
  sourced_date?: string;
  created_at?: string;
  last_updated?: string;
  status?: string;
}

export interface CompanyHooks {
  case_studies?: string[];
  testimonials?: string[];
  notable_customers?: string[];
  recent_news?: string[];
}

export type PipelineRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface PipelineRun {
  id?: number;
  skill_name: string;
  city: string;
  parameters?: Record<string, unknown>;
  company_limit: number;
  status: PipelineRunStatus;
  current_step: number;
  total_steps: number;
  current_step_name?: string;
  last_successful_step?: number;
  error_step?: number;
  company_count: number;
  started_at?: string;
  completed_at?: string;
  error_message?: string;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    ensureDataDir();
    db = new Database(PATHS.database);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema(): void {
  const database = getDb();

  database.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      website TEXT,
      company_linkedin TEXT,
      description TEXT,
      city TEXT,
      source TEXT,
      ceo_first_name TEXT,
      ceo_last_name TEXT,
      ceo_title TEXT,
      ceo_email TEXT,
      ceo_linkedin TEXT,
      employee_count INTEGER,
      industry TEXT,
      hooks TEXT,
      match_type TEXT,
      thesis_score INTEGER,
      thesis_reasoning TEXT,
      email_subject TEXT,
      email_body TEXT,
      email_verified BOOLEAN,
      email_confidence INTEGER,
      sourced_date DATE NOT NULL DEFAULT (date('now')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'new'
    );

    CREATE INDEX IF NOT EXISTS idx_domain ON companies(domain);
    CREATE INDEX IF NOT EXISTS idx_sourced_date ON companies(sourced_date);
    CREATE INDEX IF NOT EXISTS idx_created_at ON companies(created_at);
    CREATE INDEX IF NOT EXISTS idx_city ON companies(city);
    CREATE INDEX IF NOT EXISTS idx_match_type ON companies(match_type);

    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT NOT NULL DEFAULT 'lead-gen',
      city TEXT NOT NULL,
      parameters TEXT DEFAULT '{}',
      company_limit INTEGER DEFAULT 10,
      status TEXT NOT NULL DEFAULT 'pending',
      current_step INTEGER DEFAULT 0,
      total_steps INTEGER DEFAULT 12,
      current_step_name TEXT,
      last_successful_step INTEGER,
      error_step INTEGER,
      company_count INTEGER DEFAULT 0,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runs_started_at ON pipeline_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON pipeline_runs(status);
  `);
}

export function extractDomain(url: string): string {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
  }
}

export function isValidDomain(domain: string): boolean {
  if (domain.startsWith('#')) return false;
  if (!domain.includes('.')) return false;

  const nonCompanyDomains = [
    'list-manage.com', 'jotform.com', 'typeform.com', 'pitchbook.com',
    'cbre.com', 'crunchbase.com', 'mailchimp.com', 'hubspot.com',
    'googleforms.com', 'surveymonkey.com',
  ];
  return !nonCompanyDomains.some(d => domain.includes(d));
}

export function companyExists(domain: string): boolean {
  const database = getDb();
  const stmt = database.prepare('SELECT 1 FROM companies WHERE domain = ?');
  return stmt.get(domain) !== undefined;
}

export function getExistingDomains(): Set<string> {
  const database = getDb();
  const stmt = database.prepare('SELECT domain FROM companies');
  const rows = stmt.all() as { domain: string }[];
  return new Set(rows.map(r => r.domain));
}

export function upsertCompany(company: Company): number {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO companies (
      domain, name, website, company_linkedin, description, city, source,
      ceo_first_name, ceo_last_name, ceo_title, ceo_email, ceo_linkedin,
      employee_count, industry, hooks, match_type, thesis_score, thesis_reasoning,
      email_subject, email_body, email_verified, email_confidence,
      sourced_date, status
    ) VALUES (
      @domain, @name, @website, @company_linkedin, @description, @city, @source,
      @ceo_first_name, @ceo_last_name, @ceo_title, @ceo_email, @ceo_linkedin,
      @employee_count, @industry, @hooks, @match_type, @thesis_score, @thesis_reasoning,
      @email_subject, @email_body, @email_verified, @email_confidence,
      date('now'), @status
    )
    ON CONFLICT(domain) DO UPDATE SET
      name = excluded.name,
      website = COALESCE(excluded.website, companies.website),
      company_linkedin = COALESCE(excluded.company_linkedin, companies.company_linkedin),
      description = COALESCE(excluded.description, companies.description),
      city = COALESCE(excluded.city, companies.city),
      source = COALESCE(excluded.source, companies.source),
      ceo_first_name = COALESCE(excluded.ceo_first_name, companies.ceo_first_name),
      ceo_last_name = COALESCE(excluded.ceo_last_name, companies.ceo_last_name),
      ceo_title = COALESCE(excluded.ceo_title, companies.ceo_title),
      ceo_email = COALESCE(excluded.ceo_email, companies.ceo_email),
      ceo_linkedin = COALESCE(excluded.ceo_linkedin, companies.ceo_linkedin),
      employee_count = COALESCE(excluded.employee_count, companies.employee_count),
      industry = COALESCE(excluded.industry, companies.industry),
      hooks = COALESCE(excluded.hooks, companies.hooks),
      match_type = COALESCE(excluded.match_type, companies.match_type),
      thesis_score = COALESCE(excluded.thesis_score, companies.thesis_score),
      thesis_reasoning = COALESCE(excluded.thesis_reasoning, companies.thesis_reasoning),
      email_subject = COALESCE(excluded.email_subject, companies.email_subject),
      email_body = COALESCE(excluded.email_body, companies.email_body),
      email_verified = COALESCE(excluded.email_verified, companies.email_verified),
      email_confidence = COALESCE(excluded.email_confidence, companies.email_confidence),
      last_updated = CURRENT_TIMESTAMP
  `);

  const emailVerified = company.email_verified === undefined || company.email_verified === null
    ? null
    : company.email_verified ? 1 : 0;

  const result = stmt.run({
    domain: company.domain,
    name: company.name,
    website: company.website ?? null,
    company_linkedin: company.company_linkedin ?? null,
    description: company.description ?? null,
    city: company.city ?? null,
    source: company.source ?? null,
    ceo_first_name: company.ceo_first_name ?? null,
    ceo_last_name: company.ceo_last_name ?? null,
    ceo_title: company.ceo_title ?? null,
    ceo_email: company.ceo_email ?? null,
    ceo_linkedin: company.ceo_linkedin ?? null,
    employee_count: company.employee_count ?? null,
    industry: company.industry ?? null,
    hooks: company.hooks ?? null,
    match_type: company.match_type ?? null,
    thesis_score: company.thesis_score ?? null,
    thesis_reasoning: company.thesis_reasoning ?? null,
    email_subject: company.email_subject ?? null,
    email_body: company.email_body ?? null,
    email_verified: emailVerified,
    email_confidence: company.email_confidence ?? null,
    status: company.status ?? 'new',
  });

  return result.lastInsertRowid as number;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Pipeline Run functions

export function createPipelineRun(
  city: string,
  options: { limit?: number; skillName?: string } = {}
): number {
  const database = getDb();
  const { limit = 10, skillName = 'lead-gen' } = options;
  const parameters = JSON.stringify({ city, limit });

  const stmt = database.prepare(`
    INSERT INTO pipeline_runs (skill_name, city, parameters, company_limit, status, current_step, total_steps)
    VALUES (?, ?, ?, ?, 'pending', 0, 12)
  `);
  const result = stmt.run(skillName, city, parameters, limit);
  return result.lastInsertRowid as number;
}

export function getPipelineRun(id: number): PipelineRun | undefined {
  const database = getDb();
  const stmt = database.prepare('SELECT * FROM pipeline_runs WHERE id = ?');
  return stmt.get(id) as PipelineRun | undefined;
}

export function updatePipelineRunStatus(
  id: number,
  status: PipelineRunStatus,
  errorMessage?: string
): void {
  const database = getDb();
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    const stmt = database.prepare(`
      UPDATE pipeline_runs
      SET status = ?, error_message = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    stmt.run(status, errorMessage ?? null, id);
  } else {
    const stmt = database.prepare('UPDATE pipeline_runs SET status = ? WHERE id = ?');
    stmt.run(status, id);
  }
}

export function updatePipelineRunStep(
  id: number,
  step: number,
  stepName: string
): void {
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE pipeline_runs
    SET current_step = ?, current_step_name = ?, status = 'running'
    WHERE id = ?
  `);
  stmt.run(step, stepName, id);
}

export function completePipelineRunStep(id: number, step: number): void {
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE pipeline_runs
    SET last_successful_step = ?, current_step = ?
    WHERE id = ?
  `);
  stmt.run(step, step, id);
}

export function failPipelineRunStep(
  id: number,
  step: number,
  errorMessage: string
): void {
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE pipeline_runs
    SET status = 'failed', error_step = ?, error_message = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  stmt.run(step, errorMessage, id);
}

export function getIncompletePipelineRuns(): PipelineRun[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM pipeline_runs
    WHERE status IN ('pending', 'running', 'failed')
    ORDER BY started_at DESC
  `);
  return stmt.all() as PipelineRun[];
}

export function updatePipelineRunCompanyCount(id: number, count: number): void {
  const database = getDb();
  const stmt = database.prepare('UPDATE pipeline_runs SET company_count = ? WHERE id = ?');
  stmt.run(count, id);
}

export function getCompaniesCount(): number {
  const database = getDb();
  const stmt = database.prepare('SELECT COUNT(*) as count FROM companies');
  const result = stmt.get() as { count: number };
  return result.count;
}
