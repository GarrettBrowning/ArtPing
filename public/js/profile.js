// Script for profile.html (kept out of the HTML so the security policy can block inline scripts)

const params = new URLSearchParams(window.location.search);
const username = params.get('username');
let currentUser = null;
let isOwner = false;

// Get logged in user
async function getMe() {
  currentUser = await window.authReady; // from nav.js
}

// Load profile
async function loadProfile() {
  const res = await fetch(`/api/profile/${encodeURIComponent(username)}`);
  if (!res.ok) {
    document.querySelector('main').innerHTML = '<p style="color: var(--ink-muted); margin-top: 40px;">Sorry, we couldn&#39;t find that profile.</p>';
    return;
  }
  const profile = res.ok ? await res.json() : null;

  document.getElementById('profile-username').textContent = profile.username;
  document.title = `${profile.username} — ArtPing`; // so browser tabs and search results show whose profile it is
  document.getElementById('profile-pronouns').textContent = profile.pronouns || '';
  document.getElementById('profile-bio').textContent = profile.bio || '';
  if (profile.pfp) document.getElementById('pfp-img').src = profile.pfp;
  document.getElementById('follower-count').textContent = profile.followerCount;
  document.getElementById('following-count').textContent = profile.followingCount;

  // Show follow button on other people's profiles
  if (currentUser !== username) {
    setFollowButton(profile.isFollowing);
    document.getElementById('follow-btn').style.display = 'inline-block';
  }

  // Show edit button if owner
  if (currentUser === username) {
    isOwner = true;
    document.getElementById('edit-btn').style.display = 'inline-block';
    document.getElementById('pfp-edit-btn').style.display = 'block';
    document.getElementById('edit-pronouns').value = profile.pronouns || '';
    document.getElementById('edit-bio').value = profile.bio || '';
  }
}

// Load posts
// Posts come in pages; "Load more" fetches the next one
let postsCursor = null;
const loadMorePosts = document.getElementById('load-more-posts');

async function loadPosts() {
  const grid = document.getElementById('posts-grid');
  loadMorePosts.disabled = true;
  try {
    const query = postsCursor ? `?cursor=${encodeURIComponent(postsCursor)}` : '';
    const res = await fetch(`/api/posts/${encodeURIComponent(username)}${query}`);
    if (!res.ok) throw new Error(await res.text());
    const { posts, nextCursor } = await res.json();

    if (!postsCursor && posts.length === 0) {
      grid.innerHTML = '<p style="color: var(--ink-faint);">No posts yet.</p>';
    } else {
      // Same cards as the feed (likes, comments, reports), from posts.js
      grid.insertAdjacentHTML('beforeend', posts.map(renderPostCard).join(''));
    }
    postsCursor = nextCursor;
    loadMorePosts.style.display = nextCursor ? 'inline-block' : 'none';
  } catch (err) {
    showToast("Sorry, we couldn't load these posts. Please try again.");
  } finally {
    loadMorePosts.disabled = false;
  }
}
loadMorePosts.addEventListener('click', loadPosts);

// Follow / unfollow
function setFollowButton(following) {
  const btn = document.getElementById('follow-btn');
  btn.textContent = following ? 'Following' : 'Follow';
  btn.className = following ? 'btn-outline' : 'btn-primary';
  btn.dataset.following = following;
}

document.getElementById('follow-btn').addEventListener('click', async () => {
  if (!currentUser) return showLoginNeeded();
  const btn = document.getElementById('follow-btn');
  const following = btn.dataset.following === 'true';
  btn.disabled = true;
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(username)}/follow`, {
      method: following ? 'DELETE' : 'POST'
    });
    if (res.ok) {
      const data = await res.json();
      setFollowButton(data.following);
      document.getElementById('follower-count').textContent = data.followerCount;
    } else if (res.status === 401) {
      showLoginNeeded(res);
    } else {
      showToast(await res.text());
    }
  } finally {
    btn.disabled = false;
  }
});

// Followers / Following list
const followDialog = document.getElementById('follow-dialog');
const followList = document.getElementById('follow-list');
const followListMore = document.getElementById('follow-list-more');
const followListStatus = document.getElementById('follow-list-status');
let followListType = 'followers';
let followListCursor = null;
let followListLoading = false;
let followListRequest = 0; // ignore responses from a tab the user already left

function renderFollowUser(user) {
  // No button next to yourself
  const button = user.isMe ? '' : `
    <button type="button" class="follow-row-btn ${user.isFollowing ? 'btn-outline' : 'btn-primary'}"
      data-username="${escapeHtml(user.username)}" data-following="${user.isFollowing}">
      ${user.isFollowing ? 'Following' : 'Follow'}
    </button>`;
  return `
    <li class="follow-row">
      <a href="/profile.html?username=${encodeURIComponent(user.username)}" class="follow-user">
        <img src="${escapeHtml(user.pfp || '/images/default-pfp.webp')}" alt="" class="follow-avatar">
        <span>${escapeHtml(user.username)}</span>
      </a>
      ${button}
    </li>
  `;
}

// Follow / unfollow from inside the list (one listener for every row)
followList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.follow-row-btn');
  if (!btn || btn.disabled) return;

  const following = btn.dataset.following === 'true';
  btn.disabled = true;
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(btn.dataset.username)}/follow`, {
      method: following ? 'DELETE' : 'POST'
    });
    if (res.status === 401) return showLoginNeeded(res);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();

    btn.dataset.following = data.following;
    btn.textContent = data.following ? 'Following' : 'Follow';
    btn.classList.toggle('btn-outline', data.following);
    btn.classList.toggle('btn-primary', !data.following);

    // On your own profile, your "following" count changes too
    if (isOwner && data.following !== following) {
      const countEl = document.getElementById('following-count');
      countEl.textContent = Number(countEl.textContent) + (data.following ? 1 : -1);
    }
  } catch (err) {
    followListStatus.textContent = "Sorry, we couldn't update that follow. Please try again.";
  } finally {
    btn.disabled = false;
  }
});

