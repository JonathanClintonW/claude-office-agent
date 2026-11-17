/**
 * Pre-publish audit: lists the files git would publish (honouring .gitignore, without
 * creating a repository in the project) and scans them for secret-shaped strings,
 * machine-specific paths and the local Agent Office token.
 *
 * Usage: node scripts/audit-publish.cjs ["extra term" ...]
 *   Extra terms (e.g. your username, company or project names) are matched case-insensitively.
 *   Exit code 1 if anything is found. "Review" lines (credential-shaped test fixtures, e-mail
 *   addresses, home-directory paths with a placeholder-like name) are printed but do not fail.
 *   Findings show the file, line and kind only: matched values are never printed.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-audit-'));
let files;
try {
  const env = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: root };
  execFileSync('git', ['init', '-q'], { env });
  files = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { env, cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
} finally {
  fs.rmSync(gitDir, { recursive: true, force: true });
}

const binary = /\.(woff2?|ttf|otf|png|jpe?g|gif|webp|ico|mp4|webm|zip|vsix)$/i;
const home = os.homedir();
const user = os.userInfo().username;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Names used in examples and tests, not real accounts. */
const PLACEHOLDER = '(?:name|user|users|username|you|me|dev|u|alice|bob|example|test|runner|node|public|default)\\b';
const checks = [
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{8,}/],
  ['OpenAI-style key', /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Slack webhook', /hooks\.slack\.com\/services\/T[A-Z0-9]+/],
  ['Stripe live key', /\b[rs]k_live_[A-Za-z0-9]{16,}/],
  ['AWS key id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['npm token', new RegExp('\\bnpm_[A-Za-z0-9]{30,}|_auth' + 'Token')],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['home directory path', new RegExp(home.replace(/[\\/]/g, '[\\\\/]+').replace(/[.*+?^${}()|]/g, (c) => (c === '[' || c === ']' ? c : `\\${c}`)), 'i')],
  ['Windows user-profile path', new RegExp(`\\b[A-Za-z]:(?:\\\\+|/)Users(?:\\\\+|/)(?![<%$({]|${PLACEHOLDER})[A-Za-z0-9._-]{2,}`, 'i')],
  ['OS username', new RegExp(`\\b${esc(user)}\\b`, 'i')],
];
for (const term of process.argv.slice(2)) checks.push([`term "${term}"`, new RegExp(esc(term), 'i')]);

/** Worth a look, but expected in redaction tests and examples: reported, never fatal. */
const reviews = [
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/],
  ['credentials in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]+:[^\s/@'"`]{3,}@[a-z0-9.-]+/i],
  ['secret assignment', /\b(password|passwd|secret|api[_-]?key|client[_-]?secret|auth[_-]?token)["']?\s*[:=]\s*["'`][^"'`\s]{8,}["'`]/i],
  ['e-mail address', /\b[A-Za-z0-9._%+-]+@(?!example\.|[^\s"'`]*\.invalid\b|users\.noreply\.github\.com)[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[A-Za-z]{2,}\b/],
  ['home directory path', new RegExp(`/(?:Users|home)/(?!${PLACEHOLDER})[A-Za-z0-9._-]{2,}`, 'i')],
];

let token;
try {
  token = JSON.parse(fs.readFileSync(path.join(process.env.AGENT_OFFICE_HOME || path.join(home, '.agent-office'), 'config.json'), 'utf8')).token;
} catch {
  /* no local config */
}

const findings = [];
const toReview = [];
for (const rel of files) {
  if (binary.test(rel)) continue;
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  if (token && text.includes(token)) findings.push(`${rel}: contains the local Agent Office token`);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [name, re] of checks) if (re.test(line)) findings.push(`${rel}:${i + 1}: ${name}`);
    for (const [name, re] of reviews) if (re.test(line)) toReview.push(`${rel}:${i + 1}: ${name}`);
  });
}

console.log(`Files that would be published: ${files.length}`);
const leaky = files.filter((f) =>
  /(^|\/)(\.env(\..*)?|\.envrc|\.npmrc|\.netrc|settings\.local\.json|\.credentials\.json|\.claude\.json)$|(^|\/)(id_rsa|id_ed25519)|\.(pem|key|p12|pfx|jks|keystore|jsonl|vsix|log)$|\.agent-office-backup-|(^|\/)(dist|media\/ui|node_modules|\.agent-office|coverage)\//.test(f) &&
  !/(^|\/)\.env\.example$/.test(f),
);
for (const f of leaky) findings.push(`${f}: should not be published (secret, local data or build output)`);
if (toReview.length) {
  console.log(`\n${toReview.length} line(s) to review (credential-shaped fixtures, e-mail addresses, home paths):`);
  for (const r of toReview) console.log(`  ${r}`);
}
if (findings.length) {
  console.log(`\n${findings.length} finding(s):`);
  for (const f of findings) console.log(`  ${f}`);
  process.exit(1);
}
console.log('\nNo secrets, local paths, usernames or tokens found.');
