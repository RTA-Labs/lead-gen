#!/usr/bin/env npx tsx
/**
 * KB Validate -- Score pipeline leads against the KB using vector similarity (KNN voting).
 *
 * Input:  JSON file with { city, companies: [...] }
 * Output: JSON file with kb_score, kb_match, kb_similar_leads added to each company.
 *         Weak matches (below threshold) are filtered out.
 *
 * Usage:
 *   npx tsx scripts/kb-validate.ts \
 *     --input runs/<run-id>/3-new-companies.json \
 *     [--threshold 0.40] [--top-k 5] [--run <run-id>] [--provider ollama|openai]
 */

import fs from 'fs';
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
import { PATHS, getEnvPath, getRunsDir } from './utils/paths.js';
import {
  getKbDb,
  queryKNN,
  closeKbDb,
  getKbStats,
  ensureProviderConsistency,
  type KbNeighbor,
} from './utils/kb-db.js';
import {
  embedBatch,
  composeEmbedText,
  vectorToBuffer,
  ensureEmbedModel,
  getOllamaUrl,
  getEmbedProvider,
  type EmbedProvider,
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
}

interface ValidatedCompany extends NewCompany {
  kb_score: number;
  kb_match: 'strong' | 'moderate' | 'weak';
  kb_similar_leads: string[];
}

interface CompaniesInput {
  city: string;
  newCount?: number;
  companies: NewCompany[];
  [key: string]: unknown;
}

const DEFAULT_THRESHOLD = 0.40;
const STRONG_THRESHOLD = 0.65;
const KNN_K = 20;
const EMBED_BATCH_SIZE = 100;

function parseArgs(): {
  input: string;
  output?: string;
  threshold: number;
  topK: number;
  runId?: number;
  provider: EmbedProvider;
} {
  const args = process.argv.slice(2);
  const inputIndex = args.indexOf('--input');
  const outputIndex = args.indexOf('--output');
  const thresholdIndex = args.indexOf('--threshold');
  const topKIndex = args.indexOf('--top-k');
  const runIndex = args.indexOf('--run');
  const providerIndex = args.indexOf('--provider');

  if (inputIndex === -1 || !args[inputIndex + 1]) {
    console.error('Usage: npx tsx scripts/kb-validate.ts --input <path> [--output <path>] [--threshold 0.40] [--top-k 5] [--run <run-id>] [--provider ollama|openai]');
    process.exit(1);
  }

  const providerArg = providerIndex !== -1 ? args[providerIndex + 1] : undefined;
  const provider: EmbedProvider = (providerArg === 'ollama' || providerArg === 'openai')
    ? providerArg
    : getEmbedProvider();

  const runId = runIndex !== -1 && args[runIndex + 1]
    ? parseInt(args[runIndex + 1], 10)
    : undefined;

  // Derive default output path based on runId or alongside input
  let defaultOutput: string | undefined;
  if (runId !== undefined) {
    const runsDir = getRunsDir();
    defaultOutput = path.join(runsDir, String(runId), '3-kb-validated.json');
  }

  return {
    input: args[inputIndex + 1],
    output: outputIndex !== -1 ? args[outputIndex + 1] : defaultOutput,
    threshold: thresholdIndex !== -1 ? parseFloat(args[thresholdIndex + 1]) : DEFAULT_THRESHOLD,
    topK: topKIndex !== -1 ? parseInt(args[topKIndex + 1], 10) : 5,
    runId,
    provider,
  };
}

function scoreNeighbors(neighbors: KbNeighbor[]): {
  score: number;
  match: 'strong' | 'moderate' | 'weak';
  topGood: string[];
} {
  if (neighbors.length === 0) {
    return { score: 0, match: 'weak', topGood: [] };
  }

  let goodWeight = 0;
  let totalWeight = 0;

  for (const n of neighbors) {
    const weight = 1 / (n.distance + 0.001);
    totalWeight += weight;
    if (n.classification === 'good') {
      goodWeight += weight;
    }
  }

  const score = totalWeight > 0 ? goodWeight / totalWeight : 0;
  const match = score >= STRONG_THRESHOLD ? 'strong' : score >= DEFAULT_THRESHOLD ? 'moderate' : 'weak';

  const topGood = neighbors
    .filter(n => n.classification === 'good')
    .slice(0, 3)
    .map(n => n.company_name);

  return { score, match, topGood };
}

