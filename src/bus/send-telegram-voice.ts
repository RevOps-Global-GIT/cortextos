import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface SendTelegramVoiceOptions {
  deepgramApiKey?: string;
  openaiApiKey?: string;
  telegramBotToken?: string;
  voice?: string;
  ffmpegPath?: string;
  fetchImpl?: typeof fetch;
  openaiTimeoutMs?: number;
  deepgramTimeoutMs?: number;
  telegramTimeoutMs?: number;
  ffmpegTimeoutMs?: number;
}

export type SendTelegramVoiceResult =
  | { ok: true; messageId?: number }
  | { ok: false; error: string };

const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
const DEEPGRAM_SPEECH_URL = 'https://api.deepgram.com/v1/speak?model=aura-2-thalia-en';
const DEFAULT_OPENAI_VOICE = 'alloy';

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

/**
 * Synthesize text to speech and send as a Telegram voice message.
 *
 * TTS provider selection (in priority order):
 * 1. Deepgram Aura-2 — if DEEPGRAM_API_KEY (or opts.deepgramApiKey) is set
 * 2. OpenAI tts-1   — if OPENAI_API_KEY (or opts.openaiApiKey) is set
 *
 * Returns an error if neither key is available.
 */
export async function sendTelegramVoice(
  chatId: string,
  text: string,
  opts: SendTelegramVoiceOptions = {},
): Promise<SendTelegramVoiceResult> {
  const deepgramApiKey = opts.deepgramApiKey ?? process.env.DEEPGRAM_API_KEY ?? '';
  const openaiApiKey = opts.openaiApiKey ?? process.env.OPENAI_API_KEY ?? '';
  const telegramBotToken = opts.telegramBotToken ?? process.env.TELEGRAM_BOT_TOKEN ?? process.env.BOT_TOKEN ?? '';
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  if (!deepgramApiKey && !openaiApiKey) {
    return { ok: false, error: 'No TTS API key configured (set DEEPGRAM_API_KEY or OPENAI_API_KEY)' };
  }
  if (!telegramBotToken) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };
  if (!chatId.trim()) return { ok: false, error: 'chat_id is required' };
  if (!text.trim()) return { ok: false, error: 'text is required' };
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch is not available' };

  const workDir = mkdtempSync(join(tmpdir(), 'cortextos-telegram-voice-'));
  const sourceAudioPath = join(workDir, 'speech.mp3');
  const voicePath = join(workDir, 'voice.ogg');

  try {
    // ── Step 1: TTS synthesis ────────────────────────────────────────────────
    let speechResponse: Response;

    if (deepgramApiKey) {
      // Deepgram Aura-2 (preferred)
      speechResponse = await fetchImpl(DEEPGRAM_SPEECH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Token ${deepgramApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(opts.deepgramTimeoutMs ?? 60_000),
      });

      if (!speechResponse.ok) {
        const detail = await readErrorBody(speechResponse);
        return {
          ok: false,
          error: `Deepgram TTS failed with status ${speechResponse.status}${detail ? `: ${detail}` : ''}`,
        };
      }
    } else {
      // OpenAI tts-1 (fallback)
      speechResponse = await fetchImpl(OPENAI_SPEECH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'tts-1',
          voice: opts.voice ?? DEFAULT_OPENAI_VOICE,
          input: text,
          response_format: 'mp3',
        }),
        signal: AbortSignal.timeout(opts.openaiTimeoutMs ?? 60_000),
      });

      if (!speechResponse.ok) {
        const detail = await readErrorBody(speechResponse);
        return {
          ok: false,
          error: `OpenAI TTS failed with status ${speechResponse.status}${detail ? `: ${detail}` : ''}`,
        };
      }
    }

    const sourceAudio = Buffer.from(await speechResponse.arrayBuffer());
    if (sourceAudio.length === 0) {
      return { ok: false, error: 'TTS provider returned empty audio' };
    }
    writeFileSync(sourceAudioPath, sourceAudio);

    // ── Step 2: Convert MP3 → OGG Opus (Telegram voice format) ─────────────
    const ffmpeg = spawnSync(opts.ffmpegPath ?? 'ffmpeg', [
      '-y',
      '-i', sourceAudioPath,
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-vbr', 'on',
      voicePath,
    ], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: opts.ffmpegTimeoutMs ?? 60_000,
    });

    if (ffmpeg.error) {
      return { ok: false, error: `ffmpeg failed: ${ffmpeg.error.message}` };
    }
    if (ffmpeg.status !== 0) {
      const detail = (ffmpeg.stderr || ffmpeg.stdout || `exit status ${ffmpeg.status}`).trim();
      return { ok: false, error: `ffmpeg failed: ${detail}` };
    }
    if (!existsSync(voicePath)) {
      return { ok: false, error: 'ffmpeg did not produce OGG voice output' };
    }

    // ── Step 3: Send as Telegram voice message ───────────────────────────────
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('voice', new Blob([readFileSync(voicePath)]), 'voice.ogg');

    const telegramResponse = await fetchImpl(
      `https://api.telegram.org/bot${telegramBotToken}/sendVoice`,
      {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(opts.telegramTimeoutMs ?? 60_000),
      },
    );

    let telegramResult: any = null;
    try {
      telegramResult = await telegramResponse.json();
    } catch {
      telegramResult = null;
    }

    if (!telegramResponse.ok || telegramResult?.ok === false) {
      const detail =
        telegramResult?.description ??
        telegramResult?.error ??
        `status ${telegramResponse.status}`;
      return { ok: false, error: `Telegram sendVoice failed: ${detail}` };
    }

    return { ok: true, messageId: telegramResult?.result?.message_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
