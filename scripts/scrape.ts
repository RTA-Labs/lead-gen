#!/usr/bin/env npx tsx
/**
 * scrape.ts — Step 7: Playwright website hooks extraction.
 *
 * Visits each company's website and extracts conversation hooks:
 * case studies, testimonials, notable customers, and recent news.
 *
 * Usage:
 *   scrape.ts --input 6-enriched.json
 *   scrape.ts --input 6-enriched.json --run-id 42
 *
 * Output: <dataDir>/7-with-hooks.json
 */

import fs from 'fs';
import path from 'path';
import { newPage, closeBrowser, safeGoto, waitForContent, scrollToBottom, getPageText } from './utils/playwright-helpers.js';
import type { CompanyHooks } from './utils/db.js';
import { runStep, parseRunId, parseRunFolder, getDataDir, STEP_NAMES, type StepOutput } from './utils/step-runner.js';

const STEP_NUMBER = 7;
const DEFAULT_INPUT = '6-enriched.json';
const OUTPUT_FILE = '7-with-hooks.json';

const PAGE_TIMEOUT = 20_000;

interface EnrichedCompany {
  name: string;
  domain: string;
  website?: string;
  [key: string]: unknown;
}

interface CompanyWithHooks extends EnrichedCompany {
  hooks?: string; // JSON-serialized CompanyHooks
  scrape_status?: 'ok' | 'skipped' | 'error';
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

/* ── Hook extraction helpers ─────────────────────────────────────── */

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = item.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, '')
    .trim();
}

async function extractHooks(
  page: import('playwright').Page,
): Promise<CompanyHooks> {
  const hooks: CompanyHooks = {
    case_studies: [],
    testimonials: [],
    notable_customers: [],
    recent_news: [],
  };

  // --- Case Studies ---
  const caseStudySelectors = [
    'a[href*="case-stud"]',
    'a[href*="case_stud"]',
    'a[href*="success-stor"]',
    'a[href*="customer-stor"]',
    '.case-study a',
    '[class*="case-study"] a',
    '[class*="success"] a',
    'a[href*="/results"]',
  ];

  const caseStudyLinks = await page.evaluate(`(() => {
    var selectors = ${JSON.stringify(caseStudySelectors)};
    var texts = [];
    for (var i = 0; i < selectors.length; i++) {
      document.querySelectorAll(selectors[i]).forEach(function(el) {
        var text = (el.textContent || '').trim();
        if (text.length > 5 && text.length < 200) texts.push(text);
      });
    }
    return texts;
  })()`) as string[];

  hooks.case_studies = dedupeStrings(caseStudyLinks.map(cleanText)).slice(0, 5);

  // --- Testimonials / Quotes ---
  const testimonialSelectors = [
    'blockquote',
    '[class*="testimonial"]',
    '[class*="quote"]',
    '[class*="review"]',
    '[data-testid*="testimonial"]',
    '.testimonial',
    '.quote',
  ];

  const testimonials = await page.evaluate(`(() => {
    var selectors = ${JSON.stringify(testimonialSelectors)};
    var texts = [];
    for (var i = 0; i < selectors.length; i++) {
      document.querySelectorAll(selectors[i]).forEach(function(el) {
        var text = (el.textContent || '').trim();
        if (text.length > 20 && text.length < 500) texts.push(text);
      });
    }
    return texts;
  })()`) as string[];

  hooks.testimonials = dedupeStrings(testimonials.map(cleanText)).slice(0, 3);

  // --- Notable Customers / Client Logos ---
  const customerSelectors = [
    '[class*="customer"] [alt]',
    '[class*="client"] [alt]',
    '[class*="partner"] [alt]',
    '[class*="logo"] [alt]',
    '.customers img[alt]',
    '.clients img[alt]',
    '[class*="trusted"] img[alt]',
  ];

  const customers = await page.evaluate(`(() => {
    var selectors = ${JSON.stringify(customerSelectors)};
    var names = [];
    for (var i = 0; i < selectors.length; i++) {
      document.querySelectorAll(selectors[i]).forEach(function(el) {
        var alt = (el.alt || '').trim();
        if (alt && alt.length > 1 && alt.length < 80 && !/logo|icon|image/i.test(alt)) {
          names.push(alt);
        }
      });
    }
    return names;
  })()`) as string[];

  hooks.notable_customers = dedupeStrings(customers.map(cleanText)).slice(0, 10);

  // --- Recent News ---
  const newsSelectors = [
    '[class*="news"] a',
    '[class*="press"] a',
    '[class*="blog"] a',
    'article a',
    '.news-item a',
    '.press-release a',
    'a[href*="/news/"]',
    'a[href*="/press/"]',
    'a[href*="/blog/"]',
  ];

  const newsItems = await page.evaluate(`(() => {
    var selectors = ${JSON.stringify(newsSelectors)};
    var texts = [];
    for (var i = 0; i < selectors.length; i++) {
      document.querySelectorAll(selectors[i]).forEach(function(el) {
        var text = (el.textContent || '').trim();
        if (text.length > 15 && text.length < 200) texts.push(text);
      });
    }
    return texts;
  })()`) as string[];

  hooks.recent_news = dedupeStrings(newsItems.map(cleanText)).slice(0, 5);

  return hooks;
}

