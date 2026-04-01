#!/usr/bin/env npx tsx
/**
 * KB Query -- Query the vector knowledge base.
 *
 * Usage:
 *   npx tsx scripts/kb-query.ts --stats                        # KB stats
 *   npx tsx scripts/kb-query.ts --search "PE fund admin"       # embed text, KNN search
 *   npx tsx scripts/kb-query.ts --similar-to "acme.com"        # find similar to a domain
 *   npx tsx scripts/kb-query.ts --score "B2B SaaS billing"     # compute KNN voting score
 *   [--provider ollama|openai]
 */

import fs from 'fs';
import { PATHS } from './utils/paths.js';
import {
  getKbDb,
  getKbStats,
  queryKNN,
  getLeadByDomain,
  getLeadEmbedding,
  closeKbDb,
  ensureProviderConsistency,
} from './utils/kb-db.js';
import {
  embedSingle,
  vectorToBuffer,
  getOllamaUrl,
  ensureEmbedModel,
  getEmbedProvider,
  type EmbedProvider,
} from './utils/embeddings.js';

function parseArgs(): {
  mode: 'stats' | 'search' | 'similar-to' | 'score';
  query?: string;
  provider: EmbedProvider;
} {
  const args = process.argv.slice(2);

  const providerIndex = args.indexOf('--provider');
  const providerArg = providerIndex !== -1 ? args[providerIndex + 1] : undefined;
  const provider: EmbedProvider = (providerArg === 'ollama' || providerArg === 'openai')
    ? providerArg
    : getEmbedProvider();

  if (args.includes('--stats')) return { mode: 'stats', provider };

  const searchIndex = args.indexOf('--search');
  if (searchIndex !== -1 && args[searchIndex + 1]) {
    return { mode: 'search', query: args[searchIndex + 1], provider };
  }

  const similarIndex = args.indexOf('--similar-to');
  if (similarIndex !== -1 && args[similarIndex + 1]) {
    return { mode: 'similar-to', query: args[similarIndex + 1], provider };
  }

  const scoreIndex = args.indexOf('--score');
  if (scoreIndex !== -1 && args[scoreIndex + 1]) {
    return { mode: 'score', query: args[scoreIndex + 1], provider };
  }

  console.error('Usage:');
  console.error('  npx tsx scripts/kb-query.ts --stats');
  console.error('  npx tsx scripts/kb-query.ts --search "PE fund admin"');
  console.error('  npx tsx scripts/kb-query.ts --similar-to "acme.com"');
  console.error('  npx tsx scripts/kb-query.ts --score "B2B SaaS billing"');
  console.error('  [--provider ollama|openai]');
  process.exit(1);
}

function computeKnnScore(neighbors: { classification: string; distance: number }[]): {
  score: number;
  match: 'strong' | 'moderate' | 'weak';
  goodCount: number;
  badCount: number;
} {
  if (neighbors.length === 0) return { score: 0, match: 'weak', goodCount: 0, badCount: 0 };

  let goodWeight = 0;
  let totalWeight = 0;
  let goodCount = 0;
  let badCount = 0;

  for (const n of neighbors) {
    const weight = 1 / (n.distance + 0.001);
    totalWeight += weight;
    if (n.classification === 'good') {
      goodWeight += weight;
      goodCount++;
    } else {
      badCount++;
    }
  }

  const score = totalWeight > 0 ? goodWeight / totalWeight : 0;
  const match = score >= 0.65 ? 'strong' : score >= 0.40 ? 'moderate' : 'weak';

  return { score, match, goodCount, badCount };
}

