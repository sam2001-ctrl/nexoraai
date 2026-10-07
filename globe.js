/* Nexora - the turnable globe on the home page. */

function glowTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255, 216, 77, 0.5)');
  gradient.addColorStop(0.5, 'rgba(255, 216, 77, 0.14)');
  gradient.addColorStop(1, 'rgba(255, 216, 77, 0)');
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

  const wireMaterial = new THREE.MeshBasicMaterial({ color: 0x2447d0, wireframe: true, transparent: true, opacity: 0.6 });
  const wireMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), wireMaterial);
  group.add(wireMesh);

  const dotsGeometry = new THREE.IcosahedronGeometry(1.012, 3);
  const dotsMaterial = new THREE.PointsMaterial({ color: 0x13203b, size: 0.028, transparent: true, opacity: 0.85 });
  group.add(new THREE.Points(dotsGeometry, dotsMaterial));

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false }));
  glow.scale.set(3.4, 3.4, 1);
  scene.add(glow);

  const IDLE_SPIN = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 0.0018;
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

  // The globe leans toward the pointer and picks up speed when the page scrolls.
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let aimX = 0;
  let aimY = 0;
  let onScreen = true;
  new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; }).observe(canvas);
  if (!calm) {
    window.addEventListener('pointermove', event => {
      aimX = (event.clientX / window.innerWidth - 0.5) * 2;
      aimY = (event.clientY / window.innerHeight - 0.5) * 2;
    });
    let lastScroll = window.scrollY;
    window.addEventListener('scroll', () => {
      spinY = Math.max(-0.08, Math.min(0.08, spinY + (window.scrollY - lastScroll) * 0.0006));
      lastScroll = window.scrollY;
    }, { passive: true });
  }

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
    if (!onScreen) return;
    camera.position.x += (aimX * 0.35 - camera.position.x) * 0.05;
    camera.position.y += (-aimY * 0.25 - camera.position.y) * 0.05;
    camera.lookAt(0, 0, 0);
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

