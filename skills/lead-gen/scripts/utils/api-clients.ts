import os from 'os';
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
import { getWorkspaceHome } from './paths.js';

// Load .env from workspace home
dotenvConfig({ path: path.join(getWorkspaceHome(), '.env') });

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const NORBERT_API_KEY = process.env.NORBERT_API_KEY;

function isLocalMode(): boolean {
  return process.env.LEAD_GEN_LOCAL_MODE === 'true';
}

export interface ApolloPersonMatch {
  id?: string;
  first_name?: string;
  last_name?: string;
  last_name_obfuscated?: string;
  title?: string;
  email?: string;
  has_email?: boolean;
  linkedin_url?: string;
  organization?: {
    name?: string;
    estimated_num_employees?: number;
    has_employee_count?: boolean;
    industry?: string;
    has_industry?: boolean;
  };
}

export interface ApolloSearchResponse {
  people?: ApolloPersonMatch[];
  person?: ApolloPersonMatch;
}

export async function apolloEnrichByDomain(
  domain: string,
  titles: string[] = ['CEO', 'Founder', 'Co-Founder', 'Chief Executive Officer']
): Promise<ApolloPersonMatch | null> {
  if (isLocalMode()) {
    return localEnrichByDomain(domain, titles);
  }

  if (!APOLLO_API_KEY) {
    throw new Error('APOLLO_API_KEY environment variable is not set');
  }

  const searchUrl = new URL('https://api.apollo.io/api/v1/mixed_people/api_search');
  searchUrl.searchParams.append('q_organization_domains_list[]', domain);
  for (const title of titles) {
    searchUrl.searchParams.append('person_titles[]', title);
  }
  searchUrl.searchParams.append('page', '1');
  searchUrl.searchParams.append('per_page', '1');

  const response = await fetch(searchUrl, {
    method: 'POST',
    headers: {
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-api-key': APOLLO_API_KEY
    }
  });

  if (!response.ok) {
    console.error(`Apollo search failed: ${response.status}`);
    return null;
  }

  const data = await response.json() as ApolloSearchResponse;
  return data.people?.[0] ?? null;
}

export async function apolloEnrichById(
  personId: string
): Promise<ApolloPersonMatch | null> {
  if (!APOLLO_API_KEY) {
    throw new Error('APOLLO_API_KEY environment variable is not set');
  }

  const response = await fetch('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'x-api-key': APOLLO_API_KEY
    },
    body: JSON.stringify({
      id: personId,
      reveal_personal_emails: true,
    }),
  });

  if (!response.ok) {
    console.error(`Apollo enrich failed: ${response.status}`);
    return null;
  }

  const data = await response.json() as ApolloSearchResponse;
  return data.person ?? null;
}

export interface NorbertVerificationResult {
  email: string;
  result: string;
  score: number;
}

export interface NorbertResponse {
  email?: string;
  result?: string;
  score?: number;
}

export async function verifyEmailNorbert(email: string): Promise<NorbertVerificationResult> {
  if (isLocalMode()) {
    return localVerifyEmail(email);
  }

  if (!NORBERT_API_KEY) {
    throw new Error('NORBERT_API_KEY environment variable is not set');
  }

  const response = await fetch('https://api.voilanorbert.com/2018-01-08/verify', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${NORBERT_API_KEY}:`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });

  if (!response.ok) {
    console.error(`Norbert verification failed for ${email}: ${response.status}`);
    return { email, result: 'unknown', score: 0 };
  }

  const data = (await response.json()) as NorbertResponse;
  return {
    email: data.email ?? email,
    result: data.result ?? 'unknown',
    score: data.score ?? 0,
  };
}

export async function verifyEmailsBatch(emails: string[]): Promise<Map<string, NorbertVerificationResult>> {
  const results = new Map<string, NorbertVerificationResult>();

  for (const email of emails) {
    if (!email) continue;
    try {
      const result = await verifyEmailNorbert(email);
      results.set(email, result);
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      console.error(`Failed to verify ${email}:`, error);
      results.set(email, { email, result: 'unknown', score: 0 });
    }
  }

  return results;
}

// --- Local mode providers ---

function localEnrichByDomain(
  domain: string,
  titles: string[]
): ApolloPersonMatch {
  console.log(`[LOCAL] Enriching domain: ${domain}`);
  const cleanDomain = domain.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
  const companyName = cleanDomain.split('.')[0];

  return {
    id: `local-${cleanDomain}`,
    first_name: undefined,
    last_name: undefined,
    title: titles[0],
    email: `ceo@${cleanDomain}`,
    has_email: true,
    linkedin_url: `https://www.linkedin.com/company/${companyName}`,
    organization: {
      name: companyName,
      estimated_num_employees: undefined,
      has_employee_count: false,
      industry: undefined,
      has_industry: false,
    },
  };
}

async function localVerifyEmail(email: string): Promise<NorbertVerificationResult> {
  console.log(`[LOCAL] Verifying email: ${email}`);
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { email, result: 'invalid', score: 0 };
  }
  return { email, result: 'accept_all', score: 50 };
}
