import { ContactService } from '../src/contacts/contact.service';

process.env.DATABASE_URL = 'postgresql://x';

function makeSvc() {
  const prisma = {
    contact: {
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'c1' }),
      update: jest.fn().mockResolvedValue({ id: 'c1' }),
      findMany: jest.fn(),
    },
  };
  return { svc: new ContactService(prisma as any), prisma };
}

describe('ContactService', () => {
  it('findEmail returns a stored address', async () => {
    const { svc, prisma } = makeSvc();
    prisma.contact.findFirst.mockResolvedValue({ id: 'c1', name: 'דנה', email: 'dana@x.com' });
    expect(await svc.findEmail('דנה')).toBe('dana@x.com');
  });

  it('findEmail returns null when nothing is stored', async () => {
    const { svc, prisma } = makeSvc();
    prisma.contact.findFirst.mockResolvedValue(null);
    expect(await svc.findEmail('מישהו')).toBeNull();
  });

  it('remember creates a new contact when none exists', async () => {
    const { svc, prisma } = makeSvc();
    prisma.contact.findFirst.mockResolvedValue(null);
    await svc.remember({ name: 'דנה', email: 'dana@x.com', source: 'gmail' });
    expect(prisma.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'דנה', email: 'dana@x.com' }) }),
    );
  });

  it('remember fills a missing email but never overwrites an existing one with null', async () => {
    const { svc, prisma } = makeSvc();
    prisma.contact.findFirst.mockResolvedValue({ id: 'c1', name: 'דנה', email: 'dana@x.com', phone: null });
    await svc.remember({ name: 'דנה', email: null, phone: '050' });
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { email: 'dana@x.com', phone: '050' }, // email preserved, phone added
    });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  it('never throws on a lookup failure (returns null)', async () => {
    const { svc, prisma } = makeSvc();
    prisma.contact.findFirst.mockRejectedValue(new Error('db down'));
    expect(await svc.findEmail('דנה')).toBeNull();
  });
});
