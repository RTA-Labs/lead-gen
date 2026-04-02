#!/usr/bin/env npx tsx
/**
 * KB Filter (optional) -- Hard-filter bad-lead lookalikes.
 * Scores companies against bad-lead KB vectors only — no LLM calls.
 * Adds bad_lead_score and bad_lead_filtered fields to each company.
 *
 * Input:  JSON file with { city, companies: [...] }
 * Output: Same structure with bad_lead_score and bad_lead_filtered fields added.
 *         Overwrites input by default, or writes to --output path.
 *
 * Usage:
 *   npx tsx scripts/kb-filter.ts \
 *     --input runs/<run-id>/3-kb-validated.json \
 *     [--output <path>] [--bad-threshold 0.70] [--run <run-id>]
 */

import fs from 'fs';
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
import { PATHS, getEnvPath, getRunsDir } from './utils/paths.js';
import {
  getKbDb,
  queryKNN,
  getKbStats,
  closeKbDb,
  type KbNeighbor,
} from './utils/kb-db.js';
import {
  embedBatch,
  composeEmbedText,
  vectorToBuffer,
  ensureEmbedModel,
  getOllamaUrl,
} from './utils/embeddings.js';
import { readCompanies } from './utils/io.js';

// Load .env from workspace
dotenvConfig({ path: getEnvPath() });

interface NewCompany {
  name: string;
  website: string;
  domain: string;
  linkedin_url?: string;
  description?: string;
  source: string;
  city: string;
  kb_score?: number;
  kb_match?: string;
  kb_similar_leads?: string[];
}

interface FilteredCompany extends NewCompany {
  bad_lead_score: number;
  bad_lead_filtered: boolean;
}

interface CompaniesInput {
  city: string;
  companies: NewCompany[];
  [key: string]: unknown;
}

function parseArgs(): {
  input: string;
  output?: string;
  runId?: number;
  badThreshold: number;
} {
  const args = process.argv.slice(2);
  const inputIndex = args.indexOf('--input');
  const outputIndex = args.indexOf('--output');
  const badThresholdIndex = args.indexOf('--bad-threshold');
  const runIndex = args.indexOf('--run');

  if (inputIndex === -1 || !args[inputIndex + 1]) {
    console.error('Usage: npx tsx scripts/kb-filter.ts --input <path> [--output <path>] [--bad-threshold N] [--run <run-id>]');
    console.error('Flags:');
    console.error('  --output <path>      Output file path (default: overwrites input)');
    console.error('  --bad-threshold N    Bad-lead KNN score threshold for hard filter (default: 0.70)');
    process.exit(1);
  }

  const runId = runIndex !== -1 && args[runIndex + 1]
    ? parseInt(args[runIndex + 1], 10)
    : undefined;

  return {
    input: args[inputIndex + 1],
    output: outputIndex !== -1 ? args[outputIndex + 1] : undefined,
    runId,
    badThreshold: badThresholdIndex !== -1 ? parseFloat(args[badThresholdIndex + 1]) : 0.70,
  };
}

async function main() {
  const { input, output, runId, badThreshold } = parseArgs();

  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const { city, companies, raw: inputData } = readCompanies<NewCompany>(inputPath);

  const outputPath = output ? path.resolve(output) : inputPath;

  // Check KB availability
  if (!fs.existsSync(PATHS.kbDatabase)) {
    console.log('\nKB database not found -- skipping bad-lead filter, passing all companies through.');
    const filtered: FilteredCompany[] = companies.map(c => ({
      ...c,
      bad_lead_score: 0,
      bad_lead_filtered: false,
    }));

    const outputData = { ...inputData, companies: filtered };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
    console.log(`Output: ${outputPath}\n`);
    return;
  }

  getKbDb();
  const stats = getKbStats();

  if (stats.embedded === 0) {
    closeKbDb();
    console.log('\nKB has no embedded leads -- skipping bad-lead filter.');
    const filtered: FilteredCompany[] = companies.map(c => ({
      ...c,
      bad_lead_score: 0,
      bad_lead_filtered: false,
    }));

    const outputData = { ...inputData, companies: filtered };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
    console.log(`Output: ${outputPath}\n`);
    return;
  }

  console.log(`\nBad-lead filter: ${stats.total} KB leads (${stats.bad} bad, ${stats.good} good), threshold: ${badThreshold}`);

  // Embed all companies
  const ollamaUrl = getOllamaUrl();
  await ensureEmbedModel(ollamaUrl);

  console.log('  Embedding companies for bad-lead filtering...');
  const embedTexts = companies.map(c => composeEmbedText({
    company_name: c.name,
    description: c.description,
    email_domain: c.domain,
  }));

  const companyEmbeddings: number[][] = [];
  const EMBED_BATCH = 100;
  for (let i = 0; i < embedTexts.length; i += EMBED_BATCH) {
    const batch = embedTexts.slice(i, i + EMBED_BATCH);
    const batchEmbeddings = await embedBatch(batch, ollamaUrl);
    companyEmbeddings.push(...batchEmbeddings);
  }
  console.log(`  Embedded ${companyEmbeddings.length} companies.`);

  // Score each company against bad leads
  const filtered: FilteredCompany[] = [];
  let hardFilteredCount = 0;

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    const vectorBuf = vectorToBuffer(companyEmbeddings[i]);
    const neighbors = queryKNN(vectorBuf, 20);

    // Compute bad-lead score
    let badWeight = 0;
    let totalWeight = 0;
    let closestBad: KbNeighbor | null = null;

    for (const n of neighbors) {
      const w = 1 / (n.distance + 0.001);
      totalWeight += w;
      if (n.classification === 'bad') {
        badWeight += w;
        if (!closestBad) closestBad = n;
      }
    }

    const badScore = totalWeight > 0 ? badWeight / totalWeight : 0;
    const isFiltered = badScore >= badThreshold;

    if (isFiltered) {
      hardFilteredCount++;
    }

    filtered.push({
      ...company,
      bad_lead_score: parseFloat(badScore.toFixed(3)),
      bad_lead_filtered: isFiltered,
    });
  }

  closeKbDb();

  // Log results
  if (hardFilteredCount > 0) {
    console.log(`\nBad-lead hard-filtered: ${hardFilteredCount} companies`);
    const preview = filtered.filter(c => c.bad_lead_filtered).slice(0, 5);
    for (const c of preview) {
      console.log(`   - ${c.name} (${c.domain}): bad_lead_score=${c.bad_lead_score}`);
    }
    if (hardFilteredCount > 5) {
      console.log(`   ... and ${hardFilteredCount - 5} more`);
    }
  }

  const outputData = { ...inputData, companies: filtered };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));

  console.log(`\nKB filter complete: ${companies.length} companies, ${hardFilteredCount} hard-filtered`);
  console.log(`Output: ${outputPath}\n`);
}

main().catch((error) => {
  console.error(error);
  closeKbDb();
  process.exit(1);
});
