// Echo Newsletter v1.0.0 — Substack/Beehiiv alternative on Cloudflare Workers

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ENGINE_RUNTIME: Fetcher;
  EMAIL_SENDER: Fetcher;
  SHARED_BRAIN: Fetcher;
  ECHO_API_KEY: string;
  ENVIRONMENT: string;
  AE: AnalyticsEngineDataset;
}

interface RLState { c: number; t: number; }

function uid(): string { return crypto.randomUUID().replace(/-/g, '').slice(0, 16); }
function slug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80); }
function sanitize(s: string, max = 2000): string { return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, max); }
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' , 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'X-XSS-Protection': '1; mode=block', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } });
}
function err(msg: string, status = 400): Response { return json({ error: msg }, status); }

function slog(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), level, worker: 'echo-newsletter', version: '1.0.0', msg, ...data };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

function authOk(req: Request, env: Env): boolean {
  return (req.headers.get('X-Echo-API-Key') || new URL(req.url).searchParams.get('key')) === env.ECHO_API_KEY;
}

async function rateLimit(kv: KVNamespace, key: string, max: number, windowMs: number): Promise<boolean> {
  const raw = await kv.get(`rl:${key}`);
  const now = Date.now();
  let state: RLState = raw ? JSON.parse(raw) : { c: 0, t: now };
  const elapsed = now - state.t;
  const decay = (elapsed / windowMs) * max;
  state.c = Math.max(0, state.c - decay);
  state.t = now;
  if (state.c >= max) return false;
  state.c += 1;
  await kv.put(`rl:${key}`, JSON.stringify(state), { expirationTtl: Math.ceil(windowMs / 1000) * 2 });
  return true;
}

