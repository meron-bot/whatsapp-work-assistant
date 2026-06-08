import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as crypto from 'crypto';
import { env } from '../config/env';

/**
 * Guards the admin dashboard, which exposes private data.
 *
 * - ADMIN_TOKEN set → every /admin request must present it (HTTP Basic password,
 *   Bearer header, x-admin-token header, or ?token=); timing-safe comparison.
 * - ADMIN_TOKEN unset + production → fail CLOSED (deny). Secure by default: a
 *   public deploy never leaks the owner's data just because no token was set.
 * - ADMIN_TOKEN unset + non-production → open, for local dev convenience.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = env().ADMIN_TOKEN;
    if (!expected) {
      if (env().NODE_ENV === 'production') {
        throw new UnauthorizedException(
          'Admin dashboard is locked. Set ADMIN_TOKEN to enable access.',
        );
      }
      return true; // dev convenience only
    }

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
