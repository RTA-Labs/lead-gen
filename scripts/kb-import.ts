#!/usr/bin/env npx tsx
/**
 * KB Import — Bulk import historical leads from spreadsheet files into SQLite + sqlite-vec.
 * Two phases: metadata import (fast) then embedding via configured provider.
 *
 * Usage:
 *   npx tsx scripts/kb-import.ts \
 *     --good /path/to/good-leads.xlsx \
 *     --bad /path/to/bad-leads.csv \
 *     [--sheet "Sheet1"] [--resume] [--batch-size 100] [--skip-embed]
 *
 *   npx tsx scripts/kb-import.ts --resume [--batch-size 100]  (embed-only mode)
 *
 * Column mapping (auto-detected, or override with --map):
 *   --map "name=Company" --map "email=Contact Email"
 *
 * Mapping targets: name, email, description, notes, domain
 *
 * Provider selection:
 *   Set LEAD_GEN_EMBED_PROVIDER=ollama|openai in ~/.lead-gen/.env (default: openai)
 *   Or pass --provider ollama|openai
 */

import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import {
  getKbDb,
  insertLeadIfNew,
  insertEmbedding,
  markEmbedded,
  getUnembeddedLeads,
  getUnembeddedCount,
  getKbStats,
  closeKbDb,
  ensureProviderConsistency,
  type KbLead,
} from './utils/kb-db.js';
import {
  ensureEmbedModel,
  embedBatch,
  composeEmbedText,
  vectorToBuffer,
  getOllamaUrl,
  getEmbedProvider,
  type EmbedProvider,
} from './utils/embeddings.js';

interface ParsedArgs {
  goodPath?: string;
  badPath?: string;
  sheetName?: string;
  resume: boolean;
  batchSize: number;
  skipEmbed: boolean;
  mapFlags: string[];
  provider: EmbedProvider;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);

  const goodIndex = args.indexOf('--good');
  const badIndex = args.indexOf('--bad');
  const sheetIndex = args.indexOf('--sheet');
  const batchIndex = args.indexOf('--batch-size');
  const providerIndex = args.indexOf('--provider');
  const resume = args.includes('--resume');
  const skipEmbed = args.includes('--skip-embed');

  // Collect all --map values
  const mapFlags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--map' && args[i + 1]) {
      mapFlags.push(args[i + 1]);
    }
  }

  // --good and --bad are required unless --resume (embed-only mode)
  if (!resume && (goodIndex === -1 || !args[goodIndex + 1] || badIndex === -1 || !args[badIndex + 1])) {
    console.error('Usage: npx tsx scripts/kb-import.ts --good <file> --bad <file> [--sheet "Sheet1"] [--resume] [--batch-size 100] [--skip-embed] [--map target=source ...]');
    console.error('       npx tsx scripts/kb-import.ts --resume [--batch-size 100]  (embed-only mode)');
    console.error('\nMapping targets: name, email, description, notes, domain');
    console.error('Example: --map "name=Company" --map "email=Contact Email"');
    process.exit(1);
  }

  const providerArg = providerIndex !== -1 ? args[providerIndex + 1] : undefined;
  const provider: EmbedProvider = (providerArg === 'ollama' || providerArg === 'openai')
    ? providerArg
    : getEmbedProvider();

  return {
    goodPath: goodIndex !== -1 ? args[goodIndex + 1] : undefined,
    badPath: badIndex !== -1 ? args[badIndex + 1] : undefined,
    sheetName: sheetIndex !== -1 ? args[sheetIndex + 1] : undefined,
    resume,
    batchSize: batchIndex !== -1 ? parseInt(args[batchIndex + 1], 10) : 100,
    skipEmbed,
    mapFlags,
    provider,
  };
}

// Auto-detection patterns for column matching (case-insensitive)
const COLUMN_PATTERNS: Record<string, RegExp[]> = {
  name: [/^company\s*name$/i, /^company$/i, /^name$/i, /^company_name$/i],
  email: [/^e-?mail$/i, /^contact\s*email$/i, /^email\s*address$/i],
  description: [/^description$/i, /^what\s*they\s*do$/i, /^4\s*words\s*on\s*what\s*the\s*company\s*does$/i],
  notes: [/^notes$/i, /^call\s*notes$/i, /^notes\s*from\s*last\s*call$/i],
  domain: [/^domain$/i, /^website$/i, /^web$/i, /^url$/i],
};

interface ColumnMapping {
  name: string;
  email?: string;
  description?: string;
  notes?: string;
  domain?: string;
}