async function scrapeCompany(
  page: import('playwright').Page,
  company: EnrichedCompany,
): Promise<CompanyWithHooks> {
  const url = company.website ?? `https://${company.domain}`;
  const result: CompanyWithHooks = { ...company };

  try {
    const navigated = await safeGoto(page, url, PAGE_TIMEOUT);
    if (!navigated) {
      result.scrape_status = 'error';
      return result;
    }

    await waitForContent(page);
    await scrollToBottom(page);

    const hooks = await extractHooks(page);

    const hasAnyHooks =
      (hooks.case_studies?.length ?? 0) > 0 ||
      (hooks.testimonials?.length ?? 0) > 0 ||
      (hooks.notable_customers?.length ?? 0) > 0 ||
      (hooks.recent_news?.length ?? 0) > 0;

    result.hooks = JSON.stringify(hooks);
    result.scrape_status = 'ok';

    const total = (hooks.case_studies?.length ?? 0)
      + (hooks.testimonials?.length ?? 0)
      + (hooks.notable_customers?.length ?? 0)
      + (hooks.recent_news?.length ?? 0);

    process.stdout.write(`${hasAnyHooks ? `${total} hooks` : 'no hooks'}`);
  } catch (err) {
    console.error(` error: ${err instanceof Error ? err.message : err}`);
    result.scrape_status = 'error';
  }

  return result;
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

      console.log(`\n[scrape] Reading: ${inputFile}`);
      const companies: EnrichedCompany[] = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
      console.log(`[scrape] Scraping hooks from ${companies.length} company websites...`);

      const results: CompanyWithHooks[] = [];
      let okCount = 0;
      let errorCount = 0;

      try {
        for (let i = 0; i < companies.length; i++) {
          const company = companies[i];
          process.stdout.write(`  [${i + 1}/${companies.length}] ${company.domain} ... `);

          const page = await newPage();
          try {
            const scraped = await scrapeCompany(page, company);
            results.push(scraped);

            if (scraped.scrape_status === 'ok') {
              okCount++;
              console.log('');
            } else {
              errorCount++;
              console.log(' (error)');
            }
          } finally {
            await page.close();
          }

          // Write incrementally every 5 companies
          if ((i + 1) % 5 === 0) {
            fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
          }
        }
      } finally {
        await closeBrowser();
      }

      fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

      console.log(`\n[scrape] Results:`);
      console.log(`  Scraped OK: ${okCount}`);
      console.log(`  Errors:     ${errorCount}`);
      console.log(`[scrape] Done. Written to ${outputPath}`);

      const output: StepOutput = {
        summary: `Scraped hooks from ${companies.length} companies: ${okCount} OK, ${errorCount} errors`,
        inputCount: companies.length,
        outputCount: results.length,
        warnings: errorCount > 0 ? [`${errorCount} companies failed to scrape`] : undefined,
      };
      return { data: results, output };
    },
  );

  if (!result.success) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[scrape] Fatal error:', err);
  process.exit(1);
});
