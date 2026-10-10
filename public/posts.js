// Shared post code for feed.html and profile.html:
//   - renderPostCard(post): the card HTML (image, author + picture, likes, comment count)
//   - the post popup (big image, comments, comment box) opened by clicking a card
//   - likes, comments and reports, kept in sync between the cards and the popup
// Load after nav.js (uses window.authReady).

// User content (titles, comments, usernames) must be escaped before inserting as HTML
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function timeAgo(dateStr) {
  const seconds = Math.floor((Date.now() - new Date(dateStr)) / 1000);
  const units = [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]];
  for (const [label, secs] of units) {
    if (seconds >= secs) return `${Math.floor(seconds / secs)}${label} ago`;
  }
  return 'just now';
}

const DEFAULT_PFP = '/images/default-pfp.webp';
const COMMENT_MAX_LENGTH = 500;
const COMMENT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M4 5h16v11H9l-5 4z"/></svg>';
const EDIT_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v6m4-6v6"/></svg>';
const FLAG_ICON ='<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M5 21V4m0 0h11l-2 4 2 4H5"/></svg>';

// Every post rendered on this page, by id, so the popup and cards share one copy
const postStore = new Map();

function profileUrl(username) {
  return `/profile.html?username=${encodeURIComponent(username)}`;
}

function avatar(pfp, className) {
  return `<img src="${escapeHtml(pfp || DEFAULT_PFP)}" alt="" class="${className}" loading="lazy">`;
}

function likeButton(post) {
  return `
    <button type="button" class="like-btn${post.likedByMe ? ' liked' : ''}" data-id="${post._id}"
      aria-pressed="${post.likedByMe}" aria-label="Like">
      <span class="like-heart">${post.likedByMe ? '♥' : '♡'}</span>
      <span class="like-count">${post.likeCount}</span>
    </button>`;
}

function renderPostCard(post) {
  postStore.set(post._id, post);
  return `
    <div class="post-card">
      <button type="button" class="post-open post-card-image" data-id="${post._id}" aria-label="Open ${escapeHtml(post.title)}">
        <img src="${escapeHtml(post.filepath)}" alt="${escapeHtml(post.title)}" loading="lazy">
      </button>
      <div class="post-card-info">
        <p class="post-title">${escapeHtml(post.title)}</p>
        ${post.description ? `<p class="post-desc">${escapeHtml(post.description)}</p>` : ''}
        <div class="post-meta">
          <a href="${profileUrl(post.username)}" class="post-author">
            ${avatar(post.pfp, 'post-avatar')}
            <span>${escapeHtml(post.username)}</span>
          </a>
          <span class="post-time">${timeAgo(post.createdAt)}</span>
        </div>
        <div class="post-actions">
          ${likeButton(post)}
          <button type="button" class="comment-btn post-open" data-id="${post._id}" aria-label="Comments">
            ${COMMENT_ICON}<span class="comment-count" data-id="${post._id}">${post.commentCount}</span>
          </button>
          <span class="post-actions-right">
            ${post.isMine ? '' : `<button type="button" class="card-icon-btn report-btn show-signed-in" data-type="post" data-id="${post._id}" aria-label="Report post" title="Report">${FLAG_ICON}</button>`}
            ${post.isMine ? `<button type="button" class="card-icon-btn post-edit-btn" data-id="${post._id}" aria-label="Edit post" title="Edit">${EDIT_ICON}</button>` : ''}
            ${post.canDelete ? `<button type="button" class="card-icon-btn post-delete-btn" data-id="${post._id}" aria-label="Delete post" title="Delete">${TRASH_ICON}</button>` : ''}
          </span>
        </div>
      </div>
    </div>
  `;
}

// showToast() and showLoginNeeded() come from nav.js

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

// Open a dialog on top of any other open dialog, and close it on backdrop click
function setUpDialog(dialog) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.querySelectorAll('.dialog-close').forEach(btn => btn.addEventListener('click', () => dialog.close()));
}

