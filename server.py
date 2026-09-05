"""
Nexora AI local server.

Two independent jobs live here:
  1. /api/chat        - proxies text chat to OpenRouter, Groq, or Gemini and answers a
                         few "live" questions (time, date, weather) directly,
                         without waiting on the language model.
  2. /api/ai/start,
     /api/ai/stop,
     /agora/token      - mints Agora RTC tokens and starts/stops the
                         Conversational AI agent for the voice console.

Run it with `python server.py`, then open http://localhost:8000.
"""

import base64
import json
import os
import re
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

from dotenv import load_dotenv
from agora_token_builder import RtcTokenBuilder

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - stdlib on Python 3.9+
    ZoneInfo = None

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CHAT_PROVIDER = os.environ.get("CHAT_PROVIDER", "openrouter").lower()

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b")

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")
# Lets OpenRouter select an available no-cost model. Set this to a specific
# model ID later if you want consistent responses from one paid model.
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "openrouter/free")

AGORA_APP_ID = os.environ.get("AGORA_APP_ID")
AGORA_APP_CERTIFICATE = os.environ.get("AGORA_APP_CERTIFICATE")
AGORA_CUSTOMER_ID = os.environ.get("AGORA_CUSTOMER_ID")
AGORA_CUSTOMER_SECRET = os.environ.get("AGORA_CUSTOMER_SECRET")
AGORA_PIPELINE_ID = os.environ.get("AGORA_PIPELINE_ID")
AGORA_CHANNEL = os.environ.get("AGORA_CHANNEL", "nexora-demo")
AGORA_AGENT_UID = int(os.environ.get("AGORA_AGENT_UID", "14297"))

PORT = int(os.environ.get("PORT", "8000"))
PROJECT_DIR = Path(__file__).resolve().parent

# Answer directly, don't hedge, don't pad. This is the single biggest fix
# for the "vague answers" complaint - most of that came from the model
# opening with disclaimers instead of the actual answer.
CHAT_INSTRUCTIONS = """You are Nexora, a direct and knowledgeable assistant.

Rules:
- Answer the actual question in the first sentence. Do not open with
  disclaimers, restate the question, or say what you are about to do.
- If you know the answer, state it plainly. Only say you're unsure when
  you genuinely are.
- Default length is 2 to 6 sentences, or up to 5 short bullet points.
  Only go longer if the user asks for depth or a step-by-step guide.
- Never say "as an AI" or similar. Never apologize unless you made an
  actual mistake in this conversation.
- Ask at most one clarifying question, and only when you truly cannot
  proceed without it."""

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/api-config.js": ("api-config.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
}

WEATHER_CODES = {
    0: "clear sky", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
    45: "foggy", 48: "foggy with rime", 51: "light drizzle", 53: "drizzle",
    55: "dense drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
    66: "freezing rain", 67: "heavy freezing rain", 71: "light snow",
    73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light showers",
    81: "showers", 82: "violent showers", 85: "snow showers",
    86: "heavy snow showers", 95: "a thunderstorm", 96: "a thunderstorm with hail",
    99: "a severe thunderstorm with hail",
}

TIME_PATTERN = re.compile(
    r"\b(what(?:'s| is) the time|current time|what time is it|"
    r"what(?:'s| is) today'?s date|what(?:'s| is) the date|"
    r"what day is it|what day is today)\b",
    re.IGNORECASE,
)
WEATHER_PATTERN = re.compile(
    r"\b(weather|temperature outside|forecast|is it raining|"
    r"how hot is it|how cold is it)\b",
    re.IGNORECASE,
)


def required(name, value):
    if not value:
        raise ValueError(f"{name} is missing from .env")
    return value


# ---------------------------------------------------------------------------
# Agora helpers
# ---------------------------------------------------------------------------

def generate_agora_token(channel, uid):
    expires_at = int(time.time()) + 3600
    return RtcTokenBuilder.buildTokenWithUid(
        required("AGORA_APP_ID", AGORA_APP_ID),
        required("AGORA_APP_CERTIFICATE", AGORA_APP_CERTIFICATE),
        channel, int(uid), 1, expires_at,
    )


