#!/usr/bin/env npx tsx
/**
 * extract.ts — Step 2: Playwright-based scraper for aggregator pages.
 *
 * Usage:
 *   extract.ts --urls "https://example.com/startups,https://other.com/list" --city "Austin"
 *   extract.ts --input urls.txt --city "Austin"
 *   extract.ts --urls "..." --city "Austin" --run-id 42
 *
 * Output: <dataDir>/2-companies-raw.json
 */

import fs from 'fs';
import path from 'path';
import dns from 'dns/promises';
import { newPage, closeBrowser, safeGoto, waitForContent, scrollToBottom, extractLinks } from './utils/playwright-helpers.js';
import { extractDomain, isValidDomain } from './utils/db.js';
import { loadFilters, isExcludedUrl, isAggregatorExcluded, type Filters } from './utils/filters.js';
import { runStep, parseRunId, parseRunFolder, getDataDir, STEP_NAMES, type StepOutput } from './utils/step-runner.js';
import { ensureRunDirs } from './utils/paths.js';

const STEP_NUMBER = 2;
const OUTPUT_FILE = '2-companies-raw.json';

interface RawCompany {
  name: string;
  domain: string;
  website: string;
  description?: string;
  city?: string;
  source: string;
  match_type?: string;
}

interface ExtractedLink {
  href: string;
  text: string;
}

/* ── CLI arg parsing ─────────────────────────────────────────────── */

function parseArgs(): { urls: string[]; city: string; inputFile?: string; runId?: number; runFolder?: string } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const urlsArg = get('--urls');
  const inputFile = get('--input');
  const city = get('--city') ?? 'Unknown';
  const runId = parseRunId(args);
  const runFolder = parseRunFolder(args);

  const urls: string[] = [];
  if (urlsArg) {
    urls.push(...urlsArg.split(',').map(u => u.trim()).filter(Boolean));
  }
  if (inputFile && fs.existsSync(inputFile)) {
    const content = fs.readFileSync(inputFile, 'utf-8');
    // Support both plain-text URL lists and JSON arrays
    if (content.trim().startsWith('[')) {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        urls.push(...parsed.map((u: string) => u.trim()).filter(Boolean));
      }
    } else {
      const lines = content
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && l.startsWith('http'));
      urls.push(...lines);
    }
  }

  return { urls, city, inputFile, runId, runFolder };
}

/* ── Helper functions ────────────────────────────────────────────── */

function isCompanyWebsite(domain: string): boolean {
  const nonCompanyTLDs = [
    'gov', 'edu', 'mil', 'int',
  ];
  const tld = domain.split('.').pop()?.toLowerCase() ?? '';
  if (nonCompanyTLDs.includes(tld)) return false;

  const nonCompanyDomains = [
    'google.com', 'facebook.com', 'twitter.com', 'linkedin.com',
    'youtube.com', 'instagram.com', 'wikipedia.org', 'github.com',
    'reddit.com', 'medium.com', 'apple.com', 'microsoft.com', 'amazon.com',
  ];
  return !nonCompanyDomains.some(d => domain === d || domain.endsWith(`.${d}`));
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    // Strip trailing slash, fragment, common tracking params
    parsed.hash = '';
    let normalized = parsed.toString().replace(/\/+$/, '');
    return normalized;
  } catch {
    return url;
  }
}

