import { Injectable } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { extractDocumentText } from './document-text';
import { AppLogger } from '../logger/logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { NormalizedIncomingMessage } from '../whatsapp/whatsapp.types';

export interface ProcessedMedia {
  mediaAssetId: string;
  transcript: string | null;
  transcriptConfidence: number | null;
  /** False when the transcript is missing or low-confidence — callers must NOT
   *  act on it (ask the owner to confirm/resend instead). */
  transcriptReliable: boolean;
  extractedText: string | null;
  aiSummary: string | null;
  classification: string | null;
  /** Human-facing note if processing degraded (e.g. transcription failed). */
  degradedNote: string | null;
}

/** Map a media-processing failure to an honest, actionable owner message. The
 *  common case is an OpenAI quota/billing error (transcription AND vision both run
 *  on OpenAI), which needs a specific action — not the vague "try again" that just
 *  causes futile resends. */
export function degradedNoteFor(error: string): string {
  const e = error.toLowerCase();
  const quotaHit =
    e.includes('insufficient_quota') ||
    e.includes('exceeded your current quota') ||
    e.includes('quota') ||
    e.includes('billing') ||
    e.includes('(429)');
  if (quotaHit) {
    return (
      'לא הצלחתי לתמלל את ההקלטה — נגמר התקציב בחשבון ה-OpenAI שמתמלל הקלטות ומנתח תמונות. ' +
      'צריך לטעון יתרה ב-platform.openai.com/account/billing (זול מאוד — סנטים לדקת הקלטה). ' +
      'בינתיים פשוט תכתוב לי מה צריך ואני אטפל מיד.'
    );
  }
  return 'הקובץ נשמר, אבל לא הצלחתי לעבד אותו כרגע. אפשר לשלוח שוב או לכתוב לי את המשימה.';
}

/**
 * Downloads and persists original media, then runs transcription / vision /
 * text extraction. Originals are ALWAYS stored even when AI processing fails,
 * so nothing is lost and the owner can be asked to resend.
 */
@Injectable()
export class MediaService {
  private readonly logger = new AppLogger('MediaService');

  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly storage: StorageService,
    private readonly ai: AiService,
    private readonly prisma: PrismaService,
  ) {}

  async ingest(
    msg: NormalizedIncomingMessage,
    whatsappMessageRowId: string,
  ): Promise<ProcessedMedia | null> {
    if (!msg.mediaId) return null;

    // 1. Always download + store the original first.
    let buffer: Buffer;
    let mimeType = msg.mimeType ?? 'application/octet-stream';
    try {
      const dl = await this.whatsapp.downloadMedia(msg.mediaId);
      buffer = dl.buffer;
      mimeType = dl.mimeType || mimeType;
    } catch (e) {
      this.logger.error('Media download failed', { error: (e as Error).message });
      throw e; // let the queue retry
    }

    const ext = mimeType.split('/')[1]?.split(';')[0] ?? 'bin';
    const filename = `${msg.mediaId}.${ext}`;
    const stored = await this.storage.save(buffer, filename, msg.type);

    const asset = await this.prisma.mediaAsset.create({
      data: {
        whatsappMessageId: whatsappMessageRowId,
        mediaId: msg.mediaId,
        type: msg.type,
        mimeType,
        originalFileName: msg.filename,
        storagePath: stored.storagePath,
        publicUrl: stored.publicUrl,
      },
    });

    const result: ProcessedMedia = {
      mediaAssetId: asset.id,
      transcript: null,
      transcriptConfidence: null,
      transcriptReliable: true,
      extractedText: null,
      aiSummary: null,
      classification: null,
      degradedNote: null,
    };
    // Diagnostic reason persisted to MediaAsset.processingError (visible at
    // /admin/media) whenever processing degrades — never shown to the owner.
    let processingError: string | null = null;

    // 2. Type-specific AI processing. Failures degrade gracefully.
    try {
      if (msg.type === 'audio' || msg.type === 'video') {
        const tr = await this.ai.transcribe(buffer, mimeType);
        result.transcript = tr.text || null;
        result.transcriptConfidence = tr.confidence;
        if (!tr.text || (tr.confidence !== null && tr.confidence < 0.5)) {
          // Low-confidence/empty transcript: flag as unreliable so the planner
          // never acts on a guessed transcription.
          result.transcriptReliable = false;
          result.degradedNote = tr.text
            ? `שמעתי בערך: "${tr.text}". לא בטוח שהבנתי נכון. אפשר לאשר או לכתוב לי?`
            : 'לא הצלחתי להבין את ההקלטה. אפשר לשלוח שוב או לכתוב לי?';
          processingError = `transcription unusable (bytes=${buffer.length}, mime=${mimeType}, confidence=${tr.confidence ?? 'null'}, textLen=${tr.text?.length ?? 0})`;
        }
      } else if (msg.type === 'image') {
        const vision = await this.ai.describeImage(buffer, mimeType);
        result.aiSummary = vision.description;
        result.extractedText = vision.extractedText;
        result.classification = vision.classification;
      } else if (msg.type === 'document') {
        // Extract text from PDFs/Word docs so the planner can act on the CONTENT,
        // not just the filename. Unsupported/unreadable files degrade to "received".
        const extracted = await extractDocumentText(buffer, mimeType, msg.filename);
        result.extractedText = extracted;
        result.aiSummary = extracted
          ? `Document: ${msg.filename ?? filename}`
          : `Document received: ${msg.filename ?? filename}`;
      }
    } catch (e) {
      processingError = (e as Error).message.slice(0, 500);
      this.logger.error('Media AI processing failed', { error: processingError });
      result.transcriptReliable = false;
      result.degradedNote = degradedNoteFor(processingError);
    }

    await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        transcript: result.transcript,
        extractedText: result.extractedText,
        aiSummary: result.aiSummary,
        classification: result.classification,
        processingError,
      },
    });

    return result;
  }

  /** Transcribe an audio answer (clarification/approval reply). */
  async transcribeAudioMessage(mediaId: string): Promise<{ text: string; confidence: number | null }> {
    const dl = await this.whatsapp.downloadMedia(mediaId);
    const tr = await this.ai.transcribe(dl.buffer, dl.mimeType);
    return { text: tr.text, confidence: tr.confidence };
  }
}
