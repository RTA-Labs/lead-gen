#!/usr/bin/env npx tsx
/**
 * export.ts — Step 12: SQLite + CSV export of the final verified pipeline results.
 *
 * Upserts all verified companies into the SQLite database and writes
 * a CSV file to the output directory.
 *
 * Usage:
 *   export.ts --input 11-verified.json
 *   export.ts --input 11-verified.json --run-id 42
 *
 * Output:
 *   <dataDir>/deals.db      (upserted)
 *   <outputDir>/leads-<date>.csv
 */

import fs from 'fs';
import path from 'path';
import { upsertCompany, closeDb } from './utils/db.js';
import type { Company } from './utils/db.js';
import { getSkillOutputDir, getRunOutputDir, PATHS, ensureOutputDir } from './utils/paths.js';
import { runStep, parseRunId, parseRunFolder, getDataDir, STEP_NAMES, markRunCompleted, type StepOutput } from './utils/step-runner.js';
import { completeRun } from './utils/runs.js';
import { readCompanies } from './utils/io.js';

const STEP_NUMBER = 12;
const DEFAULT_INPUT = '11-verified.json';

type MatchType = 'definite_target' | 'likely_target' | 'possible_target';

const VALID_MATCH_TYPES = new Set<string>(['definite_target', 'likely_target', 'possible_target']);

interface VerifiedCompany {
  name: string;
  domain: string;
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
  hooks?: string;
  match_type?: string;
  score?: number;
  agent_score?: number;
  thesis_score?: number;
  thesis_reasoning?: string;
  email_subject?: string;
  email_body?: string;
  email_verified?: boolean;
  email_confidence?: number;
  [key: string]: unknown;
}

/* ── CLI arg parsing ─────────────────────────────────────────────── */

