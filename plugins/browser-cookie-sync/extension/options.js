const input = document.getElementById('token');
const status = document.getElementById('status');

chrome.storage.local.get('token').then(({ token }) => {
  input.value = typeof token === 'string' ? token : '';
}).catch(() => { status.textContent = 'Could not load the token.'; });

document.getElementById('settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = input.value.trim();
  if (!token) return;
  try {
    await chrome.storage.local.set({ token });
    status.textContent = 'Saved. Synchronization will start automatically when Mica is available.';
  } catch {
    status.textContent = 'Could not save the token.';
  }
});