function resolveColumnMapping(headers: string[], mapFlags: string[]): ColumnMapping {
  const mapping: Partial<ColumnMapping> = {};

  // Step 1: Parse explicit --map entries
  for (const flag of mapFlags) {
    const eqIdx = flag.indexOf('=');
    if (eqIdx === -1) {
      console.warn(`  Warning: Ignoring invalid --map value: "${flag}" (expected target=source)`);
      continue;
    }
    const target = flag.slice(0, eqIdx).trim().toLowerCase();
    const source = flag.slice(eqIdx + 1).trim();

    if (!Object.keys(COLUMN_PATTERNS).includes(target)) {
      console.warn(`  Warning: Unknown mapping target "${target}". Valid: ${Object.keys(COLUMN_PATTERNS).join(', ')}`);
      continue;
    }

    // Verify the source column exists
    const match = headers.find(h => h === source);
    if (!match) {
      // Try case-insensitive match
      const ciMatch = headers.find(h => h.toLowerCase() === source.toLowerCase());
      if (ciMatch) {
        (mapping as Record<string, string>)[target] = ciMatch;
      } else {
        console.warn(`  Warning: Column "${source}" not found in headers. Available: ${headers.join(', ')}`);
      }
    } else {
      (mapping as Record<string, string>)[target] = match;
    }
  }

  // Step 2: Auto-detect unmapped targets
  for (const [target, patterns] of Object.entries(COLUMN_PATTERNS)) {
    if ((mapping as Record<string, string>)[target]) continue; // already mapped

    for (const pattern of patterns) {
      const match = headers.find(h => pattern.test(h));
      if (match) {
        (mapping as Record<string, string>)[target] = match;
        break;
      }
    }
  }

  // Validate: name is required
  if (!mapping.name) {
    throw new Error(
      `Could not resolve "name" column. Available headers: ${headers.join(', ')}.\n` +
      `Use --map "name=YourColumnName" to specify it.`
    );
  }

  // Log resolved mapping
  console.log('  Column mapping:');
  for (const [target, col] of Object.entries(mapping)) {
    if (col) {
      const source = mapFlags.some(f => f.startsWith(`${target}=`)) ? '(explicit)' : '(auto-detected)';
      console.log(`    ${target} -> "${col}" ${source}`);
    }
  }

  return mapping as ColumnMapping;
}

const SUPPORTED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

function readSpreadsheet(filePath: string, sheetName?: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported file format "${ext}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
  }

  const workbook = XLSX.readFile(filePath);
  const sheet = sheetName
    ? workbook.Sheets[sheetName]
    : workbook.Sheets[workbook.SheetNames[0]];

  if (!sheet) {
    throw new Error(`Sheet not found: ${sheetName || workbook.SheetNames[0]}`);
  }

  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
}

function getHeaders(filePath: string, sheetName?: string): string[] {
  const workbook = XLSX.readFile(filePath);
  const sheet = sheetName
    ? workbook.Sheets[sheetName]
    : workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { header: 1 });
  const firstRow = rows[0];
  if (!firstRow || typeof firstRow !== 'object') return [];
  return Object.values(firstRow as Record<string, unknown>).map(v => String(v ?? ''));
}

function extractEmailDomain(email: string): string | null {
  if (!email || !email.includes('@')) return null;
  const domain = email.split('@')[1]?.toLowerCase().trim();
  return domain || null;
}

