#!/usr/bin/env python3
"""Telegram voice-room agent for CortexOS.

Joins an existing Telegram group voice chat, streams incoming audio to
Deepgram STT, sends completed utterances to the CortexOS bus, and speaks
orchestrator replies back into the room with Deepgram TTS.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import subprocess
import sys
import tempfile
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

import aiohttp  # noqa: F401 - kept as a runtime dependency check for Deepgram async installs.
from deepgram import AsyncDeepgramClient
from pytgcalls import PyTgCalls
import pytgcalls.filters as tg_filters
from pytgcalls.types import AudioQuality
from pytgcalls.types import Device
from pytgcalls.types import Direction
from pytgcalls.types import GroupCallConfig
from pytgcalls.types import MediaStream
from pytgcalls.types import RecordStream
from pytgcalls.types import StreamEnded
from pytgcalls.types import StreamFrames
from telethon import TelegramClient


DEFAULT_PROJECT_ROOT = Path(os.environ.get("CTX_FRAMEWORK_ROOT", str(Path.home() / "cortextos"))).expanduser()
DEFAULT_SECRETS_FILE = DEFAULT_PROJECT_ROOT / "orgs/revops-global/secrets.env"
DEFAULT_SESSION_FILE = Path.home() / ".cortextos/telethon-voice-agent.session"
DEFAULT_CTX_ROOT = Path.home() / ".cortextos/cortextos1"
AGENT_NAME = "voice-room-agent"
BUS_TARGET = "orchestrator"


@dataclass(frozen=True)
class Config:
    group: int | str
    telegram_api_id: int
    telegram_api_hash: str
    deepgram_api_key: str
    session_file: Path
    secrets_file: Path
    project_root: Path
    ctx_root: Path
    ctx_instance_id: str
    ctx_org: str
    stt_model: str
    stt_encoding: str
    stt_sample_rate: int
    stt_channels: int
    tts_model: str
    reply_timeout: float
    inbox_poll_interval: float
    auto_start_call: bool


def parse_env_file(path: Path) -> Dict[str, str]:
    values: Dict[str, str] = {}
    if not path.exists():
        return values

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        else:
            comment_at = value.find(" #")
            if comment_at >= 0:
                value = value[:comment_at].strip()
        values[key] = value

    return values


def env_value(secrets: Dict[str, str], key: str, default: Optional[str] = None) -> Optional[str]:
    return os.environ.get(key) or secrets.get(key) or default


def require_env(secrets: Dict[str, str], key: str) -> str:
    value = env_value(secrets, key)
    if not value:
        raise RuntimeError(f"Missing required secret/env value: {key}")
    return value


def require_env_any(secrets: Dict[str, str], *keys: str) -> str:
    for key in keys:
        value = env_value(secrets, key)
        if value:
            return value
    raise RuntimeError(f"Missing required secret/env value: one of {', '.join(keys)}")


def parse_group_ref(value: str) -> int | str:
    if value.lstrip("-").isdigit():
        return int(value)
    return value


def build_config(args: argparse.Namespace) -> Config:
    secrets_file = Path(args.secrets_file).expanduser()
    secrets = parse_env_file(secrets_file)

    try:
        telegram_api_id = int(require_env_any(secrets, "TELEGRAM_API_ID", "TELEGRAM_MCP_API_ID"))
    except ValueError as exc:
        raise RuntimeError("TELEGRAM_API_ID must be an integer") from exc

    return Config(
        group=parse_group_ref(args.group),
        telegram_api_id=telegram_api_id,
        telegram_api_hash=require_env_any(secrets, "TELEGRAM_API_HASH", "TELEGRAM_MCP_API_HASH"),
        deepgram_api_key=require_env(secrets, "DEEPGRAM_API_KEY"),
        session_file=Path(args.session_file).expanduser(),
        secrets_file=secrets_file,
        project_root=Path(args.project_root).expanduser(),
        ctx_root=Path(args.ctx_root).expanduser(),
        ctx_instance_id=args.ctx_instance_id,
        ctx_org=args.ctx_org,
        stt_model=args.stt_model,
        stt_encoding=args.stt_encoding,
        stt_sample_rate=args.stt_sample_rate,
        stt_channels=args.stt_channels,
        tts_model=args.tts_model,
        reply_timeout=args.reply_timeout,
        inbox_poll_interval=args.inbox_poll_interval,
        auto_start_call=args.auto_start_call,
    )


def configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        stream=sys.stdout,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Join a Telegram voice chat and bridge live speech to the CortexOS orchestrator.",
    )
    parser.add_argument("--group", required=True, help="Telegram group/channel id or username with an active voice chat.")
    parser.add_argument("--secrets-file", default=str(DEFAULT_SECRETS_FILE), help="CortexOS secrets.env path.")
    parser.add_argument("--session-file", default=str(DEFAULT_SESSION_FILE), help="Telethon .session file path.")
    parser.add_argument("--project-root", default=str(DEFAULT_PROJECT_ROOT), help="CortexOS project root for bus env.")
    parser.add_argument("--ctx-root", default=str(DEFAULT_CTX_ROOT), help="CortexOS instance root for bus env.")
    parser.add_argument("--ctx-instance-id", default="cortextos1", help="CortexOS instance id.")
    parser.add_argument("--ctx-org", default="revops-global", help="CortexOS org id.")
    parser.add_argument("--stt-model", default=os.environ.get("DEEPGRAM_STT_MODEL", "nova-3"))
    parser.add_argument("--stt-encoding", default=os.environ.get("DEEPGRAM_STT_ENCODING", "linear16"))
    parser.add_argument("--stt-sample-rate", type=int, default=int(os.environ.get("DEEPGRAM_STT_SAMPLE_RATE", "48000")))
    parser.add_argument("--stt-channels", type=int, default=int(os.environ.get("DEEPGRAM_STT_CHANNELS", "2")))
    parser.add_argument("--tts-model", default=os.environ.get("DEEPGRAM_TTS_MODEL", "aura-2-orion-en"))
    parser.add_argument("--reply-timeout", type=float, default=float(os.environ.get("VOICE_AGENT_REPLY_TIMEOUT", "90")))
    parser.add_argument("--inbox-poll-interval", type=float, default=float(os.environ.get("VOICE_AGENT_INBOX_POLL", "2")))
    parser.add_argument(
        "--auto-start-call",
        action="store_true",
        help="Start a group call if none exists. Default is safer: join only an existing voice chat.",
    )
    parser.add_argument("--verbose", action="store_true", help="Enable debug logging.")
    return parser


class BusClient:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.env = os.environ.copy()
        self.env.update(
            {
                "CTX_AGENT_NAME": AGENT_NAME,
                "CTX_INSTANCE_ID": config.ctx_instance_id,
                "CTX_ORG": config.ctx_org,
                "CTX_PROJECT_ROOT": str(config.project_root),
                "CTX_FRAMEWORK_ROOT": str(config.project_root),
                "CTX_ROOT": str(config.ctx_root),
            },
        )

    async def send_to_orchestrator(self, text: str) -> Optional[str]:
        clean_text = text.strip()
        if not clean_text:
            return None

        logging.info("bus send -> %s: %s", BUS_TARGET, clean_text)
        proc = await asyncio.create_subprocess_exec(
            "cortextos",
            "bus",
            "send-message",
            BUS_TARGET,
            "normal",
            clean_text,
            cwd=str(self.config.project_root),
            env=self.env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if stderr:
            logging.warning("bus send stderr: %s", stderr.decode(errors="replace").strip())
        if proc.returncode != 0:
            logging.error("bus send failed with exit %s", proc.returncode)
            return None

        message_id = stdout.decode(errors="replace").strip().splitlines()[-1].strip()
        logging.info("bus message id: %s", message_id)
        return message_id

    async def wait_for_reply(self, request_id: Optional[str]) -> Optional[str]:
        deadline = time.monotonic() + self.config.reply_timeout
        fallback_reply: Optional[str] = None

        while time.monotonic() < deadline:
            messages = await self.check_inbox()
            for message in messages:
                message_id = str(message.get("id") or "")
                sender = str(message.get("from") or "")
                text = str(message.get("text") or "").strip()
                reply_to = message.get("reply_to")

                if message_id:
                    await self.ack_inbox(message_id)

                if not text:
                    continue
                if sender not in {BUS_TARGET, "director", "orchestrator"}:
                    logging.debug("ignoring inbox message from %s", sender)
                    continue
                if request_id and reply_to == request_id:
                    logging.info("bus reply <- %s: %s", sender, text)
                    return text
                if fallback_reply is None:
                    fallback_reply = text

            if fallback_reply:
                logging.info("bus reply <- fallback: %s", fallback_reply)
                return fallback_reply

            await asyncio.sleep(self.config.inbox_poll_interval)

        logging.warning("timed out waiting for orchestrator reply")
        return None

    async def check_inbox(self) -> Iterable[Dict[str, Any]]:
        proc = await asyncio.create_subprocess_exec(
            "cortextos",
            "bus",
            "check-inbox",
            cwd=str(self.config.project_root),
            env=self.env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if stderr:
            logging.warning("bus inbox stderr: %s", stderr.decode(errors="replace").strip())
        if proc.returncode != 0:
            logging.error("bus check-inbox failed with exit %s", proc.returncode)
            return []

        raw = stdout.decode(errors="replace").strip() or "[]"
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            logging.warning("bus check-inbox returned non-JSON: %s", raw)
            return []

        if not isinstance(data, list):
            logging.warning("bus check-inbox returned unexpected payload: %r", data)
            return []
        return [item for item in data if isinstance(item, dict)]

    async def ack_inbox(self, message_id: str) -> None:
        proc = await asyncio.create_subprocess_exec(
            "cortextos",
            "bus",
            "ack-inbox",
            message_id,
            cwd=str(self.config.project_root),
            env=self.env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            logging.warning(
                "bus ack failed for %s: %s%s",
                message_id,
                stderr.decode(errors="replace").strip(),
                stdout.decode(errors="replace").strip(),
            )


class DeepgramBridge:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.client = AsyncDeepgramClient(api_key=config.deepgram_api_key)
        self.audio_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=400)
        self.utterance_queue: asyncio.Queue[str] = asyncio.Queue()
        self._stop = asyncio.Event()
        self._task: Optional[asyncio.Task[None]] = None
        self._partials: list[str] = []

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="deepgram-stt")

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def push_audio(self, audio: bytes) -> None:
        if not audio:
            return
        try:
            self.audio_queue.put_nowait(audio)
        except asyncio.QueueFull:
            logging.warning("dropping audio frame because Deepgram queue is full")

    async def next_utterance(self) -> str:
        return await self.utterance_queue.get()

    async def synthesize_to_wav(self, text: str) -> Path:
        fd, path = tempfile.mkstemp(prefix="voice-room-agent-", suffix=".wav")
        os.close(fd)
        wav_path = Path(path)

        logging.info("deepgram tts synthesize: %s", text)
        async with aiohttp.ClientSession():
            chunks = self.client.speak.v1.audio.generate(
                text=text,
                model=self.config.tts_model,
                container="wav",
                encoding="linear16",
                sample_rate=self.config.stt_sample_rate,
            )
            with wav_path.open("wb") as out:
                async for chunk in chunks:
                    out.write(chunk)

        return wav_path

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                logging.info("deepgram stt connecting")
                async with self.client.listen.v1.connect(
                    model=self.config.stt_model,
                    encoding=self.config.stt_encoding,
                    sample_rate=self.config.stt_sample_rate,
                    channels=self.config.stt_channels,
                    interim_results=True,
                    punctuate=True,
                    smart_format=True,
                    utterance_end_ms=1000,
                    vad_events=True,
                ) as socket:
                    logging.info("deepgram stt connected")
                    sender = asyncio.create_task(self._send_audio(socket), name="deepgram-audio-sender")
                    receiver = asyncio.create_task(self._receive_transcripts(socket), name="deepgram-transcript-receiver")
                    done, pending = await asyncio.wait(
                        {sender, receiver},
                        return_when=asyncio.FIRST_EXCEPTION,
                    )
                    for task in done:
                        exc = task.exception()
                        if exc:
                            raise exc
                    for task in pending:
                        task.cancel()
            except asyncio.CancelledError:
                raise
            except Exception:
                logging.exception("deepgram stt connection dropped; reconnecting")
                await asyncio.sleep(2)

    async def _send_audio(self, socket: Any) -> None:
        while not self._stop.is_set():
            try:
                audio = await asyncio.wait_for(self.audio_queue.get(), timeout=8)
            except asyncio.TimeoutError:
                await socket.send_keep_alive()
                continue
            await socket.send_media(audio)

    async def _receive_transcripts(self, socket: Any) -> None:
        async for message in socket:
            if isinstance(message, bytes):
                continue

            message_type = type(message).__name__
            if message_type.endswith("UtteranceEnd"):
                await self._flush_utterance()
                continue

            transcript = self._extract_transcript(message)
            if not transcript:
                continue

            if bool(getattr(message, "is_final", False)):
                self._partials.append(transcript)
                if bool(getattr(message, "speech_final", False)):
                    await self._flush_utterance()
            else:
                logging.debug("deepgram interim: %s", transcript)

    @staticmethod
    def _extract_transcript(message: Any) -> str:
        channel = getattr(message, "channel", None)
        alternatives = getattr(channel, "alternatives", None) if channel else None
        if alternatives:
            transcript = getattr(alternatives[0], "transcript", "")
            return str(transcript).strip()

        if isinstance(message, dict):
            alternatives = (
                message.get("channel", {})
                .get("alternatives", [])
            )
            if alternatives:
                return str(alternatives[0].get("transcript") or "").strip()

        return ""

    async def _flush_utterance(self) -> None:
        text = " ".join(part.strip() for part in self._partials if part.strip()).strip()
        self._partials.clear()
        if text:
            logging.info("deepgram final utterance: %s", text)
            await self.utterance_queue.put(text)


class TelegramVoiceRoomAgent:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.bus = BusClient(config)
        self.deepgram = DeepgramBridge(config)
        self.telegram = TelegramClient(
            str(config.session_file),
            config.telegram_api_id,
            config.telegram_api_hash,
        )
        self.calls = PyTgCalls(self.telegram)
        self.stop_event = asyncio.Event()
        self.speaking = False
        self.playback_done: Optional[asyncio.Event] = None
        self.chat_id: Optional[int] = None

    async def run(self) -> None:
        self._install_signal_handlers()
        self._register_call_handlers()

        await self.telegram.connect()
        if not await self.telegram.is_user_authorized():
            raise RuntimeError(f"Telethon session is not authorized: {self.config.session_file}")
        logging.info("telethon connected with session %s", self.config.session_file)

        await self.calls.start()
        await self.join_voice_chat()
        self.deepgram.start()

        logging.info("voice room agent is listening")
        worker = asyncio.create_task(self._conversation_loop(), name="conversation-loop")
        stopper = asyncio.create_task(self.stop_event.wait(), name="shutdown-wait")
        done, pending = await asyncio.wait({worker, stopper}, return_when=asyncio.FIRST_COMPLETED)

        for task in pending:
            task.cancel()
        for task in done:
            if task is not stopper:
                exc = task.exception()
                if exc:
                    raise exc

        await self.shutdown()

    async def join_voice_chat(self) -> None:
        config = GroupCallConfig(auto_start=self.config.auto_start_call)
        await self.calls.play(self.config.group, stream=None, config=config)
        await self.calls.record(
            self.config.group,
            RecordStream(audio=True, audio_parameters=AudioQuality.HIGH),
            config=config,
        )
        self.chat_id = await self.calls.resolve_chat_id(self.config.group)
        logging.info("joined voice chat for %s as chat_id=%s", self.config.group, self.chat_id)

    def _register_call_handlers(self) -> None:
        @self.calls.on_update(tg_filters.stream_frame(Direction.INCOMING))
        async def on_stream_frame(_: PyTgCalls, update: StreamFrames) -> None:
            if self.chat_id is not None and update.chat_id != self.chat_id:
                return
            if self.speaking:
                return
            if not (update.device & (Device.MICROPHONE | Device.SPEAKER)):
                return
            for frame in update.frames:
                await self.deepgram.push_audio(frame.frame)

        @self.calls.on_update()
        async def on_update(_: PyTgCalls, update: Any) -> None:
            if not isinstance(update, StreamEnded):
                return
            if self.chat_id is not None and update.chat_id != self.chat_id:
                return
            if self.playback_done:
                self.playback_done.set()

    async def _conversation_loop(self) -> None:
        while not self.stop_event.is_set():
            transcript = await self.deepgram.next_utterance()
            request_id = await self.bus.send_to_orchestrator(transcript)
            if not request_id:
                continue

            reply = await self.bus.wait_for_reply(request_id)
            if not reply:
                continue

            await self.speak(reply)

    async def speak(self, text: str) -> None:
        wav_path = await self.deepgram.synthesize_to_wav(text)
        duration = wav_duration_seconds(wav_path)
        self.playback_done = asyncio.Event()
        self.speaking = True

        try:
            logging.info("playing reply into Telegram voice chat")
            stream = MediaStream(
                wav_path,
                audio_parameters=AudioQuality.HIGH,
                video_flags=MediaStream.Flags.IGNORE,
            )
            await self.calls.play(
                self.config.group,
                stream=stream,
                config=GroupCallConfig(auto_start=False),
            )
            try:
                await asyncio.wait_for(self.playback_done.wait(), timeout=max(duration + 5, 10))
            except asyncio.TimeoutError:
                logging.debug("playback end event timed out after %.1fs", duration)
        finally:
            self.speaking = False
            self.playback_done = None
            try:
                await self.calls.play(
                    self.config.group,
                    stream=None,
                    config=GroupCallConfig(auto_start=False),
                )
            except Exception:
                logging.exception("failed to reset Telegram output stream")
            try:
                wav_path.unlink()
            except FileNotFoundError:
                pass

    def _install_signal_handlers(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self.stop_event.set)
            except NotImplementedError:
                signal.signal(sig, lambda *_: self.stop_event.set())

    async def shutdown(self) -> None:
        logging.info("shutting down")
        await self.deepgram.stop()
        try:
            await self.calls.leave_call(self.config.group, close=False)
        except Exception:
            logging.debug("leave_call failed or call was not active", exc_info=True)
        try:
            await self.telegram.disconnect()
        except Exception:
            logging.debug("telethon disconnect failed", exc_info=True)


def wav_duration_seconds(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as wav:
            frames = wav.getnframes()
            rate = wav.getframerate()
            channels = wav.getnchannels() or 1
            sample_width = wav.getsampwidth() or 1
            declared_payload_size = frames * channels * sample_width
            actual_payload_size = max(path.stat().st_size - 44, 0)
            if declared_payload_size > actual_payload_size * 2:
                return actual_payload_size / float((rate or 1) * channels * sample_width)
            return frames / float(rate or 1)
    except wave.Error:
        return 0.0


async def async_main(args: argparse.Namespace) -> int:
    config = build_config(args)
    if not config.session_file.exists():
        raise RuntimeError(f"Telethon session file does not exist: {config.session_file}")

    agent = TelegramVoiceRoomAgent(config)
    await agent.run()
    return 0


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    configure_logging(args.verbose)

    try:
        return asyncio.run(async_main(args))
    except KeyboardInterrupt:
        logging.info("interrupted")
        return 130
    except (RuntimeError, subprocess.SubprocessError):
        logging.exception("fatal error")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
