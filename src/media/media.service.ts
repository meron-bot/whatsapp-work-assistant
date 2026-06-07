import { Injectable } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
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
        }
      } else if (msg.type === 'image') {
        const vision = await this.ai.describeImage(buffer, mimeType);
        result.aiSummary = vision.description;
        result.extractedText = vision.extractedText;
        result.classification = vision.classification;
      } else if (msg.type === 'document') {
        result.extractedText = null; // text extraction for PDFs/docx left for a follow-up
        result.aiSummary = `Document received: ${msg.filename ?? filename}`;
      }
    } catch (e) {
      this.logger.error('Media AI processing failed', { error: (e as Error).message });
      result.transcriptReliable = false;
      result.degradedNote =
        'הקובץ נשמר, אבל לא הצלחתי לעבד אותו. אפשר לשלוח שוב או לכתוב לי את המשימה.';
    }

    await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        transcript: result.transcript,
        extractedText: result.extractedText,
        aiSummary: result.aiSummary,
        classification: result.classification,
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