function parseArgs(): { inputFile: string; runId?: number; runFolder?: string } {
  const args = process.argv.slice(2);
  const i = args.indexOf('--input');
  const runId = parseRunId(args);
  const runFolder = parseRunFolder(args);

  let inputFile = i !== -1 ? args[i + 1] : DEFAULT_INPUT;
  if (!path.isAbsolute(inputFile)) {
    inputFile = path.join(getDataDir(runFolder), inputFile);
  }

  return { inputFile, runId, runFolder };
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function normalizeMatchType(raw: unknown): MatchType | undefined {
  if (typeof raw === 'string' && VALID_MATCH_TYPES.has(raw)) {
    return raw as MatchType;
  }
  return undefined;
}

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsvRow(fields: unknown[]): string {
  return fields.map(escapeCsvField).join(',');
}

const CSV_HEADERS = [
  'domain',
  'name',
  'website',
  'city',
  'industry',
  'employee_count',
  'match_type',
  'thesis_score',
  'ceo_first_name',
  'ceo_last_name',
  'ceo_title',
  'ceo_email',
  'email_verified',
  'email_confidence',
  'ceo_linkedin',
  'company_linkedin',
  'description',
  'source',
  'email_subject',
  'email_body',
];

function companyToCsvRow(company: VerifiedCompany): string {
  return toCsvRow([
    company.domain,
    company.name,
    company.website,
    company.city,
    company.industry,
    company.employee_count,
    company.match_type,
    company.thesis_score ?? company.score,
    company.ceo_first_name,
    company.ceo_last_name,
    company.ceo_title,
    company.ceo_email,
    company.email_verified ? 'true' : (company.email_verified === false ? 'false' : ''),
    company.email_confidence,
    company.ceo_linkedin,
    company.company_linkedin,
    company.description,
    company.source,
    company.email_subject,
    company.email_body,
  ]);
}

/* ── Main ────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const { inputFile, runId, runFolder } = parseArgs();

  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input file not found: ${inputFile}`);
    process.exit(1);
  }

  const result = await runStep(
    { stepNumber: STEP_NUMBER, stepName: STEP_NAMES[STEP_NUMBER], runId, runFolder },
    async () => {
      console.log(`\n[export] Reading: ${inputFile}`);
      const { companies } = readCompanies<VerifiedCompany>(inputFile);
      console.log(`[export] Exporting ${companies.length} companies...`);

      // Ensure output dir exists — use run-specific output dir when available
      let outputDir: string;
      if (runFolder) {
        outputDir = getRunOutputDir(runFolder);
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      } else {
        outputDir = ensureOutputDir();
      }

      // --- SQLite upsert ---
      let upsertedCount = 0;
      let errorCount = 0;

      for (const company of companies) {
        try {
          const record: Company = {
            domain: company.domain,
            name: company.name,
            website: company.website,
            company_linkedin: company.company_linkedin,
            description: company.description,
            city: company.city,
            source: company.source,
            ceo_first_name: company.ceo_first_name,
            ceo_last_name: company.ceo_last_name,
            ceo_title: company.ceo_title,
            ceo_email: company.ceo_email,
            ceo_linkedin: company.ceo_linkedin,
            employee_count: company.employee_count,
            industry: company.industry,
            hooks: company.hooks,
            match_type: normalizeMatchType(company.match_type),
            thesis_score: company.thesis_score ?? company.agent_score ?? (typeof company.score === 'number' ? company.score : undefined),
            thesis_reasoning: company.thesis_reasoning,
            email_subject: company.email_subject,
            email_body: company.email_body,
            email_verified: company.email_verified,
            email_confidence: company.email_confidence,
            status: 'new',
          };

          upsertCompany(record);
          upsertedCount++;
        } catch (err) {
          console.error(`  Error upserting ${company.domain}:`, err instanceof Error ? err.message : err);
          errorCount++;
        }
      }

      closeDb();
      console.log(`[export] SQLite: ${upsertedCount} upserted, ${errorCount} errors -> ${PATHS.database}`);

      // --- CSV export ---
      const dateStr = new Date().toISOString().slice(0, 10);
      const csvFilename = `leads-${dateStr}.csv`;
      const csvPath = path.join(outputDir, csvFilename);

      const csvLines = [
        toCsvRow(CSV_HEADERS),
        ...companies.map(companyToCsvRow),
      ];

      fs.writeFileSync(csvPath, csvLines.join('\n') + '\n', 'utf-8');
      console.log(`[export] CSV: ${companies.length} rows -> ${csvPath}`);

      // Summary by match_type
      const counts: Record<string, number> = {};
      for (const c of companies) {
        const mt = c.match_type ?? 'unknown';
        counts[mt] = (counts[mt] ?? 0) + 1;
      }
      console.log(`[export] Match type breakdown:`);
      for (const [mt, count] of Object.entries(counts)) {
        console.log(`  ${mt}: ${count}`);
      }

      console.log(`[export] Done.`);

      const output: StepOutput = {
        summary: `Exported ${companies.length} companies to SQLite + CSV`,
        inputCount: companies.length,
        outputCount: upsertedCount,
        notes: [
          `SQLite: ${upsertedCount} upserted to ${PATHS.database}`,
          `CSV: ${csvPath}`,
          ...Object.entries(counts).map(([mt, n]) => `${mt}: ${n}`),
        ],
        warnings: errorCount > 0 ? [`${errorCount} upsert errors`] : undefined,
      };
      return { data: companies, output };
    },
  );

  if (!result.success) {
    process.exit(1);
  }

  // Mark run as completed after successful export
  if (result.success) {
    const args = process.argv.slice(2);
    const numericRunId = parseRunId(args);
    if (numericRunId !== undefined) {
      markRunCompleted(numericRunId);
    }
    const folderRunId = parseRunFolder(args);
    if (folderRunId) {
      completeRun(folderRunId);
    }
  }
}

main().catch(err => {
  console.error('[export] Fatal error:', err);
  process.exit(1);
});
