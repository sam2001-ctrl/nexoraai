"""Nexora AI local server: Gemini chat plus Agora Conversational AI."""
import base64, json, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen
from dotenv import load_dotenv
from agora_token_builder import RtcTokenBuilder

load_dotenv()
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")
AGORA_APP_ID = os.environ.get("AGORA_APP_ID")
AGORA_APP_CERTIFICATE = os.environ.get("AGORA_APP_CERTIFICATE")
AGORA_CUSTOMER_ID = os.environ.get("AGORA_CUSTOMER_ID")
AGORA_CUSTOMER_SECRET = os.environ.get("AGORA_CUSTOMER_SECRET")
AGORA_PIPELINE_ID = os.environ.get("AGORA_PIPELINE_ID")
AGORA_CHANNEL = os.environ.get("AGORA_CHANNEL", "nexora-demo")
AGORA_AGENT_UID = int(os.environ.get("AGORA_AGENT_UID", "14297"))
PORT = int(os.environ.get("PORT", "8000"))
CHAT_INSTRUCTIONS = """You are Nexora, a clear and helpful assistant. Answer the user's request directly.
Keep the default response concise: usually 3 to 6 sentences or up to 5 short bullet points.
Use a short heading or bullets only when they make the answer easier to scan. Do not repeat the question,
pad the response with introductions or conclusions, or give multiple alternatives unless asked. Ask one brief
clarifying question only when it is necessary. Give detailed, long-form answers only when the user requests them."""
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/api-config.js": ("api-config.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
}
PROJECT_DIR = Path(__file__).resolve().parent

def required(name, value):
    if not value: raise ValueError(f"{name} is missing from .env")
    return value

def generate_agora_token(channel, uid):
    expires_at = int(time.time()) + 3600
    return RtcTokenBuilder.buildTokenWithUid(required("AGORA_APP_ID", AGORA_APP_ID), required("AGORA_APP_CERTIFICATE", AGORA_APP_CERTIFICATE), channel, int(uid), 1, expires_at)

def agora_headers():
    credentials = f"{required('AGORA_CUSTOMER_ID', AGORA_CUSTOMER_ID)}:{required('AGORA_CUSTOMER_SECRET', AGORA_CUSTOMER_SECRET)}"
    return {"Authorization": "Basic " + base64.b64encode(credentials.encode()).decode(), "Content-Type": "application/json"}

def agora_request(path, payload):
    request = Request(f"https://api.agora.io/api/conversational-ai-agent/v2/projects/{required('AGORA_APP_ID', AGORA_APP_ID)}{path}", data=json.dumps(payload).encode(), headers=agora_headers(), method="POST")
    try:
        with urlopen(request, timeout=30) as response:
            raw = response.read().decode(); return json.loads(raw) if raw else {}
    except HTTPError as error:
        raise RuntimeError(f"Agora API error {error.code}: {error.read().decode(errors='replace')}") from error
    except URLError as error:
        raise RuntimeError(f"Could not reach Agora: {error.reason}") from error

def start_agora_agent(channel, client_uid):
    payload = {"name": f"nexora-{int(time.time())}", "pipeline_id": required("AGORA_PIPELINE_ID", AGORA_PIPELINE_ID), "properties": {"channel": channel, "agent_rtc_uid": str(AGORA_AGENT_UID), "remote_rtc_uids": [str(client_uid)], "token": generate_agora_token(channel, AGORA_AGENT_UID), "enable_string_uid": False, "idle_timeout": 60}}
    return agora_request("/join", payload)

def request_gemini(request):
    """Retry short-lived Gemini capacity and service errors before failing."""
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
                        message = "Gemini request limit reached. Wait a minute, then check your Gemini API quota or billing if it continues."
                    elif error.code == 503:
                        message = "Gemini is temporarily at capacity. Please try again in a moment."
                    else:
                        message = "Gemini had a temporary service problem. Please try again in a moment."
                    raise RuntimeError(f"{message}{f' Details: {detail}' if detail else ''}") from error
                raise
            time.sleep(1.5 * (2 ** attempt))

class NexoraHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args): print("[Nexora]", format % args)
    def send_json(self, status, payload):
        body = json.dumps(payload).encode(); self.send_response(status); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Access-Control-Allow-Headers", "Content-Type"); self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); self.end_headers(); self.wfile.write(body)
    def read_json(self):
        try: return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except (ValueError, json.JSONDecodeError) as error: raise ValueError("Request body must be valid JSON") from error
    def serve_static(self, path):
        filename, content_type = STATIC_FILES[path]
        body = (PROJECT_DIR / filename).read_bytes()
        self.send_response(200); self.send_header("Content-Type", content_type); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_OPTIONS(self): self.send_response(204); self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Access-Control-Allow-Headers", "Content-Type"); self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); self.end_headers()
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health": return self.send_json(200, {"success": True})
        if path == "/agora/token":
            try:
                query = parse_qs(urlparse(self.path).query); channel = query.get("channel", [AGORA_CHANNEL])[0]; uid = int(query.get("uid", ["12345"])[0])
                return self.send_json(200, {"appId": AGORA_APP_ID, "channel": channel, "uid": uid, "token": generate_agora_token(channel, uid)})
            except Exception as error: return self.send_json(500, {"error": str(error)})
        if path in STATIC_FILES: return self.serve_static(path)
        return self.send_json(404, {"error": "Not found"})
    def do_POST(self):
        try:
            data = self.read_json()
            if self.path == "/api/ai/start":
                if data.get("uid") is None: raise ValueError("uid is required to start the Agora agent")
                return self.send_json(200, {"success": True, "agent": start_agora_agent(data.get("channel", AGORA_CHANNEL), data["uid"])})
            if self.path == "/api/ai/stop":
                agent_id = data.get("agentId")
                if not agent_id: raise ValueError("agentId is required")
                agora_request(f"/agents/{agent_id}/leave", {}); return self.send_json(200, {"success": True})
            if self.path != "/api/chat": return self.send_json(404, {"error": "Not found"})
            if not GEMINI_API_KEY: raise ValueError("GEMINI_API_KEY is missing from .env")
            contents = [{"role": "model" if m.get("role") == "assistant" else "user", "parts": [{"text": m["content"]}]} for m in data.get("messages", []) if m.get("content")]
            if not contents: return self.send_json(400, {"error": "Please send at least one message."})
            model = data.get("model") or GEMINI_MODEL
            payload = {"systemInstruction": {"parts": [{"text": CHAT_INSTRUCTIONS}]}, "contents": contents, "generationConfig": {"maxOutputTokens": 450, "temperature": 0.45}}
            request = Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
            result = request_gemini(request)
            parts = result.get("candidates", [{}])[0].get("content", {}).get("parts", [])
            return self.send_json(200, {"reply": "".join(p.get("text", "") for p in parts) or "I couldn't generate a response."})
        except HTTPError as error: return self.send_json(error.code, {"error": error.read().decode(errors="replace")})
        except ValueError as error: return self.send_json(400, {"error": str(error)})
        except Exception as error: return self.send_json(500, {"error": str(error)})

if __name__ == "__main__":
    print(f"Nexora server: http://localhost:{PORT}")
    print(f"Agora REST credentials: {'loaded' if AGORA_CUSTOMER_ID and AGORA_CUSTOMER_SECRET else 'missing'}")
    print(f"Agora pipeline ID: {'loaded' if AGORA_PIPELINE_ID else 'missing'}")
    ThreadingHTTPServer(("0.0.0.0", PORT), NexoraHandler).serve_forever()
