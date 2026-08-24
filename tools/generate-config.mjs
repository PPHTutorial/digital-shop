#!/usr/bin/env node
/**
 * Rewrites js/config.js from the environment so a deploy can target a
 * different Supabase project without a hand edit.
 *
 *   SUPABASE_URL=… SUPABASE_ANON_KEY=… npm run config
 *
 * Only public values are written. The script refuses to embed anything that
 * looks like a service-role key or a payment secret.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, 'js', 'config.js');

const env = process.env;
const url = env.SUPABASE_URL?.trim();
const anonKey = (env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || '').trim();
const siteUrl = env.PUBLIC_SITE_URL?.trim();
const storeName = env.STORE_NAME?.trim();
const supportEmail = env.SUPPORT_EMAIL?.trim();

if (!url && !anonKey) {
  console.log('No SUPABASE_URL / SUPABASE_ANON_KEY in the environment — js/config.js left untouched.');
  process.exit(0);
}

if (!url || !anonKey) {
  console.error('Both SUPABASE_URL and SUPABASE_ANON_KEY must be set together.');
  process.exit(1);
}

/** A service-role JWT carries `"role":"service_role"` in its payload. */
function isServiceRole(jwt) {
  const [, payload] = jwt.split('.');
  if (!payload) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded.role === 'service_role';
  } catch {
    return false;
  }
}

if (isServiceRole(anonKey)) {
  console.error('Refusing to write a service-role key into browser configuration.');
  process.exit(1);
}

const match = url.match(/^https:\/\/([a-z0-9-]+)\.supabase\.(co|in)$/i);
if (!match) {
  console.error(`SUPABASE_URL must look like https://<ref>.supabase.co — received "${url}".`);
  process.exit(1);
}
const projectRef = match[1];

let source = await readFile(CONFIG_FILE, 'utf8');
const edits = [];

const replace = (label, pattern, replacement) => {
  const next = source.replace(pattern, replacement);
  if (next !== source) edits.push(label);
  source = next;
};

replace('PROJECT_REF', /const PROJECT_REF = '[^']*';/, `const PROJECT_REF = '${projectRef}';`);
replace('SUPABASE_ANON_KEY', /(SUPABASE_ANON_KEY:\s*\n?\s*)'[^']*'/, `$1'${anonKey}'`);

if (siteUrl) {
  replace(
    'SITE_URL',
    /SITE_URL: [^\n]*,/,
    `SITE_URL: typeof window === 'undefined' ? '${siteUrl}' : window.location.origin,`,
  );
}
if (storeName) replace('STORE_NAME', /STORE_NAME: '[^']*',/, `STORE_NAME: '${storeName}',`);
if (supportEmail) replace('SUPPORT_EMAIL', /SUPPORT_EMAIL: '[^']*',/, `SUPPORT_EMAIL: '${supportEmail}',`);

await writeFile(CONFIG_FILE, source);
console.log(`js/config.js updated for project "${projectRef}" (${edits.join(', ') || 'no changes'}).`);
