// Script for reports.html (kept out of the HTML so the security policy can block inline scripts)

const list = document.getElementById('report-list');

function renderTarget(item) {
  const t = item.target;
  if (!t) return '<p class="report-target-missing">This content was already deleted.</p>';
  const author = `by <a href="/profile.html?username=${encodeURIComponent(t.username)}">${escapeHtml(t.username)}</a> · ${timeAgo(t.createdAt)}`;
  if (item.targetType === 'post') {
    return `
      <div class="report-target">
        <img src="${escapeHtml(t.filepath)}" alt="" class="report-thumb">
        <div>
          <p class="post-title">${escapeHtml(t.title)}</p>
          ${t.description ? `<p class="post-desc">${escapeHtml(t.description)}</p>` : ''}
          <p class="post-time">${author}</p>
        </div>
      </div>`;
  }
  return `
    <div class="report-target">
      <div>
        <p class="report-comment-text">“${escapeHtml(t.text)}”</p>
        <p class="post-time">Comment ${author}</p>
      </div>
    </div>`;
}

function renderItem(item) {
  return `
    <article class="report-item" data-type="${item.targetType}" data-id="${item.targetId}">
      <div class="report-item-head">
        <span class="report-badge">${item.targetType === 'post' ? 'Post' : 'Comment'}</span>
        <span class="report-count">${item.count} report${item.count === 1 ? '' : 's'}</span>
      </div>
      ${renderTarget(item)}
      <ul class="report-reasons-list">
        ${item.reports.map(r => `
          <li>
            <strong>${escapeHtml(r.reasonLabel)}</strong>
            <span class="post-time">from ${escapeHtml(r.reporter)} · ${timeAgo(r.createdAt)}</span>
            ${r.details ? `<p class="report-details">${escapeHtml(r.details)}</p>` : ''}
          </li>
        `).join('')}
      </ul>
      <div class="report-item-actions">
        <button type="button" class="btn-outline" data-action="dismiss">Dismiss</button>
        <button type="button" class="btn-primary report-remove" data-action="remove">Remove ${item.targetType}</button>
      </div>
    </article>
  `;
}

async function loadReports() {
  const res = await fetch('/api/admin/reports');
  if (res.status === 401) {
    location.href = '/login.html';
    return;
  }
  if (res.status === 403) {
    list.innerHTML = '<p class="report-empty">Only admins can view reports.</p>';
    return;
  }
  if (!res.ok) {
    list.innerHTML = '<p class="report-empty">Sorry, we couldn&#39;t load the reports. Please try again.</p>';
    return;
  }
  const items = await res.json();
  list.innerHTML = items.length
    ? items.map(renderItem).join('')
    : '<p class="report-empty">No open reports. All clear!</p>';
}

list.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const item = btn.closest('.report-item');
  const action = btn.dataset.action;
  if (action === 'remove') {
    const ok = await confirmAction({
      title: `Remove ${item.dataset.type}?`,
      message: `This ${item.dataset.type} will be permanently deleted for everyone. This can't be undone.`,
      confirmLabel: `Remove ${item.dataset.type}`,
    });
    if (!ok) return;
  }

  item.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    const res = await fetch('/api/admin/reports/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: item.dataset.type, targetId: item.dataset.id, action }),
    });
    if (!res.ok) throw new Error(await res.text());
    item.remove();
    showToast(action === 'remove' ? 'Removed.' : 'Reports dismissed.');
    if (!list.children.length) list.innerHTML = '<p class="report-empty">No open reports. All clear!</p>';
  } catch (err) {
    item.querySelectorAll('button').forEach(b => { b.disabled = false; });
    showToast(err.message || 'Something went wrong. Please try again.');
  }
});

loadReports();
