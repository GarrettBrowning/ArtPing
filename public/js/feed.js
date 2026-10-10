// Script for feed.html (kept out of the HTML so the security policy can block inline scripts)

const grid = document.getElementById('posts-grid');
const loadMoreBtn = document.getElementById('load-more');
const status = document.getElementById('feed-status');
let nextCursor = null;
let loading = false;
let currentTab = 'new';
let seenIds = new Set(); // Trending rankings can shift between pages, so skip repeats

const emptyMessages = {
  new: 'No posts yet. Be the first to <a href="upload.html">upload</a>!',
  hot: 'No posts yet. Be the first to <a href="upload.html">upload</a>!',
  following: 'Nothing here yet. Follow artists from their profile pages to see their posts here.',
};

async function loadFeed() {
  if (loading) return;
  loading = true;
  loadMoreBtn.disabled = true;
  status.textContent = '';

  try {
    const params = new URLSearchParams();
    if (currentTab === 'hot') params.set('sort', 'hot');
    if (currentTab === 'following') params.set('scope', 'following');
    if (nextCursor) params.set('cursor', nextCursor);

    const res = await fetch(`/api/feed?${params}`);
    if (res.status === 401) {
      grid.innerHTML = '<p style="color: var(--ink-faint);"><a href="login.html">Log in</a> to see posts from artists you follow.</p>';
      nextCursor = null;
      loadMoreBtn.style.display = 'none';
      return;
    }
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();

    const fresh = data.posts.filter(p => !seenIds.has(p._id));
    fresh.forEach(p => seenIds.add(p._id));

    if (!nextCursor && fresh.length === 0) {
      grid.innerHTML = `<p style="color: var(--ink-faint);">${emptyMessages[currentTab]}</p>`;
    } else {
      grid.insertAdjacentHTML('beforeend', fresh.map(renderPostCard).join(''));
    }

    nextCursor = data.nextCursor;
    loadMoreBtn.style.display = nextCursor ? 'inline-block' : 'none';
  } catch (e) {
    status.textContent = "Sorry, we couldn't load the feed. Please try again.";
  } finally {
    loading = false;
    loadMoreBtn.disabled = false;
  }
}

loadMoreBtn.addEventListener('click', loadFeed);

// Switch tabs: reset and load from the top
document.querySelectorAll('.feed-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (loading || tab.dataset.tab === currentTab) return;
    document.querySelectorAll('.feed-tab').forEach(t => t.classList.toggle('active', t === tab));
    currentTab = tab.dataset.tab;
    nextCursor = null;
    seenIds = new Set();
    grid.innerHTML = '';
    loadMoreBtn.style.display = 'none';
    loadFeed();
  });
});

loadFeed();
