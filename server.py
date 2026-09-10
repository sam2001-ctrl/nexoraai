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
from threading import Lock
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
CLASSROOMS = {}
CLASSROOM_LOCK = Lock()

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
- Use concise Markdown when it improves clarity: short headings, bold key
  terms, and compact lists. Never use raw HTML.
- Never say "as an AI" or similar. Never apologize unless you made an
  actual mistake in this conversation.
- Ask at most one clarifying question, and only when you truly cannot
  proceed without it.
- Always complete your final sentence. If space is limited, give a shorter
  complete answer instead of stopping in the middle of a sentence."""

CHAT_MAX_TOKENS = 600

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


def start_agora_agent(channel, participant_uids):
    payload = {
        "name": f"nexora-{int(time.time())}",
        "pipeline_id": required("AGORA_PIPELINE_ID", AGORA_PIPELINE_ID),
        "properties": {
            "channel": channel,
            "agent_rtc_uid": str(AGORA_AGENT_UID),
            "remote_rtc_uids": [str(uid) for uid in participant_uids],
            "token": generate_agora_token(channel, AGORA_AGENT_UID),
            "enable_string_uid": False,
            "idle_timeout": 60,
        },
    }
    return agora_request("/join", payload)


def classroom_key(code):
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "", str(code or ""))[:32]
    if not cleaned:
        raise ValueError("A classroom code is required")
    return cleaned.upper()


def get_classroom(code):
    code = classroom_key(code)
    with CLASSROOM_LOCK:
        return CLASSROOMS.setdefault(code, {
            "code": code, "participants": {}, "events": [], "gaps": {}, "gap_users": {},
            "ai_allowed": False, "quiz_active": False, "agent_id": None,
            "lesson": {}, "confusion_signals": [], "quiz": {"answers": {}},
        })


def classroom_snapshot(room):
    participants = list(room["participants"].values())
    gaps = sorted(room["gaps"].items(), key=lambda item: item[1], reverse=True)[:5]
    return {
        "code": room["code"], "participants": participants,
        "events": room["events"][-60:], "gaps": gaps,
        "aiAllowed": room["ai_allowed"], "quizActive": room["quiz_active"],
        "lesson": room["lesson"], "confusionSignals": room["confusion_signals"][-8:],
        "quiz": {"active": room["quiz_active"], "answers": room["quiz"]["answers"]},
    }


def capture_learning_gap(room, text, speaker):
    # Lightweight, explainable heuristic for a hackathon prototype: repeated
    # question language is evidence of a shared concept gap, not a diagnosis.
    signal_match = re.search(r"\?|confus|don't understand|dont understand|explain|help|what is|why|simpler|again", text, re.I)
    if not signal_match:
        return
    room["confusion_signals"].append({"speaker": speaker, "text": text[:160], "at": int(time.time() * 1000)})
    room["confusion_signals"] = room["confusion_signals"][-40:]
    words = re.findall(r"[A-Za-z]{4,}", text.lower())
    ignored = {"what", "with", "this", "that", "from", "have", "does", "about", "please", "explain", "understand", "help"}
    for word in words:
        if word not in ignored:
            room["gaps"][word] = room["gaps"].get(word, 0) + 1
            room["gap_users"].setdefault(word, set()).add(speaker)


def clean_lesson(data):
    return {
        "topic": re.sub(r"\s+", " ", str(data.get("topic") or "")).strip()[:80],
        "level": re.sub(r"\s+", " ", str(data.get("level") or "")).strip()[:40],
        "language": re.sub(r"\s+", " ", str(data.get("language") or "")).strip()[:40],
        "objective": re.sub(r"\s+", " ", str(data.get("objective") or "")).strip()[:160],
        "quizQuestion": re.sub(r"\s+", " ", str(data.get("quizQuestion") or "")).strip()[:240],
        "expectedAnswer": re.sub(r"\s+", " ", str(data.get("expectedAnswer") or "")).strip().lower()[:100],
    }


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


def fetch_weather_fallback(place_name):
    """Fetch current weather from wttr.in when Open-Meteo is unreachable.

    This fallback needs a city name and no API key. It keeps weather replies
    working if one provider blocks or temporarily rejects the server host.
    """
    if not place_name:
        return None
    url = f"https://wttr.in/{quote(place_name, safe='')}?format=j1"
    with urlopen(Request(url, headers={"User-Agent": "Nexora/1.0"}), timeout=12) as response:
        data = json.loads(response.read())
    current = (data.get("current_condition") or [{}])[0]
    if not current:
        return None
    condition = ((current.get("weatherDesc") or [{}])[0].get("value")) or "mixed conditions"
    location = ((data.get("nearest_area") or [{}])[0].get("areaName") or [{}])[0].get("value") or place_name
    temp = current.get("temp_C")
    feels_like = current.get("FeelsLikeC")
    wind = current.get("windspeedKmph")
    if temp is None or feels_like is None or wind is None:
        return None
    return f"It's {condition.lower()} in {location} right now, {temp}°C (feels like {feels_like}°C), wind {wind} km/h."


def find_reference_leads(query):
    """Return a few real, clickable starting references for opt-in research."""
    clean_query = re.sub(r"\s+", " ", str(query or "")).strip()[:220]
    if not clean_query:
        return []
    url = (
        "https://en.wikipedia.org/w/api.php?action=query&list=search"
        f"&srsearch={quote(clean_query)}&srlimit=3&format=json"
    )
    try:
        with urlopen(Request(url, headers={"User-Agent": "NexoraAI/1.0"}), timeout=5) as response:
            results = json.loads(response.read()).get("query", {}).get("search", [])
    except Exception as error:
        print(f"[Nexora] Reference search unavailable: {error}")
        return []
    return [
        {"title": item["title"], "url": f"https://en.wikipedia.org/wiki/{quote(item['title'].replace(' ', '_'))}"}
        for item in results if item.get("title")
    ]


def answer_weather(lat, lon, place_name):
    try:
        current = fetch_weather(lat, lon)
    except Exception as primary_error:
        try:
            fallback = fetch_weather_fallback(place_name)
        except Exception as fallback_error:
            print(f"[Nexora] Weather providers failed: Open-Meteo={primary_error}; wttr.in={fallback_error}")
            raise
        if fallback:
            return fallback
        raise primary_error
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


def try_answer_live_question(message, context, is_weather_location_follow_up=False):
    """Return a direct answer string if this is a time/date/weather
    question we can answer ourselves, otherwise None (fall through to the
    language model)."""
    if TIME_PATTERN.search(message):
        return answer_time_or_date(message, context.get("timezone"))

    if WEATHER_PATTERN.search(message) or is_weather_location_follow_up:
        lat, lon = context.get("lat"), context.get("lon")
        place_name = context.get("place")
        # Accept natural forms such as "weather in Hapur", "weather right
        # now in Hapur", and the common shortened form "weather right now
        # Hapur". A stated city always takes precedence over browser location.
        city_match = re.search(
            r"\b(?:weather|forecast)(?:\s+(?:right now|today|currently|now))*"
            r"\s+(?:in|at|for|of)\s+([a-zA-Z][a-zA-Z\s-]*)"
            r"|\b(?:weather|forecast)\s+(?:right now|today|currently|now)\s+"
            r"([a-zA-Z][a-zA-Z\s-]*)",
            message,
            re.IGNORECASE,
        )
        # A user can also reply with just a city after the assistant asks for
        # their weather location.
        city_name = ((city_match.group(1) or city_match.group(2)).strip() if city_match else (
            message.strip() if is_weather_location_follow_up else ""
        ))
        if city_name:
            city_name = re.split(
                r"\s+(?:today|right now|currently|now)\b|[?.!,]",
                city_name,
            )[0].strip()
            # Keep the stated name for the fallback provider even if the
            # primary geocoding service is unavailable.
            place_name = city_name or place_name
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
            if error.code in (429, 500, 503) and attempt < 2:
                time.sleep(1.5 * (2 ** attempt))
                continue
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
def usable_ai_reply(reply):
    """Reject empty and provider-metadata-only replies before they reach students."""
    clean = re.sub(r"\s+", " ", str(reply or "")).strip()
    if len(clean) < 3:
        return False
    lower = clean.lower()
    return not (
        "user safety:" in lower
        or "response safety:" in lower
        or lower in {"safe", "blocked", "refused", "i couldn't generate a response."}
    )


def generation_was_cut_off(reason):
    """Normalise provider-specific stop reasons that mean output was truncated."""
    return str(reason or "").upper() in {"LENGTH", "MAX_TOKENS", "MAX_TOKEN", "TOKEN_LIMIT"}


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
        if path == "/api/classroom":
            try:
                code = parse_qs(urlparse(self.path).query).get("code", [""])[0]
                return self.send_json(200, classroom_snapshot(get_classroom(code)))
            except ValueError as error:
                return self.send_json(400, {"error": str(error)})
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
                participant_uids = data.get("participantUids") or [data["uid"]]
                agent = start_agora_agent(data.get("channel", AGORA_CHANNEL), participant_uids)
                if data.get("classroomCode"):
                    get_classroom(data["classroomCode"])["agent_id"] = agent.get("agent_id") or agent.get("agentId")
                return self.send_json(200, {"success": True, "agent": agent})

            if self.path == "/api/ai/stop":
                agent_id = data.get("agentId")
                if not agent_id:
                    raise ValueError("agentId is required")
                agora_request(f"/agents/{agent_id}/leave", {})
                return self.send_json(200, {"success": True})

            if self.path == "/api/ai/interrupt":
                agent_id = data.get("agentId")
                if not agent_id:
                    raise ValueError("agentId is required")
                # This keeps interruption server-side: the browser never sees
                # Agora REST credentials and the agent, rather than only its
                # local audio playback, is asked to stop the current turn.
                agora_request(f"/agents/{agent_id}/interrupt", {})
                return self.send_json(200, {"success": True})

            if self.path == "/api/classroom/join":
                room = get_classroom(data.get("code"))
                participant = data.get("participant") or {}
                uid = str(participant.get("uid") or "")
                name = re.sub(r"\s+", " ", str(participant.get("name") or "")).strip()[:40]
                role = participant.get("role")
                if not uid or not name or role not in {"teacher", "student"}:
                    raise ValueError("Classroom participant requires a name, UID, and teacher or student role")
                room["participants"][uid] = {"uid": uid, "name": name, "role": role, "handRaised": False}
                return self.send_json(200, classroom_snapshot(room))

            if self.path == "/api/classroom/event":
                room = get_classroom(data.get("code"))
                event = data.get("event") or {}
                text = re.sub(r"\s+", " ", str(event.get("text") or "")).strip()[:800]
                if text:
                    item = {"type": str(event.get("type") or "message")[:30], "speaker": str(event.get("speaker") or "Nexora")[:40], "text": text, "at": int(time.time() * 1000)}
                    room["events"].append(item)
                    if item["type"] in {"student_transcript", "student_request"}:
                        capture_learning_gap(room, text, item["speaker"])
                    if room["quiz_active"] and item["type"] == "student_transcript":
                        expected = room["lesson"].get("expectedAnswer", "")
                        if expected:
                            correct = expected in text.lower()
                            room["quiz"]["answers"][item["speaker"]] = {"text": text, "correct": correct}
                    room["events"] = room["events"][-120:]
                return self.send_json(200, classroom_snapshot(room))

            if self.path == "/api/classroom/lesson":
                room = get_classroom(data.get("code"))
                actor = room["participants"].get(str(data.get("uid")))
                if not actor or actor["role"] != "teacher":
                    raise ValueError("Only the teacher can set lesson context")
                lesson = clean_lesson(data.get("lesson") or {})
                if not lesson["topic"] or not lesson["objective"]:
                    raise ValueError("A lesson topic and objective are required")
                room["lesson"] = lesson
                return self.send_json(200, classroom_snapshot(room))

            if self.path == "/api/classroom/control":
                room = get_classroom(data.get("code"))
                actor = room["participants"].get(str(data.get("uid")))
                if not actor or actor["role"] != "teacher":
                    raise ValueError("Only the teacher can control the co-teacher")
                action = data.get("action")
                if action == "allow": room["ai_allowed"] = True
                elif action == "pause": room["ai_allowed"] = False
                elif action == "quiz":
                    if not room["lesson"].get("quizQuestion"):
                        raise ValueError("Save a lesson plan with a spoken quiz question first")
                    room["quiz_active"] = True
                    room["quiz"] = {"answers": {}}
                    room["ai_allowed"] = True
                elif action == "summary": pass
                else: raise ValueError("Unknown classroom control")
                return self.send_json(200, classroom_snapshot(room))

            if self.path == "/api/classroom/hand":
                room = get_classroom(data.get("code"))
                participant = room["participants"].get(str(data.get("uid")))
                if not participant: raise ValueError("Join the classroom before raising a hand")
                participant["handRaised"] = True
                return self.send_json(200, classroom_snapshot(room))

            if self.path == "/api/classroom/summary":
                room = get_classroom(data.get("code"))
                gaps = sorted(room["gaps"].items(), key=lambda item: item[1], reverse=True)[:3]
                students = [p["name"] for p in room["participants"].values() if p["role"] == "student"]
                support = {
                    term: sorted(name for name in room["gap_users"].get(term, set()) if name != "Nexora")
                    for term, _count in gaps
                }
                summary = {
                    "participants": len(room["participants"]), "students": students,
                    "messages": len(room["events"]), "learningGaps": gaps, "studentsNeedingSupport": support,
                    "lesson": room["lesson"], "confusionSignals": len(room["confusion_signals"]),
                    "quiz": room["quiz"],
                    "recommendation": "Revisit the most repeated concept with a worked example, then use a one-question spoken check-in.",
                }
                return self.send_json(200, summary)

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
        previous_message = messages[-2] if len(messages) >= 2 else None
        is_weather_location_follow_up = bool(
            previous_message
            and previous_message["role"] == "assistant"
            and "need a location to check the weather" in previous_message["content"].lower()
        )
        direct_answer = try_answer_live_question(
            last_message, live_context, is_weather_location_follow_up,
        )
        if direct_answer:
            return self.send_json(200, {"reply": direct_answer})

        learning_goal = re.sub(r"\s+", " ", str(data.get("learningGoal") or "")).strip()[:120]
        if learning_goal:
            messages.insert(0, {
                "role": "system",
                "content": (
                    "The student has chosen this optional learning focus: "
                    f"{learning_goal}. Use it only when it genuinely helps the answer."
                ),
            })

        sources = find_reference_leads(last_message) if data.get("research") else []
        if sources:
            reference_titles = "; ".join(source["title"] for source in sources)
            messages.insert(0, {
                "role": "system",
                "content": (
                    "Research mode is enabled. These are real starting reference leads: "
                    f"{reference_titles}. Encourage the student to open and evaluate them; do not claim "
                    "facts came from a source unless you are certain."
                ),
            })

        project_incubator = bool(data.get("projectIncubator"))
        if project_incubator:
            messages.insert(0, {
                "role": "system",
                "content": (
                    "This is a Project Incubator request. Give a complete, detailed project map that "
                    "covers every requested section. The normal short-answer limit does not apply."
                ),
            })

        if CHAT_PROVIDER == "groq":
            return self.send_json(200, {"reply": self.ask_groq(messages, unlimited=project_incubator), "sources": sources})
        if CHAT_PROVIDER == "gemini":
            return self.send_json(200, {"reply": self.ask_gemini(messages, data.get("model"), unlimited=project_incubator), "sources": sources})
        if CHAT_PROVIDER == "openrouter":
            return self.send_json(200, {"reply": self.ask_openrouter(messages, data.get("model"), unlimited=project_incubator), "sources": sources})
        raise ValueError("CHAT_PROVIDER must be 'openrouter', 'groq', or 'gemini'")

    def ask_groq(self, messages, unlimited=False):
        if not GROQ_API_KEY:
            raise ValueError("GROQ_API_KEY is missing from the server environment")
        payload = {
            "model": GROQ_MODEL,
            "messages": [{"role": "system", "content": CHAT_INSTRUCTIONS}, *messages],
            "temperature": 0.4,
        }
        if not unlimited:
            payload["max_tokens"] = CHAT_MAX_TOKENS
        request = Request(
            "https://api.groq.com/openai/v1/chat/completions",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {GROQ_API_KEY}"},
            method="POST",
        )
        result = request_ai(request, "Groq")
        choice = result.get("choices", [{}])[0]
        reply = choice.get("message", {}).get("content", "")
        if reply and generation_was_cut_off(choice.get("finish_reason")):
            continuation_payload = {
                **payload,
                "messages": [*payload["messages"], {"role": "assistant", "content": reply}, {
                    "role": "user",
                    "content": "Continue from the exact final word. Do not repeat anything. Finish the answer in complete sentences.",
                }],
                "max_tokens": 240,
            }
            continuation_request = Request(
                "https://api.groq.com/openai/v1/chat/completions",
                data=json.dumps(continuation_payload).encode(),
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {GROQ_API_KEY}"}, method="POST",
            )
            continuation = request_ai(continuation_request, "Groq").get("choices", [{}])[0].get("message", {}).get("content", "")
            reply += continuation
        return reply or "I couldn't generate a response."

    def ask_gemini(self, messages, requested_model, unlimited=False):
        if not GEMINI_API_KEY:
            raise ValueError("GEMINI_API_KEY is missing from the server environment")
        contextual_instructions = "\n\n".join(
            message["content"] for message in messages if message["role"] == "system"
        )
        contents = [
            {"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
            for m in messages if m["role"] != "system"
        ]
        model = requested_model or GEMINI_MODEL
        payload = {
            "systemInstruction": {"parts": [{"text": f"{CHAT_INSTRUCTIONS}\n\n{contextual_instructions}"}]},
            "contents": contents,
            "generationConfig": {"temperature": 0.4},
        }
        if not unlimited:
            payload["generationConfig"]["maxOutputTokens"] = CHAT_MAX_TOKENS
        request = Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        result = request_ai(request, "Gemini")
        candidate = result.get("candidates", [{}])[0]
        parts = candidate.get("content", {}).get("parts", [])
        reply = "".join(p.get("text", "") for p in parts)
        if reply and generation_was_cut_off(candidate.get("finishReason")):
            continuation_payload = {
                **payload,
                "contents": [*contents, {"role": "model", "parts": [{"text": reply}]}, {
                    "role": "user", "parts": [{"text": "Continue from the exact final word. Do not repeat anything. Finish in complete sentences."}],
                }],
                "generationConfig": {"maxOutputTokens": 240, "temperature": 0.4},
            }
            continuation_request = Request(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}",
                data=json.dumps(continuation_payload).encode(), headers={"Content-Type": "application/json"}, method="POST",
            )
            continuation_result = request_ai(continuation_request, "Gemini")
            continuation_parts = continuation_result.get("candidates", [{}])[0].get("content", {}).get("parts", [])
            reply += "".join(p.get("text", "") for p in continuation_parts)
        return reply or "I couldn't generate a response."

    def ask_openrouter(self, messages, requested_model, unlimited=False):
        if not OPENROUTER_API_KEY:
            raise ValueError("OPENROUTER_API_KEY is missing from the server environment")
        payload = {
            "model": requested_model or OPENROUTER_MODEL,
            "messages": [{"role": "system", "content": CHAT_INSTRUCTIONS}, *messages],
            "temperature": 0.4,
        }
        if not unlimited:
            payload["max_tokens"] = CHAT_MAX_TOKENS
        request = Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {OPENROUTER_API_KEY}"},
            method="POST",
        )
        result = request_ai(request, "OpenRouter")
        choice = result.get("choices", [{}])[0]
        reply = choice.get("message", {}).get("content", "")
        # Free routing can return safety metadata instead of a completion.
        # Retry once and never display that internal provider text to students.
        if not usable_ai_reply(reply):
            result = request_ai(request, "OpenRouter")
            choice = result.get("choices", [{}])[0]
            reply = choice.get("message", {}).get("content", "")
        if not usable_ai_reply(reply):
            raise RuntimeError(
                "Nexora is reconnecting to its learning engine. Please send that question once more."
            )
        if generation_was_cut_off(choice.get("finish_reason")):
            continuation_payload = {
                **payload,
                "messages": [*payload["messages"], {"role": "assistant", "content": reply}, {
                    "role": "user",
                    "content": "Continue from the exact final word. Do not repeat anything. Finish the answer in complete sentences.",
                }],
                "max_tokens": 240,
            }
            continuation_request = Request(
                "https://openrouter.ai/api/v1/chat/completions",
                data=json.dumps(continuation_payload).encode(),
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {OPENROUTER_API_KEY}"}, method="POST",
            )
            continuation_choice = request_ai(continuation_request, "OpenRouter").get("choices", [{}])[0]
            continuation = continuation_choice.get("message", {}).get("content", "")
            if usable_ai_reply(continuation):
                reply += continuation
        return reply


if __name__ == "__main__":
    print(f"Nexora server: http://localhost:{PORT}")
    print(f"Chat provider: {CHAT_PROVIDER}")
    print(f"Agora REST credentials: {'loaded' if AGORA_CUSTOMER_ID and AGORA_CUSTOMER_SECRET else 'missing'}")
    print(f"Agora pipeline ID: {'loaded' if AGORA_PIPELINE_ID else 'missing'}")
    ThreadingHTTPServer(("0.0.0.0", PORT), NexoraHandler).serve_forever()
