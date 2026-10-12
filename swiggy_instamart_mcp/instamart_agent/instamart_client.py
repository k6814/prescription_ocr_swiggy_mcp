"""
MCP client for Swiggy Instamart, using the official `mcp` Python SDK's OAuth
client support (2.1 + PKCE + Dynamic Client Registration -- see
https://mcp.swiggy.com/builders/docs/start/authenticate.md, which documents
DCR at POST /auth/register, meaning you do NOT need to pre-register a client
id for development; the SDK's OAuthClientProvider does discovery, DCR, PKCE,
and token exchange automatically against the server's /.well-known metadata).

KNOWN GAP -- staging vs production endpoint: Swiggy's quickstart
(https://mcp.swiggy.com/builders/docs/start/developer/index.md) says steps
1-5 run against "a staging endpoint" before you apply for production access,
but does not spell out the staging hostname in what I could retrieve. The
URL below (https://mcp.swiggy.com/im) is the one published in the consumer
README for the live/production connector. Check the quickstart yourself for
whether local development should point elsewhere -- don't assume this URL is
right for a first test.

KNOWN GAP -- redirect URI port: Swiggy's consumer manifest whitelists
`http://localhost/callback` with NO port number. If their auth server does
exact-string redirect matching (typical), a callback listener on a random
high port (e.g. :8765) will be rejected even though `localhost` matches.
CALLBACK_PORT below defaults to 80, which requires elevated privileges on
most systems (`sudo` on Linux/Mac, admin on Windows) or an explicit
capability grant (e.g. `setcap` on Linux). If binding port 80 isn't viable in
your setup, the realistic options are: run as root/admin for this one script,
use a reverse proxy that forwards :80 -> your listener, or ask
builders@swiggy.in whether a ported redirect_uri can be whitelisted for you.
This is a genuine external constraint, not a bug in this code.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
from pydantic import AnyUrl

from mcp import ClientSession
from mcp.client.auth import OAuthClientProvider
from mcp.client.streamable_http import streamablehttp_client
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata, OAuthToken

SERVER_URL = "https://mcp.swiggy.com/im"  # see KNOWN GAP above before trusting this
CALLBACK_HOST = "localhost"
CALLBACK_PORT = int(os.environ.get("SWIGGY_CALLBACK_PORT", "80"))
CALLBACK_PATH = "/callback"
TOKEN_FILE = Path(__file__).parent / ".swiggy_im_token.json"


# ---- Persistent token storage (file-based, so you don't re-auth every run) ----

class FileTokenStorage:
    def __init__(self, path: Path = TOKEN_FILE):
        self.path = path
        self._data = self._load()

    def _load(self) -> dict:
        if self.path.exists():
            return json.loads(self.path.read_text())
        return {}

    def _save(self) -> None:
        self.path.write_text(json.dumps(self._data))
        self.path.chmod(0o600)  # tokens are credentials -- don't leave them world-readable

    async def get_tokens(self) -> OAuthToken | None:
        raw = self._data.get("tokens")
        return OAuthToken.model_validate(raw) if raw else None

    async def set_tokens(self, tokens: OAuthToken) -> None:
        self._data["tokens"] = tokens.model_dump(mode="json")
        self._save()

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        raw = self._data.get("client_info")
        return OAuthClientInformationFull.model_validate(raw) if raw else None

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        self._data["client_info"] = client_info.model_dump(mode="json")
        self._save()


# ---- One-shot local HTTP server to catch the OAuth redirect ----

class _CallbackResult:
    code: str | None = None
    state: str | None = None
    error: str | None = None


def _make_handler(result: _CallbackResult, done: threading.Event):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path != CALLBACK_PATH:
                self.send_response(404)
                self.end_headers()
                return
            params = parse_qs(parsed.query)
            result.code = params.get("code", [None])[0]
            result.state = params.get("state", [None])[0]
            result.error = params.get("error", [None])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            msg = "Authentication failed, check the terminal." if result.error else "Authenticated -- you can close this tab."
            self.wfile.write(f"<html><body>{msg}</body></html>".encode())
            done.set()

        def log_message(self, *args):  # silence default request logging
            pass

    return Handler


async def _redirect_handler(authorization_url: str) -> None:
    print(f"\nOpening browser for Swiggy login. If it doesn't open, visit:\n{authorization_url}\n")
    webbrowser.open(authorization_url)


async def _callback_handler():
    from mcp.client.auth import AuthorizationCodeResult

    result = _CallbackResult()
    done = threading.Event()
    server = HTTPServer((CALLBACK_HOST, CALLBACK_PORT), _make_handler(result, done))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        await asyncio.get_event_loop().run_in_executor(None, done.wait)
    finally:
        server.shutdown()

    if result.error:
        raise RuntimeError(f"OAuth callback returned error: {result.error}")
    return AuthorizationCodeResult(code=result.code, state=result.state, iss=None)


def build_oauth_provider() -> OAuthClientProvider:
    return OAuthClientProvider(
        server_url=SERVER_URL,
        client_metadata=OAuthClientMetadata(
            client_name="Instamart NL Cart Agent",
            redirect_uris=[AnyUrl(f"http://{CALLBACK_HOST}:{CALLBACK_PORT}{CALLBACK_PATH}"
                                   if CALLBACK_PORT != 80
                                   else f"http://{CALLBACK_HOST}{CALLBACK_PATH}")],
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
            scope="mcp:tools",
        ),
        storage=FileTokenStorage(),
        redirect_handler=_redirect_handler,
        callback_handler=_callback_handler,
    )


class InstamartClient:
    """Thin async context manager wrapping an authenticated MCP session."""

    def __init__(self):
        self._cm = None
        self.session: ClientSession | None = None

    async def __aenter__(self) -> "InstamartClient":
        oauth = build_oauth_provider()
        http_client = httpx.AsyncClient(auth=oauth, timeout=30.0)
        transport = streamablehttp_client(SERVER_URL, http_client=http_client)
        self._transport_cm = transport
        read, write, _ = await transport.__aenter__()
        self.session = ClientSession(read, write)
        await self.session.__aenter__()
        await self.session.initialize()
        return self

    async def __aexit__(self, *exc):
        if self.session:
            await self.session.__aexit__(*exc)
        await self._transport_cm.__aexit__(*exc)

    async def list_tools(self):
        return await self.session.list_tools()

    async def call_tool(self, name: str, arguments: dict):
        return await self.session.call_tool(name, arguments)
