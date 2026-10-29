/**
 * Local helper for capturing a Rally.tv user session token.
 *
 * Rally.tv uses Auth0 email OTP (no password). This script cannot complete OTP
 * without your mailbox. It prints the exact browser steps and optionally
 * validates a token you paste.
 *
 * Usage:
 *   npm run login-helper
 *   npm run login-helper -- --check
 *   RALLYTV_AUTH_TOKEN='eyJ...' npm run login-helper -- --check
 */

import * as readline from 'readline';

const CLIENT_ID = 'zL90h7Q1y0684rRPC2O3UwZQqPodIiVX';

function printInstructions(): void {
  console.log(`
Rally.tv Auth0 session helper
=============================

1. Open https://www.rally.tv/en in Chrome/Firefox and complete email OTP login.
2. Open DevTools → Application/Storage → Local Storage for https://www.rally.tv
   (or Network → any abs-gateway / account request → Authorization header).
3. Copy the Auth0 access token (JWT). It usually starts with "eyJ".
4. Paste it into the Stremio addon configure page field "Auth0 access token",
   or set RALLYTV_AUTH_TOKEN for local scripts.

Auth0 domain: login.rally.tv
Client ID:    ${CLIENT_ID}
Account UI:   https://account.rally.tv

Notes:
- Anonymous device sessions (api.redbull.tv/v3/session) are obtained automatically
  by the addon for search — you do not paste those.
- Streams inspected on 2026-10-29 played as clear HLS without a user token.
  Keep a user token handy if play starts returning 401/403 (re-auth required).
- Never commit tokens. Do not share your addon install URL if it embeds secrets.
`);
}

async function checkToken(token: string): Promise<void> {
  const auth = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  const res = await fetch('https://abs-gateway.redbull.com/', {
    headers: {
      Authorization: auth,
      Accept: 'application/json',
      'User-Agent': 'rallytv-stremio-addon-login-helper',
    },
    redirect: 'manual',
  });
  console.log('abs-gateway probe status:', res.status);
  console.log(
    '(403/404 from the root path is common; use Stremio play errors as the real signal.)',
  );

  // Decode JWT payload without verifying — local inspection only
  try {
    const raw = token.replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(Buffer.from(raw.split('.')[1], 'base64url').toString('utf8')) as {
      iss?: string;
      aud?: string | string[];
      exp?: number;
      sub?: string;
    };
    console.log('JWT claims (unverified):', {
      iss: payload.iss,
      aud: payload.aud,
      exp: payload.exp ? new Date(payload.exp * 1000).toISOString() : undefined,
      sub: payload.sub,
    });
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      console.error('Token is expired — log in again.');
      process.exit(2);
    }
  } catch {
    console.warn('Could not decode JWT payload; ensure you pasted the full access token.');
  }
}

async function promptToken(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) =>
    rl.question('Paste Auth0 access token (or empty to skip): ', resolve),
  );
  rl.close();
  return (answer || '').trim();
}

async function main(): Promise<void> {
  printInstructions();
  const check = process.argv.includes('--check');
  let token = process.env.RALLYTV_AUTH_TOKEN || '';
  if (check && !token) {
    token = await promptToken();
  }
  if (check && token) {
    await checkToken(token);
  } else if (check) {
    console.log('No token provided.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