async function hashIP(ip: string): string {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + 'echo-nl-salt'));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': '*' } });
    try {

    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    try { env.AE.writeDataPoint({ blobs: [m, p, '200'], doubles: [Date.now()], indexes: ['echo-newsletter'] }); } catch {}

    // ── Public endpoints ──
    if (p === '/health' || p === '/') return json({ status: 'healthy', service: 'echo-newsletter', version: '1.0.0', timestamp: new Date().toISOString() });
    if (p === '/status') { const r = await env.DB.prepare('SELECT COUNT(*) as c FROM tenants').first<{c:number}>(); return json({ tenants: r?.c || 0 }); }

    // ── Subscriber public endpoints (no auth) ──

    // Subscribe form endpoint
    if (m === 'POST' && p === '/subscribe') {
      const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
      if (!await rateLimit(env.CACHE, `sub:${await hashIP(ip)}`, 5, 3600000)) return err('Rate limited', 429);
      const body = await req.json<{ tenant_id: string; list_id?: string; email: string; name?: string }>().catch(() => null);
      if (!body?.tenant_id || !body?.email) return err('tenant_id and email required');
      const email = sanitize(body.email.toLowerCase().trim(), 320);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('Invalid email');
      const name = body.name ? sanitize(body.name, 200) : null;
      const id = uid();
      const ipHash = await hashIP(ip);
      try {
        await env.DB.prepare('INSERT INTO subscribers (id, tenant_id, email, name, status, source, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, email) DO UPDATE SET name=COALESCE(excluded.name, name), updated_at=datetime(\'now\') RETURNING id, status')
          .bind(id, body.tenant_id, email, name, 'active', 'form', ipHash).first();
        if (body.list_id) {
          const sub = await env.DB.prepare('SELECT id FROM subscribers WHERE tenant_id=? AND email=?').bind(body.tenant_id, email).first<{id:string}>();
          if (sub) await env.DB.prepare('INSERT OR IGNORE INTO list_subscribers (list_id, subscriber_id) VALUES (?, ?)').bind(body.list_id, sub.id).run();
          await env.DB.prepare('UPDATE lists SET subscriber_count = (SELECT COUNT(*) FROM list_subscribers WHERE list_id=?) WHERE id=?').bind(body.list_id, body.list_id).run();
        }
        return json({ ok: true, message: 'Subscribed successfully' });
      } catch (e: any) { return err(e.message, 500); }
    }

    // Unsubscribe
    if (m === 'GET' && p === '/unsubscribe') {
      const sid = url.searchParams.get('sid');
      const tid = url.searchParams.get('tid');
      if (!sid || !tid) return err('Missing parameters');
      await env.DB.prepare('UPDATE subscribers SET status=?, unsubscribed_at=datetime(\'now\') WHERE id=? AND tenant_id=?').bind('unsubscribed', sid, tid).run();
      return new Response('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Unsubscribed</h2><p>You have been removed from the mailing list.</p></body></html>', { headers: { 'Content-Type': 'text/html' } });
    }

    // Open tracking pixel
    if (m === 'GET' && p === '/t/open') {
      const sid = url.searchParams.get('sid');
      const iid = url.searchParams.get('iid');
      if (sid && iid) {
        const tid = url.searchParams.get('tid') || '';
        (async () => {
          await env.DB.prepare('UPDATE sends SET opened_at=COALESCE(opened_at, datetime(\'now\')) WHERE issue_id=? AND subscriber_id=?').bind(iid, sid).run();
          await env.DB.prepare('INSERT INTO events (tenant_id, issue_id, subscriber_id, event_type) VALUES (?, ?, ?, ?)').bind(tid, iid, sid, 'open').run();
          await env.DB.prepare('UPDATE issues SET total_opened = (SELECT COUNT(DISTINCT subscriber_id) FROM sends WHERE issue_id=? AND opened_at IS NOT NULL) WHERE id=?').bind(iid, iid).run();
        })();
      }
      const pixel = new Uint8Array([71,73,70,56,57,97,1,0,1,0,128,0,0,255,255,255,0,0,0,33,249,4,0,0,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]);
      return new Response(pixel, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' } });
    }

    // Click tracking
    if (m === 'GET' && p === '/t/click') {
      const dest = url.searchParams.get('url');
      const sid = url.searchParams.get('sid');
      const iid = url.searchParams.get('iid');
      if (!dest) return err('Missing url');
      if (sid && iid) {
        const tid = url.searchParams.get('tid') || '';
        (async () => {
          await env.DB.prepare('UPDATE sends SET clicked_at=COALESCE(clicked_at, datetime(\'now\')) WHERE issue_id=? AND subscriber_id=?').bind(iid, sid).run();
          await env.DB.prepare('INSERT INTO events (tenant_id, issue_id, subscriber_id, event_type, metadata) VALUES (?, ?, ?, ?, ?)').bind(tid, iid, sid, 'click', JSON.stringify({ url: dest })).run();
          await env.DB.prepare('UPDATE issues SET total_clicked = (SELECT COUNT(DISTINCT subscriber_id) FROM sends WHERE issue_id=? AND clicked_at IS NOT NULL) WHERE id=?').bind(iid, iid).run();
        })();
      }
      return Response.redirect(dest, 302);
    }

    // Public RSS feed
    if (m === 'GET' && p.match(/^\/feed\/[a-zA-Z0-9]+$/)) {
      const tid = p.split('/')[2];
      const tenant = await env.DB.prepare('SELECT * FROM tenants WHERE id=?').bind(tid).first();
      if (!tenant) return err('Not found', 404);
      const issues = await env.DB.prepare('SELECT * FROM issues WHERE tenant_id=? AND status=? ORDER BY sent_at DESC LIMIT 20').bind(tid, 'sent').all();
      const domain = (tenant as any).domain || 'newsletter.echo-ept.com';
      let rss = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n<title>${sanitize((tenant as any).name, 100)}</title>\n<link>https://${domain}</link>\n<description>${sanitize((tenant as any).name, 200)} Newsletter</description>\n`;
      for (const i of issues.results || []) {
        const issue = i as any;
        rss += `<item><title>${sanitize(issue.title, 200)}</title><link>https://${domain}/issues/${issue.slug || issue.id}</link><pubDate>${new Date(issue.sent_at || issue.created_at).toUTCString()}</pubDate><description><![CDATA[${issue.content_html?.slice(0, 5000) || ''}]]></description></item>\n`;
      }
      rss += '</channel></rss>';
      return new Response(rss, { headers: { 'Content-Type': 'application/rss+xml', 'Access-Control-Allow-Origin': '*' } });
    }

    // Public issue view
    if (m === 'GET' && p.match(/^\/public\/[a-zA-Z0-9]+\/issues$/)) {
      const tid = p.split('/')[2];
      const issues = await env.DB.prepare('SELECT id, title, slug, preview_text, sent_at FROM issues WHERE tenant_id=? AND status=? ORDER BY sent_at DESC LIMIT 50').bind(tid, 'sent').all();
      return json({ issues: issues.results || [] });
    }

    if (m === 'GET' && p.match(/^\/public\/[a-zA-Z0-9]+\/issues\/[a-zA-Z0-9-]+$/)) {
      const parts = p.split('/');
      const tid = parts[2]; const issueSlug = parts[4];
      const issue = await env.DB.prepare('SELECT id, title, slug, subject_line, preview_text, content_html, sent_at FROM issues WHERE tenant_id=? AND (slug=? OR id=?) AND status=?').bind(tid, issueSlug, issueSlug, 'sent').first();
      if (!issue) return err('Not found', 404);
      return json({ issue });
    }

    // Embeddable subscribe form widget
    if (m === 'GET' && p === '/widget.js') {
      const tid = url.searchParams.get('id');
      const lid = url.searchParams.get('list') || '';
      if (!tid) return err('Missing id');
      const tenant = await env.DB.prepare('SELECT name, brand_color FROM tenants WHERE id=?').bind(tid).first<{name:string;brand_color:string}>();
      const color = tenant?.brand_color || '#14b8a6';
      const name = tenant?.name || 'Newsletter';
      const js = `(function(){var d=document,w=d.createElement('div');w.id='echo-nl-widget';w.innerHTML='<div style="font-family:sans-serif;max-width:400px;padding:24px;border-radius:12px;border:1px solid #e2e8f0;background:#fff"><h3 style="margin:0 0 8px;font-size:18px;color:#0f172a">Subscribe to ${name.replace(/'/g, "\\'")}</h3><p style="margin:0 0 16px;font-size:14px;color:#64748b">Get the latest updates delivered to your inbox.</p><form id="echo-nl-form"><input id="echo-nl-email" type="email" placeholder="your@email.com" required style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #e2e8f0;font-size:14px;margin-bottom:8px"/><input id="echo-nl-name" type="text" placeholder="Your name (optional)" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #e2e8f0;font-size:14px;margin-bottom:12px"/><button type="submit" style="width:100%;padding:10px;border-radius:8px;border:none;background:${color};color:#fff;font-size:14px;font-weight:600;cursor:pointer">Subscribe</button></form><p id="echo-nl-msg" style="margin:8px 0 0;font-size:13px;display:none"></p><p style="margin:8px 0 0;font-size:11px;color:#94a3b8;text-align:center">Powered by <a href="https://echo-ept.com/newsletter" style="color:${color};text-decoration:none">Echo Newsletter</a></p></div>';var c=d.currentScript;c.parentNode.insertBefore(w,c.nextSibling);d.getElementById('echo-nl-form').addEventListener('submit',function(e){e.preventDefault();var msg=d.getElementById('echo-nl-msg');var email=d.getElementById('echo-nl-email').value;var name=d.getElementById('echo-nl-name').value;msg.style.display='block';msg.style.color='#64748b';msg.textContent='Subscribing...';fetch(c.src.split('/widget.js')[0]+'/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenant_id:'${tid}',list_id:'${lid}',email:email,name:name||undefined})}).then(function(r){return r.json()}).then(function(d){if(d.ok){msg.style.color='${color}';msg.textContent='Subscribed! Check your inbox.';}else{msg.style.color='#ef4444';msg.textContent=d.error||'Error';}}).catch(function(){msg.style.color='#ef4444';msg.textContent='Network error';});});})();`;
      return new Response(js, { headers: { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' } });
    }

    // ── Authenticated endpoints ──
    try {
    if (!authOk(req, env)) return err('Unauthorized', 401);
    const tid = req.headers.get('X-Tenant-ID') || url.searchParams.get('tenant_id') || '';

    // ── Tenant CRUD ──
    if (m === 'POST' && p === '/api/tenants') {
      const body = await req.json<any>();
      const id = uid();
      await env.DB.prepare('INSERT INTO tenants (id, name, from_name, from_email, domain, brand_color) VALUES (?, ?, ?, ?, ?, ?)').bind(id, sanitize(body.name), sanitize(body.from_name || body.name), body.from_email || null, body.domain || null, body.brand_color || '#14b8a6').run();
      return json({ id });
    }
    if (m === 'GET' && p === '/api/tenants') { const r = await env.DB.prepare('SELECT * FROM tenants').all(); return json({ tenants: r.results || [] }); }
    if (m === 'GET' && p.match(/^\/api\/tenants\/[a-zA-Z0-9]+$/)) { const id = p.split('/')[3]; const r = await env.DB.prepare('SELECT * FROM tenants WHERE id=?').bind(id).first(); return r ? json(r) : err('Not found', 404); }

    // ── Lists ──
    if (m === 'POST' && p === '/api/lists') {
      const body = await req.json<any>();
      const id = uid();
      await env.DB.prepare('INSERT INTO lists (id, tenant_id, name, description, double_optin) VALUES (?, ?, ?, ?, ?)').bind(id, tid, sanitize(body.name), body.description ? sanitize(body.description) : null, body.double_optin ? 1 : 0).run();
      return json({ id });
    }
    if (m === 'GET' && p === '/api/lists') { const r = await env.DB.prepare('SELECT * FROM lists WHERE tenant_id=? ORDER BY created_at DESC').bind(tid).all(); return json({ lists: r.results || [] }); }
    if (m === 'DELETE' && p.match(/^\/api\/lists\/[a-zA-Z0-9]+$/)) { const id = p.split('/')[3]; await env.DB.prepare('DELETE FROM lists WHERE id=? AND tenant_id=?').bind(id, tid).run(); return json({ ok: true }); }

    // ── Subscribers ──
    if (m === 'POST' && p === '/api/subscribers') {
      const body = await req.json<any>();
      const id = uid();
      const email = sanitize(body.email.toLowerCase().trim(), 320);
      await env.DB.prepare('INSERT INTO subscribers (id, tenant_id, email, name, status, source, custom_fields) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, email) DO UPDATE SET name=COALESCE(excluded.name, name), status=excluded.status, custom_fields=excluded.custom_fields')
        .bind(id, tid, email, body.name ? sanitize(body.name, 200) : null, body.status || 'active', body.source || 'api', body.custom_fields ? JSON.stringify(body.custom_fields) : '{}').run();
      if (body.list_id) {
        const sub = await env.DB.prepare('SELECT id FROM subscribers WHERE tenant_id=? AND email=?').bind(tid, email).first<{id:string}>();
        if (sub) await env.DB.prepare('INSERT OR IGNORE INTO list_subscribers (list_id, subscriber_id) VALUES (?, ?)').bind(body.list_id, sub.id).run();
      }
      return json({ id });
    }
    if (m === 'GET' && p === '/api/subscribers') {
      const status = url.searchParams.get('status') || 'active';
      const listId = url.searchParams.get('list_id');
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
      const offset = parseInt(url.searchParams.get('offset') || '0');
      let q: string; let params: any[];
      if (listId) {
        q = 'SELECT s.* FROM subscribers s JOIN list_subscribers ls ON s.id=ls.subscriber_id WHERE s.tenant_id=? AND ls.list_id=? AND s.status=? ORDER BY s.created_at DESC LIMIT ? OFFSET ?';
        params = [tid, listId, status, limit, offset];
      } else {
        q = 'SELECT * FROM subscribers WHERE tenant_id=? AND status=? ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params = [tid, status, limit, offset];
      }
      const r = await env.DB.prepare(q).bind(...params).all();
      const count = await env.DB.prepare('SELECT COUNT(*) as c FROM subscribers WHERE tenant_id=? AND status=?').bind(tid, status).first<{c:number}>();
      return json({ subscribers: r.results || [], total: count?.c || 0 });
    }
    if (m === 'DELETE' && p.match(/^\/api\/subscribers\/[a-zA-Z0-9]+$/)) {
      const id = p.split('/')[3];
      await env.DB.prepare('UPDATE subscribers SET status=?, unsubscribed_at=datetime(\'now\') WHERE id=? AND tenant_id=?').bind('unsubscribed', id, tid).run();
      return json({ ok: true });
    }

    // Bulk import subscribers
    if (m === 'POST' && p === '/api/subscribers/import') {
      const body = await req.json<{ list_id?: string; subscribers: { email: string; name?: string }[] }>();
      if (!body?.subscribers?.length) return err('subscribers array required');
      const batch = body.subscribers.slice(0, 500);
      let imported = 0;
      for (const sub of batch) {
        const email = sanitize(sub.email.toLowerCase().trim(), 320);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
        const id = uid();
        await env.DB.prepare('INSERT INTO subscribers (id, tenant_id, email, name, status, source) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, email) DO NOTHING')
          .bind(id, tid, email, sub.name ? sanitize(sub.name, 200) : null, 'active', 'import').run();
        if (body.list_id) {
          const s = await env.DB.prepare('SELECT id FROM subscribers WHERE tenant_id=? AND email=?').bind(tid, email).first<{id:string}>();
          if (s) await env.DB.prepare('INSERT OR IGNORE INTO list_subscribers (list_id, subscriber_id) VALUES (?, ?)').bind(body.list_id, s.id).run();
        }
        imported++;
      }
      return json({ imported, total: batch.length });
    }

    // ── Issues (newsletters) ──
    if (m === 'POST' && p === '/api/issues') {
      const body = await req.json<any>();
      const id = uid();
      const s = body.title ? slug(body.title) + '-' + id.slice(0, 6) : id;
      await env.DB.prepare('INSERT INTO issues (id, tenant_id, title, slug, subject_line, preview_text, content_html, content_text, list_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, tid, sanitize(body.title), s, sanitize(body.subject_line || body.title), body.preview_text ? sanitize(body.preview_text, 300) : null, body.content_html || '', body.content_text || null, body.list_id || null).run();
      return json({ id, slug: s });
    }
    if (m === 'GET' && p === '/api/issues') {
      const status = url.searchParams.get('status');
      const q = status ? 'SELECT * FROM issues WHERE tenant_id=? AND status=? ORDER BY created_at DESC LIMIT 50' : 'SELECT * FROM issues WHERE tenant_id=? ORDER BY created_at DESC LIMIT 50';
      const r = status ? await env.DB.prepare(q).bind(tid, status).all() : await env.DB.prepare(q).bind(tid).all();
      return json({ issues: r.results || [] });
    }
    if (m === 'GET' && p.match(/^\/api\/issues\/[a-zA-Z0-9-]+$/)) {
      const id = p.split('/')[3];
      const r = await env.DB.prepare('SELECT * FROM issues WHERE (id=? OR slug=?) AND tenant_id=?').bind(id, id, tid).first();
      return r ? json(r) : err('Not found', 404);
    }
    if (m === 'PUT' && p.match(/^\/api\/issues\/[a-zA-Z0-9-]+$/)) {
      const id = p.split('/')[3];
      const body = await req.json<any>();
      const sets: string[] = []; const vals: any[] = [];
      if (body.title) { sets.push('title=?'); vals.push(sanitize(body.title)); }
      if (body.subject_line) { sets.push('subject_line=?'); vals.push(sanitize(body.subject_line)); }
      if (body.preview_text !== undefined) { sets.push('preview_text=?'); vals.push(sanitize(body.preview_text, 300)); }
      if (body.content_html !== undefined) { sets.push('content_html=?'); vals.push(body.content_html); }
      if (body.content_text !== undefined) { sets.push('content_text=?'); vals.push(body.content_text); }
      if (body.status) { sets.push('status=?'); vals.push(body.status); }
      if (body.scheduled_at) { sets.push('scheduled_at=?'); vals.push(body.scheduled_at); }
      if (body.list_id) { sets.push('list_id=?'); vals.push(body.list_id); }
      sets.push('updated_at=datetime(\'now\')');
      vals.push(id, tid);
      await env.DB.prepare(`UPDATE issues SET ${sets.join(',')} WHERE id=? AND tenant_id=?`).bind(...vals).run();
      return json({ ok: true });
    }
    if (m === 'DELETE' && p.match(/^\/api\/issues\/[a-zA-Z0-9-]+$/)) {
      const id = p.split('/')[3];
      await env.DB.prepare('DELETE FROM issues WHERE id=? AND tenant_id=?').bind(id, tid).run();
      return json({ ok: true });
    }

    // ── Send issue ──
    if (m === 'POST' && p.match(/^\/api\/issues\/[a-zA-Z0-9-]+\/send$/)) {
      const issueId = p.split('/')[3];
      const issue = await env.DB.prepare('SELECT * FROM issues WHERE id=? AND tenant_id=?').bind(issueId, tid).first<any>();
      if (!issue) return err('Issue not found', 404);
      if (issue.status === 'sent') return err('Already sent');
      const tenant = await env.DB.prepare('SELECT * FROM tenants WHERE id=?').bind(tid).first<any>();
      if (!tenant) return err('Tenant not found', 404);

      // Get subscribers for this issue's list or all active subscribers
      let subs: any[];
      if (issue.list_id) {
        const r = await env.DB.prepare('SELECT s.* FROM subscribers s JOIN list_subscribers ls ON s.id=ls.subscriber_id WHERE s.tenant_id=? AND ls.list_id=? AND s.status=?').bind(tid, issue.list_id, 'active').all();
        subs = r.results || [];
      } else {
        const r = await env.DB.prepare('SELECT * FROM subscribers WHERE tenant_id=? AND status=?').bind(tid, 'active').all();
        subs = r.results || [];
      }

      let sent = 0;
      const baseUrl = url.origin;
      for (const sub of subs.slice(0, tenant.max_sends_per_day || 500)) {
        const sendId = uid();
        // Inject tracking pixel and unsubscribe link
        const trackingPixel = `<img src="${baseUrl}/t/open?sid=${sub.id}&iid=${issueId}&tid=${tid}" width="1" height="1" style="display:none" />`;
        const unsubLink = `${baseUrl}/unsubscribe?sid=${sub.id}&tid=${tid}`;
        const htmlWithTracking = issue.content_html + trackingPixel + `<p style="font-size:12px;color:#999;text-align:center;margin-top:24px"><a href="${unsubLink}" style="color:#999">Unsubscribe</a></p>`;

        try {
          await env.EMAIL_SENDER.fetch('https://email/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: sub.email, from_name: tenant.from_name, from_email: tenant.from_email,
              subject: issue.subject_line, html: htmlWithTracking, text: issue.content_text || ''
            })
          });
          await env.DB.prepare('INSERT INTO sends (id, issue_id, subscriber_id, tenant_id, status, sent_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))').bind(sendId, issueId, sub.id, tid, 'sent').run();
          sent++;
        } catch {
          await env.DB.prepare('INSERT INTO sends (id, issue_id, subscriber_id, tenant_id, status, error) VALUES (?, ?, ?, ?, ?, ?)').bind(sendId, issueId, sub.id, tid, 'failed', 'Send error').run();
        }
      }

      await env.DB.prepare('UPDATE issues SET status=?, sent_at=datetime(\'now\'), total_sent=? WHERE id=?').bind('sent', sent, issueId).run();
      return json({ ok: true, sent, total_subscribers: subs.length });
    }

    // ── Issue analytics ──
    if (m === 'GET' && p.match(/^\/api\/issues\/[a-zA-Z0-9-]+\/analytics$/)) {
      const id = p.split('/')[3];
      const issue = await env.DB.prepare('SELECT id, title, total_sent, total_opened, total_clicked, total_unsubscribed, total_bounced, sent_at FROM issues WHERE id=? AND tenant_id=?').bind(id, tid).first();
      if (!issue) return err('Not found', 404);
      const events = await env.DB.prepare('SELECT event_type, COUNT(*) as c FROM events WHERE issue_id=? GROUP BY event_type').bind(id).all();
      return json({ issue, events: events.results || [] });
    }

    // ── Templates ──
    if (m === 'POST' && p === '/api/templates') {
      const body = await req.json<any>();
      const id = uid();
      await env.DB.prepare('INSERT INTO templates (id, tenant_id, name, html, category) VALUES (?, ?, ?, ?, ?)').bind(id, tid, sanitize(body.name), body.html, body.category || 'general').run();
      return json({ id });
    }
    if (m === 'GET' && p === '/api/templates') { const r = await env.DB.prepare('SELECT * FROM templates WHERE tenant_id=? ORDER BY created_at DESC').bind(tid).all(); return json({ templates: r.results || [] }); }
    if (m === 'DELETE' && p.match(/^\/api\/templates\/[a-zA-Z0-9]+$/)) { const id = p.split('/')[3]; await env.DB.prepare('DELETE FROM templates WHERE id=? AND tenant_id=?').bind(id, tid).run(); return json({ ok: true }); }

    // ── Automations ──
    if (m === 'POST' && p === '/api/automations') {
      const body = await req.json<any>();
      const id = uid();
      await env.DB.prepare('INSERT INTO automations (id, tenant_id, name, trigger_type, trigger_config, steps, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, tid, sanitize(body.name), body.trigger_type || 'subscribe', JSON.stringify(body.trigger_config || {}), JSON.stringify(body.steps || []), body.status || 'inactive').run();
      return json({ id });
    }
    if (m === 'GET' && p === '/api/automations') { const r = await env.DB.prepare('SELECT * FROM automations WHERE tenant_id=? ORDER BY created_at DESC').bind(tid).all(); return json({ automations: r.results || [] }); }
    if (m === 'PUT' && p.match(/^\/api\/automations\/[a-zA-Z0-9]+$/)) {
      const id = p.split('/')[3];
      const body = await req.json<any>();
      const sets: string[] = []; const vals: any[] = [];
      if (body.name) { sets.push('name=?'); vals.push(sanitize(body.name)); }
      if (body.steps) { sets.push('steps=?'); vals.push(JSON.stringify(body.steps)); }
      if (body.status) { sets.push('status=?'); vals.push(body.status); }
      if (body.trigger_config) { sets.push('trigger_config=?'); vals.push(JSON.stringify(body.trigger_config)); }
      if (!sets.length) return err('Nothing to update');
      vals.push(id, tid);
      await env.DB.prepare(`UPDATE automations SET ${sets.join(',')} WHERE id=? AND tenant_id=?`).bind(...vals).run();
      return json({ ok: true });
    }

    // ── AI content generation ──
    if (m === 'POST' && p === '/api/ai/generate') {
      const body = await req.json<{ topic: string; tone?: string; length?: string }>();
      if (!body?.topic) return err('topic required');
      const prompt = `Write a newsletter issue about: ${sanitize(body.topic, 500)}. Tone: ${body.tone || 'professional'}. Length: ${body.length || 'medium'}. Return HTML content suitable for email. Include a compelling subject line at the start marked with SUBJECT: on the first line.`;
      try {
        const aiResp = await env.ENGINE_RUNTIME.fetch('https://engine/query', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ engine_id: 'GEN-01', query: prompt, max_tokens: 2000 })
        });
        const aiData = await aiResp.json<any>();
        const content = aiData.response || aiData.answer || '';
        const subjectMatch = content.match(/SUBJECT:\s*(.+?)[\n\r]/);
        return json({ subject_line: subjectMatch?.[1]?.trim() || body.topic, content_html: content.replace(/SUBJECT:.*[\n\r]/, '') });
      } catch { return err('AI generation failed', 500); }
    }

    // ── Analytics ──
    if (m === 'GET' && p === '/api/analytics/overview') {
      const total = await env.DB.prepare('SELECT COUNT(*) as c FROM subscribers WHERE tenant_id=? AND status=?').bind(tid, 'active').first<{c:number}>();
      const issues = await env.DB.prepare('SELECT COUNT(*) as c FROM issues WHERE tenant_id=? AND status=?').bind(tid, 'sent').first<{c:number}>();
      const sent = await env.DB.prepare('SELECT SUM(total_sent) as s, SUM(total_opened) as o, SUM(total_clicked) as cl FROM issues WHERE tenant_id=? AND status=?').bind(tid, 'sent').first<{s:number;o:number;cl:number}>();
      const recent = await env.DB.prepare('SELECT COUNT(*) as c FROM subscribers WHERE tenant_id=? AND status=? AND created_at > datetime(\'now\', \'-7 days\')').bind(tid, 'active').first<{c:number}>();
      return json({
        subscribers: total?.c || 0, subscribers_last_7d: recent?.c || 0,
        issues_sent: issues?.c || 0, total_sent: sent?.s || 0,
        total_opened: sent?.o || 0, total_clicked: sent?.cl || 0,
        open_rate: (sent?.s || 0) > 0 ? ((sent?.o || 0) / (sent?.s || 1) * 100).toFixed(1) + '%' : '0%',
        click_rate: (sent?.s || 0) > 0 ? ((sent?.cl || 0) / (sent?.s || 1) * 100).toFixed(1) + '%' : '0%'
      });
    }
    if (m === 'GET' && p === '/api/analytics/daily') {
      const days = Math.min(parseInt(url.searchParams.get('days') || '30'), 90);
      const r = await env.DB.prepare('SELECT * FROM analytics_daily WHERE tenant_id=? ORDER BY date DESC LIMIT ?').bind(tid, days).all();
      return json({ daily: r.results || [] });
    }
    if (m === 'GET' && p === '/api/analytics/growth') {
      const r = await env.DB.prepare("SELECT date(created_at) as date, COUNT(*) as new_subscribers FROM subscribers WHERE tenant_id=? AND created_at > datetime('now', '-30 days') GROUP BY date(created_at) ORDER BY date").bind(tid).all();
      return json({ growth: r.results || [] });
    }

    try { env.AE.writeDataPoint({ blobs: [req.method, p, '404'], doubles: [Date.now()], indexes: ['echo-newsletter'] }); } catch {}
    return err('Not found', 404);

    } catch (err_caught: unknown) {
      const msg = err_caught instanceof Error ? err_caught.message : 'Unknown error';
      const stack = err_caught instanceof Error ? err_caught.stack : undefined;
      slog('error', 'Unhandled request error', { method: m, path: p, error: msg, stack });
      return json({ ok: false, error: 'Internal server error', message: msg, path: p }, 500);
    }
    } catch (e: unknown) {
      if ((e as Error).message?.includes('JSON')) {
        try { env.AE.writeDataPoint({ blobs: [req.method, new URL(req.url).pathname, '400'], doubles: [Date.now()], indexes: ['echo-newsletter'] }); } catch {}
        return err('Invalid JSON body', 400);
      }
      console.error(`[echo-newsletter] ${(e as Error).message}`);
      try { env.AE.writeDataPoint({ blobs: [req.method, new URL(req.url).pathname, '500'], doubles: [Date.now()], indexes: ['echo-newsletter'] }); } catch {}
      return err('Internal server error', 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Daily analytics aggregation
    const today = new Date().toISOString().split('T')[0];
    const tenants = await env.DB.prepare('SELECT id FROM tenants').all();
    for (const t of (tenants.results || []) as any[]) {
      const tid = t.id;
      const total = await env.DB.prepare('SELECT COUNT(*) as c FROM subscribers WHERE tenant_id=? AND status=?').bind(tid, 'active').first<{c:number}>();
      const newSubs = await env.DB.prepare("SELECT COUNT(*) as c FROM subscribers WHERE tenant_id=? AND status=? AND date(created_at)=?").bind(tid, 'active', today).first<{c:number}>();
      const unsubs = await env.DB.prepare("SELECT COUNT(*) as c FROM subscribers WHERE tenant_id=? AND status=? AND date(unsubscribed_at)=?").bind(tid, 'unsubscribed', today).first<{c:number}>();
      const sent = await env.DB.prepare("SELECT COUNT(*) as c FROM sends WHERE tenant_id=? AND date(sent_at)=? AND status=?").bind(tid, today, 'sent').first<{c:number}>();
      const opened = await env.DB.prepare("SELECT COUNT(*) as c FROM sends WHERE tenant_id=? AND date(sent_at)=? AND opened_at IS NOT NULL").bind(tid, today).first<{c:number}>();
      const clicked = await env.DB.prepare("SELECT COUNT(*) as c FROM sends WHERE tenant_id=? AND date(sent_at)=? AND clicked_at IS NOT NULL").bind(tid, today).first<{c:number}>();
      await env.DB.prepare('INSERT INTO analytics_daily (tenant_id, date, subscribers_total, subscribers_new, subscribers_unsubscribed, emails_sent, emails_opened, emails_clicked) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, date) DO UPDATE SET subscribers_total=excluded.subscribers_total, subscribers_new=excluded.subscribers_new, subscribers_unsubscribed=excluded.subscribers_unsubscribed, emails_sent=excluded.emails_sent, emails_opened=excluded.emails_opened, emails_clicked=excluded.emails_clicked')
        .bind(tid, today, total?.c || 0, newSubs?.c || 0, unsubs?.c || 0, sent?.c || 0, opened?.c || 0, clicked?.c || 0).run();
    }

    // Process automation enrollments
    const dueEnrollments = await env.DB.prepare("SELECT ae.*, a.steps, a.tenant_id FROM automation_enrollments ae JOIN automations a ON ae.automation_id=a.id WHERE ae.status='active' AND ae.next_step_at <= datetime('now') LIMIT 50").all();
    for (const enrollment of (dueEnrollments.results || []) as any[]) {
      const steps = JSON.parse(enrollment.steps || '[]');
      const stepIdx = enrollment.current_step;
      if (stepIdx >= steps.length) {
        await env.DB.prepare("UPDATE automation_enrollments SET status='completed', completed_at=datetime('now') WHERE id=?").bind(enrollment.id).run();
        continue;
      }
      const step = steps[stepIdx];
      if (step.type === 'email' && step.issue_id) {
        const issue = await env.DB.prepare('SELECT * FROM issues WHERE id=?').bind(step.issue_id).first<any>();
        const sub = await env.DB.prepare('SELECT * FROM subscribers WHERE id=?').bind(enrollment.subscriber_id).first<any>();
        const tenant = await env.DB.prepare('SELECT * FROM tenants WHERE id=?').bind(enrollment.tenant_id).first<any>();
        if (issue && sub && tenant) {
          try {
            await env.EMAIL_SENDER.fetch('https://email/send', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ to: sub.email, from_name: tenant.from_name, from_email: tenant.from_email, subject: issue.subject_line, html: issue.content_html, text: issue.content_text || '' })
            });
          } catch {}
        }
      }
      const nextDelay = steps[stepIdx + 1]?.delay_hours || 24;
      await env.DB.prepare("UPDATE automation_enrollments SET current_step=?, next_step_at=datetime('now', '+' || ? || ' hours') WHERE id=?").bind(stepIdx + 1, nextDelay, enrollment.id).run();
    }

    // Schedule pending issues
    const scheduled = await env.DB.prepare("SELECT * FROM issues WHERE status='scheduled' AND scheduled_at <= datetime('now')").all();
    for (const issue of (scheduled.results || []) as any[]) {
      // Trigger send by updating status — next cron or manual send will pick it up
      await env.DB.prepare("UPDATE issues SET status='sending' WHERE id=?").bind(issue.id).run();
    }
  }
};
