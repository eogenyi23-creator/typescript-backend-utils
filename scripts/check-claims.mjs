/**
 * Verifies the claims audit in docs/claims-audit.md:
 *
 * 1. Every row in the main claim table has a Status column value.
 * 2. Every row with status `test-backed` names a test file and a test title that
 *    can actually be found in the tests/ directory.
 * 3. No row is missing its status.
 *
 * Usage: node scripts/check-claims.mjs
 *
 * Table row format (Markdown):
 *   | # | Claim | Where | Code | Test file | Test title | Status |
 *
 * The script reads the test files directly and checks that each named test title
 * appears as a string literal inside the named test file. It does not run the tests.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const audit = readFileSync(join(root, 'docs', 'claims-audit.md'), 'utf8');

// ---------------------------------------------------------------------------
// Parse the main claim table
// ---------------------------------------------------------------------------

// Match rows in the main claim table: lines starting with | and containing
// a row number (not the header or separator).
const rowRe = /^\|\s*(\d+)\s*\|(.+?)\|(.+?)\|(.+?)\|(.+?)\|(.+?)\|(.+?)\|$/gm;

const rows = [];
let match;
while ((match = rowRe.exec(audit)) !== null) {
  const [, num, claim, where, code, testFile, testTitle, status] = match.map((s) =>
    typeof s === 'string' ? s.trim() : s
  );
  rows.push({ num, claim, where, code, testFile, testTitle, status });
}

if (rows.length === 0) {
  console.error('check-claims: no claim rows found in docs/claims-audit.md');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Collect all test file content
// ---------------------------------------------------------------------------

function collectTestFiles(dir) {
  const files = {};
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      Object.assign(files, collectTestFiles(full));
    } else if (entry.endsWith('.test.ts')) {
      files[`tests/${full.slice(join(root, 'tests').length + 1)}`] = readFileSync(full, 'utf8');
    }
  }
  return files;
}

const testFiles = collectTestFiles(join(root, 'tests'));

// ---------------------------------------------------------------------------
// Validate each row
// ---------------------------------------------------------------------------

let failed = 0;
const errors = [];

for (const row of rows) {
  // 1. Check status is present and valid
  const validStatuses = ['test-backed', 'code-only', 'not verified'];
  if (!validStatuses.includes(row.status)) {
    errors.push(`  Row #${row.num}: invalid or missing status "${row.status}" (must be one of: ${validStatuses.join(', ')})`);
    failed++;
    continue;
  }

  // 2. For test-backed rows, check that the named file and title exist
  if (row.status === 'test-backed') {
    if (!row.testFile || row.testFile === '—' || row.testFile.trim() === '') {
      errors.push(`  Row #${row.num}: status is test-backed but test file is empty`);
      failed++;
      continue;
    }
    if (!row.testTitle || row.testTitle === '—' || row.testTitle.trim() === '') {
      errors.push(`  Row #${row.num}: status is test-backed but test title is empty`);
      failed++;
      continue;
    }

    // Normalise the file path to match the keys in testFiles
    // Remove backtick formatting from markdown table cells
    const normFile = row.testFile.trim().replace(/^`|`$/g, '').replace(/^\.\//, '');
    const fileContent = testFiles[normFile];

    if (!fileContent) {
      errors.push(`  Row #${row.num}: test file "${normFile}" not found in tests/ (available: ${Object.keys(testFiles).join(', ')})`);
      failed++;
      continue;
    }

    // Check the test title appears in the file. The audit uses "describe > it" notation;
    // extract just the leaf it() title (last segment after '>') for the search.
    // Also handle backtick escapes in the title.
    const normTitle = row.testTitle.trim().replace(/^`|`$/g, '').replace(/\\`/g, '`');
    // Extract leaf title: last segment after ' > ' if present
    const segments = normTitle.split(' > ');
    const leafTitle = segments[segments.length - 1].trim();
    if (!fileContent.includes(leafTitle)) {
      errors.push(`  Row #${row.num}: test title "${leafTitle}" not found in ${normFile}`);
      failed++;
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const testBacked = rows.filter((r) => r.status === 'test-backed').length;
const codeOnly   = rows.filter((r) => r.status === 'code-only').length;
const notVerified = rows.filter((r) => r.status === 'not verified').length;

if (failed > 0) {
  console.error(`check-claims: ${failed} of ${rows.length} rows failed:\n`);
  errors.forEach((e) => console.error(e));
  process.exit(1);
}

console.log(
  `check-claims: ${rows.length} rows validated.\n` +
  `  test-backed: ${testBacked}  code-only: ${codeOnly}  not-verified: ${notVerified} ✓`
);
