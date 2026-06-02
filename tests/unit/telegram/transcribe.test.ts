import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { transcribeVoice } from '../../../src/telegram/transcribe';

describe('transcribeVoice', () => {
  let workDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'cortextos-transcribe-test-'));
    savedEnv = {
      CTX_TELEGRAM_NO_TRANSCRIBE: process.env.CTX_TELEGRAM_NO_TRANSCRIBE,
      CTX_WHISPER_BIN: process.env.CTX_WHISPER_BIN,
      CTX_FFMPEG_BIN: process.env.CTX_FFMPEG_BIN,
      CTX_WHISPER_MODEL: process.env.CTX_WHISPER_MODEL,
      CTX_WHISPER_LANG: process.env.CTX_WHISPER_LANG,
    };
    delete process.env.CTX_TELEGRAM_NO_TRANSCRIBE;
    delete process.env.CTX_WHISPER_BIN;
    delete process.env.CTX_FFMPEG_BIN;
    delete process.env.CTX_WHISPER_MODEL;
    delete process.env.CTX_WHISPER_LANG;
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns null when CTX_TELEGRAM_NO_TRANSCRIBE=1', async () => {
    process.env.CTX_TELEGRAM_NO_TRANSCRIBE = '1';
    const oggPath = join(workDir, 'voice.ogg');
    writeFileSync(oggPath, 'fake-audio');
    expect(await transcribeVoice(oggPath)).toBeNull();
  });

  it('returns null when ogg file does not exist', async () => {
    expect(await transcribeVoice(join(workDir, 'missing.ogg'))).toBeNull();
  });

  it('returns null when ogg path is empty', async () => {
    expect(await transcribeVoice('')).toBeNull();
  });

  it('returns null when model file does not exist', async () => {
    const oggPath = join(workDir, 'voice.ogg');
    writeFileSync(oggPath, 'fake-audio');
    process.env.CTX_WHISPER_MODEL = join(workDir, 'no-such-model.bin');
    expect(await transcribeVoice(oggPath)).toBeNull();
  });

  it('returns null when ffmpeg binary is missing', async () => {
    const oggPath = join(workDir, 'voice.ogg');
    const fakeModel = join(workDir, 'model.bin');
    writeFileSync(oggPath, 'fake-audio');
    writeFileSync(fakeModel, 'fake-model');
    process.env.CTX_WHISPER_MODEL = fakeModel;
    process.env.CTX_FFMPEG_BIN = '/nonexistent/path/ffmpeg-does-not-exist';
    expect(await transcribeVoice(oggPath)).toBeNull();
  });

  it('returns null when whisper binary is missing', async () => {
    const oggPath = join(workDir, 'voice.ogg');
    const fakeModel = join(workDir, 'model.bin');
    writeFileSync(oggPath, 'fake-audio');
    writeFileSync(fakeModel, 'fake-model');
    process.env.CTX_WHISPER_MODEL = fakeModel;
    process.env.CTX_FFMPEG_BIN = 'true'; // exit 0, do nothing
    process.env.CTX_WHISPER_BIN = '/nonexistent/path/whisper-cli-does-not-exist';
    // ffmpeg "true" succeeds without producing wav, but the path returned still
    // gets handed to whisper which fails on missing-binary. Either branch
    // yields null — both are valid graceful-fallback outcomes.
    expect(await transcribeVoice(oggPath)).toBeNull();
  });

  it('respects timeoutMs option', async () => {
    const oggPath = join(workDir, 'voice.ogg');
    const fakeModel = join(workDir, 'model.bin');
    writeFileSync(oggPath, 'fake-audio');
    writeFileSync(fakeModel, 'fake-model');
    process.env.CTX_WHISPER_MODEL = fakeModel;
    process.env.CTX_FFMPEG_BIN = 'sleep'; // never returns within timeout
    const start = Date.now();
    const result = await transcribeVoice(oggPath, { timeoutMs: 100 });
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(2000);
  });

  it('passes CTX_WHISPER_LANG to whisper-cli', async () => {
    const oggPath = join(workDir, 'voice.ogg');
    const fakeModel = join(workDir, 'model.bin');
    const wavPath = join(workDir, 'voice.wav');
    const argsPath = join(workDir, 'whisper-args.json');
    const fakeFfmpeg = join(workDir, 'ffmpeg.js');
    const fakeWhisper = join(workDir, 'whisper.js');

    writeFileSync(oggPath, 'fake-audio');
    writeFileSync(fakeModel, 'fake-model');
    writeFileSync(fakeFfmpeg, [
      '#!/usr/bin/env node',
      `require('fs').writeFileSync(${JSON.stringify(wavPath)}, 'fake-wav');`,
      '',
    ].join('\n'));
    writeFileSync(fakeWhisper, [
      '#!/usr/bin/env node',
      `require('fs').writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
      "process.stdout.write('hola mundo\\n');",
      '',
    ].join('\n'));
    chmodSync(fakeFfmpeg, 0o755);
    chmodSync(fakeWhisper, 0o755);

    process.env.CTX_WHISPER_MODEL = fakeModel;
    process.env.CTX_FFMPEG_BIN = fakeFfmpeg;
    process.env.CTX_WHISPER_BIN = fakeWhisper;
    process.env.CTX_WHISPER_LANG = 'es';

    await expect(transcribeVoice(oggPath)).resolves.toBe('hola mundo');
    expect(JSON.parse(readFileSync(argsPath, 'utf-8'))).toEqual([
      '-m', fakeModel,
      '-f', wavPath,
      '-l', 'es',
      '-nt',
      '-np',
    ]);
  });
});