def agora_headers():
    credentials = f"{required('AGORA_CUSTOMER_ID', AGORA_CUSTOMER_ID)}:{required('AGORA_CUSTOMER_SECRET', AGORA_CUSTOMER_SECRET)}"
    return {
        "Authorization": "Basic " + base64.b64encode(credentials.encode()).decode(),
        "Content-Type": "application/json",
    }


def agora_request(path, payload):
    url = f"https://api.agora.io/api/conversational-ai-agent/v2/projects/{required('AGORA_APP_ID', AGORA_APP_ID)}{path}"
    request = Request(url, data=json.dumps(payload).encode(), headers=agora_headers(), method="POST")
    try:
        with urlopen(request, timeout=30) as response:
            raw = response.read().decode()
            return json.loads(raw) if raw else {}
    except HTTPError as error:
        raise RuntimeError(f"Agora API error {error.code}: {error.read().decode(errors='replace')}") from error
    except URLError as error:
        raise RuntimeError(f"Could not reach Agora: {error.reason}") from error


def start_agora_agent(channel, client_uid):
    payload = {
        "name": f"nexora-{int(time.time())}",
        "pipeline_id": required("AGORA_PIPELINE_ID", AGORA_PIPELINE_ID),
        "properties": {
            "channel": channel,
            "agent_rtc_uid": str(AGORA_AGENT_UID),
            "remote_rtc_uids": [str(client_uid)],
            "token": generate_agora_token(channel, AGORA_AGENT_UID),
            "enable_string_uid": False,
            "idle_timeout": 60,
        },
    }
    return agora_request("/join", payload)


# ---------------------------------------------------------------------------
# Live-answer helpers (time / date / weather) - these bypass the LLM
# entirely so they are always accurate, instead of relying on a model that
# has no clock and no internet access.
# ---------------------------------------------------------------------------

def answer_time_or_date(message, timezone_name):
    tz = None
    if timezone_name and ZoneInfo is not None:
        try:
            tz = ZoneInfo(timezone_name)
        except Exception:
            tz = None
    now = datetime.now(tz) if tz else datetime.utcnow()
    tz_label = timezone_name if tz else "UTC"

    wants_date_only = "date" in message.lower() or "day is" in message.lower()
    if wants_date_only:
        return f"Today is {now.strftime('%A, %B %d, %Y')} ({tz_label})."
    return f"It's {now.strftime('%I:%M %p').lstrip('0')} on {now.strftime('%A, %B %d')} ({tz_label})."


def geocode_location(name):
    url = f"https://geocoding-api.open-meteo.com/v1/search?name={quote(name)}&count=1"
    with urlopen(Request(url), timeout=10) as response:
        data = json.loads(response.read())
    results = data.get("results") or []
    if not results:
        return None
    place = results[0]
    return place["latitude"], place["longitude"], place.get("name", name)


def fetch_weather(lat, lon):
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat}&longitude={lon}"
        "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m"
        "&temperature_unit=celsius&wind_speed_unit=kmh"
    )
    with urlopen(Request(url), timeout=10) as response:
        data = json.loads(response.read())
    return data.get("current", {})


def answer_weather(lat, lon, place_name):
    current = fetch_weather(lat, lon)
    if not current:
        return None
    condition = WEATHER_CODES.get(current.get("weather_code"), "mixed conditions")
    temp = current.get("temperature_2m")
    feels_like = current.get("apparent_temperature")
    wind = current.get("wind_speed_10m")
    where = f" in {place_name}" if place_name else ""
    return (
        f"It's {condition}{where} right now, {temp:.0f}\u00b0C "
        f"(feels like {feels_like:.0f}\u00b0C), wind {wind:.0f} km/h."
    )


