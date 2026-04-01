import fs from 'fs';
import { PATHS } from './paths.js';

export interface Filters {
  excludeDomains: string[];
  excludePatterns: string[];
  includeDomains: string[];
  aggregatorExcludeDomains: string[];
}

export const DEFAULT_FILTERS: Filters = {
  excludeDomains: [
    'linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
    'youtube.com', 'github.com', 'crunchbase.com', 'builtin.com', 'f6s.com',
    'angellist.com', 'wellfound.com', 'techcrunch.com', 'forbes.com',
    'medium.com', 'wikipedia.org', 'google.com', 'apple.com', 'microsoft.com',
    'amazon.com', 'ycombinator.com', 'techstars.com', 'list-manage.com',
    'jotform.com', 'typeform.com', 'mailchimp.com', 'hubspot.com',
    'googleforms.com', 'surveymonkey.com', 'pitchbook.com', 'cbre.com',
    'bloomberg.com', 'reuters.com', 'wsj.com', 'nytimes.com', 'reddit.com',
    'quora.com', 'glassdoor.com', 'indeed.com', 'zoominfo.com', 'dnb.com',
  ],
  excludePatterns: ['mailto:', 'tel:', 'javascript:'],
  includeDomains: [],
  aggregatorExcludeDomains: [
    'linkedin.com', 'twitter.com', 'facebook.com', 'instagram.com',
    'youtube.com', 'github.com', 'wikipedia.org',
  ],
};

/**
 * Parse a markdown bullet list section into an array of string values.
 * Handles lines starting with "- " and strips inline code/italics markers.
 */
export function parseBulletList(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
    .filter(line => line.length > 0 && !line.startsWith('_('));
}

/**
 * Parse a markdown document into named sections.
 * Returns a map of section heading (lowercased) to section body text.
 */
export function parseSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();

  // Strip frontmatter (--- ... ---) if present
  let body = content;
  if (content.startsWith('---')) {
    const endFrontmatter = content.indexOf('\n---', 3);
    if (endFrontmatter !== -1) {
      body = content.slice(endFrontmatter + 4);
    }
  }

  const lines = body.split('\n');
  let currentSection: string | null = null;
  const sectionLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      if (currentSection !== null) {
        sections.set(currentSection, sectionLines.join('\n'));
        sectionLines.length = 0;
      }
      currentSection = headingMatch[1].trim().toLowerCase();
    } else if (currentSection !== null) {
      sectionLines.push(line);
    }
  }

  if (currentSection !== null) {
    sections.set(currentSection, sectionLines.join('\n'));
  }

  return sections;
}

/**
 * Load filters from the config/filters.md file.
 * Falls back to DEFAULT_FILTERS if the file does not exist or cannot be parsed.
 */
export function loadFilters(): Filters {
  const filtersPath = PATHS.filters;

  if (!fs.existsSync(filtersPath)) {
    return { ...DEFAULT_FILTERS };
  }

  try {
    const content = fs.readFileSync(filtersPath, 'utf-8');
    const sections = parseSections(content);

    const excludeDomains = sections.has('exclude domains')
      ? parseBulletList(sections.get('exclude domains')!)
      : DEFAULT_FILTERS.excludeDomains;

    const excludePatterns = sections.has('exclude patterns')
      ? parseBulletList(sections.get('exclude patterns')!)
      : DEFAULT_FILTERS.excludePatterns;

    const includeDomains = sections.has('include domains')
      ? parseBulletList(sections.get('include domains')!)
      : DEFAULT_FILTERS.includeDomains;

    const aggregatorExcludeDomains = sections.has('aggregator exclude domains')
      ? parseBulletList(sections.get('aggregator exclude domains')!)
      : DEFAULT_FILTERS.aggregatorExcludeDomains;

    return { excludeDomains, excludePatterns, includeDomains, aggregatorExcludeDomains };
  } catch (error) {
    console.error('Failed to load filters, using defaults:', error instanceof Error ? error.message : error);
    return { ...DEFAULT_FILTERS };
  }
}

/**
 * Returns true if the URL matches any excluded domain or pattern.
 */
export function isExcludedUrl(url: string, filters: Filters): boolean {
  if (!url) return true;

  for (const pattern of filters.excludePatterns) {
    if (url.startsWith(pattern)) return true;
  }

  try {
    const hostname = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
    return filters.excludeDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/**
 * Returns true if the URL's domain is in the includeDomains list.
 * When includeDomains is empty, all non-excluded domains are considered included.
 */
export function isIncludedDomain(url: string, filters: Filters): boolean {
  if (filters.includeDomains.length === 0) return true;

  try {
    const hostname = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
    return filters.includeDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/**
 * Returns true if the URL should be excluded from aggregator scraping.
 */
export function isAggregatorExcluded(url: string, filters: Filters): boolean {
  if (!url) return true;

  try {
    const hostname = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
    return filters.aggregatorExcludeDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}
