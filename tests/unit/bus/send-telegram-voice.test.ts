import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from 'child_process';
import { writeFileSync } from 'fs';
import { sendTelegramVoice } from '../../../src/bus/send-telegram-voice';

const mockSpawnSync = spawnSync as unknown as Mock;

// Helper: mock a successful ffmpeg run that writes a fake OGG file.
function mockFfmpegSuccess() {
  mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => {
    const outputPath = args[args.length - 1];
    writeFileSync(outputPath, Buffer.from([7, 8, 9]));
    return { status: 0, stdout: '', stderr: '' };
  });
}

describe('sendTelegramVoice', () => {
  const originalDeepgramKey = process.env.DEEPGRAM_API_KEY;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalBotToken = process.env.BOT_TOKEN;
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mockSpawnSync.mockReset();
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalDeepgramKey === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = originalDeepgramKey;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalTelegramToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
    if (originalBotToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = originalBotToken;
  });

  // ─── Guard checks ──────────────────────────────────────────────────────────

  it('returns error when neither TTS key is set', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';

    const result = await sendTelegramVoice('123', 'hello');

    expect(result).toEqual({
      ok: false,
      error: 'No TTS API key configured (set DEEPGRAM_API_KEY or OPENAI_API_KEY)',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('returns error when TELEGRAM_BOT_TOKEN is missing', async () => {
    process.env.OPENAI_API_KEY = 'openai-token';

    const result = await sendTelegramVoice('123', 'hello');

    expect(result).toEqual({ ok: false, error: 'TELEGRAM_BOT_TOKEN not set' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  // ─── OpenAI path ───────────────────────────────────────────────────────────

  it('synthesizes with OpenAI when OPENAI_API_KEY is set (no Deepgram key)', async () => {
    process.env.OPENAI_API_KEY = 'openai-token';
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 987 } }),
      } as Response);

    mockFfmpegSuccess();

    const result = await sendTelegramVoice('chat-123', 'Speak this');

    expect(result).toEqual({ ok: true, messageId: 987 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [openAiUrl, openAiInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(openAiUrl).toBe('https://api.openai.com/v1/audio/speech');
    expect(openAiInit.method).toBe('POST');
    expect((openAiInit.headers as Record<string, string>).Authorization).toBe('Bearer openai-token');
    expect(JSON.parse(String(openAiInit.body))).toMatchObject({
      model: 'tts-1',
      voice: 'alloy',
      input: 'Speak this',
    });
  });

  it('reports OpenAI TTS failure with status code', async () => {
    process.env.OPENAI_API_KEY = 'openai-token';
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Rate limit exceeded',
    } as Response);

    const result = await sendTelegramVoice('123', 'hello');

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('429') });
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  // ─── Deepgram path ─────────────────────────────────────────────────────────

  it('prefers Deepgram when both DEEPGRAM_API_KEY and OPENAI_API_KEY are set', async () => {
    process.env.DEEPGRAM_API_KEY = 'dg-token';
    process.env.OPENAI_API_KEY = 'openai-token';
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from([5, 6, 7, 8]).buffer,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 42 } }),
      } as Response);

    mockFfmpegSuccess();

    const result = await sendTelegramVoice('chat-456', 'Hi from Deepgram');

    expect(result).toEqual({ ok: true, messageId: 42 });

    const [deepgramUrl, deepgramInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(deepgramUrl).toContain('api.deepgram.com/v1/speak');
    expect((deepgramInit.headers as Record<string, string>).Authorization).toBe('Token dg-token');
    expect(JSON.parse(String(deepgramInit.body))).toEqual({ text: 'Hi from Deepgram' });
  });

  it('synthesizes with Deepgram when only DEEPGRAM_API_KEY is set', async () => {
    process.env.DEEPGRAM_API_KEY = 'dg-only';
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from([1, 2]).buffer,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 11 } }),
      } as Response);

    mockFfmpegSuccess();

    const result = await sendTelegramVoice('chat-789', 'Deepgram only');

    expect(result).toEqual({ ok: true, messageId: 11 });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api.deepgram.com');
  });

  it('reports Deepgram TTS failure with status code', async () => {
    process.env.DEEPGRAM_API_KEY = 'dg-token';
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Invalid credentials',
    } as Response);

    const result = await sendTelegramVoice('123', 'hello');

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Deepgram TTS failed') });
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  // ─── Shared path tests ─────────────────────────────────────────────────────

  it('respects opts.deepgramApiKey over env var', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from([1]).buffer,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      } as Response);

    mockFfmpegSuccess();

    const result = await sendTelegramVoice('123', 'test', { deepgramApiKey: 'opts-dg-key' });

    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Token opts-dg-key');
  });

  it('sends ffmpeg output to Telegram as voice', async () => {
    process.env.OPENAI_API_KEY = 'openai-token';
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 7 } }),
      } as Response);

    mockFfmpegSuccess();

    await sendTelegramVoice('chat-99', 'ffmpeg test');

    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    const [ffmpegCmd, ffmpegArgs] = mockSpawnSync.mock.calls[0] as [string, string[]];
    expect(ffmpegCmd).toBe('ffmpeg');
    expect(ffmpegArgs).toEqual(expect.arrayContaining(['-c:a', 'libopus', '-b:a', '32k']));

    const [telegramUrl, telegramInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(telegramUrl).toBe('https://api.telegram.org/bottelegram-token/sendVoice');
    expect(telegramInit.body).toBeInstanceOf(FormData);
    const formData = telegramInit.body as FormData;
    expect(formData.get('chat_id')).toBe('chat-99');
    expect(formData.get('voice')).toBeInstanceOf(Blob);
  });
});
