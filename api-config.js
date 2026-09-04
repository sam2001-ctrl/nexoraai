/*
  GEMINI API TEMPLATE
  -------------------
  For production, call your own backend instead of placing a secret key in a browser file.
  Your backend should accept POST { messages: [{ role, content }] } and return
  { reply: "your AI response" }. Set endpoint below to that backend URL.
*/
window.NEXORA_CONFIG = {
  endpoint: "http://localhost:8000/api/chat",
  model: "gemini-3.6-flash"
};
