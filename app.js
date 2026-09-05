/* Nexora AI - front end
 * Two independent features live in this file:
 *   1. Text chat against /api/chat (see server.py)
 *   2. Live voice via Agora Conversational AI
 * Plus a small reusable draggable 3D globe (hero + voice window).
 */

const config = window.NEXORA_CONFIG || {};
const CHAT_ENDPOINT = config.endpoint || '/api/chat';

/* ------------------------------------------------------------- nav scroll */

document.querySelectorAll('[data-scroll]').forEach(button => {
  button.addEventListener('click', () => {
    const targetId = button.dataset.scroll;
    const target = document.getElementById(targetId);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

/* -------------------------------------------------------------- location
 * Used only to answer "what's the weather" directly and correctly. Asked
 * for once, quietly; if it's denied the chat still works, it just asks the
 * user for a city name when they ask about weather.
 */

const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let userLocation = null;

if ('geolocation' in navigator) {
  navigator.geolocation.getCurrentPosition(
    position => {
      userLocation = { lat: position.coords.latitude, lon: position.coords.longitude };
    },
    () => { /* denied or unavailable - the server will ask for a city instead */ },
    { timeout: 8000 },
  );
}

/* ------------------------------------------------------------------ chat */

const chat = document.querySelector('#chat');
const chatForm = document.querySelector('#chatForm');
const promptInput = document.querySelector('#promptInput');
const sendButton = document.querySelector('#sendButton');
const chatStatus = document.querySelector('#chatStatus');
const clearHistoryButton = document.querySelector('#clearHistoryButton');

const history = [];
const HISTORY_STORAGE_KEY = 'nexora-chat-history-v1';
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
let chatRequest = null;
let isSendingChat = false;

function setChatStatus(label, live = false) {
  chatStatus.classList.toggle('live', live);
  chatStatus.innerHTML = `<i class="dot"></i>${label}`;
}

function addMessage(content, role = 'assistant', extraClass = '', shouldScroll = true) {
  const message = document.createElement('article');
  message.className = `message ${role} ${extraClass}`.trim();
  message.innerHTML = role === 'assistant'
    ? '<div class="avatar">N</div><div class="bubble"></div>'
    : '<div class="bubble"></div>';
  message.querySelector('.bubble').textContent = content;
  chat.append(message);
  if (shouldScroll) message.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return message;
}

function showWelcomeMessage() {
  addMessage('Welcome to Nexora. What would you like to explore?', 'assistant', '', false);
}

function saveHistory() {
  try {
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    const activeHistory = history.filter(message => message.createdAt >= cutoff);
    history.splice(0, history.length, ...activeHistory);
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(activeHistory));
  } catch (error) {
    console.warn('Could not save chat history:', error);
  }
}

function restoreHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]');
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    const activeHistory = Array.isArray(stored)
      ? stored.filter(message =>
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string' &&
          Number.isFinite(message.createdAt) &&
          message.createdAt >= cutoff)
      : [];
    history.push(...activeHistory);
    chat.replaceChildren();
    if (history.length) history.forEach(message => addMessage(message.content, message.role, '', false));
    else showWelcomeMessage();
    saveHistory();
  } catch (error) {
    console.warn('Could not restore chat history:', error);
    chat.replaceChildren();
    showWelcomeMessage();
  }
}

function clearHistory() {
  history.splice(0, history.length);
  localStorage.removeItem(HISTORY_STORAGE_KEY);
  chat.replaceChildren();
  showWelcomeMessage();
}

restoreHistory();
clearHistoryButton.addEventListener('click', clearHistory);

async function getReply() {
  chatRequest = new AbortController();
  const response = await fetch(CHAT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: chatRequest.signal,
    body: JSON.stringify({
      model: config.model,
      messages: history.slice(-16).map(({ role, content }) => ({ role, content })),
      timezone: userTimezone,
      lat: userLocation?.lat,
      lon: userLocation?.lon,
    }),
  });

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const bodyText = await response.text();
    if (bodyText.trimStart().startsWith('<')) {
      throw new Error('The AI server is not running here. Start server.py, then open http://localhost:8000 - not Live Server or the HTML file directly.');
    }
    throw new Error('The AI server returned an unexpected response. Open http://localhost:8000 after starting server.py.');
  }

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Your AI endpoint returned an error.');
  return data.reply || data.message || data.choices?.[0]?.message?.content || 'Your endpoint returned no reply.';
}

chatForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (isSendingChat) return;
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  isSendingChat = true;
  sendButton.disabled = true;
  addMessage(prompt, 'user');
  history.push({ role: 'user', content: prompt, createdAt: Date.now() });
  saveHistory();
  promptInput.value = '';
  promptInput.style.height = 'auto';

  const pending = addMessage('Thinking', 'assistant', 'thinking');
  setChatStatus('Thinking', true);

  try {
    const reply = await getReply();
    pending.remove();
    addMessage(reply);
    history.push({ role: 'assistant', content: reply, createdAt: Date.now() });
    saveHistory();
  } catch (error) {
    pending.remove();
    if (error.name !== 'AbortError') addMessage(error.message || 'Something went wrong. Please try again.');
  } finally {
    chatRequest = null;
    isSendingChat = false;
    sendButton.disabled = false;
    setChatStatus('Ready');
  }
});

promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 110)}px`;
});

promptInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

document.querySelectorAll('.suggestion').forEach(button => {
  button.addEventListener('click', () => {
    promptInput.value = button.textContent;
    promptInput.focus();
    promptInput.dispatchEvent(new Event('input'));
  });
});

/* ----------------------------------------------------------------- voice */

const AGORA_SERVER = window.location.origin;
const AGORA_CHANNEL = `nexora-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
const AGORA_UID = Math.floor(Math.random() * 1_000_000) + 1;

let agoraClient = null;
let microphoneTrack = null;
let agoraAgentId = null;
let isConnectingAgora = false;
const remoteAudioTracks = new Map();

const voiceButton = document.querySelector('#voiceButton');
const voiceButtonText = document.querySelector('#voiceButtonText');
const voiceState = document.querySelector('#voiceState');
const voiceStatus = document.querySelector('#voiceStatus');

function setVoiceUi(live) {
  voiceButton.classList.toggle('listening', live);
  voiceButtonText.textContent = live ? 'End conversation' : 'Start conversation';
  voiceState.textContent = live ? 'Listening and connected' : 'Ready when you are';
  voiceStatus.classList.toggle('live', live);
  voiceStatus.innerHTML = `<i class="dot"></i>${live ? 'Live' : 'Ready'}`;
  setGlobeActive('voiceGlobe', live);
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The server returned an error.');
  return data;
}

async function playRemoteAudio(user, mediaType) {
  if (mediaType !== 'audio') return;
  await agoraClient.subscribe(user, mediaType);
  const track = user.audioTrack;
  if (!track || remoteAudioTracks.get(user.uid) === track) return;
  remoteAudioTracks.get(user.uid)?.stop();
  track.play();
  remoteAudioTracks.set(user.uid, track);
}

function stopRemoteAudio(user) {
  const track = remoteAudioTracks.get(user.uid) || user.audioTrack;
  track?.stop();
  remoteAudioTracks.delete(user.uid);
}

async function connectAgora() {
  if (isConnectingAgora || agoraClient) return;
  isConnectingAgora = true;
  voiceButton.disabled = true;
  try {
    voiceState.textContent = 'Connecting…';
    const tokenData = await getJson(`${AGORA_SERVER}/agora/token?channel=${encodeURIComponent(AGORA_CHANNEL)}&uid=${AGORA_UID}`);

    agoraClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
    agoraClient.on('user-published', (user, mediaType) =>
      playRemoteAudio(user, mediaType).catch(error => console.error('Remote audio error:', error)));
    agoraClient.on('user-unpublished', (user, mediaType) => {
      if (mediaType === 'audio') stopRemoteAudio(user);
    });
    agoraClient.on('user-left', stopRemoteAudio);

    await agoraClient.join(tokenData.appId, tokenData.channel, tokenData.token, tokenData.uid);
    microphoneTrack = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, AGC: true, ANS: true });
    await agoraClient.publish([microphoneTrack]);

    const agentResult = await getJson(`${AGORA_SERVER}/api/ai/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: tokenData.channel, uid: tokenData.uid }),
    });
    agoraAgentId = agentResult.agent?.agent_id || agentResult.agent?.agentId;
    if (!agoraAgentId) throw new Error('Agora started an agent but did not return its ID.');

    setVoiceUi(true);
  } catch (error) {
    console.error('Agora connection error:', error);
    voiceState.textContent = `Connection failed: ${error.message}`;
    await disconnectAgora(false);
  } finally {
    isConnectingAgora = false;
    voiceButton.disabled = false;
  }
}

async function disconnectAgora(stopAgent = true) {
  const agentId = agoraAgentId;
  agoraAgentId = null;

  if (stopAgent && agentId) {
    try {
      await getJson(`${AGORA_SERVER}/api/ai/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      });
    } catch (error) {
      console.warn('Could not stop Agora agent:', error);
    }
  }

  if (microphoneTrack) {
    microphoneTrack.stop();
    microphoneTrack.close();
    microphoneTrack = null;
  }
  for (const track of remoteAudioTracks.values()) track.stop();
  remoteAudioTracks.clear();

  if (agoraClient) {
    try {
      await agoraClient.leave();
    } catch (error) {
      console.warn('Could not leave Agora channel:', error);
    }
    agoraClient.removeAllListeners();
    agoraClient = null;
  }
  setVoiceUi(false);
}