// ===== Likes (cards and popup) =====
async function toggleLike(postId, btn) {
  const post = postStore.get(postId);
  if (!post || btn.disabled) return;
  const wasLiked = post.likedByMe;
  document.querySelectorAll(`.like-btn[data-id="${postId}"]`).forEach(b => { b.disabled = true; });

  try {
    const res = await fetch(`/api/posts/${postId}/like`, { method: wasLiked ? 'DELETE' : 'POST' });
    if (res.status === 401) return showLoginNeeded(res);
    if (!res.ok) throw new Error(await res.text());
    const { liked, likeCount } = await res.json();
    post.likedByMe = liked;
    post.likeCount = likeCount;
    document.querySelectorAll(`.like-btn[data-id="${postId}"]`).forEach(b => {
      b.classList.toggle('liked', liked);
      b.setAttribute('aria-pressed', liked);
      b.querySelector('.like-heart').textContent = liked ? '♥' : '♡';
      b.querySelector('.like-count').textContent = likeCount;
    });
  } catch (err) {
    showToast("Sorry, we couldn't update your like. Please try again.");
  } finally {
    document.querySelectorAll(`.like-btn[data-id="${postId}"]`).forEach(b => { b.disabled = false; });
  }
}

function setCommentCount(postId, count) {
  const post = postStore.get(postId);
  if (post) post.commentCount = count;
  document.querySelectorAll(`.comment-count[data-id="${postId}"]`).forEach(el => { el.textContent = count; });
}

// ===== Post popup with comments =====
let postDialog = null;
let openPostId = null;
let commentCursor = null;
let commentsLoading = false;
let commentRequest = 0; // ignore responses for a post the user already closed
let shownCommentIds = new Set();

function getPostDialog() {
  if (postDialog) return postDialog;
  document.body.insertAdjacentHTML('beforeend', `
    <dialog class="post-dialog" aria-labelledby="post-dialog-title">
      <button type="button" class="dialog-close post-dialog-close" aria-label="Close">&times;</button>
      <div class="post-dialog-body">
        <div class="post-dialog-image"><img alt=""></div>
        <div class="post-dialog-side">
          <div class="post-dialog-header"></div>
          <div class="post-dialog-actions"></div>
          <h4 class="comments-title">Comments</h4>
          <ul class="comment-list"></ul>
          <div class="comments-more-wrap">
            <button type="button" class="btn-outline comments-more" style="display:none;">Load more comments</button>
          </div>
          <form class="comment-form show-signed-in">
            <label for="comment-text" class="visually-hidden">Add a comment</label>
            <textarea id="comment-text" rows="2" maxlength="${COMMENT_MAX_LENGTH}" placeholder="Add a comment…" required></textarea>
            <div class="comment-form-row">
              <span class="comment-chars">0 / ${COMMENT_MAX_LENGTH}</span>
              <button type="submit" class="btn-primary">Post</button>
            </div>
          </form>
          <p class="comment-login show-signed-out"><a href="/login.html">Log in</a> to comment.</p>
        </div>
      </div>
    </dialog>
  `);
  postDialog = document.body.lastElementChild;
  setUpDialog(postDialog);

  const form = postDialog.querySelector('.comment-form');
  const textarea = form.querySelector('textarea');
  const chars = form.querySelector('.comment-chars');
  textarea.addEventListener('input', () => {
    chars.textContent = `${textarea.value.length} / ${COMMENT_MAX_LENGTH}`;
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    addComment(textarea, chars, form.querySelector('button[type="submit"]'));
  });
  postDialog.querySelector('.comments-more').addEventListener('click', loadComments);
  postDialog.addEventListener('close', () => {
    openPostId = null;
    commentRequest++;
  });
  return postDialog;
}

