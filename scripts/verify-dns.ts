/**
 * Report what is actually published for a domain, independent of intent.
 *
 *   npm run dns:verify -- yourdomain.com
 *
 * Uses the same checks the Worker exposes, so the answer here and the answer
 * in the app cannot disagree.
 */
import { checkPosture, type Grade } from "../src/posture";

const GLYPH: Record<Grade, string> = { ok: "OK  ", weak: "WEAK", missing: "GONE", error: "ERR " };

const domain = process.argv[2];
if (!domain) {
  console.error("usage: npm run dns:verify -- <domain>");
  process.exit(1);
}

const report = await checkPosture(domain);

console.log(`\nEmail security posture for ${report.domain}\n`);
for (const finding of report.findings) {
  console.log(`  [${GLYPH[finding.grade]}] ${finding.name}`);
  if (finding.value) console.log(`         ${finding.value.slice(0, 120)}`);
  console.log(`         ${finding.detail}`);
}
const { ok, weak, missing, error } = report.summary;
console.log(`\n  ${ok} ok · ${weak} weak · ${missing} missing · ${error} error\n`);
// A non-zero exit makes this usable as a deployment gate.
process.exitCode = missing + error > 0 ? 1 : 0;