async function loadFollowList() {
  if (followListLoading) return;
  followListLoading = true;
  followListMore.disabled = true;
  followListStatus.textContent = '';
  const type = followListType;
  const request = ++followListRequest;

  try {
    const query = followListCursor ? `?cursor=${encodeURIComponent(followListCursor)}` : '';
    const res = await fetch(`/api/users/${encodeURIComponent(username)}/${type}${query}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (request !== followListRequest) return;

    if (!followListCursor && data.users.length === 0) {
      followList.innerHTML = `<li class="follow-empty">${type === 'followers' ? 'No followers yet.' : 'Not following anyone yet.'}</li>`;
    } else {
      followList.insertAdjacentHTML('beforeend', data.users.map(renderFollowUser).join(''));
    }
    followListCursor = data.nextCursor;
    followListMore.style.display = followListCursor ? 'inline-block' : 'none';
  } catch (e) {
    if (request === followListRequest) followListStatus.textContent = "Sorry, we couldn't load this list. Please try again.";
  } finally {
    if (request === followListRequest) {
      followListLoading = false;
      followListMore.disabled = false;
    }
  }
}

function showFollowList(type) {
  followListType = type;
  followListCursor = null;
  followListLoading = false;
  followList.innerHTML = '';
  followListMore.style.display = 'none';
  followDialog.querySelectorAll('.feed-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.list === type);
    t.setAttribute('aria-selected', t.dataset.list === type);
  });
  if (!followDialog.open) followDialog.showModal();
  loadFollowList();
}

document.querySelectorAll('.follow-stat').forEach(btn => {
  btn.addEventListener('click', () => showFollowList(btn.dataset.list));
});
followDialog.querySelectorAll('.feed-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.dataset.list !== followListType) showFollowList(tab.dataset.list);
  });
});
followListMore.addEventListener('click', loadFollowList);
followDialog.querySelector('.follow-dialog-close').addEventListener('click', () => followDialog.close());
// Close when clicking the dark backdrop outside the box
followDialog.addEventListener('click', (e) => {
  if (e.target === followDialog) followDialog.close();
});

// Edit profile toggle
document.getElementById('edit-btn').addEventListener('click', () => {
  document.getElementById('edit-form-container').style.display = 'block';
  document.getElementById('edit-btn').style.display = 'none';
});

document.getElementById('cancel-edit-btn').addEventListener('click', () => {
  document.getElementById('edit-form-container').style.display = 'none';
  document.getElementById('edit-btn').style.display = 'inline-block';
});

// Save profile
document.getElementById('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const bio = document.getElementById('edit-bio').value;
  const pronouns = document.getElementById('edit-pronouns').value;
  const errorMsg = document.getElementById('edit-error');

  const res = await fetch('/api/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bio, pronouns })
  });

  if (res.ok) {
    document.getElementById('profile-bio').textContent = bio;
    document.getElementById('profile-pronouns').textContent = pronouns;
    document.getElementById('edit-form-container').style.display = 'none';
    document.getElementById('edit-btn').style.display = 'inline-block';
  } else {
    errorMsg.textContent = await res.text();
    errorMsg.style.display = 'block';
  }
});

// PFP upload
document.getElementById('pfp-input').addEventListener('change', async () => {
  const input = document.getElementById('pfp-input');
  const file = input.files[0];
  input.value = ''; // lets you pick the same file again after an error
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showToast('Sorry, that image is too big. Profile pictures can be up to 5 MB.');
    return;
  }

  const formData = new FormData();
  formData.append('pfp', file);

  try {
    const res = await fetch('/api/profile/pfp', {
      method: 'POST',
      body: formData
    });
    if (res.status === 401) return showLoginNeeded(res);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    document.getElementById('pfp-img').src = data.pfp;
    showToast('Profile picture updated.');
  } catch (err) {
    showToast(err.message || "Sorry, we couldn't update your profile picture. Please try again.");
  }
});


// Init
(async () => {
  await getMe();
  if (!username) {
    if (currentUser) {
      location.href = `/profile.html?username=${encodeURIComponent(currentUser)}`;
    } else {
      location.href = '/login.html';
    }
    return;
  }
  await loadProfile();
  await loadPosts();
})();
