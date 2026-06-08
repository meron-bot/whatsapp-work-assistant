import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as crypto from 'crypto';
import { env } from '../config/env';

/**
 * Guards the admin dashboard. When ADMIN_TOKEN is unset the dashboard stays open
 * (so an existing setup is never locked out by upgrading). When it IS set, every
 * /admin request must present the token — via HTTP Basic auth (browser-friendly:
 * any username, the token as the password), a Bearer header, an x-admin-token
 * header, or a ?token= query param. The comparison is timing-safe.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = env().ADMIN_TOKEN;
    if (!expected) return true; // not configured → open, as before

    const req = context.switchToHttp().getRequest<Request>();
    const provided = this.extractToken(req);
    if (provided && this.safeEqual(provided, expected)) return true;

    // Prompt browsers for Basic credentials instead of returning a bare 401.
    const res = context.switchToHttp().getResponse<Response>();
    res.setHeader('WWW-Authenticate', 'Basic realm="admin"');
    throw new UnauthorizedException('Admin token required');
  }

  private extractToken(req: Request): string | null {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string') {
      if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
      if (auth.startsWith('Basic ')) {
        const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        return idx >= 0 ? decoded.slice(idx + 1) : decoded; // password part
      }
    }
    const header = req.headers['x-admin-token'];
    if (typeof header === 'string') return header;
    const q = (req.query as Record<string, unknown> | undefined)?.token;
    if (typeof q === 'string') return q;
    return null;
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  }
}