async function main() {
  const { mode, query, provider } = parseArgs();

  if (!fs.existsSync(PATHS.kbDatabase)) {
    console.error('KB database not found. Run kb-import first.');
    process.exit(1);
  }

  getKbDb();

  switch (mode) {
    case 'stats': {
      const stats = getKbStats();
      console.log('\nKB Stats\n');
      console.log(`  Total leads:  ${stats.total}`);
      console.log(`  Good leads:   ${stats.good}`);
      console.log(`  Bad leads:    ${stats.bad}`);
      console.log(`  Embedded:     ${stats.embedded}`);
      console.log(`  Unembedded:   ${stats.unembedded}`);
      console.log(`  Coverage:     ${stats.total > 0 ? ((stats.embedded / stats.total) * 100).toFixed(1) : 0}%`);
      console.log('');
      break;
    }

    case 'search': {
      console.log(`\nSearching for: "${query}"\n`);
      await ensureEmbedModel(getOllamaUrl(), provider);
      ensureProviderConsistency(provider);
      const vector = await embedSingle(query!, getOllamaUrl(), provider);
      const neighbors = queryKNN(vectorToBuffer(vector), 20);

      if (neighbors.length === 0) {
        console.log('  No results found.\n');
      } else {
        const { score, match, goodCount, badCount } = computeKnnScore(neighbors);
        console.log(`  KNN Score: ${score.toFixed(3)} (${match}) -- ${goodCount} good, ${badCount} bad in top ${neighbors.length}\n`);
        console.log('  Top matches:');
        for (const n of neighbors.slice(0, 10)) {
          const label = n.classification === 'good' ? '[good]' : '[bad] ';
          console.log(`    ${label} ${n.distance.toFixed(4)} | ${n.company_name} (${n.email_domain || 'no domain'})`);
        }
        console.log('');
      }
      break;
    }

    case 'similar-to': {
      console.log(`\nFinding leads similar to: ${query}\n`);

      const lead = getLeadByDomain(query!);
      if (lead) {
        console.log(`  Known lead: ${lead.company_name} (${lead.classification})`);
        if (lead.description) console.log(`  Description: ${lead.description}`);

        if (lead.id) {
          const embedding = getLeadEmbedding(lead.id);
          if (embedding) {
            const neighbors = queryKNN(embedding, 21); // +1 for self
            const filtered = neighbors.filter(n => n.id !== lead.id);
            console.log(`\n  Similar leads:`);
            for (const n of filtered.slice(0, 10)) {
              const label = n.classification === 'good' ? '[good]' : '[bad] ';
              console.log(`    ${label} ${n.distance.toFixed(4)} | ${n.company_name} (${n.email_domain || 'no domain'})`);
            }
          } else {
            console.log('  Lead not yet embedded.');
          }
        }
      } else {
        console.log(`  Domain "${query}" not found in KB. Embedding as query text...`);
        await ensureEmbedModel(getOllamaUrl(), provider);
        ensureProviderConsistency(provider);
        const vector = await embedSingle(query!, getOllamaUrl(), provider);
        const neighbors = queryKNN(vectorToBuffer(vector), 10);
        for (const n of neighbors) {
          const label = n.classification === 'good' ? '[good]' : '[bad] ';
          console.log(`    ${label} ${n.distance.toFixed(4)} | ${n.company_name} (${n.email_domain || 'no domain'})`);
        }
      }
      console.log('');
      break;
    }

    case 'score': {
      console.log(`\nScoring: "${query}"\n`);
      await ensureEmbedModel(getOllamaUrl(), provider);
      ensureProviderConsistency(provider);
      const vector = await embedSingle(query!, getOllamaUrl(), provider);
      const neighbors = queryKNN(vectorToBuffer(vector), 20);
      const { score, match, goodCount, badCount } = computeKnnScore(neighbors);

      console.log(`  Score: ${score.toFixed(3)}`);
      console.log(`  Match: ${match}`);
      console.log(`  Good neighbors: ${goodCount}/${neighbors.length}`);
      console.log(`  Bad neighbors:  ${badCount}/${neighbors.length}`);
      console.log('');
      break;
    }
  }

  closeKbDb();
}

main().catch((error) => {
  console.error(error);
  closeKbDb();
  process.exit(1);
});
