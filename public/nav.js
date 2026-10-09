// Shared nav logic, loaded in <head> on every page with a nav.
// Checks whether the visitor is signed in, then tags <html data-auth="in|out">.
// CSS uses that tag to show .show-signed-in / .show-signed-out elements, and hides
// both until the check finishes so the wrong buttons never flash on screen.

// Pages can `await window.authReady` to get the signed-in username (or null)
window.authReady = fetch('/api/me')
  .then(res => res.json())
  .then(data => data.username || null)
  .catch(() => null);

const domReady = new Promise(resolve => {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', resolve, { once: true });
  } else {
    resolve();
  }
});

Promise.all([window.authReady, domReady]).then(([username]) => {
  document.documentElement.dataset.auth = username ? 'in' : 'out';

  const profileLink = document.getElementById('profile-link');
  if (profileLink && username) {
    profileLink.href = `/profile.html?username=${encodeURIComponent(username)}`;
  }
});

// Logout button (same on every page)
document.addEventListener('click', async (e) => {
  if (!e.target.closest('#logout')) return;
  const res = await fetch('/api/logout', { method: 'POST' });
  if (res.ok) {
    location.href = '/login.html';
  } else {
    alert('Logout failed');
  }
});
