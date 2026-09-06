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

function requestUserLocation() {
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      position => {
        userLocation = { lat: position.coords.latitude, lon: position.coords.longitude };
        resolve(userLocation);
      },
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  });
}

// Populate location quietly on load. The weather quick action below asks
// again from a user click if the browser has not granted access yet.
requestUserLocation();

/* ------------------------------------------------------------------ chat */

const chat = document.querySelector('#chat');
const chatForm = document.querySelector('#chatForm');
const promptInput = document.querySelector('#promptInput');
const sendButton = document.querySelector('#sendButton');
const chatStatus = document.querySelector('#chatStatus');
const clearHistoryButton = document.querySelector('#clearHistoryButton');
const goalInput = document.querySelector('#goalInput');
const saveGoalButton = document.querySelector('#saveGoalButton');
const forgetGoalButton = document.querySelector('#forgetGoalButton');
const researchToggle = document.querySelector('#researchToggle');

const history = [];
const HISTORY_STORAGE_KEY = 'nexora-chat-history-v1';
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
let chatRequest = null;
let isSendingChat = false;
const GOAL_STORAGE_KEY = 'nexora-learning-goal-v1';
let learningGoal = localStorage.getItem(GOAL_STORAGE_KEY) || '';
goalInput.value = learningGoal;

function saveLearningGoal() {
  learningGoal = goalInput.value.trim().slice(0, 120);
  if (learningGoal) localStorage.setItem(GOAL_STORAGE_KEY, learningGoal);
  else localStorage.removeItem(GOAL_STORAGE_KEY);
  goalInput.value = learningGoal;
}

saveGoalButton.addEventListener('click', saveLearningGoal);
forgetGoalButton.addEventListener('click', () => {
  learningGoal = '';
  goalInput.value = '';
  localStorage.removeItem(GOAL_STORAGE_KEY);
});

function setChatStatus(label, live = false) {
  chatStatus.classList.toggle('live', live);
  chatStatus.innerHTML = `<i class="dot"></i>${label}`;
}

function addMessage(content, role = 'assistant', extraClass = '', shouldScroll = true, sources = []) {
  const message = document.createElement('article');
  message.className = `message ${role} ${extraClass}`.trim();
  message.innerHTML = role === 'assistant'
    ? '<div class="avatar">N</div><div class="bubble"></div>'
    : '<div class="bubble"></div>';
  const bubble = message.querySelector('.bubble');
  // Assistant replies support useful Markdown (lists, emphasis, code), but are
  // sanitised before insertion so an upstream response can never inject HTML.
  if (role === 'assistant' && !extraClass && window.marked && window.DOMPurify) {
    bubble.innerHTML = DOMPurify.sanitize(marked.parse(content, { gfm: true, breaks: true }));
  } else {
    bubble.textContent = content;
  }
  if (role === 'assistant' && sources.length) {
    const sourceList = document.createElement('div');
    sourceList.className = 'source-list';
    sourceList.append('Reference leads: ');
    sources.forEach((source, index) => {
      if (!source?.url || !source?.title) return;
      const link = document.createElement('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = source.title;
      sourceList.append(link);
      if (index < sources.length - 1) sourceList.append(' · ');
    });
    message.append(sourceList);
  }
  if (role === 'assistant' && !extraClass) {
    const nextSteps = document.createElement('div');
    nextSteps.className = 'next-steps';
    ['Explain simpler', 'Give me a challenge', 'What should I learn next?'].forEach(label => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        promptInput.value = `${label} based on your last answer.`;
        promptInput.dispatchEvent(new Event('input'));
        chatForm.requestSubmit();
      });
      nextSteps.append(button);
    });
    message.append(nextSteps);
  }
  chat.append(message);
  if (shouldScroll) message.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return message;
}

