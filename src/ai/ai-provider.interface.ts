/**
 * Provider abstraction so the planner / transcription / vision pipelines do not
 * depend on a specific vendor. Concrete providers (OpenAI, Anthropic) implement
 * the relevant subset.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionOptions {
  system?: string;
  messages: ChatMessage[];
  /** Hint that the model must return a single JSON object. */
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Cost tier: 'light' = cheap model, 'heavy' = stronger model. Default heavy. */
  tier?: 'light' | 'heavy';
}

export interface TranscriptionResult {
  text: string;
  /** Best-effort confidence in [0,1]; null if the provider does not report it. */
  confidence: number | null;
  language?: string | null;
}

export interface VisionResult {
  /** Plain-language description of the image. */
  description: string;
  /** OCR / visible text, if any. */
  extractedText: string | null;
  classification:
    | 'receipt'
    | 'business_card'
    | 'site_photo'
    | 'whiteboard'
    | 'document_photo'
    | 'general_work_image'
    | 'unknown';
  confidence: number;
}

export interface TextCompletionProvider {
  complete(options: CompletionOptions): Promise<string>;
}

export interface TranscriptionProvider {
  transcribe(audio: Buffer, mimeType: string): Promise<TranscriptionResult>;
}

export interface VisionProvider {
  describeImage(image: Buffer, mimeType: string): Promise<VisionResult>;
}