function isValidCompanyName(text: string): boolean {
  if (!text || text.length < 2 || text.length > 80) return false;
  // Skip nav/footer noise
  if (/^(home|about|contact|login|sign up|sign in|privacy|terms|blog|news|careers|menu|search|close|submit|back|next|prev|more|skip)$/i.test(text)) {
    return false;
  }
  // Skip text that's just a URL
  if (/^https?:\/\//i.test(text)) return false;
  // Skip text with too many special characters
  if ((text.match(/[^a-zA-Z0-9\s&.',-]/g) ?? []).length > text.length / 3) return false;
  return true;
}

function extractNameFromDomain(domain: string): string {
  const name = domain.split('.')[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

async function validateDomain(domain: string): Promise<boolean> {
  // Quick DNS check — if the domain resolves, it's likely valid
  try {
    await dns.lookup(domain);
    return true;
  } catch {
    // DNS failed — try an HTTP HEAD as fallback
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`https://${domain}`, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timeout);
      return response.ok || response.status < 500;
    } catch {
      return false;
    }
  }
}

async function extractStructuredCompanies(
  page: import('playwright').Page,
): Promise<Array<{ name: string; url: string; description: string }>> {
  return page.evaluate(`(() => {
    var results = [];
    var containers = Array.from(document.querySelectorAll(
      'li, .company, .startup, .card, [class*="company"], [class*="startup"], [class*="listing"], tr'
    ));
    for (var i = 0; i < containers.length; i++) {
      var container = containers[i];
      var link = container.querySelector('a[href]');
      if (!link) continue;
      var href = link.href;
      if (!href || href.startsWith('javascript') || href.startsWith('mailto')) continue;
      var name = (link.textContent || '').trim()
        || (container.querySelector('h2,h3,h4,.name,.title') || {}).textContent || '';
      name = (name || '').trim();
      var desc = (container.querySelector('p,.description,.summary,.bio') || {}).textContent || '';
      if (name && href) {
        results.push({ name: name, url: href, description: desc.trim() });
      }
    }
    return results;
  })()`);
}

async function extractCompaniesFromPage(
  page: import('playwright').Page,
  url: string,
  city: string,
  filters: Filters,
): Promise<RawCompany[]> {
  const companies: RawCompany[] = [];
  const seenDomains = new Set<string>();

  const navigated = await safeGoto(page, url);
  if (!navigated) return companies;
  await waitForContent(page);
  await scrollToBottom(page);

  // Extract structured company entries (cards, list items, rows)
  const structuredEntries = await extractStructuredCompanies(page);

  // Extract all links as fallback
  const links = await extractLinks(page);

  const sourceHostname = extractDomain(url);

  // Process structured entries first
  for (const entry of structuredEntries) {
    if (!entry.url) continue;

    let domain: string;
    try {
      domain = extractDomain(entry.url);
    } catch {
      continue;
    }

    if (!isValidDomain(domain)) continue;
    if (seenDomains.has(domain)) continue;
    if (isExcludedUrl(entry.url, filters)) continue;
    if (isAggregatorExcluded(entry.url, filters)) continue;
    if (domain === sourceHostname) continue;
    if (!isCompanyWebsite(domain)) continue;

    seenDomains.add(domain);
    companies.push({
      name: isValidCompanyName(entry.name) ? entry.name : extractNameFromDomain(domain),
      domain,
      website: normalizeUrl(entry.url.startsWith('http') ? entry.url : `https://${domain}`),
      description: entry.description || undefined,
      city,
      source: url,
    });
  }

  // Fall back to raw link extraction for any missed companies
  for (const link of links) {
    if (!link.href || !link.text) continue;
    if (link.href.startsWith('javascript') || link.href.startsWith('mailto')) continue;

    let domain: string;
    try {
      domain = extractDomain(link.href);
    } catch {
      continue;
    }

    if (!isValidDomain(domain)) continue;
    if (seenDomains.has(domain)) continue;
    if (isExcludedUrl(link.href, filters)) continue;
    if (isAggregatorExcluded(link.href, filters)) continue;
    if (domain === sourceHostname) continue;
    if (!isCompanyWebsite(domain)) continue;
    if (!isValidCompanyName(link.text)) continue;

    seenDomains.add(domain);
    companies.push({
      name: link.text.trim(),
      domain,
      website: normalizeUrl(link.href.startsWith('http') ? link.href : `https://${domain}`),
      city,
      source: url,
    });
  }

  return companies;
}

/* ── Main ────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const { urls, city, runId, runFolder } = parseArgs();

  if (urls.length === 0) {
    console.error('Error: No URLs provided. Use --urls "url1,url2" or --input <file>');
    process.exit(1);
  }

  if (runFolder) ensureRunDirs(runFolder);

  const result = await runStep(
    { stepNumber: STEP_NUMBER, stepName: STEP_NAMES[STEP_NUMBER], runId, runFolder },
    async () => {
      const dataDir = getDataDir(runFolder);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const outputPath = path.join(dataDir, OUTPUT_FILE);

      console.log(`\n[extract] Processing ${urls.length} URL(s) for city: ${city}`);

      const filters = loadFilters();
      const allCompanies: RawCompany[] = [];
      const globalSeen = new Set<string>();

      try {
        for (const url of urls) {
          console.log(`  Scraping: ${url}`);
          const page = await newPage();

          try {
            const companies = await extractCompaniesFromPage(page, url, city, filters);

            for (const company of companies) {
              if (!globalSeen.has(company.domain)) {
                globalSeen.add(company.domain);
                allCompanies.push(company);
              }
            }

            console.log(`    Found ${companies.length} companies (running total: ${allCompanies.length})`);
          } catch (err) {
            console.error(`    Error scraping ${url}:`, err instanceof Error ? err.message : err);
          } finally {
            await page.close();
          }
        }
      } finally {
        await closeBrowser();
      }

      // Optional: validate domains via DNS/HTTP (skip for speed if > 50)
      if (allCompanies.length <= 50) {
        console.log(`  Validating ${allCompanies.length} domains...`);
        const validated: RawCompany[] = [];
        for (const company of allCompanies) {
          const valid = await validateDomain(company.domain);
          if (valid) {
            validated.push(company);
          } else {
            console.log(`    Skipping invalid domain: ${company.domain}`);
          }
        }
        fs.writeFileSync(outputPath, JSON.stringify(validated, null, 2));
        console.log(`\n[extract] Done. ${validated.length} companies written to ${outputPath}`);

        const output: StepOutput = {
          summary: `Extracted ${validated.length} companies from ${urls.length} URL(s) for ${city}`,
          inputCount: urls.length,
          outputCount: validated.length,
          notes: validated.length < allCompanies.length
            ? [`${allCompanies.length - validated.length} domains failed DNS/HTTP validation`]
            : undefined,
        };
        return { data: validated, output };
      }

      fs.writeFileSync(outputPath, JSON.stringify(allCompanies, null, 2));
      console.log(`\n[extract] Done. ${allCompanies.length} companies written to ${outputPath}`);

      const output: StepOutput = {
        summary: `Extracted ${allCompanies.length} companies from ${urls.length} URL(s) for ${city}`,
        inputCount: urls.length,
        outputCount: allCompanies.length,
      };
      return { data: allCompanies, output };
    },
  );

  if (!result.success) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[extract] Fatal error:', err);
  process.exit(1);
});
