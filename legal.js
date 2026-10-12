document.getElementById('clearDevice')?.addEventListener('click', () => {
  try { sessionStorage.clear(); } catch { /* nothing to clear */ }
  document.getElementById('clearDone').textContent = 'Done. This tab no longer holds any Nexora data.';
});
