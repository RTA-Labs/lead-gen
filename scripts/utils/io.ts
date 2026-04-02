import fs from 'fs';

export interface CompaniesFile {
  companies: Record<string, unknown>[];
  city?: string;
  [key: string]: unknown;
}

export function readCompanies<T = Record<string, unknown>>(filePath: string): { companies: T[]; city: string; raw: CompaniesFile } {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (Array.isArray(parsed)) {
    return { companies: parsed as T[], city: '', raw: { companies: parsed, city: '' } };
  }
  return { companies: (parsed.companies ?? []) as T[], city: parsed.city ?? '', raw: parsed };
}
