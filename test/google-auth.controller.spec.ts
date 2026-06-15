import { GoogleAuthController } from '../src/google/google-auth.controller';
import { google } from 'googleapis';

jest.mock('googleapis', () => ({
  google: { tasks: jest.fn() },
}));
const mockedTasks = google.tasks as unknown as jest.Mock;

function makeAuth(overrides: Partial<{ isAuthorized: boolean; client: unknown }> = {}) {
  return {
    isAuthorized: jest.fn().mockResolvedValue(overrides.isAuthorized ?? true),
    getAuthorizedClient: jest.fn().mockResolvedValue(overrides.client ?? {}),
  } as any;
}

describe('GoogleAuthController status', () => {
  afterEach(() => jest.clearAllMocks());

  it('reports disconnected when no token is stored', async () => {
    const controller = new GoogleAuthController(makeAuth({ isAuthorized: false }));
    const result = await controller.status();
    expect(result.connected).toBe(false);
    expect(mockedTasks).not.toHaveBeenCalled();
  });

  it('reports connected when the tasks probe succeeds (no email/userinfo scope needed)', async () => {
    const list = jest.fn().mockResolvedValue({ data: {} });
    mockedTasks.mockReturnValue({ tasklists: { list } });
    const controller = new GoogleAuthController(makeAuth());
    const result = await controller.status();
    expect(result.connected).toBe(true);
    expect(list).toHaveBeenCalledWith({ maxResults: 1 });
  });

  it('reports disconnected with the error when the probe call fails', async () => {
    const list = jest.fn().mockRejectedValue(new Error('invalid_grant'));
    mockedTasks.mockReturnValue({ tasklists: { list } });
    const controller = new GoogleAuthController(makeAuth());
    const result = await controller.status();
    expect(result.connected).toBe(false);
    expect(result.error).toBe('invalid_grant');
  });
});
