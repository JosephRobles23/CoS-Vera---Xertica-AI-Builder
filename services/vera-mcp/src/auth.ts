/**
 * auth.ts — defaultHandler del OAuthProvider: rutas que NO son /mcp.
 *
 *  POST /enroll     — llamado por GAS (sidebar "Conectar"): {webAppUrl, secret}. Verifica por
 *                     challenge-response que ese /exec posee el secreto y crea un pairing-code.
 *  GET  /authorize  — página donde el CLEVE pega el pairing-code (paso de identidad del OAuth).
 *  POST /authorize  — consume el code → crea el tenant → completa la autorización con
 *                     props={tenantId}. El provider maneja /token y /register.
 *
 * ⚠️ Los métodos de env.OAUTH_PROVIDER (parseAuthRequest / completeAuthorization) siguen el
 *    contrato documentado de @cloudflare/workers-oauth-provider; confirmar nombres/firmas
 *    exactos contra su README antes del primer deploy (ver README.md §Confirmar).
 */
import type { Env } from './env';
import { verifyDeployment } from './gasClient';
import { createPairing, consumePairing, createTenant } from './storage';
import { pairingCode } from './crypto';

const PAIRING_TTL_MS = 10 * 60 * 1000; // 10 min (Q12)

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function authorizePage(message = ''): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar Vera</title>
<body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem">
<h1>Conectar Vera</h1>
<p>Abre tu hoja del CoS → botón <b>Conectar con Claude/ChatGPT</b> y pega aquí el código.</p>
${message ? `<p style="color:#b91c1c">${message}</p>` : ''}
<form method="POST">
  <input name="code" autofocus autocomplete="off" placeholder="CÓDIGO"
    style="font-size:1.2rem;letter-spacing:.2em;padding:.6rem;width:100%;text-transform:uppercase">
  <button style="margin-top:1rem;padding:.6rem 1.2rem;font-size:1rem">Conectar</button>
</form></body>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // --- Enrollment (GAS → Worker) ---
    if (url.pathname === '/enroll' && request.method === 'POST') {
      let body: { webAppUrl?: string; secret?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: 'bad-request' }, 400); }
      const webAppUrl = String(body.webAppUrl || '');
      const secret = String(body.secret || '');
      if (!/^https:\/\/[^?#]+\/exec/i.test(webAppUrl) || !secret) {
        return json({ ok: false, error: 'invalid-params' }, 400);
      }
      const ok = await verifyDeployment(webAppUrl, secret).catch(() => false);
      if (!ok) return json({ ok: false, error: 'challenge-failed' }, 400);
      const code = pairingCode();
      await createPairing(env, code, webAppUrl, secret, PAIRING_TTL_MS);
      return json({ ok: true, code, expiresInSeconds: PAIRING_TTL_MS / 1000 });
    }

    // --- OAuth authorize: página del pairing-code ---
    if (url.pathname === '/authorize') {
      if (request.method === 'GET') return html(authorizePage());

      if (request.method === 'POST') {
        const form = await request.formData();
        const code = String(form.get('code') || '').trim().toUpperCase();
        const pairing = code ? await consumePairing(env, code) : null;
        if (!pairing) return html(authorizePage('Código inválido o vencido. Genera uno nuevo desde el sidebar.'), 400);

        const tenantId = crypto.randomUUID();
        await createTenant(env, tenantId, pairing.webAppUrl, pairing.secret);

        // Completa el flujo OAuth atando props={tenantId} al token que el provider emitirá.
        const authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: authReq,
          userId: tenantId,
          metadata: {},
          scope: authReq.scope,
          props: { tenantId }
        });
        return Response.redirect(redirectTo, 302);
      }
    }

    return new Response('Not found', { status: 404 });
  }
};