function extractDomainFromUrl(url: string): string | null {
  if (!url) return null;
  try {
    // Handle bare domains like "example.com"
    const withProto = url.includes('://') ? url : `https://${url}`;
    return new URL(withProto).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

interface MappedLead {
  company_name: string;
  email_domain?: string;
  description?: string;
  call_notes?: string;
  classification: 'good' | 'bad';
}

function mapRowToLead(row: Record<string, unknown>, mapping: ColumnMapping, classification: 'good' | 'bad'): MappedLead | null {
  const companyName = String(row[mapping.name] ?? '').trim();
  if (!companyName) return null;

  let emailDomain: string | null = null;
  if (mapping.email) {
    const email = String(row[mapping.email] ?? '').trim();
    emailDomain = extractEmailDomain(email);
  }
  if (!emailDomain && mapping.domain) {
    const domainVal = String(row[mapping.domain] ?? '').trim();
    emailDomain = extractDomainFromUrl(domainVal);
  }

  return {
    company_name: companyName,
    email_domain: emailDomain || undefined,
    description: mapping.description ? String(row[mapping.description] ?? '').trim() || undefined : undefined,
    call_notes: mapping.notes ? String(row[mapping.notes] ?? '').trim() || undefined : undefined,
    classification,
  };
}

async function embedUnembeddedLeads(batchSize: number, provider: EmbedProvider): Promise<void> {
  const ollamaUrl = getOllamaUrl();

  console.log(`\nEmbedding leads via ${provider}...`);
  await ensureEmbedModel(ollamaUrl, provider);
  ensureProviderConsistency(provider);

  let totalEmbedded = 0;
  const totalToEmbed = getUnembeddedCount();
  console.log(`  ${totalToEmbed} leads to embed (batch size: ${batchSize})\n`);

  const db = getKbDb();

  while (true) {
    const leads = getUnembeddedLeads(batchSize);
    if (leads.length === 0) break;

    const texts = leads.map(l => l.embed_text || composeEmbedText(l));
    const embeddings = await embedBatch(texts, ollamaUrl, provider);

    const insertBatch = db.transaction(() => {
      for (let i = 0; i < leads.length; i++) {
        const lead = leads[i];
        const vector = vectorToBuffer(embeddings[i]);
        insertEmbedding(lead.id!, vector);
        markEmbedded(lead.id!);
      }
    });
    insertBatch();

    totalEmbedded += leads.length;
    if (totalEmbedded % 1000 < batchSize) {
      const pct = ((totalEmbedded / totalToEmbed) * 100).toFixed(1);
      console.log(`  Embedded ${totalEmbedded}/${totalToEmbed} (${pct}%)`);
    }
  }

  console.log(`\nEmbedding complete: ${totalEmbedded} leads embedded.`);
}

async function main() {
  const { goodPath, badPath, sheetName, resume, batchSize, skipEmbed, mapFlags, provider } = parseArgs();

  console.log('\nKB Import -- Loading historical leads into SQLite + sqlite-vec\n');
  console.log(`  Good leads: ${goodPath}`);
  console.log(`  Bad leads:  ${badPath}`);
  if (sheetName) console.log(`  Sheet: ${sheetName}`);
  if (resume) console.log(`  Mode: Resume (skip existing domains, embed unembedded)`);
  if (skipEmbed) console.log(`  Mode: Skip embedding (metadata only)`);
  if (mapFlags.length > 0) console.log(`  Mappings: ${mapFlags.join(', ')}`);
  console.log(`  Batch size: ${batchSize}`);

  // Initialize KB database
  getKbDb();

  if (resume) {
    const stats = getKbStats();
    console.log(`\nExisting KB: ${stats.total} leads (${stats.good} good, ${stats.bad} bad), ${stats.embedded} embedded`);

    if (stats.unembedded > 0 && !skipEmbed) {
      console.log(`\nResuming embedding for ${stats.unembedded} unembedded leads...`);
      await embedUnembeddedLeads(batchSize, provider);
    } else if (stats.unembedded === 0) {
      console.log('\nAll leads already embedded.');
    }

    closeKbDb();
    return;
  }

  // Phase 1: Metadata import
  console.log('\nReading files...');
  const goodRows = readSpreadsheet(goodPath!, sheetName);
  const badRows = readSpreadsheet(badPath!, sheetName);
  console.log(`  Good file: ${goodRows.length} rows`);
  console.log(`  Bad file:  ${badRows.length} rows`);

  // Resolve column mapping from headers
  console.log('\nResolving column mapping...');
  const goodHeaders = getHeaders(goodPath!, sheetName);
  const badHeaders = getHeaders(badPath!, sheetName);
  const allHeaders = [...new Set([...goodHeaders, ...badHeaders])];
  const mapping = resolveColumnMapping(allHeaders, mapFlags);

  console.log('\nMapping rows to leads...');
  const goodLeads = goodRows.map(r => mapRowToLead(r, mapping, 'good')).filter((l): l is MappedLead => l !== null);
  const badLeads = badRows.map(r => mapRowToLead(r, mapping, 'bad')).filter((l): l is MappedLead => l !== null);
  console.log(`  Good leads: ${goodLeads.length} (${goodRows.length - goodLeads.length} skipped)`);
  console.log(`  Bad leads:  ${badLeads.length} (${badRows.length - badLeads.length} skipped)`);

  console.log('\nImporting into kb.db...');
  const allLeads = [...goodLeads, ...badLeads];
  let imported = 0;
  let skipped = 0;

  const db = getKbDb();
  const insertMany = db.transaction((leads: MappedLead[]) => {
    for (const lead of leads) {
      const embedText = composeEmbedText(lead);
      const id = insertLeadIfNew({
        ...lead,
        embed_text: embedText,
      });
      if (id !== null) {
        imported++;
      } else {
        skipped++;
      }
    }
  });

  // Process in chunks of 1000 for transaction batching
  for (let i = 0; i < allLeads.length; i += 1000) {
    const chunk = allLeads.slice(i, i + 1000);
    insertMany(chunk);
    if ((i + 1000) % 10000 < 1000) {
      console.log(`  Processed ${Math.min(i + 1000, allLeads.length)}/${allLeads.length}...`);
    }
  }

  console.log(`\nMetadata import complete: ${imported} imported, ${skipped} skipped (duplicate domain)`);

  // Phase 2: Embedding
  if (skipEmbed) {
    const stats = getKbStats();
    console.log(`\nSkipping embedding. Run with --resume later to embed ${stats.unembedded} leads.`);
  } else {
    await embedUnembeddedLeads(batchSize, provider);
  }

  // Print final stats
  const stats = getKbStats();
  console.log('\nKB Stats:');
  console.log(`  Total leads:  ${stats.total}`);
  console.log(`  Good leads:   ${stats.good}`);
  console.log(`  Bad leads:    ${stats.bad}`);
  console.log(`  Embedded:     ${stats.embedded}`);
  console.log(`  Unembedded:   ${stats.unembedded}`);
  console.log('');

  closeKbDb();
}

main().catch((error) => {
  console.error('Import failed:', error);
  closeKbDb();
  process.exit(1);
});