function showWelcomeMessage() {
  addMessage('Welcome to Nexora. What would you like to explore?', 'assistant', 'welcome', false);
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

// A refresh starts a new conversation.  Clear the persisted transcript before
// rendering anything so a message from a previous visit cannot briefly appear.
clearHistory();
clearHistoryButton.addEventListener('click', clearHistory);

async function getReply() {
  chatRequest = new AbortController();
  const response = await fetch(CHAT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: chatRequest.signal,
    body: JSON.stringify({
      model: config.model,
      // A focused recent context is quicker to send and process than a full transcript.
      messages: history.slice(-8).map(({ role, content }) => ({ role, content })),
      timezone: userTimezone,
      lat: userLocation?.lat,
      lon: userLocation?.lon,
      learningGoal,
      research: researchToggle.checked,
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
  return {
    reply: data.reply || data.message || data.choices?.[0]?.message?.content || 'Your endpoint returned no reply.',
    sources: Array.isArray(data.sources) ? data.sources : [],
  };
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
    const { reply, sources } = await getReply();
    pending.remove();
    addMessage(reply, 'assistant', '', true, sources);
    history.push({ role: 'assistant', content: reply, createdAt: Date.now() });
    saveHistory();
  } catch (error) {
    pending.remove();
    if (error.name !== 'AbortError') addMessage(error.message || 'Something went wrong. Please try again.', 'assistant', 'error');
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
  button.addEventListener('click', async () => {
    const isWeatherSuggestion = /weather/i.test(button.textContent);
    promptInput.value = button.textContent;
    promptInput.focus();
    promptInput.dispatchEvent(new Event('input'));
    if (isWeatherSuggestion) {
      if (!userLocation) await requestUserLocation();
      chatForm.requestSubmit();
    }
  });
});

function openConsoleWithPrompt(prompt) {
  document.getElementById('console')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  promptInput.value = prompt;
  promptInput.dispatchEvent(new Event('input'));
  window.setTimeout(() => {
    promptInput.focus();
    chatForm.requestSubmit();
  }, 450);
}

document.querySelectorAll('[data-spark]').forEach(button => {
  button.addEventListener('click', () => openConsoleWithPrompt(
    'Create a Curiosity Spark for me: give me one surprising question to explore, why it matters, a 10-minute first challenge, and one thing I can share with a friend. Keep it exciting and age-appropriate.',
  ));
});

document.querySelector('#projectForm')?.addEventListener('submit', event => {
  event.preventDefault();
  const interest = document.querySelector('#projectInterest').value.trim();
  const problem = document.querySelector('#projectProblem').value.trim();
  const outcome = document.querySelector('#projectOutcome').value.trim() || 'a clear presentation of what I learn';
  if (!interest || !problem) return;
  openConsoleWithPrompt(
    `Create a student Project Map in Markdown. My interest: ${interest}. The question or problem: ${problem}. I want to create: ${outcome}. Include: a strong project title, why it matters, a research question, 3 realistic first steps, materials or people I may need, and a simple presentation plan. Encourage me to do the investigation myself.`,
  );
});

/* ----------------------------------------------------------------- voice */

const AGORA_SERVER = window.location.origin;
const AGORA_CHANNEL = `nexora-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
const AGORA_UID = Math.floor(Math.random() * 1_000_000) + 1;

let agoraClient = null;
let microphoneTrack = null;
let agoraAgentId = null;
let isConnectingAgora = false;
let isMicrophoneMuted = false;
const remoteAudioTracks = new Map();

const voiceButton = document.querySelector('#voiceButton');
const voiceButtonText = document.querySelector('#voiceButtonText');
const voiceState = document.querySelector('#voiceState');
const voiceStatus = document.querySelector('#voiceStatus');
const muteButton = document.querySelector('#muteButton');
const muteButtonText = document.querySelector('#muteButtonText');

async function setMicrophoneMuted(muted) {
  if (!microphoneTrack) return;
  await microphoneTrack.setMuted(muted);
  isMicrophoneMuted = muted;
  muteButton.classList.toggle('is-muted', muted);
  muteButton.setAttribute('aria-pressed', String(muted));
  muteButtonText.textContent = muted ? 'Unmute mic' : 'Mute mic';
}

function setVoiceUi(live) {
  voiceButton.classList.toggle('listening', live);
  voiceButtonText.textContent = live ? 'End conversation' : 'Start conversation';
  voiceState.textContent = live ? 'Listening and connected' : 'Ready when you are';
  voiceStatus.classList.toggle('live', live);
  voiceStatus.innerHTML = `<i class="dot"></i>${live ? 'Live' : 'Ready'}`;
  muteButton.disabled = !live;
  voiceFace?.setState(live ? 'active' : 'idle');
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
  voiceFace?.attachAudioTrack(track.getMediaStreamTrack?.());
}

async function stopRemoteAudio(user) {
  const track = remoteAudioTracks.get(user.uid) || user.audioTrack;
  track?.stop();
  remoteAudioTracks.delete(user.uid);
  voiceFace?.detachAudioTrack();
}

async function connectAgora() {
  if (isConnectingAgora || agoraClient) return;
  isConnectingAgora = true;
  voiceButton.disabled = true;
  voiceFace?.setState('connecting');
  try {
    voiceState.textContent = 'Connecting…';
    const tokenData = await getJson(`${AGORA_SERVER}/agora/token?channel=${encodeURIComponent(AGORA_CHANNEL)}&uid=${AGORA_UID}`);

    agoraClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
    agoraClient.on('user-published', (user, mediaType) =>
      playRemoteAudio(user, mediaType).catch(error => console.error('Remote audio error:', error)));
    agoraClient.on('user-unpublished', (user, mediaType) => {
      if (mediaType === 'audio') stopRemoteAudio(user).catch(error => console.error('Remote audio cleanup error:', error));
    });
    agoraClient.on('user-left', user => stopRemoteAudio(user).catch(error => console.error('Remote audio cleanup error:', error)));

    await agoraClient.join(tokenData.appId, tokenData.channel, tokenData.token, tokenData.uid);
    microphoneTrack = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, AGC: true, ANS: true });
    await agoraClient.publish([microphoneTrack]);
    isMicrophoneMuted = false;

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
    voiceFace?.setState('idle');
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
  isMicrophoneMuted = false;
  muteButton.classList.remove('is-muted');
  muteButton.setAttribute('aria-pressed', 'false');
  muteButtonText.textContent = 'Mute mic';
  for (const track of remoteAudioTracks.values()) track.stop();
  remoteAudioTracks.clear();
  voiceFace?.detachAudioTrack();

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
muteButton.addEventListener('click', async () => {
  try {
    await setMicrophoneMuted(!isMicrophoneMuted);
  } catch (error) {
    console.error('Could not change microphone state:', error);
    voiceState.textContent = 'Could not change microphone state. Please try again.';
  }
});
window.addEventListener('beforeunload', () => { microphoneTrack?.close(); agoraClient?.leave(); });

/* ------------------------------------------------------------------ globe
 * A small, dependency-free (beyond three.js) draggable wireframe globe.
 * Used for the hero visual only. Drag to spin manually; it drifts on its
 * own the rest of the time.
 */

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

function voiceGlowTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(30, 183, 255, 0.54)');
  gradient.addColorStop(0.38, 'rgba(0, 126, 255, 0.28)');
  gradient.addColorStop(0.72, 'rgba(34, 62, 167, 0.08)');
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

  function tick() {
    requestAnimationFrame(tick);
    if (!dragging) {
      // ease drag momentum back to a gentle idle spin, rather than snapping
      spinY += (IDLE_SPIN - spinY) * 0.02;
      spinX += (0 - spinX) * 0.05;
      group.rotation.y += spinY;
      group.rotation.x = Math.max(-1.1, Math.min(1.1, group.rotation.x + spinX));
    }
    renderer.render(scene, camera);
  }
  tick();
}

if (typeof THREE !== 'undefined') {
  createGlobe('heroGlobe');
} else {
  console.warn('three.js did not load - the hero globe is skipped, everything else still works.');
}

/* ------------------------------------------------------------------ face
 * A layered, glassy assistant orb for the voice console:
 *   - a vivid fuchsia core with shifting light beneath its surface
 *   - two minimal illuminated pill-shaped eyes
 *   - a translucent glass shell and soft halo for depth
 * Everything sits in one group, dragged like a ball - it only turns when
 * you turn it, easing to a stop rather than spinning on its own.
 * Three expression states:
 *   idle       - call not connected, calm smile
 *   connecting - handshaking with Agora, eyes glance side to side
 *   active     - call connected; mouth opens with the remote agent's
 *                real speaking volume (via an AnalyserNode), and eases
 *                back to a small smile when it's quiet
 */

function createFace(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof THREE === 'undefined') return null;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.z = 3.4;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  scene.add(new THREE.AmbientLight(0xc9f5ff, 0.48));
  const keyLight = new THREE.DirectionalLight(0xe1faff, 1.25);
  keyLight.position.set(-1.5, 2.2, 2.8);
  scene.add(keyLight);
  const rimLight = new THREE.PointLight(0x007cff, 1.45, 8);
  rimLight.position.set(2, -0.8, 2.1);
  scene.add(rimLight);
  const cyanLight = new THREE.PointLight(0x7cecff, 0.75, 7);
  cyanLight.position.set(-2.3, -1.4, -1.5);
  scene.add(cyanLight);

  const group = new THREE.Group();
  scene.add(group);

  const FACE_R = 0.82;
  const SHELL_R = 0.98;

  // Live face texture: an offscreen 2D canvas redrawn every frame, mapped
  // onto the inner sphere with the standard equirectangular UV, so the
  // front of the sphere (facing the camera at rest) lines up with the face.
  const texCanvas = document.createElement('canvas');
  texCanvas.width = 1024;
  texCanvas.height = 512;
  const tctx = texCanvas.getContext('2d');
  const faceTexture = new THREE.CanvasTexture(texCanvas);

  // 1. illuminated core
  const inner = new THREE.Mesh(
    new THREE.SphereGeometry(FACE_R, 64, 64),
    new THREE.MeshStandardMaterial({
      map: faceTexture,
      roughness: 0.22,
      metalness: 0.13,
      emissive: new THREE.Color(0x005ac7),
      emissiveIntensity: 0.5,
    }),
  );
  group.add(inner);

  // 2. outer glass shell catches scene lights without hiding the core
  const outerShell = new THREE.Mesh(
    new THREE.SphereGeometry(SHELL_R, 64, 64),
    new THREE.MeshPhongMaterial({
      color: 0xc8f6ff,
      transparent: true,
      opacity: 0.15,
      shininess: 120,
      specular: 0xffffff,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  group.add(outerShell);

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: voiceGlowTexture(), transparent: true, depthWrite: false }));
  glow.scale.set(3.9, 3.9, 1);
  scene.add(glow);

  // drag to rotate - manual only, momentum eases back to a stop rather
  // than settling into a perpetual idle spin
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let spinY = 0;
  let spinX = 0;

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
    const size = Math.min(parent.clientWidth, parent.clientHeight) || parent.clientWidth || 260;
    renderer.setSize(size, size, false);
    camera.aspect = 1;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas.parentElement);
  resize();

  const face = {
    state: 'idle',
    volume: 0,
    targetVolume: 0,
    blinkTimer: 0,
    nextBlinkAt: 2 + Math.random() * 3,
    blinkClose: 0,
    lookX: 0,
    lookY: 0,
    lookTimer: Math.random() * 10,
    mouthOpen: 0,
    time: 0,
    analyser: null,
    audioCtx: null,
    dataArray: null,
  };

  function paintFace(dt) {
    face.time += dt;
    const W = texCanvas.width;
    const H = texCanvas.height;

    // Rich blue with moving highlights gives the core its glassy depth.
    const gradient = tctx.createLinearGradient(0, 0, W, H);
    gradient.addColorStop(0, '#082b74');
    gradient.addColorStop(0.32, '#006eea');
    gradient.addColorStop(0.62, '#12b9ff');
    gradient.addColorStop(1, '#073280');
    tctx.fillStyle = gradient;
    tctx.fillRect(0, 0, W, H);

    const shimmer = tctx.createRadialGradient(W * 0.2, H * 0.25, 0, W * 0.2, H * 0.25, H * 0.48);
    shimmer.addColorStop(0, 'rgba(239, 253, 255, 0.82)');
    shimmer.addColorStop(0.23, 'rgba(121, 226, 255, 0.32)');
    shimmer.addColorStop(1, 'rgba(20, 176, 255, 0)');
    tctx.fillStyle = shimmer;
    tctx.fillRect(0, 0, W, H);

    const underglow = tctx.createRadialGradient(W * 0.66, H * 0.82, 0, W * 0.66, H * 0.82, H * 0.56);
    underglow.addColorStop(0, 'rgba(0, 48, 143, 0.8)');
    underglow.addColorStop(1, 'rgba(0, 30, 96, 0)');
    tctx.fillStyle = underglow;
    tctx.fillRect(0, 0, W, H);

    // front-facing point of a default-orientation sphere maps to (0.25, 0.5)
    // in UV space - draw the face centered there so it faces the camera at rest
    const cx = W * 0.25;
    const cy = H * 0.5;
    const r = H * 0.42;

    // Eye position, eyelid size, and mouth all respond to the current voice
    // state so this reads as a character, not just a static icon.
    face.blinkTimer += dt;
    if (face.blinkTimer >= face.nextBlinkAt) {
      const blinkProgress = (face.blinkTimer - face.nextBlinkAt) / 0.18;
      face.blinkClose = Math.sin(Math.min(blinkProgress, 1) * Math.PI);
      if (blinkProgress >= 1) {
        face.blinkTimer = 0;
        face.nextBlinkAt = 2.2 + Math.random() * 3.8;
        face.blinkClose = 0;
      }
    }

    face.lookTimer += dt;
    let targetLookX = Math.sin(face.lookTimer * 0.55) * 0.10;
    let targetLookY = Math.cos(face.lookTimer * 0.38) * 0.045;
    if (face.state === 'connecting') {
      targetLookX = Math.sin(face.lookTimer * 2.2) * 0.22;
      targetLookY = Math.cos(face.lookTimer * 1.5) * 0.10;
    } else if (face.state === 'active') {
      targetLookX = Math.sin(face.lookTimer * 0.9) * 0.055;
      targetLookY = -0.035 + Math.cos(face.lookTimer * 0.65) * 0.025;
    }
    face.lookX += (targetLookX - face.lookX) * dt * 3.6;
    face.lookY += (targetLookY - face.lookY) * dt * 3.6;

    const eyeY = cy - r * 0.1 + face.lookY * r;
    const eyeSpacing = r * 0.36;
    const eyeW = r * 0.115;
    const eyeHBase = face.state === 'connecting' ? r * 0.28 : face.state === 'active' ? r * 0.30 : r * 0.34;
    const eyeH = Math.max(H * 0.012, eyeHBase * (1 - face.blinkClose * 0.91));
    const activeBrightness = face.state === 'active' ? 0.9 + Math.min(0.1, face.volume * 0.1) : 0.94;

    [-1, 1].forEach(side => {
      const ex = cx + side * eyeSpacing + face.lookX * r;
      tctx.save();
      tctx.shadowColor = 'rgba(222, 250, 255, 0.95)';
      tctx.shadowBlur = r * 0.22;
      tctx.beginPath();
      tctx.ellipse(ex, eyeY, eyeW, eyeH, 0, 0, Math.PI * 2);
      tctx.fillStyle = `rgba(255, 249, 254, ${activeBrightness})`;
      tctx.fill();
      tctx.restore();
    });

    if (face.state === 'connecting') {
      // Asymmetric brows and a small round mouth make the temporary
      // connection state read as curious/confused rather than broken.
      [-1, 1].forEach(side => {
        const ex = cx + side * eyeSpacing + face.lookX * r;
        const browLift = side === -1 ? r * 0.16 : 0;
        tctx.beginPath();
        tctx.moveTo(ex - eyeW * 1.25, eyeY - eyeHBase * 1.45 - browLift);
        tctx.quadraticCurveTo(ex, eyeY - eyeHBase * 1.7 - browLift, ex + eyeW * 1.25, eyeY - eyeHBase * 1.45 - browLift);
        tctx.strokeStyle = 'rgba(230, 252, 255, 0.88)';
        tctx.lineWidth = Math.max(3, H * 0.014);
        tctx.lineCap = 'round';
        tctx.stroke();
      });
      tctx.beginPath();
      tctx.ellipse(cx, cy + r * 0.37, r * 0.105, r * 0.14, 0, 0, Math.PI * 2);
      tctx.fillStyle = 'rgba(0, 49, 126, 0.66)';
      tctx.fill();
    }

    // A broader smile when active makes the conversation state feel happy;
    // it opens a little further in rhythm with the speaker's voice.
    const smileTarget = face.state === 'active'
      ? 0.16 + Math.min(0.28, face.volume * 0.34)
      : 0;
    face.mouthOpen += (smileTarget - face.mouthOpen) * dt * 7;

    const mouthY = cy + r * 0.37;
    const mouthHalfW = face.state === 'active' ? r * 0.29 : r * 0.24;
    const smileDepth = r * (0.105 + face.mouthOpen * 0.18);

    if (face.mouthOpen > 0.12 && face.state !== 'connecting') {
      tctx.beginPath();
      tctx.ellipse(cx, mouthY + smileDepth * 0.34, mouthHalfW * 0.68, face.mouthOpen * r * 0.18, 0, 0, Math.PI * 2);
      tctx.fillStyle = 'rgba(0, 49, 126, 0.62)';
      tctx.fill();
    }

    if (face.state !== 'connecting') {
      tctx.save();
      tctx.shadowColor = 'rgba(202, 247, 255, 0.95)';
      tctx.shadowBlur = r * 0.13;
      tctx.beginPath();
      tctx.moveTo(cx - mouthHalfW, mouthY);
      tctx.quadraticCurveTo(cx, mouthY + smileDepth, cx + mouthHalfW, mouthY);
      tctx.strokeStyle = 'rgba(237, 253, 255, 0.96)';
      tctx.lineWidth = Math.max(3, H * 0.016);
      tctx.lineCap = 'round';
      tctx.stroke();
      tctx.restore();
    }

    faceTexture.needsUpdate = true;
  }

  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    face.volume += (face.targetVolume - face.volume) * 0.3;
    if (face.analyser) {
      face.analyser.getByteFrequencyData(face.dataArray);
      let sum = 0;
      for (let i = 0; i < face.dataArray.length; i++) sum += face.dataArray[i];
      face.targetVolume = Math.min(1, sum / face.dataArray.length / 90);
    } else {
      face.targetVolume = 0;
    }
    paintFace(dt);
    const pulseStrength = face.state === 'active' ? 0.018 + face.volume * 0.025 : 0.008;
    const pulse = 1 + Math.sin(now * (face.state === 'active' ? 0.008 : 0.002)) * pulseStrength;
    glow.scale.set(3.9 * pulse, 3.9 * pulse, 1);

    // manual rotation only - momentum decays to a full stop, no idle drift
    if (!dragging) {
      spinY += (0 - spinY) * 0.06;
      spinX += (0 - spinX) * 0.06;
      group.rotation.y += spinY;
      group.rotation.x = Math.max(-1.1, Math.min(1.1, group.rotation.x + spinX));
    }

    renderer.render(scene, camera);
  }
  requestAnimationFrame(loop);

  return {
    setState(state) { face.state = state; },
    attachAudioTrack(mediaStreamTrack) {
      if (!mediaStreamTrack) return;
      try {
        this.detachAudioTrack();
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new AudioContextClass();
        const source = audioCtx.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        face.audioCtx = audioCtx;
        face.analyser = analyser;
        face.dataArray = new Uint8Array(analyser.frequencyBinCount);
      } catch (error) {
        console.warn('Could not analyze remote audio for face animation:', error);
      }
    },
    detachAudioTrack() {
      face.analyser = null;
      face.dataArray = null;
      face.targetVolume = 0;
      face.audioCtx?.close();
      face.audioCtx = null;
    },
  };
}

const voiceFace = typeof THREE !== 'undefined' ? createFace('voiceFace') : null;
if (typeof THREE === 'undefined') {
  console.warn('three.js did not load - the voice face is skipped, everything else still works.');
}