function renderComment(c) {
  const actions = [
    c.canDelete ? `<button type="button" class="comment-action comment-delete" data-id="${c._id}">Delete</button>` : '',
    !c.isMine ? `<button type="button" class="comment-action report-btn show-signed-in" data-type="comment" data-id="${c._id}">Report</button>` : '',
  ].join('');
  return `
    <li class="comment" data-id="${c._id}">
      <a href="${profileUrl(c.username)}">${avatar(c.pfp, 'comment-avatar')}</a>
      <div class="comment-body">
        <p class="comment-head">
          <a href="${profileUrl(c.username)}" class="comment-author">${escapeHtml(c.username)}</a>
          <span class="comment-time">${timeAgo(c.createdAt)}</span>
        </p>
        <p class="comment-text">${escapeHtml(c.text)}</p>
        ${actions ? `<div class="comment-actions">${actions}</div>` : ''}
      </div>
    </li>
  `;
}

function openPost(postId) {
  const post = postStore.get(postId);
  if (!post) return;
  const dialog = getPostDialog();
  openPostId = postId;
  commentCursor = null;
  commentsLoading = false;
  shownCommentIds = new Set();

  const img = dialog.querySelector('.post-dialog-image img');
  img.src = post.filepath;
  img.alt = post.title;
  dialog.querySelector('.post-dialog-header').innerHTML = `
    <a href="${profileUrl(post.username)}" class="post-author">
      ${avatar(post.pfp, 'post-avatar')}
      <span>${escapeHtml(post.username)}</span>
    </a>
    <span class="post-time">${timeAgo(post.createdAt)}</span>
    <h3 id="post-dialog-title" class="post-dialog-title">${escapeHtml(post.title)}</h3>
    ${post.description ? `<p class="post-dialog-desc">${escapeHtml(post.description)}</p>` : ''}
  `;
  dialog.querySelector('.post-dialog-actions').innerHTML = `
    ${likeButton(post)}
    <span class="post-actions-right">
      ${post.isMine ? '' : `<button type="button" class="report-btn report-post-btn show-signed-in" data-type="post" data-id="${post._id}">${FLAG_ICON} Report</button>`}
      ${post.isMine ? `<button type="button" class="post-edit-btn post-text-btn" data-id="${post._id}">${EDIT_ICON} Edit</button>` : ''}
      ${post.canDelete ? `<button type="button" class="post-delete-btn" data-id="${post._id}">${TRASH_ICON} Delete post</button>` : ''}
    </span>
  `;
  dialog.querySelector('.comment-list').innerHTML = '';
  dialog.querySelector('.comments-more').style.display = 'none';
  const textarea = dialog.querySelector('.comment-form textarea');
  textarea.value = '';
  dialog.querySelector('.comment-chars').textContent = `0 / ${COMMENT_MAX_LENGTH}`;

  if (!dialog.open) dialog.showModal();
  dialog.querySelector('.post-dialog-side').scrollTop = 0;
  loadComments();
}

async function loadComments() {
  if (commentsLoading || !openPostId) return;
  commentsLoading = true;
  const postId = openPostId;
  const request = ++commentRequest;
  const dialog = getPostDialog();
  const list = dialog.querySelector('.comment-list');
  const more = dialog.querySelector('.comments-more');
  more.disabled = true;

  try {
    const query = commentCursor ? `?cursor=${encodeURIComponent(commentCursor)}` : '';
    const res = await fetch(`/api/posts/${postId}/comments${query}`);
    if (res.status === 404) {
      list.innerHTML = '<li class="comment-empty">This post has been removed.</li>';
      return;
    }
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (request !== commentRequest) return;

    // Skip comments already shown (e.g. one you just posted)
    const fresh = data.comments.filter(c => !shownCommentIds.has(String(c._id)));
    fresh.forEach(c => shownCommentIds.add(String(c._id)));
    list.querySelector('.comment-empty')?.remove();
    if (!commentCursor && fresh.length === 0 && shownCommentIds.size === 0) {
      list.innerHTML = '<li class="comment-empty">No comments yet. Be the first!</li>';
    } else {
      list.insertAdjacentHTML('beforeend', fresh.map(renderComment).join(''));
    }
    commentCursor = data.nextCursor;
    more.style.display = commentCursor ? 'inline-block' : 'none';
  } catch (err) {
    if (request === commentRequest) showToast("Sorry, we couldn't load the comments. Please try again.");
  } finally {
    if (request === commentRequest) {
      commentsLoading = false;
      more.disabled = false;
    }
  }
}