async function main() {
  const { input, output, threshold, topK, runId, provider } = parseArgs();

  const inputPath = path.resolve(input);

  // Graceful fallback: if kb.db doesn't exist, pass all leads through
  if (!fs.existsSync(PATHS.kbDatabase)) {
    console.log('\nKB database not found -- skipping KB validation (all leads pass through)');
    console.log('  Run kb-import first to enable vector-based scoring.\n');

    if (!fs.existsSync(inputPath)) {
      console.error(`Input file not found: ${inputPath}`);
      process.exit(1);
    }

    const { companies: rawCompanies, raw: inputData } = readCompanies<NewCompany>(inputPath);
    const companies = rawCompanies.map((c: NewCompany) => ({
      ...c,
      kb_score: 0,
      kb_match: 'moderate' as const,
      kb_similar_leads: [],
    }));

    const outputData = {
      ...inputData,
      kbValidatedAt: new Date().toISOString(),
      kbSkipped: true,
      companies,
    };

    const outputPath = output ? path.resolve(output) : inputPath.replace(/\.json$/, '-kb-validated.json');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
    console.log(`Output (pass-through): ${outputPath}\n`);
    return;
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  getKbDb();
  const ollamaUrl = getOllamaUrl();

  const { city, companies } = readCompanies<NewCompany>(inputPath);

  const stats = getKbStats();
  console.log(`\nKB: ${stats.total} leads (${stats.good} good, ${stats.bad} bad), ${stats.embedded} embedded`);
  console.log(`Validating ${companies.length} companies (threshold: ${threshold}, K=${KNN_K})\n`);

  // Ensure embedding model is available
  await ensureEmbedModel(ollamaUrl, provider);
  ensureProviderConsistency(provider);

  // Embed all companies in batches
  console.log('  Embedding companies...');
  const embedTexts = companies.map(c => composeEmbedText({
    company_name: c.name,
    description: c.description,
    email_domain: c.domain,
  }));

  const allEmbeddings: number[][] = [];
  for (let i = 0; i < embedTexts.length; i += EMBED_BATCH_SIZE) {
    const batch = embedTexts.slice(i, i + EMBED_BATCH_SIZE);
    const batchEmbeddings = await embedBatch(batch, ollamaUrl, provider);
    allEmbeddings.push(...batchEmbeddings);
  }
  console.log(`  Embedded ${allEmbeddings.length} companies.`);

  // Score each company via KNN voting
  const validated: ValidatedCompany[] = [];
  let strongCount = 0;
  let moderateCount = 0;
  let weakCount = 0;

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    const vectorBuf = vectorToBuffer(allEmbeddings[i]);
    const neighbors = queryKNN(vectorBuf, KNN_K);
    const { score, match, topGood } = scoreNeighbors(neighbors);

    if (match === 'strong') strongCount++;
    else if (match === 'moderate') moderateCount++;
    else weakCount++;

    validated.push({
      ...company,
      kb_score: parseFloat(score.toFixed(3)),
      kb_match: match,
      kb_similar_leads: topGood.slice(0, topK),
    });
  }

  // Filter: only strong + moderate pass through
  const passed = validated.filter(c => c.kb_match !== 'weak');
  passed.sort((a, b) => b.kb_score - a.kb_score);

  const outputData = {
    city,
    kbValidatedAt: new Date().toISOString(),
    threshold,
    topK,
    originalCount: companies.length,
    passedCount: passed.length,
    filteredCount: weakCount,
    strongCount,
    moderateCount,
    weakCount,
    companies: passed,
  };

  const outputPath = output
    ? path.resolve(output)
    : inputPath.replace(/\.json$/, '-kb-validated.json');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));

  console.log(`\nKB Validation complete`);
  console.log(`   Strong matches:   ${strongCount}`);
  console.log(`   Moderate matches: ${moderateCount}`);
  console.log(`   Weak (filtered):  ${weakCount}`);
  console.log(`   Passed through:   ${passed.length}/${companies.length}`);
  console.log(`Output: ${outputPath}\n`);

  closeKbDb();
}

main().catch((error) => {
  console.error(error);
  closeKbDb();
  process.exit(1);
});
