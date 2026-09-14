export function normalizeVersion(value) {
  return String(value).trim().replace(/^v/, '');
}

export function parseSemver(value) {
  const match = normalizeVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : undefined;
}

export function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  if (!left || !right) throw new Error(`Cannot compare invalid semantic versions '${leftValue}' and '${rightValue}'.`);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  return 0;
}

export function isPatchUpgrade(currentValue, targetValue) {
  const current = parseSemver(currentValue);
  const target = parseSemver(targetValue);
  return Boolean(
    current && target &&
    current.major === target.major &&
    current.minor === target.minor &&
    target.patch > current.patch
  );
}