async function addComment(textarea, chars, submitBtn) {
  const postId = openPostId;
  const text = textarea.value.trim();
  if (!postId || !text) return;
  submitBtn.disabled = true;

  try {
    const res = await fetch(`/api/posts/${postId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.status === 401) return showLoginNeeded(res);
    if (!res.ok) throw new Error(await res.text());
    const { comment, commentCount } = await res.json();

    setCommentCount(postId, commentCount);
    if (openPostId === postId) {
      const list = getPostDialog().querySelector('.comment-list');
      list.querySelector('.comment-empty')?.remove();
      shownCommentIds.add(String(comment._id));
      list.insertAdjacentHTML('beforeend', renderComment(comment));
      list.lastElementChild.scrollIntoView({ block: 'nearest' });
      textarea.value = '';
      chars.textContent = `0 / ${COMMENT_MAX_LENGTH}`;
    }
  } catch (err) {
    showToast(err.message || "Sorry, we couldn't post your comment. Please try again.");
  } finally {
    submitBtn.disabled = false;
  }
}

async function removeComment(btn) {
  const ok = await confirmAction({
    title: 'Delete comment?',
    message: 'This comment will be permanently deleted.',
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  const postId = openPostId;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/comments/${btn.dataset.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    const { commentCount } = await res.json();
    const item = btn.closest('.comment');
    const list = item.parentElement;
    item.remove();
    if (!list.children.length) list.innerHTML = '<li class="comment-empty">No comments yet. Be the first!</li>';
    if (postId) setCommentCount(postId, commentCount);
  } catch (err) {
    btn.disabled = false;
    showToast(err.message || "Sorry, we couldn't delete that comment. Please try again.");
  }
}

// ===== Editing your own post (title and description only) =====
const TITLE_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 1000;
let editDialog = null;

function getEditDialog() {
  if (editDialog) return editDialog;
  document.body.insertAdjacentHTML('beforeend', `
    <dialog class="edit-dialog" aria-labelledby="edit-dialog-title">
      <form class="edit-form">
        <h3 id="edit-dialog-title" class="report-title">Edit post</h3>
        <div class="field">
          <label for="edit-post-title">Title</label>
          <input type="text" id="edit-post-title" maxlength="${TITLE_MAX_LENGTH}" required>
          <span class="field-hint"><span class="edit-title-count">0</span> / ${TITLE_MAX_LENGTH}</span>
        </div>
        <div class="field">
          <label for="edit-post-description">Description <span class="optional">(optional)</span></label>
          <textarea id="edit-post-description" rows="4" maxlength="${DESCRIPTION_MAX_LENGTH}"></textarea>
          <span class="field-hint"><span class="edit-desc-count">0</span> / ${DESCRIPTION_MAX_LENGTH}</span>
        </div>
        <p class="report-error"></p>
        <div class="report-buttons">
          <button type="button" class="btn-outline dialog-close">Cancel</button>
          <button type="submit" class="btn-primary">Save changes</button>
        </div>
      </form>
    </dialog>
  `);
  editDialog = document.body.lastElementChild;
  setUpDialog(editDialog);

  const form = editDialog.querySelector('.edit-form');
  const title = form.querySelector('#edit-post-title');
  const desc = form.querySelector('#edit-post-description');
  const updateCounts = () => {
    form.querySelector('.edit-title-count').textContent = title.value.length;
    form.querySelector('.edit-desc-count').textContent = desc.value.length;
  };
  title.addEventListener('input', updateCounts);
  desc.addEventListener('input', updateCounts);
  form.updateCounts = updateCounts;
  form.addEventListener('submit', saveEdit);
  return editDialog;
}

function openEdit(postId) {
  const post = postStore.get(postId);
  if (!post) return;
  const dialog = getEditDialog();
  const form = dialog.querySelector('.edit-form');
  form.dataset.id = postId;
  form.querySelector('#edit-post-title').value = post.title;
  form.querySelector('#edit-post-description').value = post.description || '';
  form.querySelector('.report-error').textContent = '';
  form.updateCounts();
  dialog.showModal();
  form.querySelector('#edit-post-title').focus();
}

async function saveEdit(e) {
  e.preventDefault();
  const form = e.target;
  const postId = form.dataset.id;
  const submitBtn = form.querySelector('button[type="submit"]');
  const error = form.querySelector('.report-error');
  const title = form.querySelector('#edit-post-title').value.trim();
  const description = form.querySelector('#edit-post-description').value.trim();
  error.textContent = '';
  if (!title) {
    error.textContent = 'Please give your post a title.';
    return;
  }

  submitBtn.disabled = true;
  try {
    const res = await fetch(`/api/posts/${postId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description }),
    });
    if (res.status === 401) {
      editDialog.close();
      return showLoginNeeded(res);
    }
    if (!res.ok) {
      error.textContent = await res.text();
      return;
    }
    const updated = await res.json();
    const post = postStore.get(postId);
    if (post) Object.assign(post, updated);
    refreshPostText(postId);
    editDialog.close();
    showToast('Changes saved.');
  } catch (err) {
    error.textContent = 'Sorry, we couldn\'t save your changes. Please try again.';
  } finally {
    submitBtn.disabled = false;
  }
}

