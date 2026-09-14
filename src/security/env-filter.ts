const NEVER_INHERIT = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL)/i;

export function buildSafeEnvironment(allowNames: string[], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowNames) {
    if (NEVER_INHERIT.test(name)) continue;
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}
