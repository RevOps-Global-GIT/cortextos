import { createReadStream, existsSync } from 'fs';
import { basename } from 'path';

export interface TranscribeVoiceOptions {
  openaiApiKey?: string;
  model?: string;
  language?: string;
  /** Timeout in ms for the Whisper API call. Default: 30_000 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Transcribe a local audio file (OGG/OGA/MP3/WAV/M4A) using OpenAI Whisper.
 *
 * Returns the transcript string, or an empty string on any failure.
 * Never throws — transcription is best-effort and must never block
 * the rest of the inbound message pipeline.
 */
export async function transcribeVoice(
  filePath: string,
  opts: TranscribeVoiceOptions = {},
): Promise<string> {
  const openaiApiKey = opts.openaiApiKey ?? process.env.OPENAI_API_KEY ?? '';
  if (!openaiApiKey) {
    console.warn('[transcribe-voice] OPENAI_API_KEY not set — skipping STT');
    return '';
  }

  if (!existsSync(filePath)) {
    console.warn(`[transcribe-voice] file not found: ${filePath}`);
    return '';
  }

  try {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      console.warn('[transcribe-voice] fetch not available');
      return '';
    }

    // Build multipart form body using FormData + File
    const audioBuffer = await import('fs').then(({ readFileSync }) => readFileSync(filePath));
    const fileName = basename(filePath);
    // Determine MIME type from extension
    const ext = fileName.split('.').pop()?.toLowerCase() ?? 'ogg';
    const mimeMap: Record<string, string> = {
      ogg: 'audio/ogg',
      oga: 'audio/ogg',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      mp4: 'audio/mp4',
      webm: 'audio/webm',
    };
    const mimeType = mimeMap[ext] ?? 'audio/ogg';

    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: mimeType }), fileName);
    formData.append('model', opts.model ?? 'whisper-1');
    if (opts.language) {
      formData.append('language', opts.language);
    }

    const response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: formData,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`[transcribe-voice] Whisper API error ${response.status}: ${body.slice(0, 200)}`);
      return '';
    }

    const result = await response.json() as { text?: string };
    return (result.text ?? '').trim();
  } catch (err) {
    console.warn(`[transcribe-voice] error: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}
