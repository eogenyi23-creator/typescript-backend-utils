/**
 * Verifies that every fenced TypeScript code block in README.md that is tagged
 * with a module name appears (character-for-character) in the corresponding
 * examples/ file.
 *
 * Usage: node scripts/check-readme-examples.mjs
 *
 * The README uses markers of the form:
 *   <!-- example: <filename-without-extension> -->
 *   ```typescript
 *   ...code...
 *   ```
 *
 * Any fenced block immediately following one of those markers is checked
 * against examples/<filename>.ts.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const readme = readFileSync(join(root, 'README.md'), 'utf8');

// Find all <!-- example: <name> --> markers followed by a fenced code block.
const markerRe = /<!--\s*example:\s*(\S+)\s*-->\s*```(?:typescript|ts)\n([\s\S]*?)```/g;

let match;
let found = 0;
let failed = 0;
const errors = [];

while ((match = markerRe.exec(readme)) !== null) {
  const [, name, snippet] = match;
  found++;
  const examplePath = join(root, 'examples', `${name}.ts`);

  let exampleContent;
  try {
    exampleContent = readFileSync(examplePath, 'utf8');
  } catch {
    errors.push(`  MISSING  examples/${name}.ts  (referenced by <!-- example: ${name} --> in README)`);
    failed++;
    continue;
  }

  // Normalise line endings and strip leading/trailing whitespace for comparison.
  const normalise = (s) => s.replace(/\r\n/g, '\n').trim();
  const needleNorm = normalise(snippet);

  if (!normalise(exampleContent).includes(needleNorm)) {
    errors.push(
      `  MISMATCH  examples/${name}.ts does not contain the snippet from README:\n` +
      `  --- README snippet (first 300 chars) ---\n` +
      `  ${snippet.trim().slice(0, 300)}\n` +
      `  ----------------------------------------`
    );
    failed++;
  }
}

if (found === 0) {
  console.error(
    'check-readme-examples: no <!-- example: <name> --> markers found in README.md.\n' +
    'Add markers before each fenced TypeScript block to enable this check.'
  );
  process.exit(1);
}

if (failed > 0) {
  console.error(`check-readme-examples: ${failed} of ${found} snippet(s) failed:\n`);
  errors.forEach((e) => console.error(e));
  process.exit(1);
}

console.log(`check-readme-examples: all ${found} snippet(s) matched. ✓`);
