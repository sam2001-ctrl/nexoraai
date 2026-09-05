// Legacy Node/Gemini proxy - not used by the current app (see server.py + README).
// Kept only for reference. Keep GEMINI_API_KEY in your terminal, not in browser files.
const http = require('http');

const apiKey = process.env.GEMINI_API_KEY;
const defaultModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  });
  response.end(JSON.stringify(body));
}

http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    });
    return response.end();
  }
  if (request.method !== 'POST' || request.url !== '/api/chat') {
    return sendJson(response, 404, { error: 'Not found' });
  }
  if (!apiKey) return sendJson(response, 500, { error: 'Set GEMINI_API_KEY before starting the server.' });

  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const contents = (data.messages || []).filter(message => message.content).map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));
    if (!contents.length) return sendJson(response, 400, { error: 'Please send at least one message.' });

    const model = data.model || defaultModel;
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents }) },
    );
    const result = await geminiResponse.json();
    if (!geminiResponse.ok) return sendJson(response, geminiResponse.status, { error: result.error?.message || 'Gemini request failed.' });
    const parts = result.candidates?.[0]?.content?.parts || [];
    const reply = parts.map(part => part.text || '').join('') || "I couldn't generate a response.";
    return sendJson(response, 200, { reply });
  } catch (error) {
    return sendJson(response, 500, { error: error.message || 'Unable to contact Gemini.' });
  }
}).listen(8000, 'localhost', () => console.log('Gemini API proxy running at http://localhost:8000'));