// Show a post's new title/description on its card and in the popup (if open)
function refreshPostText(postId) {
  const post = postStore.get(postId);
  if (!post) return;
  document.querySelectorAll(`.post-card-image[data-id="${postId}"]`).forEach(el => {
    const card = el.closest('.post-card');
    card.outerHTML = renderPostCard(post);
  });
  if (postDialog && postDialog.open && openPostId === postId) {
    postDialog.querySelector('.post-dialog-image img').alt = post.title;
    postDialog.querySelector('.post-dialog-title').textContent = post.title;
    let desc = postDialog.querySelector('.post-dialog-desc');
    if (post.description) {
      if (!desc) {
        postDialog.querySelector('.post-dialog-title').insertAdjacentHTML('afterend', '<p class="post-dialog-desc"></p>');
        desc = postDialog.querySelector('.post-dialog-desc');
      }
      desc.textContent = post.description;
    } else if (desc) {
      desc.remove();
    }
  }
}

// ===== Deleting your own post =====
async function removePost(btn) {
  const postId = btn.dataset.id;
  const post = postStore.get(postId);
  const ok = await confirmAction({
    title: 'Delete post?',
    message: post && !post.isMine
      ? `This post by ${post.username}, its likes and its comments will be permanently deleted for everyone. This can't be undone.`
      : 'Your post, its likes and its comments will be permanently deleted. This can\'t be undone.',
    confirmLabel: 'Delete post',
  });
  if (!ok) return;

  btn.disabled = true;
  try {
    const res = await fetch(`/api/posts/${postId}`, { method: 'DELETE' });
    if (res.status === 401) return showLoginNeeded(res);
    if (!res.ok) throw new Error(await res.text());

    if (postDialog && postDialog.open) postDialog.close();
    postStore.delete(postId);
    // Remove the card from the page
    document.querySelectorAll(`.post-card-image[data-id="${postId}"]`).forEach(el => {
      const card = el.closest('.post-card');
      const grid = card.parentElement;
      card.remove();
      if (!grid.querySelector('.post-card')) {
        grid.innerHTML = '<p style="color: var(--ink-faint);">No posts yet.</p>';
      }
    });
    showToast('Post deleted.');
  } catch (err) {
    btn.disabled = false;
    showToast(err.message || "Sorry, we couldn't delete that post. Please try again.");
  }
}