def try_answer_live_question(message, context):
    """Return a direct answer string if this is a time/date/weather
    question we can answer ourselves, otherwise None (fall through to the
    language model)."""
    if TIME_PATTERN.search(message):
        return answer_time_or_date(message, context.get("timezone"))

    if WEATHER_PATTERN.search(message):
        lat, lon = context.get("lat"), context.get("lon")
        place_name = context.get("place")
        if lat is None or lon is None:
            city_match = re.search(r"weather (?:in|at|for)\s+([a-zA-Z\s]+)", message, re.IGNORECASE)
            if city_match:
                city_name = re.split(
                    r"\s+(?:today|right now|currently|now)\b|[?.!,]",
                    city_match.group(1).strip(),
                )[0].strip()
                try:
                    located = geocode_location(city_name) if city_name else None
                except Exception:
                    located = None
                if located:
                    lat, lon, place_name = located
            if lat is None or lon is None:
                return ("I need a location to check the weather - share your city, "
                        "or allow location access in your browser, and ask again.")
        try:
            answer = answer_weather(lat, lon, place_name)
        except Exception:
            return "I couldn't reach the weather service just now. Try again in a moment."
        return answer or "I couldn't read a weather report for that location."

    return None


def request_ai(request, provider_name):
    """Retry short-lived provider capacity and service errors before failing."""
    for attempt in range(3):
        try:
            with urlopen(request, timeout=90) as response:
                return json.loads(response.read())
        except HTTPError as error:
            if error.code not in (429, 500, 503) or attempt == 2:
                if error.code in (429, 500, 503):
                    try:
                        detail = json.loads(error.read().decode(errors="replace")).get("error", {}).get("message", "")
                    except (ValueError, json.JSONDecodeError):
                        detail = ""
                    if error.code == 429:
                        message = f"{provider_name} request limit reached. Wait a minute, then check your API quota if it continues."
                    elif error.code == 503:
                        message = f"{provider_name} is temporarily at capacity. Please try again in a moment."
                    else:
                        message = f"{provider_name} had a temporary service problem. Please try again in a moment."
                    raise RuntimeError(f"{message}{f' Details: {detail}' if detail else ''}") from error
            # Do not expose an upstream HTML/proxy response such as "error
            # code: 1010" in the chat.  1010 is normally an access denial
            # from an upstream security layer, not something the visitor can
            # correct by rewording their message.
            if error.code == 1010:
                raise RuntimeError(
                    f"{provider_name} denied this server's request (error 1010). "
                    "Try again shortly; if it continues, allow this server/IP in the provider's security settings or use another chat provider."
                ) from error

            try:
                detail = json.loads(error.read().decode(errors="replace")).get("error", {}).get("message", "")
            except (ValueError, json.JSONDecodeError):
                detail = ""
            raise RuntimeError(
                f"{provider_name} could not complete the request (status {error.code}). "
                f"{detail or 'Please try again in a moment.'}"
            ) from error
            time.sleep(1.5 * (2 ** attempt))


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class NexoraHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print("[Nexora]", format % args)

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            return json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError) as error:
            raise ValueError("Request body must be valid JSON") from error

    def serve_static(self, path):
        filename, content_type = STATIC_FILES[path]
        body = (PROJECT_DIR / filename).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return self.send_json(200, {"success": True})
        if path == "/agora/token":
            try:
                query = parse_qs(urlparse(self.path).query)
                channel = query.get("channel", [AGORA_CHANNEL])[0]
                uid = int(query.get("uid", ["12345"])[0])
                return self.send_json(200, {
                    "appId": AGORA_APP_ID,
                    "channel": channel,
                    "uid": uid,
                    "token": generate_agora_token(channel, uid),
                })
            except Exception as error:
                return self.send_json(500, {"error": str(error)})
        if path in STATIC_FILES:
            return self.serve_static(path)
        return self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        try:
            data = self.read_json()

            if self.path == "/api/ai/start":
                if data.get("uid") is None:
                    raise ValueError("uid is required to start the Agora agent")
                agent = start_agora_agent(data.get("channel", AGORA_CHANNEL), data["uid"])
                return self.send_json(200, {"success": True, "agent": agent})

            if self.path == "/api/ai/stop":
                agent_id = data.get("agentId")
                if not agent_id:
                    raise ValueError("agentId is required")
                agora_request(f"/agents/{agent_id}/leave", {})
                return self.send_json(200, {"success": True})

            if self.path != "/api/chat":
                return self.send_json(404, {"error": "Not found"})

            return self.handle_chat(data)

        except HTTPError as error:
            return self.send_json(error.code, {"error": error.read().decode(errors="replace")})
        except ValueError as error:
            return self.send_json(400, {"error": str(error)})
        except Exception as error:
            return self.send_json(500, {"error": str(error)})

    def handle_chat(self, data):
        messages = [
            {"role": m.get("role", "user"), "content": m["content"]}
            for m in data.get("messages", []) if m.get("content")
        ]
        if not messages:
            return self.send_json(400, {"error": "Please send at least one message."})

        last_message = messages[-1]["content"]
        live_context = {
            "timezone": data.get("timezone"),
            "lat": data.get("lat"),
            "lon": data.get("lon"),
            "place": data.get("place"),
        }
        direct_answer = try_answer_live_question(last_message, live_context)
        if direct_answer:
            return self.send_json(200, {"reply": direct_answer})

        if CHAT_PROVIDER == "groq":
            return self.send_json(200, {"reply": self.ask_groq(messages)})
        if CHAT_PROVIDER == "gemini":
            return self.send_json(200, {"reply": self.ask_gemini(messages, data.get("model"))})
        if CHAT_PROVIDER == "openrouter":
            return self.send_json(200, {"reply": self.ask_openrouter(messages, data.get("model"))})
        raise ValueError("CHAT_PROVIDER must be 'openrouter', 'groq', or 'gemini'")

    def ask_groq(self, messages):
        if not GROQ_API_KEY:
            raise ValueError("GROQ_API_KEY is missing from the server environment")
        payload = {
            "model": GROQ_MODEL,
            "messages": [{"role": "system", "content": CHAT_INSTRUCTIONS}, *messages],
            "max_tokens": 450,
            "temperature": 0.4,
        }
        request = Request(
            "https://api.groq.com/openai/v1/chat/completions",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {GROQ_API_KEY}"},
            method="POST",
        )
        result = request_ai(request, "Groq")
        reply = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        return reply or "I couldn't generate a response."

    def ask_gemini(self, messages, requested_model):
        if not GEMINI_API_KEY:
            raise ValueError("GEMINI_API_KEY is missing from the server environment")
        contents = [
            {"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
            for m in messages
        ]
        model = requested_model or GEMINI_MODEL
        payload = {
            "systemInstruction": {"parts": [{"text": CHAT_INSTRUCTIONS}]},
            "contents": contents,
            "generationConfig": {"maxOutputTokens": 450, "temperature": 0.4},
        }
        request = Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        result = request_ai(request, "Gemini")
        parts = result.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        reply = "".join(p.get("text", "") for p in parts)
        return reply or "I couldn't generate a response."

    def ask_openrouter(self, messages, requested_model):
        if not OPENROUTER_API_KEY:
            raise ValueError("OPENROUTER_API_KEY is missing from the server environment")
        payload = {
            "model": requested_model or OPENROUTER_MODEL,
            "messages": [{"role": "system", "content": CHAT_INSTRUCTIONS}, *messages],
            "max_tokens": 450,
            "temperature": 0.4,
        }
        request = Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {OPENROUTER_API_KEY}"},
            method="POST",
        )
        result = request_ai(request, "OpenRouter")
        reply = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        return reply or "I couldn't generate a response."


if __name__ == "__main__":
    print(f"Nexora server: http://localhost:{PORT}")
    print(f"Chat provider: {CHAT_PROVIDER}")
    print(f"Agora REST credentials: {'loaded' if AGORA_CUSTOMER_ID and AGORA_CUSTOMER_SECRET else 'missing'}")
    print(f"Agora pipeline ID: {'loaded' if AGORA_PIPELINE_ID else 'missing'}")
    ThreadingHTTPServer(("0.0.0.0", PORT), NexoraHandler).serve_forever()
