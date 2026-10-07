import type { SetupSettings } from '../setup/settings.js';
import type { DomainPolicy } from './browser-core.js';

export const SOCIAL_PLATFORM_IDS = ['youtube', 'tiktok'] as const;
export type SocialPlatform = typeof SOCIAL_PLATFORM_IDS[number];

export const SOCIAL_PLATFORM_DOMAINS: Record<SocialPlatform, readonly string[]> = {
  youtube: [
    'youtube.com',
    'google.com',
    'googleapis.com',
    'gstatic.com',
    'googleusercontent.com',
    'ggpht.com',
    'ytimg.com',
    'googlevideo.com'
  ],
  tiktok: [
    'tiktok.com',
    'tiktokcdn.com',
    'tiktokv.com',
    'byteoversea.com',
    'ibytedtos.com',
    'ibyteimg.com',
    'byteimg.com',
    'muscdn.com'
  ]
};

function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!domain || domain.length > 253 || !/^[a-z0-9.-]+$/.test(domain) || domain.includes('..')) {
    throw new Error(`Invalid browser allowed domain '${value}'.`);
  }
  return domain;
}

export function browserDomainRules(settings: Pick<SetupSettings, 'browser' | 'social'>): string[] {
  const rules = new Set<string>();
  for (const value of settings.browser.allowedDomains) rules.add(normalizeDomain(value));
  for (const platform of settings.social.enabledPlatforms) {
    for (const value of SOCIAL_PLATFORM_DOMAINS[platform]) rules.add(normalizeDomain(value));
  }
  return [...rules].sort();
}

export function domainMatchesRule(hostname: string, rule: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  const normalizedRule = normalizeDomain(rule);
  return host === normalizedRule || host.endsWith(`.${normalizedRule}`);
}

export function createBrowserDomainPolicy(settings: Pick<SetupSettings, 'browser' | 'social'>): DomainPolicy {
  const rules = browserDomainRules(settings);
  return hostname => rules.some(rule => domainMatchesRule(hostname, rule));
}
