/*
  For production, call your own backend instead of placing a secret key in a browser file.
  Your backend (server.py) accepts POST { messages: [{ role, content }] } and returns
  { reply: "your AI response" }. Set endpoint below only if you deliberately use a
  different backend URL than the one this page is served from.
*/
window.NEXORA_CONFIG = {
  endpoint: "/api/chat"
};
