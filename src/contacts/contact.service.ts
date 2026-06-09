import { Injectable } from '@nestjs/common';
import { Contact } from '@prisma/client';
import { AppLogger } from '../logger/logger.service';
import { PrismaService } from '../prisma/prisma.service';

export interface RememberContactInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
}

/**
 * Dedicated contact store. Lets the assistant resolve an email recipient (or a
 * phone) from a name without re-searching Gmail every time, and remembers
 * contacts it discovers or the owner states. All reads are best-effort: a lookup
 * failure returns null so the caller can fall back (e.g. to a live Gmail search).
 */
@Injectable()
export class ContactService {
  private readonly logger = new AppLogger('ContactService');

  constructor(private readonly prisma: PrismaService) {}

  /** Find a contact by case-insensitive name or email substring; newest first. */
  async find(query: string): Promise<Contact | null> {
    const q = query.trim();
    if (!q) return null;
    try {
      return await this.prisma.contact.findFirst({
        where: {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        },
        orderBy: { updatedAt: 'desc' },
      });
    } catch (e) {
      this.logger.warn('Contact lookup failed', { error: (e as Error).message });
      return null;
    }
  }

  /** Resolve a usable email address for a name. Null if unknown. */
  async findEmail(name: string): Promise<string | null> {
    const c = await this.find(name);
    return c?.email ?? null;
  }

  /**
   * Upsert a contact by name: fills in a missing email/phone but never overwrites
   * an existing value with null. Idempotent and best-effort (never throws).
   */
  async remember(input: RememberContactInput): Promise<void> {
    const name = input.name.trim();
    if (!name) return;
    try {
      const existing = await this.prisma.contact.findFirst({
        where: { name: { equals: name, mode: 'insensitive' } },
      });
      if (existing) {
        await this.prisma.contact.update({
          where: { id: existing.id },
          data: {
            email: input.email ?? existing.email,
            phone: input.phone ?? existing.phone,
          },
        });
        return;
      }
      await this.prisma.contact.create({
        data: {
          name,
          email: input.email ?? null,
          phone: input.phone ?? null,
          source: input.source ?? null,
        },
      });
    } catch (e) {
      this.logger.warn('Failed to remember contact', { error: (e as Error).message });
    }
  }

  /** All contacts, for the admin dashboard. */
  list(): Promise<Contact[]> {
    return this.prisma.contact.findMany({ orderBy: { updatedAt: 'desc' }, take: 200 });
  }
}
