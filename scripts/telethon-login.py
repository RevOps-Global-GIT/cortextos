#!/usr/bin/env python3
"""
One-time Telethon user account login for the Telegram voice room agent.
Run once on the VM to create a session file, then the voice agent uses it automatically.

Usage: python3 scripts/telethon-login.py
"""

import os
import asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession

API_ID = int(os.environ.get("TELEGRAM_MCP_API_ID", "34427999"))
API_HASH = os.environ.get("TELEGRAM_MCP_API_HASH", "cc2bc0ad9cc1dc48438c07e2d40dce68")
SESSION_PATH = os.environ.get("TELETHON_SESSION_PATH", os.path.expanduser("~/.cortextos/telethon-orch"))

async def main():
    os.makedirs(os.path.dirname(SESSION_PATH), exist_ok=True)
    client = TelegramClient(SESSION_PATH, API_ID, API_HASH)
    await client.start()
    me = await client.get_me()
    print(f"\n✓ Logged in as: {me.first_name} (@{me.username})")
    print(f"✓ Session saved to: {SESSION_PATH}.session")
    print(f"\nThe voice room agent will use this session automatically.")
    await client.disconnect()

asyncio.run(main())
