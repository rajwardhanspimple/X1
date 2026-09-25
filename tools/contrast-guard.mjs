import fs from 'node:fs';

const css = fs.readFileSync('apps/client/src/styles.css', 'utf8');
const tokens = new Map();
for (const match of css.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) tokens.set(match[1], match[2]);
const luminance = (hex) => {
  const channels = [0, 2, 4].map((i) => parseInt(hex.slice(i + 1, i + 3), 16) / 255);
  const linear = channels.map((c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};
const ratio = (a, b) => {
  const light = Math.max(luminance(a), luminance(b));
  const dark = Math.min(luminance(a), luminance(b));
  return (light + 0.05) / (dark + 0.05);
};
const pairs = [
  ['--ink-primary', '--surface-base'],
  ['--ink-secondary', '--surface-base'],
  ['--ink-label', '--surface-base'],
  ['--ink-primary', '--surface-raised'],
];
const failures = [];
for (const [foreground, background] of pairs) {
  const value = ratio(tokens.get(foreground), tokens.get(background));
  if (value < 4.5) failures.push(`${foreground} on ${background}: ${value.toFixed(2)}:1`);
}
if (failures.length) {
  console.error(`Contrast guard failed (body text requires 4.5:1):\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`Contrast guard passed for ${pairs.length} body-text token pairs.`);
