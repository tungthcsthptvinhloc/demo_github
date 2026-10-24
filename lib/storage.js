'use strict';
// Lưu file đề và bài nộp.
// - Trên Vercel: Vercel Blob (biến môi trường BLOB_READ_WRITE_TOKEN). Trình duyệt tải file thẳng lên Blob,
//   máy chủ chỉ cấp "vé" tải lên và ghi lại đường dẫn -> không vướng giới hạn 4.5 MB của Vercel.
// - Chạy thử trên máy: lưu vào thư mục .devdata/uploads.
const path = require('path');
const fs = require('fs');

const MODE = process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'local';
const LOCAL_DIR = path.join(process.env.DEV_DATA_DIR || path.join(__dirname, '..', '.devdata'), 'uploads');
const LOCAL_PREFIX = '/dev-files/';

// Thư mục được phép ghi của từng người: giáo viên -> task/, học sinh -> sub/<id>/
const uploadPrefix = user => (user.role === 'teacher' ? 'task/' : `sub/${user.id}/`);

// Kiểm tra đường dẫn file do trình duyệt gửi lên đúng là file trong kho của mình, trong thư mục của người đó.
function isOwnFileUrl(url, prefix) {
  if (typeof url !== 'string' || url.length > 1000) return false;
  if (MODE === 'local') {
    return url.startsWith(LOCAL_PREFIX + prefix) && !url.includes('..');
  }
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.endsWith('.public.blob.vercel-storage.com') &&
      decodeURIComponent(u.pathname).startsWith('/' + prefix);
  } catch {
    return false;
  }
}

async function removeFiles(urls) {
  if (!urls.length) return;
  try {
    if (MODE === 'blob') {
      await require('@vercel/blob').del(urls);
    } else {
      for (const u of urls) fs.rmSync(path.join(LOCAL_DIR, u.slice(LOCAL_PREFIX.length)), { force: true });
    }
  } catch (err) {
    console.error('Không xóa được file:', err.message);
  }
}

// Đường dẫn để trình duyệt xem / tải file.
function fileHref(url, download) {
  if (!download) return url;
  return url + (url.includes('?') ? '&' : '?') + 'download=1';
}

module.exports = { MODE, LOCAL_DIR, LOCAL_PREFIX, uploadPrefix, isOwnFileUrl, removeFiles, fileHref };
