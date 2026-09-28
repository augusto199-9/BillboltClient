// Builds DATABASE_URL and DIRECT_URL from separate, simple pieces
// (SUPABASE_HOST / SUPABASE_USER / SUPABASE_PASSWORD / SUPABASE_DATABASE)
// instead of requiring you to hand-assemble a connection string.
//
// Why: a Postgres password with symbols like `$` has to be percent-encoded
// inside a URL (`$` -> `%24`) or the connection breaks — and doing that by
// hand is exactly where mistakes creep in (extra spaces, double-encoding,
// a missing `@`). This script does that encoding in code, correctly, every
// time, so you just paste the raw password as Supabase shows it — nothing
// to type by hand, nothing to get wrong.
//
// Runs automatically as part of the Render build step (see package.json).
// If DATABASE_URL / DIRECT_URL are already set directly instead, this
// script does nothing and leaves them alone.
const fs = require('fs');
const path = require('path');

const host = process.env.SUPABASE_HOST;
const user = process.env.SUPABASE_USER;
const password = process.env.SUPABASE_PASSWORD;
const database = process.env.SUPABASE_DATABASE || 'postgres';
const poolPort = process.env.SUPABASE_POOL_PORT || '6543';
const directPort = process.env.SUPABASE_DIRECT_PORT || '5432';

if (process.env.DATABASE_URL && process.env.DIRECT_URL) {
  console.log('[prepare-env] DATABASE_URL and DIRECT_URL are already set — leaving them as-is.');
  process.exit(0);
}

if (!host || !user || !password) {
  console.log(
    '[prepare-env] SUPABASE_HOST / SUPABASE_USER / SUPABASE_PASSWORD are not all set, ' +
      'and DATABASE_URL/DIRECT_URL are missing too. Nothing to build — set one or the other.'
  );
  process.exit(0);
}

function buildUrl(port, extra) {
  // encodeURIComponent correctly escapes $, @, /, spaces, etc. — this is
  // the one and only place any encoding happens, and it's always correct.
  const u = encodeURIComponent(user);
  const p = encodeURIComponent(password);
  return `postgresql://${u}:${p}@${host}:${port}/${database}${extra || ''}`;
}

const databaseUrl = buildUrl(poolPort, '?pgbouncer=true');
const directUrl = buildUrl(directPort);

const envPath = path.join(__dirname, '..', '.env');
let existingLines = [];
try {
  existingLines = fs
    .readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('DATABASE_URL=') && !l.startsWith('DIRECT_URL='));
} catch (e) {
  /* no existing .env yet — that's fine */
}

existingLines.push(`DATABASE_URL="${databaseUrl}"`);
existingLines.push(`DIRECT_URL="${directUrl}"`);
fs.writeFileSync(envPath, existingLines.join('\n') + '\n');
console.log('[prepare-env] Built DATABASE_URL and DIRECT_URL from SUPABASE_* variables.');
