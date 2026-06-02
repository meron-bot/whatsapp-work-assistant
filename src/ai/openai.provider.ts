import { Injectable } from '@nestjs/common';
import OpenAI, { toFile } from 'openai';
import { z } from 'zod';
import { env } from '../config/env';
import { AppLogger } from '../logger/logger.service';
import {
  CompletionOptions,
  TextCompletionProvider,
  TranscriptionProvider,
  TranscriptionResult,
  VisionProvider,
  VisionResult,
} from './ai-provider.interface';

const visionSchema = z.object({
  description: z.string(),
  extractedText: z.string().nullable(),
  classification: z.enum([
    'receipt',
    'business_card',
    'site_photo',
    'whiteboard',
    'document_photo',
    'general_work_image',
    'unknown',
  ]),
  confidence: z.number().min(0).max(1),
});

@Injectable()
export class OpenAIProvider
  implements TextCompletionProvider, TranscriptionProvider, VisionProvider
{
  private readonly client: OpenAI;
  private readonly logger = new AppLogger('OpenAIProvider');

  constructor() {
    this.client = new OpenAI({ apiKey: env().OPENAI_API_KEY });
  }

  async complete(options: CompletionOptions): Promise<string> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (options.system) messages.push({ role: 'system', content: options.system });
    for (const m of options.messages) messages.push({ role: m.role, content: m.content });

    const res = await this.client.chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens ?? 2000,
      ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    });
    return res.choices[0]?.message?.content ?? '';
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<TranscriptionResult> {
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'mp3';
    const file = await toFile(audio, `audio.${ext}`, { type: mimeType });
    const res = await this.client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'verbose_json',
    });
    // whisper-1 verbose_json exposes no_speech / avg_logprob per segment; we use
    // a conservative heuristic to derive a confidence value.
    const anyRes = res as unknown as {
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

  async describeImage(image: Buffer, mimeType: string): Promise<VisionResult> {
    const dataUrl = `data:${mimeType};base64,${image.toString('base64')}`;
    const res = await this.client.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You analyse a single work-related image. Return ONLY JSON: ' +
            '{"description": string, "extractedText": string|null, ' +
            '"classification": one of [receipt,business_card,site_photo,whiteboard,document_photo,general_work_image,unknown], ' +
            '"confidence": number 0..1}. ' +
            'Do NOT invent text that is not clearly visible. If unsure, use null and "unknown".',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe and classify this image.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ] as unknown as string,
        },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? '{}';
    try {
      return visionSchema.parse(JSON.parse(raw));
    } catch (e) {
      this.logger.warn('Vision output failed validation, returning unknown', {
        error: (e as Error).message,
      });
      return {
        description: 'Image could not be analysed reliably.',
        extractedText: null,
        classification: 'unknown',
        confidence: 0,
      };
    }
  }
}
