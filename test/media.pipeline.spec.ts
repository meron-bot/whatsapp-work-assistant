import { MediaService } from '../src/media/media.service';
import { NormalizedIncomingMessage } from '../src/whatsapp/whatsapp.types';

process.env.DATABASE_URL = 'postgresql://x';
process.env.STORAGE_PROVIDER = 'local';
process.env.LOCAL_STORAGE_PATH = './storage-test';

function audioMessage(): NormalizedIncomingMessage {
  return {
    whatsappMessageId: 'wamid.audio',
    fromNumber: '972500000000',
    toNumber: '972511111111',
    type: 'audio',
    text: null,
    mediaId: 'media-audio-1',
    mimeType: 'audio/ogg',
    filename: null,
    timestamp: new Date().toISOString(),
    raw: {},
  };
}

describe('MediaService audio pipeline', () => {
  // (4) Audio message pipeline: download -> store -> transcribe -> persist
  it('downloads, stores and transcribes a voice note', async () => {
    const whatsapp = {
      downloadMedia: jest.fn().mockResolvedValue({ buffer: Buffer.from('audio'), mimeType: 'audio/ogg' }),
    } as any;
    const storage = {
      save: jest.fn().mockResolvedValue({ storagePath: '/tmp/a.ogg', publicUrl: null }),
    } as any;
    const ai = {
      transcribe: jest.fn().mockResolvedValue({ text: 'לשלוח לאבי את ההצעה', confidence: 0.9 }),
    } as any;
    const prisma = {
      mediaAsset: {
        create: jest.fn().mockResolvedValue({ id: 'asset1' }),
        update: jest.fn().mockResolvedValue({ id: 'asset1' }),
      },
    } as any;

    const svc = new MediaService(whatsapp, storage, ai, prisma);
    const result = await svc.ingest(audioMessage(), 'row1');

    expect(whatsapp.downloadMedia).toHaveBeenCalledWith('media-audio-1');
    expect(storage.save).toHaveBeenCalled();
    expect(ai.transcribe).toHaveBeenCalled();
    expect(result?.transcript).toBe('לשלוח לאבי את ההצעה');
    expect(result?.degradedNote).toBeNull();
  });

  // (7 building block) low-confidence audio produces a "I heard roughly…" note
  it('produces a degraded note when transcription confidence is low', async () => {
    const whatsapp = {
      downloadMedia: jest.fn().mockResolvedValue({ buffer: Buffer.from('x'), mimeType: 'audio/ogg' }),
    } as any;
    const storage = { save: jest.fn().mockResolvedValue({ storagePath: '/tmp/a.ogg', publicUrl: null }) } as any;
    const ai = { transcribe: jest.fn().mockResolvedValue({ text: 'אולי משהו', confidence: 0.2 }) } as any;
    const prisma = {
      mediaAsset: { create: jest.fn().mockResolvedValue({ id: 'asset2' }), update: jest.fn().mockResolvedValue({}) },
    } as any;

    const svc = new MediaService(whatsapp, storage, ai, prisma);
    const result = await svc.ingest(audioMessage(), 'row2');
    expect(result?.degradedNote).toContain('שמעתי בערך');
  });

  it('still stores the original when transcription fails', async () => {
    const whatsapp = {
      downloadMedia: jest.fn().mockResolvedValue({ buffer: Buffer.from('x'), mimeType: 'audio/ogg' }),
    } as any;
    const storage = { save: jest.fn().mockResolvedValue({ storagePath: '/tmp/a.ogg', publicUrl: null }) } as any;
    const ai = { transcribe: jest.fn().mockRejectedValue(new Error('whisper down')) } as any;
    const prisma = {
      mediaAsset: { create: jest.fn().mockResolvedValue({ id: 'asset3' }), update: jest.fn().mockResolvedValue({}) },
    } as any;

    const svc = new MediaService(whatsapp, storage, ai, prisma);
    const result = await svc.ingest(audioMessage(), 'row3');
    expect(storage.save).toHaveBeenCalled();
    expect(result?.degradedNote).toContain('הקובץ נשמר');
  });

  // An OpenAI quota/billing failure gets a specific, actionable note (not the
  // vague "try again" that just causes endless futile resends).
  it('gives a clear billing message when transcription fails on OpenAI quota', async () => {
    const whatsapp = {
      downloadMedia: jest.fn().mockResolvedValue({ buffer: Buffer.from('x'), mimeType: 'audio/ogg' }),
    } as any;
    const storage = { save: jest.fn().mockResolvedValue({ storagePath: '/tmp/a.ogg', publicUrl: null }) } as any;
    const ai = {
      transcribe: jest
        .fn()
        .mockRejectedValue(new Error('OpenAI transcription failed (429): {"error":{"type":"insufficient_quota"}}')),
    } as any;
    const prisma = {
      mediaAsset: { create: jest.fn().mockResolvedValue({ id: 'asset4' }), update: jest.fn().mockResolvedValue({}) },
    } as any;

    const svc = new MediaService(whatsapp, storage, ai, prisma);
    const result = await svc.ingest(audioMessage(), 'row4');
    expect(result?.degradedNote).toContain('OpenAI');
    expect(result?.degradedNote).toContain('billing');
  });
});
