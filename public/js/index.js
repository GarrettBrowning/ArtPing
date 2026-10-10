// Script for index.html (kept out of the HTML so the security policy can block inline scripts)

// The welcome message never shows text taken from the link, so nobody can make
// ArtPing display a fake message by sending someone a crafted URL.
const msg = document.getElementById('welcome-msg');
const params = new URLSearchParams(window.location.search);
const justRegistered = params.get('welcome') === '1';
const justDeleted = params.get('deleted') === '1';

(async () => {
  const username = await window.authReady;
  if (username) {
    msg.textContent = `Welcome back, ${username}!`;
  } else if (justDeleted) {
    msg.textContent = 'Your account has been deleted. Thanks for being part of ArtPing.';
  } else if (justRegistered) {
    msg.textContent = 'Welcome to ArtPing! Your account has been created. Log in to get started.';
  } else {
    return;
  }
  msg.classList.add('visible');
})();
