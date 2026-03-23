import { cookies } from 'next/headers';
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';

export type AdminGuard = { ok: true; user: any } | { ok: false; reason: string };

function extractBearerToken(req?: Request): string | null {
  if (!req) return null;
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  if (!authHeader) return null;

  const [scheme, token] = authHeader.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;

  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function ensureAdmin(req?: Request): Promise<AdminGuard> {
  try {
    const supabaseAuth = createRouteHandlerClient({ cookies });
    let user: any = null;

    const { data: userFromCookie } = await supabaseAuth.auth.getUser();
    if (userFromCookie?.user) {
      user = userFromCookie.user;
    } else {
      const bearerToken = extractBearerToken(req);
      if (bearerToken) {
        const { data: userFromToken } = await supabaseAuth.auth.getUser(bearerToken);
        if (userFromToken?.user) {
          user = userFromToken.user;
        }
      }
    }

    if (!user) return { ok: false, reason: 'Not authenticated' };

    const email = String(user.email || '').toLowerCase();
    const allowEmails = (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const allowDomains = (process.env.ADMIN_EMAIL_DOMAINS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean);

    // If no explicit allow lists are configured:
    // - In development: allow any authenticated user (for local testing)
    // - In production: deny access (security requirement - must configure ADMIN_EMAILS or ADMIN_EMAIL_DOMAINS)
    if (allowEmails.length === 0 && allowDomains.length === 0) {
      if (process.env.NODE_ENV === 'production') {
        return { ok: false, reason: 'Admin access not configured. Set ADMIN_EMAILS or ADMIN_EMAIL_DOMAINS.' };
      }
      return { ok: true, user };
    }

    const appMeta = (user as any).app_metadata || {};
    const userMeta = (user as any).user_metadata || {};
    const roles = new Set<string>([
      ...((Array.isArray(appMeta.roles) ? appMeta.roles : []) as string[]),
      ...((Array.isArray(userMeta.roles) ? userMeta.roles : []) as string[]),
      String(appMeta.role || '').toLowerCase(),
      String(userMeta.role || '').toLowerCase(),
    ].filter(Boolean));

    const isAdminFlag = Boolean(appMeta.is_admin || userMeta.is_admin);

    const emailAllowed = allowEmails.length > 0 ? allowEmails.includes(email) : false;
    const domainAllowed = allowDomains.length > 0 && email.includes('@')
      ? allowDomains.includes(email.split('@')[1])
      : false;
    const roleAllowed = roles.has('admin');

    if (!(emailAllowed || domainAllowed || roleAllowed || isAdminFlag)) {
      return { ok: false, reason: 'Not authorized' };
    }

    return { ok: true, user };
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'Auth error' };
  }
}
