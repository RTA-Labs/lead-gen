#!/usr/bin/env npx tsx
/**
 * lead-gen readiness check.
 * Usage: npx tsx scripts/status.ts
 *
 * Checks workspace, API keys, Playwright, config files, KB stats, and recent runs.
 * Exit code: 0 if ready, 1 if critical issues.
 */
import fs from 'fs';
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
import {
  getWorkspaceHome,
  getEnvPath,
  getSkillDataDir,
  getSkillConfigDir,
  isWorkspaceInitialized,
  PATHS,
} from './utils/paths.js';

// Load .env from workspace
const envPath = getEnvPath();
if (fs.existsSync(envPath)) {
  dotenvConfig({ path: envPath });
}

const workspaceHome = getWorkspaceHome();
const configDir = getSkillConfigDir();
const dataDir = getSkillDataDir();

let criticalIssues = 0;

function ok(label: string, msg: string) {
  console.log(`  [OK]   ${label}: ${msg}`);
}

function warn(label: string, msg: string) {
  console.log(`  [WARN] ${label}: ${msg}`);
}

function fail(label: string, msg: string) {
  console.log(`  [FAIL] ${label}: ${msg}`);
  criticalIssues++;
}

console.log('\nlead-gen Status\n');
console.log(`  Workspace: ${workspaceHome}`);
console.log('');

// --- Workspace initialized ---
if (isWorkspaceInitialized()) {
  ok('Workspace', 'initialized');
} else {
  fail('Workspace', `not found at ${workspaceHome} — run: npx tsx scripts/init.ts`);
}

// --- .env file and API keys ---
if (fs.existsSync(envPath)) {
  ok('.env', 'found');
  const envContent = fs.readFileSync(envPath, 'utf-8');

  for (const key of ['APOLLO_API_KEY', 'NORBERT_API_KEY']) {
    const match = envContent.match(new RegExp(`^${key}=(.+)$`, 'm'));
    const envVal = process.env[key];
    if ((match && match[1].trim()) || envVal) {
      ok(key, 'set');
    } else {
      fail(key, `not set — edit ${envPath}`);
    }
  }

  const openaiMatch = envContent.match(/^OPENAI_API_KEY=(.+)$/m);
  if ((openaiMatch && openaiMatch[1].trim()) || process.env.OPENAI_API_KEY) {
    ok('OPENAI_API_KEY', 'set');
  } else {
    warn('OPENAI_API_KEY', 'not set — required if using OpenAI for embeddings');
  }
} else {
  fail('.env', `not found — run: npx tsx scripts/init.ts`);
}

// --- Playwright Chromium ---
try {
  const { chromium } = await import('playwright');
  const executablePath = chromium.executablePath();
  if (fs.existsSync(executablePath)) {
    ok('Playwright Chromium', 'installed');
  } else {
    fail('Playwright Chromium', `not found at ${executablePath} — run: npx playwright install chromium`);
  }
} catch {
  fail('Playwright Chromium', 'playwright not importable — run: npx playwright install chromium');
}

// --- Config files ---
const configFiles: Array<{ file: string; critical: boolean }> = [
  { file: 'thesis.md', critical: true },
  { file: 'email-template.md', critical: true },
  { file: 'filters.md', critical: false },
];

for (const { file, critical } of configFiles) {
  const p = path.join(configDir, file);
  if (fs.existsSync(p)) {
    ok(`config/${file}`, 'present');
  } else {
    if (critical) {
      fail(`config/${file}`, `missing — run: npx tsx scripts/init.ts`);
    } else {
      warn(`config/${file}`, `missing — run: npx tsx scripts/init.ts`);
    }
  }
}

// --- KB status ---
console.log('');
if (fs.existsSync(PATHS.kbDatabase)) {
  try {
    const Database = (await import('better-sqlite3')).default;
    const sqliteVec = await import('sqlite-vec');
    const db = new Database(PATHS.kbDatabase);
    sqliteVec.load(db);

    const total = (db.prepare('SELECT COUNT(*) as c FROM kb_leads').get() as { c: number }).c;
    const good = (db.prepare("SELECT COUNT(*) as c FROM kb_leads WHERE classification = 'good'").get() as { c: number }).c;
    const bad = (db.prepare("SELECT COUNT(*) as c FROM kb_leads WHERE classification = 'bad'").get() as { c: number }).c;
    const embedded = (db.prepare('SELECT COUNT(*) as c FROM kb_leads WHERE embedded_at IS NOT NULL').get() as { c: number }).c;
    const unembedded = total - embedded;

    ok('KB (kb.db)', `${total} leads — ${good} good, ${bad} bad, ${unembedded} unembedded`);
    db.close();
  } catch (err) {
    warn('KB (kb.db)', `found but could not read: ${(err as Error).message}`);
  }
} else {
  warn('KB (kb.db)', 'not found — import leads with: npx tsx scripts/kb-import.ts --good <file> --bad <file>');
}

// --- Recent pipeline runs ---
console.log('');
if (fs.existsSync(PATHS.database)) {
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(PATHS.database);

    const runs = db.prepare(`
      SELECT id, city, status, company_count, started_at, completed_at, error_message
      FROM pipeline_runs
      ORDER BY started_at DESC
      LIMIT 3
    `).all() as Array<{
      id: number;
      city: string;
      status: string;
      company_count: number;
      started_at: string;
      completed_at: string | null;
      error_message: string | null;
    }>;

    if (runs.length > 0) {
      console.log('  Recent pipeline runs:');
      for (const run of runs) {
        const date = run.started_at ? run.started_at.slice(0, 16) : '?';
        const extra = run.status === 'failed' && run.error_message
          ? ` — ${run.error_message.slice(0, 60)}`
          : '';
        console.log(`    Run #${run.id} [${run.status}] ${run.city} | ${run.company_count} companies | ${date}${extra}`);
      }
    } else {
      console.log('  Recent pipeline runs: none');
    }
    db.close();
  } catch (err) {
    warn('Pipeline runs', `could not read: ${(err as Error).message}`);
  }
} else {
  console.log('  Recent pipeline runs: no database yet');
}

console.log('');
if (criticalIssues === 0) {
  console.log('  Ready to run lead-gen pipeline.\n');
  process.exit(0);
} else {
  console.log(`  ${criticalIssues} critical issue(s) found. Resolve them before running the pipeline.\n`);
  process.exit(1);
}
