import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We stub globalThis.fetch so no network calls are made
const mockFetch = vi.fn();

describe('transcribeVoice', () => {
  let testDir: string;
  let dummyOgg: string;

  beforeEach(() => {
    vi.resetAllMocks();
    // Provide a dummy API key
    process.env.OPENAI_API_KEY = 'sk-test-key';
    // globalThis.fetch is used by the module
    vi.stubGlobal('fetch', mockFetch);

    testDir = mkdtempSync(join(tmpdir(), 'transcribe-test-'));
    dummyOgg = join(testDir, 'voice.ogg');
    writeFileSync(dummyOgg, Buffer.from([0x4f, 0x67, 0x67, 0x53])); // OGG magic bytes
  });

  const cleanup = () => rmSync(testDir, { recursive: true, force: true });

  it('returns transcript text on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'Hello world' }),
    });
    const { transcribeVoice } = await import('../../../src/bus/transcribe-voice');
    const result = await transcribeVoice(dummyOgg);
    cleanup();
    expect(result).toBe('Hello world');
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.headers?.Authorization).toBe('Bearer sk-test-key');
  });

  it('returns empty string when file does not exist', async () => {
    const { transcribeVoice } = await import('../../../src/bus/transcribe-voice');
    const result = await transcribeVoice('/nonexistent/voice.ogg');
    expect(result).toBe('');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty string when API key is missing', async () => {
    process.env.OPENAI_API_KEY = '';
    const { transcribeVoice } = await import('../../../src/bus/transcribe-voice');
    const result = await transcribeVoice(dummyOgg);
    cleanup();
    expect(result).toBe('');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty string on API error (non-ok response)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    });
    const { transcribeVoice } = await import('../../../src/bus/transcribe-voice');
    const result = await transcribeVoice(dummyOgg);
    cleanup();
    expect(result).toBe('');
  });

  it('returns empty string on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network failure'));
    const { transcribeVoice } = await import('../../../src/bus/transcribe-voice');
    const result = await transcribeVoice(dummyOgg);
    cleanup();
    expect(result).toBe('');
  });

  it('trims whitespace from transcript', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '  trimmed  ' }),
    });
    const { transcribeVoice } = await import('../../../src/bus/transcribe-voice');
    const result = await transcribeVoice(dummyOgg);
    cleanup();
    expect(result).toBe('trimmed');
  });
});
