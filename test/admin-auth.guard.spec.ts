import { AdminAuthGuard } from '../src/admin/admin-auth.guard';
import { env } from '../src/config/env';

jest.mock('../src/config/env', () => ({ env: jest.fn() }));
const mockedEnv = env as unknown as jest.Mock;

function ctx(headers: Record<string, unknown> = {}, query: Record<string, unknown> = {}) {
  const res = { setHeader: jest.fn() };
  const req = { headers, query };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as any;
}

describe('AdminAuthGuard', () => {
  const guard = new AdminAuthGuard();

  it('allows everything when ADMIN_TOKEN is unset (no lock-out)', () => {
    mockedEnv.mockReturnValue({ ADMIN_TOKEN: '' });
    expect(guard.canActivate(ctx())).toBe(true);
  });

  it('rejects when a token is required but none is presented', () => {
    mockedEnv.mockReturnValue({ ADMIN_TOKEN: 'secret' });
    expect(() => guard.canActivate(ctx())).toThrow();
  });

  it('accepts a correct Bearer token', () => {
    mockedEnv.mockReturnValue({ ADMIN_TOKEN: 'secret' });
    expect(guard.canActivate(ctx({ authorization: 'Bearer secret' }))).toBe(true);
  });

  it('accepts the token as a Basic-auth password (browser-friendly)', () => {
    mockedEnv.mockReturnValue({ ADMIN_TOKEN: 'secret' });
    const basic = 'Basic ' + Buffer.from('admin:secret').toString('base64');
    expect(guard.canActivate(ctx({ authorization: basic }))).toBe(true);
  });

  it('accepts a correct ?token= query param', () => {
    mockedEnv.mockReturnValue({ ADMIN_TOKEN: 'secret' });
    expect(guard.canActivate(ctx({}, { token: 'secret' }))).toBe(true);
  });

  it('rejects a wrong token', () => {
    mockedEnv.mockReturnValue({ ADMIN_TOKEN: 'secret' });
    expect(() => guard.canActivate(ctx({ authorization: 'Bearer nope' }))).toThrow();
  });
});