// ===== Reports =====
let reportDialog = null;
let reportReasons = null;

async function getReportDialog() {
  if (reportDialog) return reportDialog;
  if (!reportReasons) {
    const res = await fetch('/api/report-reasons');
    reportReasons = await res.json();
  }
  if (reportDialog) return reportDialog; // created while we were fetching
  document.body.insertAdjacentHTML('beforeend', `
    <dialog class="report-dialog" aria-labelledby="report-dialog-title">
      <form class="report-form">
        <h3 id="report-dialog-title" class="report-title">Report</h3>
        <p class="report-sub">Why are you reporting this? Your report is anonymous to the person you report.</p>
        <fieldset class="report-reasons">
          <legend class="visually-hidden">Reason</legend>
          ${Object.entries(reportReasons).map(([key, label]) => `
            <label class="report-reason"><input type="radio" name="reason" value="${key}" required> ${escapeHtml(label)}</label>
          `).join('')}
        </fieldset>
        <label class="report-details-label" for="report-details">More details (optional)</label>
        <textarea id="report-details" rows="3" maxlength="500"></textarea>
        <p class="report-error"></p>
        <div class="report-buttons">
          <button type="button" class="btn-outline dialog-close">Cancel</button>
          <button type="submit" class="btn-primary">Send report</button>
        </div>
      </form>
    </dialog>
  `);
  reportDialog = document.body.lastElementChild;
  setUpDialog(reportDialog);
  reportDialog.querySelector('.report-form').addEventListener('submit', submitReport);
  return reportDialog;
}

async function openReport(targetType, targetId) {
  if (!await window.authReady) return showLoginNeeded();
  let dialog;
  try {
    dialog = await getReportDialog();
  } catch (err) {
    showToast("Sorry, we couldn't open the report form. Please try again.");
    return;
  }
  const form = dialog.querySelector('.report-form');
  form.reset();
  form.dataset.type = targetType;
  form.dataset.id = targetId;
  dialog.querySelector('.report-title').textContent = targetType === 'post' ? 'Report post' : 'Report comment';
  dialog.querySelector('.report-error').textContent = '';
  dialog.showModal();
}

async function submitReport(e) {
  e.preventDefault();
  const form = e.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const error = form.querySelector('.report-error');
  submitBtn.disabled = true;
  error.textContent = '';

  try {
    const res = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetType: form.dataset.type,
        targetId: form.dataset.id,
        reason: form.elements.reason.value,
        details: form.querySelector('textarea').value,
      }),
    });
    if (res.status === 401) return showLoginNeeded(res);
    if (!res.ok) {
      error.textContent = await res.text();
      return;
    }
    reportDialog.close();
    showToast('Thanks for reporting. We will review it.');
  } catch (err) {
    error.textContent = "Sorry, we couldn't send your report. Please try again.";
  } finally {
    submitBtn.disabled = false;
  }
}

// ===== One click listener for everything above (works for cards added later too) =====
document.addEventListener('click', (e) => {
  const like = e.target.closest('.like-btn');
  if (like) return toggleLike(like.dataset.id, like);

  const open = e.target.closest('.post-open');
  if (open) return openPost(open.dataset.id);

  const report = e.target.closest('.report-btn');
  if (report) return openReport(report.dataset.type, report.dataset.id);

  const del = e.target.closest('.comment-delete');
  if (del) return removeComment(del);

  const edit = e.target.closest('.post-edit-btn');
  if (edit) return openEdit(edit.dataset.id);

  const delPost = e.target.closest('.post-delete-btn');
  if (delPost) return removePost(delPost);
});
