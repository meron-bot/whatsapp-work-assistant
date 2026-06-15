import { env } from '../src/config/env';
import { AiService } from '../src/ai/ai.service';

jest.mock('../src/config/env', () => ({ env: jest.fn() }));

const mockEnv = env as unknown as jest.Mock;

function makeService(opts: {
  transcriptionProvider?: 'openai' | 'groq';
  groqKey?: string;
  openaiTranscribe: jest.Mock;
  groqTranscribe: jest.Mock;
}) {
  mockEnv.mockReturnValue({
    AI_TRANSCRIPTION_PROVIDER: opts.transcriptionProvider ?? 'openai',
    GROQ_API_KEY: opts.groqKey ?? '',
  });
  const openai = { transcribe: opts.openaiTranscribe } as any;
  const anthropic = {} as any;
  const groq = {
    transcribe: opts.groqTranscribe,
    isConfigured: () => (opts.groqKey ?? '').length > 0,
  } as any;
  return new AiService(openai, anthropic, groq);
}

const audio = Buffer.from('x');
const ok = { text: 'hi', confidence: 0.9, language: 'he' };

describe('AiService.transcribe', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses OpenAI by default and does not touch Groq', async () => {
    const openaiTranscribe = jest.fn().mockResolvedValue(ok);
    const groqTranscribe = jest.fn();
    const ai = makeService({ groqKey: 'gsk_x', openaiTranscribe, groqTranscribe });

    expect(await ai.transcribe(audio, 'audio/ogg')).toEqual(ok);
    expect(openaiTranscribe).toHaveBeenCalled();
    expect(groqTranscribe).not.toHaveBeenCalled();
  });

  it('falls back to Groq when OpenAI fails and a Groq key is set', async () => {
    const openaiTranscribe = jest.fn().mockRejectedValue(new Error('insufficient_quota'));
    const groqTranscribe = jest.fn().mockResolvedValue(ok);
    const ai = makeService({ groqKey: 'gsk_x', openaiTranscribe, groqTranscribe });

    expect(await ai.transcribe(audio, 'audio/ogg')).toEqual(ok);
    expect(groqTranscribe).toHaveBeenCalled();
  });

  it('rethrows when OpenAI fails and no Groq key is set', async () => {
    const openaiTranscribe = jest.fn().mockRejectedValue(new Error('insufficient_quota'));
    const groqTranscribe = jest.fn();
    const ai = makeService({ groqKey: '', openaiTranscribe, groqTranscribe });

    await expect(ai.transcribe(audio, 'audio/ogg')).rejects.toThrow('insufficient_quota');
    expect(groqTranscribe).not.toHaveBeenCalled();
  });

  it('uses Groq directly when AI_TRANSCRIPTION_PROVIDER=groq', async () => {
    const openaiTranscribe = jest.fn();
    const groqTranscribe = jest.fn().mockResolvedValue(ok);
    const ai = makeService({
      transcriptionProvider: 'groq',
      groqKey: 'gsk_x',
      openaiTranscribe,
      groqTranscribe,
    });

    expect(await ai.transcribe(audio, 'audio/ogg')).toEqual(ok);
    expect(openaiTranscribe).not.toHaveBeenCalled();
    expect(groqTranscribe).toHaveBeenCalled();
  });
});
