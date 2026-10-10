// Shared nav logic, loaded in <head> on every page with a nav.
// Checks whether the visitor is signed in, then tags <html data-auth="in|out">.
// CSS uses that tag to show .show-signed-in / .show-signed-out elements, and hides
// both until the check finishes so the wrong buttons never flash on screen.

// Pages can `await window.authReady` to get the signed-in username (or null),
// or `await window.authInfo` for { username, isAdmin }
window.authInfo = fetch('/api/me')
  .then(res => res.json())
  .then(data => ({ username: data.username || null, isAdmin: !!data.isAdmin }))
  .catch(() => ({ username: null, isAdmin: false }));
window.authReady = window.authInfo.then(info => info.username);

const domReady = new Promise(resolve => {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', resolve, { once: true });
  } else {
    resolve();
  }
});

Promise.all([window.authInfo, domReady]).then(([{ username, isAdmin }]) => {
  document.documentElement.dataset.auth = username ? 'in' : 'out';
  if (isAdmin) document.documentElement.dataset.admin = 'true'; // shows .show-admin (Reports link)

  const profileLink = document.getElementById('profile-link');
  if (profileLink && username) {
    profileLink.href = `/profile.html?username=${encodeURIComponent(username)}`;
  }
});

// ===== Small pop-up notice at the bottom of the screen =====
// showToast('Saved.') or showToast(message, { link: { href: '/login.html', text: 'Log in' } })
let toastTimer;
function showToast(message, { link } = {}) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.toggle('has-link', !!link);
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.text;
    toast.append(' ', a);
  }
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), link ? 6000 : 3500);
}

// For a 401 response: shows the server's "Sorry, you must be logged in…" message with a Log in link
async function showLoginNeeded(res) {
  const message = res ? await res.text() : '';
  showToast(message || 'Sorry, you must be logged in to use this feature.', {
    link: { href: '/login.html', text: 'Log in' },
  });
}

// Logout button (same on every page)
document.addEventListener('click', async (e) => {
  if (!e.target.closest('#logout')) return;
  try {
    const res = await fetch('/api/logout', { method: 'POST' });
    if (!res.ok) throw new Error();
    location.href = '/login.html';
  } catch (err) {
    showToast('Sorry, we couldn\'t log you out. Please try again.');
  }
});