voiceButton.addEventListener('click', () => (agoraClient ? disconnectAgora() : connectAgora()));
window.addEventListener('beforeunload', () => { microphoneTrack?.close(); agoraClient?.leave(); });

/* ------------------------------------------------------------------ globe
 * A small, dependency-free (beyond three.js) draggable wireframe globe.
 * Used for the hero visual and the voice console. Drag to spin manually;
 * it drifts on its own the rest of the time, and picks up a faster/brighter
 * spin while a voice call is live.
 */

const globes = new Map();

function glowTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(139, 123, 255, 0.55)');
  gradient.addColorStop(0.5, 'rgba(69, 232, 209, 0.18)');
  gradient.addColorStop(1, 'rgba(5, 6, 10, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function createGlobe(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof THREE === 'undefined') return;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.z = 3.1;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const group = new THREE.Group();
  scene.add(group);

  const wireMaterial = new THREE.MeshBasicMaterial({ color: 0x8b7bff, wireframe: true, transparent: true, opacity: 0.55 });
  const wireMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), wireMaterial);
  group.add(wireMesh);

  const dotsGeometry = new THREE.IcosahedronGeometry(1.012, 3);
  const dotsMaterial = new THREE.PointsMaterial({ color: 0x45e8d1, size: 0.028, transparent: true, opacity: 0.85 });
  group.add(new THREE.Points(dotsGeometry, dotsMaterial));

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false }));
  glow.scale.set(3.4, 3.4, 1);
  scene.add(glow);

  const IDLE_SPIN = 0.0018;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let spinY = IDLE_SPIN; // current per-frame rotation speed, decays back to IDLE_SPIN
  let spinX = 0;         // current per-frame vertical drift, decays to 0

  function pointerDown(event) {
    dragging = true;
    const point = event.touches ? event.touches[0] : event;
    lastX = point.clientX;
    lastY = point.clientY;
  }

  function pointerMove(event) {
    if (!dragging) return;
    const point = event.touches ? event.touches[0] : event;
    const deltaX = point.clientX - lastX;
    const deltaY = point.clientY - lastY;
    lastX = point.clientX;
    lastY = point.clientY;
    spinY = deltaX * 0.0032;
    spinX = deltaY * 0.0032;
    group.rotation.y += spinY;
    group.rotation.x = Math.max(-1.1, Math.min(1.1, group.rotation.x + spinX));
    event.preventDefault?.();
  }

  function pointerUp() {
    dragging = false;
  }

  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', pointerMove);
  window.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('touchstart', pointerDown, { passive: true });
  canvas.addEventListener('touchmove', pointerMove, { passive: false });
  window.addEventListener('touchend', pointerUp);

  function resize() {
    const parent = canvas.parentElement;
    const size = Math.min(parent.clientWidth, parent.clientHeight) || parent.clientWidth || 300;
    renderer.setSize(size, size, false);
    camera.aspect = 1;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas.parentElement);
  resize();

  const state = { active: false, pulse: 0 };

  function tick() {
    requestAnimationFrame(tick);
    if (!dragging) {
      // ease drag momentum back to a gentle idle spin, rather than snapping
      spinY += (IDLE_SPIN - spinY) * 0.02;
      spinX += (0 - spinX) * 0.05;
      group.rotation.y += spinY;
      group.rotation.x = Math.max(-1.1, Math.min(1.1, group.rotation.x + spinX));
    }
    if (state.active) {
      state.pulse += 0.05;
      const scale = 1 + Math.sin(state.pulse) * 0.04;
      group.scale.set(scale, scale, scale);
      wireMaterial.opacity = 0.75;
    } else {
      group.scale.set(1, 1, 1);
      wireMaterial.opacity = 0.55;
    }
    renderer.render(scene, camera);
  }
  tick();

  globes.set(canvasId, state);
}

function setGlobeActive(canvasId, active) {
  const state = globes.get(canvasId);
  if (state) state.active = active;
}

if (typeof THREE !== 'undefined') {
  createGlobe('heroGlobe');
  createGlobe('voiceGlobe');
} else {
  console.warn('three.js did not load - globes are skipped, everything else still works.');
}
