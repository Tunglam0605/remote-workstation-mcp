export const NAVIGATION = Object.freeze([
  {
    id: 'Overview',
    label: 'Home',
    group: 'Home',
    icon: 'house',
    route: 'overview',
    aliases: [],
    legacyRoutes: []
  },
  {
    id: 'Work',
    label: 'Work',
    group: 'Work',
    icon: 'briefcase-business',
    route: 'work',
    aliases: [],
    legacyRoutes: [],
    children: ['Projects', 'Work Sessions', 'Tasks', 'Artifacts']
  },
  {
    id: 'Agents',
    label: 'AI',
    group: 'AI',
    icon: 'sparkles',
    route: 'agents',
    aliases: ['Execution'],
    legacyRoutes: ['execution'],
    children: ['Routing', 'Codex', 'Antigravity', 'Usage & fallback']
  },
  {
    id: 'Engineering',
    label: 'Engineering',
    group: 'Tools',
    icon: 'wrench',
    route: 'engineering',
    aliases: [],
    legacyRoutes: [],
    children: ['Hardware', 'Firmware', 'Debug', 'ROS 2', 'Build tools']
  },
  {
    id: 'Office',
    label: 'Office',
    group: 'Tools',
    icon: 'files',
    route: 'office',
    aliases: [],
    legacyRoutes: [],
    children: ['Word', 'Excel', 'PowerPoint']
  },
  {
    id: 'Web',
    label: 'Web',
    group: 'Tools',
    icon: 'globe-2',
    route: 'web',
    aliases: [],
    legacyRoutes: [],
    children: ['Browser sessions', 'Site adapters', 'NotebookLM']
  },
  {
    id: 'Devices',
    label: 'Devices',
    group: 'System',
    icon: 'monitor',
    route: 'devices',
    aliases: [],
    legacyRoutes: [],
    children: ['Nodes', 'Pairing', 'Multi-node']
  },
  {
    id: 'Security',
    label: 'Security',
    group: 'System',
    icon: 'shield-check',
    route: 'security',
    aliases: ['Access'],
    legacyRoutes: ['access'],
    children: ['Permissions', 'Scopes', 'Leases', 'Approvals']
  },
  {
    id: 'System',
    label: 'System',
    group: 'System',
    icon: 'settings-2',
    route: 'system',
    aliases: ['Updates', 'Settings'],
    legacyRoutes: ['updates', 'settings'],
    children: ['Runtime', 'Updates', 'Recovery', 'Diagnostics']
  }
]);

const PAGE_BY_ID = new Map(NAVIGATION.map(item => [item.id, item]));
const PAGE_BY_ROUTE = new Map(NAVIGATION.map(item => [item.route, item]));
const ALIASES = new Map(NAVIGATION.flatMap(item => item.aliases.map(alias => [alias, item.id])));
const ROUTE_ALIASES = new Map(
  NAVIGATION.flatMap(item => item.legacyRoutes.map((route, index) => [
    route.toLowerCase(),
    item.aliases[index] ?? item.id
  ]))
);

export function canonicalPage(value) {
  if (!value) return 'Overview';
  const text = String(value).trim();
  if (PAGE_BY_ID.has(text)) return text;
  if (ALIASES.has(text)) return ALIASES.get(text);
  const route = text.replace(/^#/, '').toLowerCase();
  return PAGE_BY_ROUTE.get(route)?.id ?? ROUTE_ALIASES.get(route) ?? 'Overview';
}

export function routeForPage(value) {
  return PAGE_BY_ID.get(canonicalPage(value))?.route ?? 'overview';
}

export function pageFromHash(hash = '') {
  const route = String(hash).replace(/^#/, '').trim().toLowerCase();
  return PAGE_BY_ROUTE.get(route)?.id ?? ROUTE_ALIASES.get(route) ?? 'Overview';
}

export function navigationItem(value) {
  return PAGE_BY_ID.get(canonicalPage(value));
}
