#!/usr/bin/env npx tsx
/**
 * dedupe.ts — Step 3: Filters out companies already present in the SQLite database.
 *
 * Usage:
 *   dedupe.ts --input 2-companies-raw.json
 *   dedupe.ts --input 2-companies-raw.json --run-id 42
 *
 * Output: <dataDir>/3-new-companies.json
 */

import fs from 'fs';
import path from 'path';
import { getExistingDomains, extractDomain, isValidDomain, closeDb } from './utils/db.js';
import { runStep, parseRunId, parseRunFolder, getDataDir, STEP_NAMES, type StepOutput } from './utils/step-runner.js';

const STEP_NUMBER = 3;
const DEFAULT_INPUT = '2-companies-raw.json';
const OUTPUT_FILE = '3-new-companies.json';

interface RawCompany {
  name: string;
  domain: string;
  website: string;
  description?: string;
  city?: string;
  source?: string;
  match_type?: string;
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
      const dataDir = getDataDir(runFolder);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const outputPath = path.join(dataDir, OUTPUT_FILE);

      console.log(`\n[dedupe] Reading: ${inputFile}`);
      const raw: RawCompany[] = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
      console.log(`[dedupe] Input: ${raw.length} companies`);

      // Load all known domains from the database
      const existingDomains = getExistingDomains();
      console.log(`[dedupe] Existing domains in DB: ${existingDomains.size}`);

      const seenDomains = new Set<string>();
      const newCompanies: RawCompany[] = [];
      let skippedInvalid = 0;
      let skippedExisting = 0;
      let skippedDuplicate = 0;

      for (const company of raw) {
        // Normalize domain
        let domain: string;
        try {
          domain = company.domain
            ? extractDomain(company.domain.includes('.')
              ? (company.domain.startsWith('http') ? company.domain : `https://${company.domain}`)
              : company.domain)
            : extractDomain(company.website ?? '');
        } catch {
          skippedInvalid++;
          continue;
        }

        if (!isValidDomain(domain)) {
          skippedInvalid++;
          continue;
        }

        // Deduplicate within this batch
        if (seenDomains.has(domain)) {
          skippedDuplicate++;
          continue;
        }

        // Skip companies already in the database
        if (existingDomains.has(domain)) {
          skippedExisting++;
          continue;
        }

        seenDomains.add(domain);
        newCompanies.push({ ...company, domain });
      }

      closeDb();

      fs.writeFileSync(outputPath, JSON.stringify(newCompanies, null, 2));

      const warnings: string[] = [];
      if (skippedExisting > 0) warnings.push(`${skippedExisting} already in DB`);
      if (skippedDuplicate > 0) warnings.push(`${skippedDuplicate} duplicates within batch`);
      if (skippedInvalid > 0) warnings.push(`${skippedInvalid} invalid domains`);

      console.log(`\n[dedupe] Results:`);
      console.log(`  New companies:       ${newCompanies.length}`);
      console.log(`  Skipped (existing):  ${skippedExisting}`);
      console.log(`  Skipped (duplicate): ${skippedDuplicate}`);
      console.log(`  Skipped (invalid):   ${skippedInvalid}`);
      console.log(`[dedupe] Done. Written to ${outputPath}`);

      const output: StepOutput = {
        summary: `Deduped ${raw.length} companies → ${newCompanies.length} new`,
        inputCount: raw.length,
        outputCount: newCompanies.length,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
      return { data: newCompanies, output };
    },
  );

  if (!result.success) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[dedupe] Fatal error:', err);
  process.exit(1);
});
