import { Injectable } from '@nestjs/common';
import { env } from '../config/env';
import { TranscriptionProvider, TranscriptionResult } from './ai-provider.interface';

/**
 * Groq transcription provider. Groq exposes an OpenAI-compatible endpoint that
 * runs Whisper large-v3 on a generous free tier, so it serves as a free
 * fallback when the OpenAI account is out of quota.
 */
@Injectable()
export class GroqProvider implements TranscriptionProvider {
  /** True only when a Groq key is configured; callers gate the fallback on this. */
  isConfigured(): boolean {
    return env().GROQ_API_KEY.length > 0;
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<TranscriptionResult> {
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'mp3';
    // Native fetch + FormData, mirroring OpenAIProvider.transcribe: the bundled
    // SDK multipart path throws "Connection error" on Node 20, while a plain POST
    // works. The Uint8Array wrap + casts bridge the duplicate DOM/@types/node
    // FormData/Blob globals (see openai.provider.ts for the full rationale).
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }) as any, `audio.${ext}`);
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'verbose_json');

    const httpRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env().GROQ_API_KEY}` },
      body: form as any,
    });
    if (!httpRes.ok) {
      const body = await httpRes.text();
      throw new Error(`Groq transcription failed (${httpRes.status}): ${body.slice(0, 300)}`);
    }
    const anyRes = (await httpRes.json()) as {
      text: string;
      language?: string;
      segments?: { avg_logprob?: number; no_speech_prob?: number }[];
    };
    let confidence: number | null = null;
    if (anyRes.segments && anyRes.segments.length) {
      const avg =
        anyRes.segments.reduce((s, seg) => s + (seg.avg_logprob ?? -1), 0) /
        anyRes.segments.length;
      // map avg_logprob (~ -1..0) to a rough 0..1 confidence
      confidence = Math.max(0, Math.min(1, 1 + avg));
    }
    return { text: anyRes.text ?? '', confidence, language: anyRes.language ?? null };
  }
}
