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

// Styled replacement for the browser's confirm() prompt.
// Usage: if (await confirmAction({ title, message, confirmLabel })) { ...do it... }
let confirmDialog = null;
let confirmResolve = null; // answers the open prompt; null when none is waiting

function finishConfirm(answer) {
  if (confirmDialog.open) confirmDialog.close();
  if (confirmResolve) {
    const resolve = confirmResolve;
    confirmResolve = null;
    resolve(answer);
  }
}

function confirmAction({ title, message, confirmLabel = 'Delete' }) {
  if (!confirmDialog) {
    document.body.insertAdjacentHTML('beforeend', `
      <dialog class="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-message">
        <div class="confirm-form">
          <h3 id="confirm-title" class="confirm-title"></h3>
          <p id="confirm-message" class="confirm-message"></p>
          <div class="confirm-buttons">
            <button type="button" class="btn-outline confirm-cancel">Cancel</button>
            <button type="button" class="btn-primary btn-danger confirm-ok"></button>
          </div>
        </div>
      </dialog>
    `);
    confirmDialog = document.body.lastElementChild;
    confirmDialog.querySelector('.confirm-ok').addEventListener('click', () => finishConfirm(true));
    confirmDialog.querySelector('.confirm-cancel').addEventListener('click', () => finishConfirm(false));
    // Clicking the dark backdrop counts as Cancel
    confirmDialog.addEventListener('click', (e) => {
      if (e.target === confirmDialog) finishConfirm(false);
    });
    // Escape counts as Cancel
    confirmDialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finishConfirm(false);
    });
    // Closed any other way: treat as Cancel (no-op if already answered)
    confirmDialog.addEventListener('close', () => finishConfirm(false));
  }
  if (confirmResolve) finishConfirm(false); // a previous prompt was still waiting

  confirmDialog.querySelector('.confirm-title').textContent = title;
  confirmDialog.querySelector('.confirm-message').textContent = message;
  confirmDialog.querySelector('.confirm-ok').textContent = confirmLabel;
  confirmDialog.showModal();
  confirmDialog.querySelector('.confirm-cancel').focus(); // safe choice selected by default

  return new Promise(resolve => { confirmResolve = resolve; });
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
