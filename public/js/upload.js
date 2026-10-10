// Script for upload.html (kept out of the HTML so the security policy can block inline scripts)

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const previewContainer = document.getElementById('preview-container');
const previewImg = document.getElementById('preview-img');
const removeBtn = document.getElementById('remove-btn');
const cancelBtn = document.getElementById('cancel-btn');
const uploadForm = document.getElementById('upload-form');
const serverMessage = document.querySelector('.server-message');
let selectedFile = null;

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) showPreview(fileInput.files[0]);
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) showPreview(file);
});

dropZone.addEventListener('dragover', (e) => e.preventDefault());

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function showMessage(text, ok) {
  serverMessage.textContent = text;
  serverMessage.style.cssText = ok
    ? 'background-color: #d4edda; color: #155724; padding: 10px 16px; border-radius: 4px;'
    : 'background-color: #f8d7da; color: #b71c1c; padding: 10px 16px; border-radius: 4px;';
}

function showPreview(file) {
  // Quick checks here for a fast answer; the server checks the real file contents too
  if (!ALLOWED_TYPES.includes(file.type)) {
    showMessage('Sorry, only JPG, PNG, WebP and GIF images can be uploaded.', false);
    fileInput.value = '';
    return;
  }
  if (file.size > MAX_BYTES) {
    showMessage('Sorry, that image is too big. The limit is 10 MB.', false);
    fileInput.value = '';
    return;
  }
  serverMessage.textContent = '';
  serverMessage.style.cssText = '';
  selectedFile = file;
  previewImg.src = URL.createObjectURL(file);
  previewContainer.style.display = 'block';
}

function clearPreview() {
  selectedFile = null;
  previewImg.src = '';
  previewContainer.style.display = 'none';
  fileInput.value = '';
  uploadForm.reset();
}

removeBtn.addEventListener('click', clearPreview);
cancelBtn.addEventListener('click', clearPreview);

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedFile) return;

  const formData = new FormData();
  formData.append('image', selectedFile);
  formData.append('title', document.getElementById('title').value);
  formData.append('description', document.getElementById('description').value);

  const submitBtn = uploadForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Uploading…';
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    if (res.ok) {
      showMessage('Your artwork has been posted!', true);
      clearPreview();
    } else {
      showMessage(await res.text(), false);
    }
  } catch (err) {
    showMessage("Sorry, we couldn't reach the server. Please check your connection and try again.", false);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Upload';
  }
});
