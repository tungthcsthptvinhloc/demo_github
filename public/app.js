'use strict';

const MAX_FILES = 10;
const MAX_BYTES = 10 * 1024 * 1024;

const state = { user: null, teamName: '' };
const view = document.getElementById('view');

// ================================================================ tiện ích chung

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = iso => iso
  ? new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' })
  : '';

function relSpan(iso) {
  const ms = Math.abs(new Date(iso).getTime() - Date.now());
  const min = Math.round(ms / 60000), h = Math.round(ms / 3600000), d = Math.round(ms / 86400000);
  return min < 60 ? `${Math.max(min, 1)} phút` : h < 48 ? `${h} giờ` : `${d} ngày`;
}

function dueHtml(dueAt) {
  if (!dueAt) return '<span>⏰ Không có hạn nộp</span>';
  const past = new Date(dueAt).getTime() < Date.now();
  return `<span class="${past ? 'text-danger' : ''}">⏰ Hạn: ${fmt(dueAt)} (${past ? 'đã hết hạn ' + relSpan(dueAt) : 'còn ' + relSpan(dueAt)})</span>`;
}

// Chuyển ISO -> giá trị cho ô datetime-local (giờ địa phương).
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

const fileSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const isImage = f => /^image\/(png|jpe?g|gif|webp|bmp)$/.test(f.mime || f.type || '');
const canPreview = f => isImage(f) || /^(application\/pdf|text\/plain)$/.test(f.mime || '');

function fileIcon(f) {
  const n = (f.orig_name || f.name || '').toLowerCase();
  if (isImage(f)) return '🖼️';
  if (n.endsWith('.pdf')) return '📕';
  if (/\.docx?$/.test(n)) return '📘';
  if (/\.xlsx?$/.test(n)) return '📗';
  if (/\.pptx?$/.test(n)) return '📙';
  return '📄';
}

const STATUS = {
  new: { label: 'Chưa xem', short: '○' },
  viewed: { label: 'Đã xem – chưa làm', short: '◐' },
  submitted: { label: 'Đã nộp', short: '✓' },
  graded: { label: 'Đã chấm', short: '✓✓' },
  redo: { label: 'Cần làm lại', short: '↺' },
};
const STUDENT_LABEL = { new: 'Mới', viewed: 'Chưa làm', submitted: 'Đã nộp – chờ chấm', graded: 'Đã chấm', redo: 'Cần làm lại' };

const badge = (status, forStudent = false) =>
  `<span class="badge st-${status}">${forStudent ? STUDENT_LABEL[status] : STATUS[status].label}</span>`;

function flags(c) {
  let h = '';
  if (c.overdue) h += ' <span class="badge badge-danger">Quá hạn</span>';
  if (c.late) h += ' <span class="badge badge-late">Nộp muộn</span>';
  return h;
}

// Văn bản thường + công thức LaTeX ($...$, $$...$$) + tự nhận đường link.
function richText(s) {
  return esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

const MATH_OPTS = {
  delimiters: [
    { left: '$$', right: '$$', display: true },
    { left: '\\[', right: '\\]', display: true },
    { left: '$', right: '$', display: false },
    { left: '\\(', right: '\\)', display: false },
  ],
  throwOnError: false,
};
function typeset(root = view) {
  if (!window.renderMathInElement) return;
  const targets = root.classList && root.classList.contains('rich') ? [root] : root.querySelectorAll('.rich');
  targets.forEach(el => window.renderMathInElement(el, MATH_OPTS));
}

function filesHtml(files) {
  if (!files || !files.length) return '';
  const imgs = files.filter(isImage);
  const others = files.filter(f => !isImage(f));
  let h = '';
  if (imgs.length) {
    h += `<div class="thumbs">${imgs.map(f => `<a href="/files/${f.id}" target="_blank" title="${esc(f.orig_name)}">
      <img src="/files/${f.id}" loading="lazy" alt="${esc(f.orig_name)}"></a>`).join('')}</div>`;
  }
  if (others.length) {
    h += `<ul class="file-list">${others.map(f => `<li><span>${fileIcon(f)}</span>
      <span class="name" title="${esc(f.orig_name)}">${esc(f.orig_name)}</span>
      <span class="muted small nowrap">${fileSize(f.size)}</span>
      ${canPreview(f) ? `<a class="small" href="/files/${f.id}" target="_blank">Xem</a>` : ''}
      <a class="small" href="/files/${f.id}?dl=1">Tải về</a></li>`).join('')}</ul>`;
  }
  return h;
}

// ================================================================ gọi máy chủ

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opt);
  } catch {
    throw new Error('Không kết nối được tới máy chủ. Kiểm tra mạng hoặc máy chủ đã bật chưa.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* không có nội dung JSON */ }
  if (!res.ok) {
    if (res.status === 401 && state.user) {
      state.user = null;
      go('#/login');
    }
    throw new Error(data.error || `Lỗi ${res.status}`);
  }
  return data;
}

// Gửi biểu mẫu có file (bản chạy thử trên máy), báo số byte đã gửi.
function sendForm(method, url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.upload.onprogress = e => { if (onProgress && e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* bỏ qua */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Lỗi ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Mất kết nối tới máy chủ. Kiểm tra mạng rồi thử lại.'));
    xhr.send(formData);
  });
}

// Tên file an toàn để đặt trên kho lưu trữ (tên gốc tiếng Việt vẫn được lưu riêng để hiển thị).
function safeFileName(name) {
  const ext = (name.match(/\.[a-z0-9]{1,8}$/i) || [''])[0].toLowerCase();
  const base = name.slice(0, name.length - ext.length).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return (base || 'file') + ext;
}

// Tải lần lượt các file lên kho (Vercel Blob, hoặc thư mục .devdata khi chạy thử),
// trả về danh sách { url, name, size, type } để gửi kèm biểu mẫu.
async function uploadFiles(files, bar) {
  if (files.length && state.storage === 'missing') {
    throw new Error('Chưa kết nối kho Vercel Blob nên chưa gửi được file. Giáo viên cần vào Vercel → Storage gắn kho Blob rồi Redeploy.');
  }
  const prefix = state.user.role === 'teacher' ? 'task/' : `sub/${state.user.id}/`;
  const total = files.reduce((sum, f) => sum + f.size, 0) || 1;
  let done = 0;
  const progress = loaded => { if (bar) bar.style.width = `${Math.min(100, ((done + loaded) / total) * 100)}%`; };
  const out = [];
  for (const f of files) {
    const pathname = prefix + safeFileName(f.name);
    let url;
    try {
      if (state.storage === 'blob') {
        const r = await window.VercelBlob.upload(pathname, f, {
          access: 'public', handleUploadUrl: '/api/upload', contentType: f.type || undefined,
          onUploadProgress: e => progress(e.loaded),
        });
        url = r.url;
      } else {
        const fd = new FormData();
        fd.append('pathname', pathname);
        fd.append('file', f, f.name);
        url = (await sendForm('POST', '/api/dev-upload', fd, progress)).url;
      }
    } catch (err) {
      throw new Error(`Không tải được file "${f.name}": ${err.message}`);
    }
    done += f.size;
    progress(0);
    out.push({ url, name: f.name, size: f.size, type: f.type });
  }
  return out;
}

// ================================================================ giao diện chung

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.textContent = msg;
  if (isError) el.className = 'err';
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), isError ? 5000 : 3000);
}

function modal(title, bodyHtml, actions) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h2>${esc(title)}</h2><div class="modal-body">${bodyHtml}</div>
    <div class="modal-actions"></div></div>`;
  const close = () => { back.remove(); document.body.classList.remove('printing'); };
  const bar = back.querySelector('.modal-actions');
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.cls || ''}`;
    b.type = 'button';
    b.textContent = a.label;
    b.onclick = () => (a.onClick ? a.onClick(close, back) : close());
    bar.appendChild(b);
  }
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  document.body.appendChild(back);
  return { el: back, close };
}

function confirmDialog(title, message, okLabel = 'Đồng ý', danger = false) {
  return new Promise(resolve => {
    modal(title, `<p>${message}</p>`, [
      { label: 'Hủy', cls: 'btn-ghost', onClick: close => { close(); resolve(false); } },
      { label: okLabel, cls: danger ? 'btn-danger' : '', onClick: close => { close(); resolve(true); } },
    ]);
  });
}

// Bắt sự kiện gửi biểu mẫu: khóa nút, hiện lỗi trong .form-error.
function onSubmit(form, handler) {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const buttons = form.querySelectorAll('button');
    const errBox = form.querySelector('.form-error');
    buttons.forEach(b => { b.disabled = true; });
    if (errBox) errBox.innerHTML = '';
    try {
      await handler(Object.fromEntries(new FormData(form)), e.submitter);
    } catch (err) {
      if (errBox) errBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      else toast(err.message, true);
    } finally {
      buttons.forEach(b => { b.disabled = false; });
    }
  });
}

// Ô soạn thảo có xem trước công thức.
function attachPreview(textarea, preview) {
  let timer;
  const update = () => {
    preview.innerHTML = textarea.value.trim() ? richText(textarea.value) : '<span class="muted">Xem trước sẽ hiện ở đây</span>';
    typeset(preview);
  };
  textarea.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 250); });
  update();
}

// Nén ảnh chụp điện thoại (thường 3-8 MB) trước khi gửi.
async function compressImage(file, threshold) {
  if (!/^image\/(jpeg|png|webp|bmp)$/.test(file.type) || file.size <= threshold) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

// Khu chọn file: cho chọn nhiều lần, bỏ bớt file, nén ảnh lớn.
function filePicker(root, { threshold, studentMode = false }) {
  const files = [];
  root.innerHTML = `
    <div class="actions">
      ${studentMode ? '<button type="button" class="btn btn-ghost" data-pick="img">📷 Chụp / chọn ảnh</button>' : ''}
      <button type="button" class="btn btn-ghost" data-pick="any">📎 ${studentMode ? 'Chọn file khác' : 'Chọn file đính kèm'}</button>
      <span class="muted small">Tối đa ${MAX_FILES} file, mỗi file ≤ 10 MB</span>
    </div>
    <input type="file" multiple class="hidden" data-input="img" accept="image/*">
    <input type="file" multiple class="hidden" data-input="any">
    <ul class="file-list"></ul>`;
  const list = root.querySelector('.file-list');
  const draw = () => {
    list.innerHTML = files.map((f, i) => `<li><span>${fileIcon(f)}</span><span class="name">${esc(f.name)}</span>
      <span class="muted small nowrap">${fileSize(f.size)}</span>
      <button type="button" class="link-btn danger small" data-rm="${i}">Bỏ</button></li>`).join('');
  };
  root.querySelectorAll('[data-pick]').forEach(b => {
    b.onclick = () => root.querySelector(`[data-input="${b.dataset.pick}"]`).click();
  });
  root.querySelectorAll('input[type=file]').forEach(input => {
    input.onchange = async () => {
      for (const f of input.files) {
        if (files.length >= MAX_FILES) { toast(`Chỉ được tối đa ${MAX_FILES} file`, true); break; }
        const prepared = await compressImage(f, threshold);
        if (prepared.size > MAX_BYTES) { toast(`"${f.name}" lớn hơn 10 MB, không thể gửi`, true); continue; }
        files.push(prepared);
      }
      input.value = '';
      draw();
    };
  });
  list.addEventListener('click', e => {
    const i = e.target.dataset.rm;
    if (i !== undefined) { files.splice(Number(i), 1); draw(); }
  });
  return { files };
}

function setTopbar(show) {
  const bar = document.getElementById('topbar');
  bar.hidden = !show;
  if (!show || !state.user) return;
  document.getElementById('team-name').textContent = state.teamName || 'Quản lý nhiệm vụ';
  document.getElementById('user-name').textContent =
    `${state.user.role === 'teacher' ? 'GV' : 'HS'}: ${state.user.full_name}`;
  const links = state.user.role === 'teacher'
    ? [['#/gv/nhiem-vu', 'Nhiệm vụ'], ['#/gv/tong-hop', 'Tổng hợp'], ['#/gv/hoc-sinh', 'Học sinh'], ['#/gv/cai-dat', 'Cài đặt']]
    : [['#/hs/nhiem-vu', 'Nhiệm vụ của em'], ['#/doi-mat-khau', 'Đổi mật khẩu']];
  const hash = location.hash;
  document.getElementById('nav').innerHTML = links
    .map(([href, label]) => `<a href="${href}" class="${hash.startsWith(href) ? 'active' : ''}">${label}</a>`).join('');
}

document.getElementById('logout-btn').onclick = async () => {
  try { await api('POST', '/api/logout'); } catch { /* vẫn đăng xuất ở phía trình duyệt */ }
  state.user = null;
  go('#/login');
};

// ================================================================ đăng nhập, khởi tạo, đổi mật khẩu

async function viewLogin() {
  if (state.user) return go(home());
  const st = await api('GET', '/api/setup-status');
  if (st.needsSetup) return go('#/setup');
  setTopbar(false);
  view.innerHTML = `<div class="auth-wrap"><div class="card">
    <div class="auth-title"><div class="big-icon">📘</div><h1>${esc(st.teamName || 'Quản lý nhiệm vụ')}</h1>
      <div class="muted">Đăng nhập để tiếp tục</div></div>
    <form id="f">
      <div class="form-error"></div>
      <div class="field"><label for="u">Tên đăng nhập</label>
        <input type="text" id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
      <div class="field"><label for="p">Mật khẩu</label>
        <input type="password" id="p" name="password" autocomplete="current-password" required></div>
      <button class="btn" style="width:100%;justify-content:center">Đăng nhập</button>
    </form>
    <p class="hint center">Quên mật khẩu? Hãy nhờ giáo viên đặt lại.</p>
  </div></div>`;
  document.getElementById('u').focus();
  onSubmit(document.getElementById('f'), async data => {
    const r = await api('POST', '/api/login', data);
    state.user = r.user;
    go(home());
  });
}

async function viewSetup() {
  const st = await api('GET', '/api/setup-status');
  if (!st.needsSetup) return go('#/login');
  setTopbar(false);
  view.innerHTML = `<div class="auth-wrap"><div class="card">
    <div class="auth-title"><div class="big-icon">🎓</div><h1>Thiết lập lần đầu</h1>
      <div class="muted">Tạo tài khoản giáo viên quản lý đội tuyển</div></div>
    <form id="f">
      <div class="form-error"></div>
      ${st.needsSetupCode ? `<div class="field"><label>Mã khởi tạo</label><input type="password" name="setup_code" autocomplete="off" required>
        <div class="hint">Là giá trị biến <code>SETUP_CODE</code> thầy/cô đã đặt trên Vercel.</div></div>` : ''}
      <div class="field"><label>Tên đội tuyển</label><input type="text" name="team_name" placeholder="VD: Đội tuyển HSG Toán 12" required></div>
      <div class="field"><label>Họ và tên giáo viên</label><input type="text" name="full_name" required></div>
      <div class="field"><label>Tên đăng nhập</label><input type="text" name="username" autocapitalize="none" placeholder="VD: giaovien" required>
        <div class="hint">Chữ không dấu, số, dấu chấm hoặc gạch dưới (3-30 ký tự).</div></div>
      <div class="field"><label>Mật khẩu</label><input type="password" name="password" autocomplete="new-password" required></div>
      <div class="field"><label>Nhập lại mật khẩu</label><input type="password" name="password2" autocomplete="new-password" required></div>
      <button class="btn" style="width:100%;justify-content:center">Tạo tài khoản và bắt đầu</button>
    </form></div></div>`;
  onSubmit(document.getElementById('f'), async data => {
    if (data.password !== data.password2) throw new Error('Hai mật khẩu không khớp');
    const r = await api('POST', '/api/setup', data);
    state.user = r.user;
    state.teamName = data.team_name;
    go(home());
  });
}

async function viewChangePw() {
  setTopbar(true);
  const first = state.user.must_change_pw;
  view.innerHTML = `<div class="auth-wrap" style="margin-top:3vh"><div class="card">
    <h2>Đổi mật khẩu</h2>
    ${first ? '<div class="info-box">Đây là lần đăng nhập đầu tiên (hoặc mật khẩu vừa được đặt lại). Vui lòng đặt mật khẩu mới của riêng mình.</div>' : ''}
    <form id="f">
      <div class="form-error"></div>
      <div class="field"><label>Mật khẩu hiện tại</label><input type="password" name="old_password" autocomplete="current-password" required></div>
      <div class="field"><label>Mật khẩu mới</label><input type="password" name="new_password" autocomplete="new-password" required>
        <div class="hint">Ít nhất 6 ký tự.</div></div>
      <div class="field"><label>Nhập lại mật khẩu mới</label><input type="password" name="new_password2" autocomplete="new-password" required></div>
      <button class="btn">Lưu mật khẩu mới</button>
    </form></div></div>`;
  onSubmit(document.getElementById('f'), async data => {
    if (data.new_password !== data.new_password2) throw new Error('Hai mật khẩu mới không khớp');
    await api('POST', '/api/change-password', data);
    state.user.must_change_pw = false;
    toast('Đã đổi mật khẩu');
    go(home());
  });
}

// ================================================================ GIÁO VIÊN: danh sách nhiệm vụ

const SEGMENTS = ['graded', 'submitted', 'redo', 'viewed', 'new'];

function progressBar(c) {
  if (!c.total) return '<div class="progress"></div>';
  return `<div class="progress">${SEGMENTS.map(k => c[k]
    ? `<span class="bg-${k}" style="width:${(c[k] / c.total) * 100}%" title="${STATUS[k].label}: ${c[k]}"></span>` : '').join('')}</div>`;
}

function legend(c) {
  return `<div class="legend">${SEGMENTS.map(k => `<span><i class="bg-${k}"></i>${STATUS[k].label}: <b>${c[k]}</b></span>`).join('')}
    ${c.overdue ? `<span class="text-danger"><b>${c.overdue}</b> em quá hạn chưa nộp</span>` : ''}</div>`;
}

async function tTaskList() {
  setTopbar(true);
  const { tasks } = await api('GET', '/api/tasks');
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Nhiệm vụ đã giao</h1><div class="muted">${tasks.length} nhiệm vụ</div></div>
      <div class="actions">
        <a class="btn btn-ghost" href="/api/export.xlsx">⬇ Xuất Excel</a>
        <a class="btn" href="#/gv/nhiem-vu/moi">+ Giao nhiệm vụ mới</a>
      </div>
    </div>
    ${tasks.length > 4 ? '<div class="field"><input type="search" id="q" placeholder="Tìm nhiệm vụ theo tên..."></div>' : ''}
    <div class="task-list" id="list">
      ${tasks.length ? tasks.map(t => `
        <a class="card task-card" href="#/gv/nhiem-vu/${t.id}" data-title="${esc(t.title.toLowerCase())}">
          <div class="title">${esc(t.title)}</div>
          <div class="meta">
            <span>Giao lúc ${fmt(t.created_at)}</span>${dueHtml(t.due_at)}
            <span>👥 ${t.assign_all ? 'Cả đội' : 'Một số em'} (${t.counts.total} HS)</span>
            ${t.file_count ? `<span>📎 ${t.file_count} file</span>` : ''}
          </div>
          ${progressBar(t.counts)}${legend(t.counts)}
        </a>`).join('') : `<div class="card empty">Chưa có nhiệm vụ nào.<br><br>
          <a class="btn" href="#/gv/nhiem-vu/moi">+ Giao nhiệm vụ đầu tiên</a></div>`}
    </div>`;
  const q = document.getElementById('q');
  if (q) {
    q.oninput = () => {
      const s = q.value.trim().toLowerCase();
      view.querySelectorAll('.task-card').forEach(el => el.classList.toggle('hidden', !el.dataset.title.includes(s)));
    };
  }
}

// ================================================================ GIÁO VIÊN: tạo / sửa nhiệm vụ

async function tTaskForm(id) {
  setTopbar(true);
  const [{ students }, detail] = await Promise.all([
    api('GET', '/api/students'),
    id ? api('GET', `/api/tasks/${id}`) : Promise.resolve(null),
  ]);
  const t = detail ? detail.task : { title: '', description: '', due_at: null, assign_all: true, files: [] };
  const chosen = new Set(detail ? detail.assignee_ids : []);
  const active = students.filter(s => s.active);
  const removed = new Set();

  view.innerHTML = `
    <a class="back" href="${id ? `#/gv/nhiem-vu/${id}` : '#/gv/nhiem-vu'}">← Quay lại</a>
    <h1>${id ? 'Sửa nhiệm vụ' : 'Giao nhiệm vụ mới'}</h1>
    <form id="f" class="card" style="margin-top:12px">
      <div class="form-error"></div>
      <div class="field"><label>Tên nhiệm vụ *</label>
        <input type="text" name="title" value="${esc(t.title)}" maxlength="200" placeholder="VD: Bài tập Số học - Tuần 5" required></div>
      <div class="field"><label>Nội dung / yêu cầu</label>
        <textarea name="description" id="desc" rows="8" placeholder="Mô tả yêu cầu, đề bài...">${esc(t.description)}</textarea>
        <div class="hint">Công thức toán: viết trong <code>$...$</code> (cùng dòng) hoặc <code>$$...$$</code> (dòng riêng).
          VD: <code>$x^2 + \\sqrt{y} = \\frac{1}{2}$</code></div>
        <div class="preview-box rich" id="preview"></div></div>
      <div class="grid-2">
        <div class="field"><label>Hạn nộp</label>
          <input type="datetime-local" name="due_at" value="${toLocalInput(t.due_at)}">
          <div class="hint">Để trống nếu không giới hạn thời gian. Học sinh vẫn nộp được sau hạn (bị đánh dấu "nộp muộn").</div></div>
        <div class="field"><label>Giao cho</label>
          <div class="radio-row">
            <label><input type="radio" name="assign_all" value="1" ${t.assign_all ? 'checked' : ''}> Cả đội (${active.length} HS)</label>
            <label><input type="radio" name="assign_all" value="0" ${t.assign_all ? '' : 'checked'}> Chọn học sinh</label>
          </div>
          <div class="hint">"Cả đội" bao gồm cả học sinh được thêm sau này.</div>
        </div>
      </div>
      <div class="field ${t.assign_all ? 'hidden' : ''}" id="picker-wrap">
        <div class="actions"><button type="button" class="link-btn" id="all-on">Chọn tất cả</button>·
          <button type="button" class="link-btn" id="all-off">Bỏ chọn</button>
          <span class="muted small" id="pick-count"></span></div>
        <div class="student-picker">${active.map(s => `<label class="check"><input type="checkbox" value="${s.id}" ${chosen.has(s.id) ? 'checked' : ''}>
          ${esc(s.full_name)} <span class="muted small">${esc(s.class_name)}</span></label>`).join('') || '<span class="muted">Chưa có học sinh nào</span>'}</div>
      </div>
      <div class="field"><label>File đề / tài liệu</label>
        ${t.files.length ? `<ul class="file-list" id="old-files">${t.files.map(f => `<li data-id="${f.id}"><span>${fileIcon(f)}</span>
          <span class="name">${esc(f.orig_name)}</span><span class="muted small">${fileSize(f.size)}</span>
          <button type="button" class="link-btn danger small" data-toggle="${f.id}">Xóa</button></li>`).join('')}</ul>` : ''}
        <div id="picker" style="margin-top:8px"></div>
      </div>
      <div class="actions">
        <button class="btn">${id ? 'Lưu thay đổi' : 'Giao nhiệm vụ'}</button>
        <a class="btn btn-ghost" href="${id ? `#/gv/nhiem-vu/${id}` : '#/gv/nhiem-vu'}">Hủy</a>
      </div>
      <div class="upload-bar hidden" id="bar-wrap"><span id="bar"></span></div>
    </form>`;

  const form = document.getElementById('f');
  attachPreview(document.getElementById('desc'), document.getElementById('preview'));

  const pickerWrap = document.getElementById('picker-wrap');
  const boxes = () => [...pickerWrap.querySelectorAll('input[type=checkbox]')];
  const countPicked = () => { document.getElementById('pick-count').textContent = `Đã chọn ${boxes().filter(b => b.checked).length} em`; };
  form.querySelectorAll('input[name=assign_all]').forEach(r => {
    r.onchange = () => pickerWrap.classList.toggle('hidden', form.assign_all.value === '1');
  });
  pickerWrap.addEventListener('change', countPicked);
  document.getElementById('all-on').onclick = () => { boxes().forEach(b => { b.checked = true; }); countPicked(); };
  document.getElementById('all-off').onclick = () => { boxes().forEach(b => { b.checked = false; }); countPicked(); };
  countPicked();

  const oldFiles = document.getElementById('old-files');
  if (oldFiles) {
    oldFiles.addEventListener('click', e => {
      const fid = Number(e.target.dataset.toggle);
      if (!fid) return;
      const li = e.target.closest('li');
      if (removed.has(fid)) { removed.delete(fid); li.classList.remove('removed'); e.target.textContent = 'Xóa'; }
      else { removed.add(fid); li.classList.add('removed'); e.target.textContent = 'Hoàn tác'; }
    });
  }
  // Ảnh đề giữ nguyên chất lượng, chỉ nén khi vượt giới hạn 10 MB.
  const picker = filePicker(document.getElementById('picker'), { threshold: MAX_BYTES });

  onSubmit(form, async data => {
    document.getElementById('bar-wrap').classList.remove('hidden');
    const files = await uploadFiles(picker.files, document.getElementById('bar'));
    const r = await api(id ? 'PUT' : 'POST', id ? `/api/tasks/${id}` : '/api/tasks', {
      title: data.title,
      description: data.description,
      due_at: data.due_at ? new Date(data.due_at).toISOString() : '',
      assign_all: data.assign_all === '1',
      student_ids: boxes().filter(b => b.checked).map(b => Number(b.value)),
      remove_file_ids: [...removed],
      files,
    });
    toast(id ? 'Đã lưu thay đổi' : 'Đã giao nhiệm vụ');
    go(`#/gv/nhiem-vu/${r.id}`);
  });
}

// ================================================================ GIÁO VIÊN: chi tiết nhiệm vụ

async function tTaskDetail(id) {
  setTopbar(true);
  const { task: t, students } = await api('GET', `/api/tasks/${id}`);
  const c = t.counts;
  let filter = 'all';
  const filters = [['all', 'Tất cả', c.total], ...SEGMENTS.slice().reverse().map(k => [k, STATUS[k].label, c[k]]), ['overdue', 'Quá hạn', c.overdue]];

  view.innerHTML = `
    <a class="back" href="#/gv/nhiem-vu">← Danh sách nhiệm vụ</a>
    <div class="page-head">
      <div><h1>${esc(t.title)}</h1>
        <div class="muted small" style="display:flex;gap:12px;flex-wrap:wrap">
          <span>Giao lúc ${fmt(t.created_at)}</span>${dueHtml(t.due_at)}
          <span>👥 ${t.assign_all ? 'Cả đội' : 'Một số em'} (${c.total} HS)</span></div></div>
      <div class="actions">
        <a class="btn btn-ghost" href="#/gv/nhiem-vu/${t.id}/sua">✏️ Sửa</a>
        <button class="btn btn-ghost" id="del">🗑 Xóa</button>
      </div>
    </div>
    ${t.description || t.files.length ? `<div class="card">
      ${t.description ? `<div class="rich">${richText(t.description)}</div>` : ''}${filesHtml(t.files)}</div>` : ''}
    <div class="card">
      <h2>Tình hình thực hiện</h2>
      ${progressBar(c)}
      <div class="chips" id="chips" style="margin-top:12px">${filters.map(([k, label, n]) =>
        `<button class="chip ${k === 'all' ? 'active' : ''}" data-f="${k}">${label} (${n})</button>`).join('')}</div>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Học sinh</th><th>Trạng thái</th><th>Xem lần đầu</th><th>Nộp lúc</th><th>Điểm</th><th></th></tr></thead>
        <tbody id="rows"></tbody></table></div>
    </div>`;

  const draw = () => {
    const list = students.filter(s => filter === 'all' || (filter === 'overdue' ? s.overdue : s.status === filter));
    document.getElementById('rows').innerHTML = list.length ? list.map((s, i) => `
      <tr class="clickable" data-sid="${s.id}">
        <td class="muted">${i + 1}</td>
        <td><b>${esc(s.full_name)}</b> <span class="muted small">${esc(s.class_name)}</span></td>
        <td>${badge(s.status)}${flags(s)}</td>
        <td class="small">${s.first_viewed_at ? `${fmt(s.first_viewed_at)}<div class="muted">${s.view_count} lần xem</div>` : '<span class="muted">—</span>'}</td>
        <td class="small">${s.submitted_at ? `${fmt(s.submitted_at)}${s.submission_count > 1 ? `<div class="muted">${s.submission_count} lần nộp</div>` : ''}` : '<span class="muted">—</span>'}</td>
        <td><b>${s.score ?? ''}</b></td>
        <td class="nowrap">${s.status === 'submitted' ? '<span class="btn btn-sm">Chấm bài →</span>'
          : s.submission_count ? '<span class="btn btn-sm btn-ghost">Xem bài</span>' : ''}</td>
      </tr>`).join('') : '<tr><td colspan="7" class="empty">Không có học sinh nào</td></tr>';
  };
  draw();

  document.getElementById('chips').onclick = e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    filter = b.dataset.f;
    view.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
    draw();
  };
  document.getElementById('rows').onclick = e => {
    const tr = e.target.closest('tr[data-sid]');
    if (tr) go(`#/gv/nhiem-vu/${t.id}/hs/${tr.dataset.sid}`);
  };
  document.getElementById('del').onclick = async () => {
    const ok = await confirmDialog('Xóa nhiệm vụ?',
      `Nhiệm vụ <b>${esc(t.title)}</b> cùng <b>toàn bộ bài nộp</b> của học sinh sẽ bị xóa vĩnh viễn. Không thể hoàn tác.`, 'Xóa vĩnh viễn', true);
    if (!ok) return;
    await api('DELETE', `/api/tasks/${t.id}`);
    toast('Đã xóa nhiệm vụ');
    go('#/gv/nhiem-vu');
  };
}

// ================================================================ GIÁO VIÊN: xem và chấm bài

function submissionsHtml(subs) {
  if (!subs.length) return '<div class="empty">Chưa có bài nộp.</div>';
  const one = (s, i) => `
    <div class="submission ${i ? 'old' : ''}">
      <div class="submission-head"><b>Lần nộp ${subs.length - i}</b><span>${fmt(s.created_at)}</span>
        ${s.late ? '<span class="badge badge-late">Nộp muộn</span>' : ''}</div>
      ${s.content ? `<div class="rich">${richText(s.content)}</div>` : ''}
      ${filesHtml(s.files)}
    </div>`;
  return one(subs[0], 0) + (subs.length > 1
    ? `<details><summary class="muted small" style="cursor:pointer;margin-bottom:10px">Xem ${subs.length - 1} lần nộp trước</summary>
       ${subs.slice(1).map((s, i) => one(s, i + 1)).join('')}</details>` : '');
}

async function tReview(taskId, sid) {
  setTopbar(true);
  const [d, list] = await Promise.all([
    api('GET', `/api/tasks/${taskId}/students/${sid}`),
    api('GET', `/api/tasks/${taskId}`),
  ]);
  const p = d.progress;
  const order = list.students;
  const idx = order.findIndex(s => s.id === Number(sid));
  const prev = order[idx - 1], next = order[idx + 1];
  const nextPending = order.slice(idx + 1).concat(order.slice(0, idx)).find(s => s.status === 'submitted');
  const hasSub = d.submissions.length > 0;

  view.innerHTML = `
    <a class="back" href="#/gv/nhiem-vu/${taskId}">← ${esc(d.task.title)}</a>
    <div class="page-head">
      <div><h1>${esc(d.student.full_name)} <span class="muted small">${esc(d.student.class_name)}</span></h1>
        <div>${badge(p.status)}${flags(p)}</div></div>
      <div class="actions">
        ${prev ? `<a class="btn btn-ghost btn-sm" href="#/gv/nhiem-vu/${taskId}/hs/${prev.id}">← ${esc(prev.full_name)}</a>` : ''}
        ${next ? `<a class="btn btn-ghost btn-sm" href="#/gv/nhiem-vu/${taskId}/hs/${next.id}">${esc(next.full_name)} →</a>` : ''}
      </div>
    </div>
    <div class="review-grid">
      <div class="card"><h2>Bài làm</h2>${submissionsHtml(d.submissions)}</div>
      <div>
        <div class="card">
          <h3>Thông tin</h3>
          <dl class="kv">
            <dt>Hạn nộp</dt><dd>${d.task.due_at ? fmt(d.task.due_at) : 'Không có'}</dd>
            <dt>Xem lần đầu</dt><dd>${p.first_viewed_at ? fmt(p.first_viewed_at) : '—'}</dd>
            <dt>Xem gần nhất</dt><dd>${p.last_viewed_at ? `${fmt(p.last_viewed_at)} (${p.view_count} lần)` : '—'}</dd>
            <dt>Nộp lúc</dt><dd>${p.submitted_at ? fmt(p.submitted_at) : '—'}</dd>
            <dt>Số lần nộp</dt><dd>${d.submissions.length}</dd>
            ${p.graded_at ? `<dt>${p.status === 'redo' ? 'Trả bài lúc' : 'Chấm lúc'}</dt><dd>${fmt(p.graded_at)}</dd>` : ''}
          </dl>
        </div>
        ${hasSub ? `<form class="card" id="grade">
          <h3>Chấm bài</h3>
          <div class="form-error"></div>
          <div class="field"><label>Điểm</label>
            <input type="text" inputmode="decimal" name="score" value="${p.status === 'graded' && p.score !== null ? p.score : ''}" placeholder="VD: 8.5 (có thể để trống)"></div>
          <div class="field"><label>Nhận xét</label>
            <textarea name="feedback" id="fb" rows="5" placeholder="Nhận xét cho học sinh...">${esc(p.feedback || '')}</textarea>
            <div class="preview-box rich small" id="fb-preview"></div></div>
          <div class="actions">
            <button class="btn btn-success" name="act" value="grade">✓ Lưu chấm điểm</button>
            <button class="btn btn-warn" name="act" value="redo">↺ Yêu cầu làm lại</button>
          </div>
          <div class="hint">"Yêu cầu làm lại": học sinh sẽ thấy nhận xét và phải nộp bài mới.</div>
        </form>` : ''}
        ${nextPending ? `<a class="btn" style="width:100%;justify-content:center"
            href="#/gv/nhiem-vu/${taskId}/hs/${nextPending.id}">Bài chờ chấm tiếp theo: ${esc(nextPending.full_name)} →</a>` : ''}
      </div>
    </div>`;

  const form = document.getElementById('grade');
  if (!form) return;
  attachPreview(document.getElementById('fb'), document.getElementById('fb-preview'));
  onSubmit(form, async (data, submitter) => {
    if (submitter && submitter.value === 'redo') {
      if (!data.feedback.trim()) throw new Error('Hãy ghi nhận xét để học sinh biết cần sửa gì');
      await api('POST', `/api/tasks/${taskId}/students/${sid}/redo`, { feedback: data.feedback });
      toast('Đã yêu cầu học sinh làm lại');
    } else {
      await api('POST', `/api/tasks/${taskId}/students/${sid}/grade`, { score: data.score, feedback: data.feedback });
      toast('Đã lưu chấm điểm');
    }
    render();
  });
}

// ================================================================ GIÁO VIÊN: học sinh

let serverAddress = '';
async function getServerAddress() {
  if (!serverAddress) {
    try {
      const r = await api('GET', '/api/server-info');
      serverAddress = r.addresses[0] || location.origin;
    } catch { serverAddress = location.origin; }
  }
  return serverAddress;
}

async function showCredentials(creds, title = 'Tài khoản học sinh') {
  const addr = await getServerAddress();
  const tsv = ['Họ và tên\tLớp\tTên đăng nhập\tMật khẩu', ...creds.map(c => `${c.full_name}\t${c.class_name}\t${c.username}\t${c.password}`)].join('\n');
  modal(title, `
    <div class="info-box no-print">Mật khẩu <b>chỉ hiển thị một lần</b> - hãy in hoặc sao chép ngay. Học sinh sẽ phải đổi mật khẩu ở lần đăng nhập đầu tiên.</div>
    <p>Địa chỉ truy cập: <b>${esc(addr)}</b></p>
    <div class="table-wrap"><table class="cred-table">
      <thead><tr><th>#</th><th>Họ và tên</th><th>Lớp</th><th>Tên đăng nhập</th><th>Mật khẩu</th></tr></thead>
      <tbody>${creds.map((c, i) => `<tr><td>${i + 1}</td><td>${esc(c.full_name)}</td><td>${esc(c.class_name)}</td>
        <td><code>${esc(c.username)}</code></td><td><code>${esc(c.password)}</code></td></tr>`).join('')}</tbody>
    </table></div>`, [
    { label: '🖨 In', cls: 'btn-ghost', onClick: () => { document.body.classList.add('printing'); window.print(); document.body.classList.remove('printing'); } },
    { label: '📋 Sao chép (dán vào Excel)', cls: 'btn-ghost', onClick: async () => {
      try { await navigator.clipboard.writeText(tsv); toast('Đã sao chép'); } catch { toast('Trình duyệt không cho sao chép, hãy dùng nút In', true); }
    } },
    { label: 'Đóng' },
  ]);
}

// Đọc danh sách dán từ Excel: mỗi dòng "Họ tên<Tab>Lớp", có thể có cột STT ở đầu.
function parseStudentLines(text) {
  return text.split(/\r?\n/).map(line => {
    let cells = line.split('\t').map(s => s.trim()).filter(Boolean);
    if (cells.length === 1 && line.includes(',')) cells = line.split(',').map(s => s.trim()).filter(Boolean);
    if (cells.length && /^\d+\.?$/.test(cells[0])) cells.shift();
    return { full_name: cells[0] || '', class_name: cells[1] || '' };
  }).filter(s => s.full_name && !/^(h[ọo]\s*(v[àa]\s*)?t[êe]n|stt)$/i.test(s.full_name));
}

async function tStudents() {
  setTopbar(true);
  const { students } = await api('GET', '/api/students');
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Học sinh</h1><div class="muted">${students.filter(s => s.active).length} em đang hoạt động</div></div>
      <div class="actions">
        <button class="btn btn-ghost" id="show-bulk">📋 Nhập danh sách từ Excel</button>
        <button class="btn" id="show-add">+ Thêm học sinh</button>
      </div>
    </div>
    <form class="card hidden" id="add-form">
      <h2>Thêm học sinh</h2>
      <div class="form-error"></div>
      <div class="grid-2">
        <div class="field"><label>Họ và tên *</label><input type="text" name="full_name" required></div>
        <div class="field"><label>Lớp</label><input type="text" name="class_name" placeholder="VD: 11A1"></div>
      </div>
      <div class="field"><label>Tên đăng nhập</label><input type="text" name="username" autocapitalize="none" placeholder="Để trống để tự tạo (VD: Nguyễn Văn An → annv)"></div>
      <div class="actions"><button class="btn">Tạo tài khoản</button><button type="button" class="btn btn-ghost" data-close>Hủy</button></div>
    </form>
    <div class="card hidden" id="bulk-box">
      <h2>Nhập danh sách học sinh</h2>
      <p class="muted small" style="margin-top:0">Trong Excel, bôi đen 2 cột <b>Họ và tên</b> và <b>Lớp</b> (có thể kèm cột STT ở đầu), bấm Ctrl+C rồi dán vào ô dưới.
        Hoặc gõ mỗi dòng một em. Tên đăng nhập và mật khẩu sẽ được tạo tự động.</p>
      <textarea id="bulk-text" rows="8" placeholder="Nguyễn Văn An&#9;11A1&#10;Trần Thị Bình&#9;11A2"></textarea>
      <div id="bulk-preview" class="small" style="margin-top:8px"></div>
      <div class="actions" style="margin-top:10px"><button class="btn" id="bulk-go" disabled>Tạo tài khoản</button>
        <button type="button" class="btn btn-ghost" data-close>Hủy</button></div>
    </div>
    <div class="card" id="student-table">
      ${students.length ? `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Họ và tên</th><th>Lớp</th><th>Tên đăng nhập</th><th>Đã nộp</th><th>Quá hạn</th><th>Tình trạng</th><th></th></tr></thead>
        <tbody>${students.map((s, i) => `<tr class="${s.active ? '' : 'inactive'}">
          <td class="muted">${i + 1}</td><td><b>${esc(s.full_name)}</b></td><td>${esc(s.class_name)}</td>
          <td><code>${esc(s.username)}</code></td>
          <td>${s.active ? `${s.done}/${s.assigned}` : ''}</td>
          <td>${s.overdue ? `<span class="badge badge-danger">${s.overdue}</span>` : ''}</td>
          <td>${s.active ? (s.must_change_pw ? '<span class="badge badge-outline">Chưa đăng nhập lần đầu</span>' : '<span class="badge st-graded">Hoạt động</span>')
            : '<span class="badge st-new">Đã khóa</span>'}</td>
          <td class="nowrap small">
            <button class="link-btn" data-act="edit" data-id="${s.id}">Sửa</button> ·
            <button class="link-btn" data-act="reset" data-id="${s.id}">Đặt lại MK</button> ·
            <button class="link-btn" data-act="toggle" data-id="${s.id}">${s.active ? 'Khóa' : 'Mở khóa'}</button> ·
            <button class="link-btn danger" data-act="delete" data-id="${s.id}">Xóa</button>
          </td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">Chưa có học sinh. Bấm "+ Thêm học sinh" hoặc "Nhập danh sách từ Excel".</div>'}
    </div>`;

  const addForm = document.getElementById('add-form');
  const bulkBox = document.getElementById('bulk-box');
  document.getElementById('show-add').onclick = () => { bulkBox.classList.add('hidden'); addForm.classList.remove('hidden'); addForm.full_name.focus(); };
  document.getElementById('show-bulk').onclick = () => { addForm.classList.add('hidden'); bulkBox.classList.remove('hidden'); document.getElementById('bulk-text').focus(); };
  view.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => b.closest('.card').classList.add('hidden'); });

  onSubmit(addForm, async data => {
    const r = await api('POST', '/api/students', data);
    await render();
    showCredentials(r.credentials, 'Đã tạo tài khoản');
  });

  const bulkText = document.getElementById('bulk-text');
  const bulkGo = document.getElementById('bulk-go');
  let parsed = [];
  bulkText.oninput = () => {
    parsed = parseStudentLines(bulkText.value);
    bulkGo.disabled = !parsed.length;
    bulkGo.textContent = parsed.length ? `Tạo ${parsed.length} tài khoản` : 'Tạo tài khoản';
    document.getElementById('bulk-preview').innerHTML = parsed.length
      ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Họ và tên</th><th>Lớp</th></tr></thead><tbody>
        ${parsed.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.full_name)}</td><td>${esc(s.class_name)}</td></tr>`).join('')}</tbody></table></div>` : '';
  };
  bulkGo.onclick = async () => {
    bulkGo.disabled = true;
    try {
      const r = await api('POST', '/api/students/bulk', { students: parsed });
      await render();
      showCredentials(r.credentials, `Đã tạo ${r.credentials.length} tài khoản`);
    } catch (err) {
      toast(err.message, true);
      bulkGo.disabled = false;
    }
  };

  document.getElementById('student-table').addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const s = students.find(x => x.id === Number(b.dataset.id));
    try {
      if (b.dataset.act === 'edit') return editStudent(s);
      if (b.dataset.act === 'reset') {
        if (!await confirmDialog('Đặt lại mật khẩu?', `Tạo mật khẩu mới cho <b>${esc(s.full_name)}</b>. Mật khẩu cũ sẽ không dùng được nữa.`, 'Đặt lại')) return;
        const r = await api('POST', `/api/students/${s.id}/reset-password`);
        await render();
        showCredentials(r.credentials, 'Mật khẩu mới');
      }
      if (b.dataset.act === 'toggle') {
        await api('PUT', `/api/students/${s.id}`, { active: !s.active });
        toast(s.active ? `Đã khóa tài khoản ${s.full_name}` : `Đã mở khóa ${s.full_name}`);
        render();
      }
      if (b.dataset.act === 'delete') {
        if (!await confirmDialog('Xóa học sinh?', `Xóa <b>${esc(s.full_name)}</b> cùng <b>toàn bộ bài nộp</b> của em này. Không thể hoàn tác.
            <br><br><span class="muted small">Nếu chỉ muốn tạm ngừng, hãy dùng "Khóa" để giữ lại dữ liệu.</span>`, 'Xóa vĩnh viễn', true)) return;
        await api('DELETE', `/api/students/${s.id}`);
        toast('Đã xóa học sinh');
        render();
      }
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function editStudent(s) {
  const m = modal('Sửa thông tin học sinh', `
    <form id="edit-f"><div class="form-error"></div>
      <div class="field"><label>Họ và tên</label><input type="text" name="full_name" value="${esc(s.full_name)}" required></div>
      <div class="field"><label>Lớp</label><input type="text" name="class_name" value="${esc(s.class_name)}"></div>
      <div class="field"><label>Tên đăng nhập</label><input type="text" name="username" value="${esc(s.username)}" autocapitalize="none" required></div>
    </form>`, [
    { label: 'Hủy', cls: 'btn-ghost' },
    { label: 'Lưu', onClick: () => m.el.querySelector('#edit-f').requestSubmit() },
  ]);
  onSubmit(m.el.querySelector('#edit-f'), async data => {
    await api('PUT', `/api/students/${s.id}`, data);
    m.close();
    toast('Đã lưu');
    render();
  });
}

// ================================================================ GIÁO VIÊN: bảng tổng hợp

async function tOverview() {
  setTopbar(true);
  const { tasks, students } = await api('GET', '/api/overview');
  const cellHtml = (c, t, s) => {
    if (!c) return '<td class="na" title="Không được giao">—</td>';
    const text = c.status === 'graded' && c.score !== null ? c.score : STATUS[c.status].short;
    return `<td class="cell st-${c.status} ${c.overdue ? 'overdue' : ''}" data-t="${t.id}" data-s="${s.id}"
      title="${esc(s.full_name)} – ${esc(t.title)}: ${STATUS[c.status].label}${c.overdue ? ' (quá hạn)' : ''}${c.late ? ' (nộp muộn)' : ''}">${text}${c.late ? '<sup>M</sup>' : ''}</td>`;
  };
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Bảng tổng hợp</h1><div class="muted">${students.length} học sinh × ${tasks.length} nhiệm vụ</div></div>
      <div class="actions"><a class="btn" href="/api/export.xlsx">⬇ Xuất Excel</a></div>
    </div>
    <div class="card">
      <div class="legend" style="margin-bottom:12px">
        ${Object.entries(STATUS).map(([k, v]) => `<span><span class="badge st-${k}">${v.short}</span> ${v.label}</span>`).join('')}
        <span><span class="badge st-graded">8.5</span> Điểm</span>
        <span><span class="badge" style="box-shadow:inset 0 0 0 2px var(--danger)">&nbsp;</span> Quá hạn chưa nộp</span>
        <span><sup style="color:#86198f">M</sup> Nộp muộn</span><span>— Không giao</span>
      </div>
      ${tasks.length && students.length ? `<div class="table-wrap"><table class="matrix">
        <thead><tr><th class="sticky">Học sinh</th>
          ${tasks.map(t => `<th class="task-col"><a href="#/gv/nhiem-vu/${t.id}" title="${esc(t.title)}">${esc(t.title.length > 40 ? t.title.slice(0, 38) + '…' : t.title)}</a>
            ${t.due_at ? `<div class="muted small" style="font-weight:400">${fmt(t.due_at).split(' ').pop().slice(0, 5)}</div>` : ''}</th>`).join('')}
          <th>Đã nộp</th><th>Quá hạn</th></tr></thead>
        <tbody>${students.map(s => {
          const assigned = s.cells.filter(Boolean);
          const done = assigned.filter(c => c.status === 'submitted' || c.status === 'graded').length;
          const overdue = assigned.filter(c => c.overdue).length;
          return `<tr><td class="sticky"><b>${esc(s.full_name)}</b> <span class="muted small">${esc(s.class_name)}</span></td>
            ${s.cells.map((c, i) => cellHtml(c, tasks[i], s)).join('')}
            <td>${done}/${assigned.length}</td><td>${overdue ? `<span class="badge badge-danger">${overdue}</span>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="empty">Chưa có dữ liệu.</div>'}
    </div>`;
  view.querySelector('.matrix')?.addEventListener('click', e => {
    const td = e.target.closest('td.cell');
    if (td) go(`#/gv/nhiem-vu/${td.dataset.t}/hs/${td.dataset.s}`);
  });
}

// ================================================================ GIÁO VIÊN: cài đặt

async function tSettings() {
  setTopbar(true);
  const info = await api('GET', '/api/server-info');
  view.innerHTML = `
    <h1>Cài đặt</h1>
    <div class="grid-2" style="margin-top:14px">
      <div>
        <div class="card"><h2>Địa chỉ cho học sinh truy cập</h2>
          <p class="muted small" style="margin-top:0">Học sinh mở trình duyệt trên điện thoại hoặc máy tính (ở bất cứ đâu có Internet) và vào:</p>
          ${info.addresses.map(a => `<div style="font-size:1.2rem;font-weight:700;margin:6px 0;word-break:break-all"><code>${esc(a)}</code></div>`).join('')}
        </div>
        <form class="card" id="team-f"><h2>Tên đội tuyển</h2><div class="form-error"></div>
          <div class="field"><input type="text" name="team_name" value="${esc(info.teamName)}" required></div>
          <button class="btn">Lưu</button></form>
      </div>
      <div>
        <div class="card"><h2>Tài khoản giáo viên</h2>
          <p>${esc(state.user.full_name)} — <code>${esc(state.user.username)}</code></p>
          <a class="btn btn-ghost" href="#/doi-mat-khau">Đổi mật khẩu</a></div>
        <div class="card"><h2>Sao lưu dữ liệu</h2>
          <p class="small" style="margin-top:0">Dữ liệu lưu trên Neon Postgres (tài khoản, nhiệm vụ, điểm) và Vercel Blob (ảnh, file).
          Nên xuất báo cáo Excel định kỳ để lưu giữ kết quả.</p>
          <a class="btn btn-ghost" href="/api/export.xlsx">⬇ Xuất báo cáo Excel</a></div>
      </div>
    </div>`;
  onSubmit(document.getElementById('team-f'), async data => {
    await api('PUT', '/api/settings', data);
    state.teamName = data.team_name;
    setTopbar(true);
    toast('Đã lưu');
  });
}

// ================================================================ HỌC SINH: danh sách nhiệm vụ

async function sTaskList() {
  setTopbar(true);
  const { tasks } = await api('GET', '/api/my/tasks');
  const byDue = (a, b) => (a.due_at || '9999').localeCompare(b.due_at || '9999') || b.created_at.localeCompare(a.created_at);
  const todo = tasks.filter(t => ['new', 'viewed', 'redo'].includes(t.status)).sort(byDue);
  const waiting = tasks.filter(t => t.status === 'submitted');
  const graded = tasks.filter(t => t.status === 'graded');
  const overdue = todo.filter(t => t.overdue).length;

  const card = t => `
    <a class="card task-card" href="#/hs/nhiem-vu/${t.id}">
      <div class="title">${esc(t.title)}</div>
      <div class="meta">
        ${badge(t.status, true)}${flags(t)}
        ${t.status === 'graded' && t.score !== null ? `<span><b>Điểm: ${t.score}</b></span>` : ''}
        ${['new', 'viewed', 'redo'].includes(t.status) ? dueHtml(t.due_at) : `<span>Nộp lúc ${fmt(t.submitted_at)}</span>`}
        ${t.file_count ? `<span>📎 ${t.file_count} file</span>` : ''}
      </div>
    </a>`;
  const section = (title, list, emptyText) => `<h2 class="section-title">${title} (${list.length})</h2>
    <div class="task-list">${list.length ? list.map(card).join('') : `<div class="card empty">${emptyText}</div>`}</div>`;

  view.innerHTML = `
    <h1>Chào ${esc(givenName(state.user.full_name))}! 👋</h1>
    <div class="muted">${todo.length ? `Em có <b>${todo.length}</b> nhiệm vụ cần làm${overdue ? `, trong đó <b class="text-danger">${overdue}</b> đã quá hạn` : ''}.`
      : 'Em đã hoàn thành tất cả nhiệm vụ. Rất tốt!'}</div>
    ${section('Cần làm', todo, 'Không có nhiệm vụ nào cần làm 🎉')}
    ${waiting.length ? section('Đã nộp – chờ chấm', waiting, '') : ''}
    ${graded.length ? section('Đã chấm', graded, '') : ''}`;
}

const givenName = n => n.trim().split(/\s+/).pop();

// ================================================================ HỌC SINH: làm nhiệm vụ

async function sTaskDetail(id, silent) {
  setTopbar(true);
  const d = await api('GET', `/api/my/tasks/${id}${silent ? '?silent=1' : ''}`);
  const { task: t, progress: p, submissions: subs } = d;
  const pastDue = t.due_at && new Date(t.due_at).getTime() < Date.now();

  view.innerHTML = `
    <a class="back" href="#/hs/nhiem-vu">← Nhiệm vụ của em</a>
    <h1>${esc(t.title)}</h1>
    <div class="muted small" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      ${badge(p.status, true)}${flags(p)}<span>Giao lúc ${fmt(t.created_at)}</span>${dueHtml(t.due_at)}</div>
    ${p.status === 'redo' ? `<div class="warn-box"><b>↺ Giáo viên yêu cầu em làm lại bài này.</b>
      ${p.feedback ? `<div class="rich" style="margin-top:6px">${richText(p.feedback)}</div>` : ''}</div>` : ''}
    ${p.status === 'graded' ? `<div class="ok-box"><div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
      ${p.score !== null ? `<div><div class="small">Điểm</div><div class="score-big">${p.score}</div></div>` : '<div><b>✓ Bài đã được chấm</b></div>'}
      ${p.feedback ? `<div style="flex:1;min-width:200px"><div class="small">Nhận xét của giáo viên</div><div class="rich">${richText(p.feedback)}</div></div>` : ''}
      </div></div>` : ''}
    <div class="card"><h2>Đề bài</h2>
      ${t.description ? `<div class="rich">${richText(t.description)}</div>` : '<div class="muted">Xem file đính kèm.</div>'}
      ${filesHtml(t.files)}</div>
    ${d.can_submit ? `<form class="card" id="submit-f">
      <h2>${subs.length ? 'Nộp lại bài' : 'Nộp bài'}</h2>
      ${subs.length && p.status === 'submitted' ? '<div class="info-box">Em đã nộp bài. Em vẫn có thể nộp lại khi giáo viên chưa chấm; giáo viên xem được tất cả các lần nộp.</div>' : ''}
      ${pastDue ? '<div class="warn-box">Đã quá hạn nộp. Em vẫn nộp được nhưng bài sẽ bị đánh dấu <b>nộp muộn</b>.</div>' : ''}
      <div class="form-error"></div>
      <div class="field"><label>Bài làm / ghi chú</label>
        <textarea name="content" id="content" rows="6" placeholder="Gõ bài làm, hoặc ghi chú cho giáo viên. Có thể chụp ảnh bài làm trên giấy và đính kèm bên dưới."></textarea>
        <div class="hint">Công thức: <code>$x^2$</code>, <code>$\\frac{a}{b}$</code>, <code>$\\sqrt{x}$</code>.
          <button type="button" class="link-btn small" id="toggle-prev">Xem trước</button></div>
        <div class="preview-box rich hidden" id="content-prev"></div></div>
      <div class="field"><label>Ảnh / file bài làm</label><div id="picker"></div></div>
      <button class="btn">📤 Nộp bài</button>
      <div class="upload-bar hidden" id="bar-wrap"><span id="bar"></span></div>
    </form>` : ''}
    ${subs.length ? `<div class="card"><h2>Bài em đã nộp</h2>${submissionsHtml(subs)}</div>` : ''}`;

  const form = document.getElementById('submit-f');
  if (!form) return;
  const content = document.getElementById('content');
  const prev = document.getElementById('content-prev');
  document.getElementById('toggle-prev').onclick = () => {
    prev.classList.toggle('hidden');
    if (!prev.classList.contains('hidden')) attachPreview(content, prev);
  };
  const picker = filePicker(document.getElementById('picker'), { threshold: 800 * 1024, studentMode: true });
  onSubmit(form, async data => {
    if (!data.content.trim() && !picker.files.length) throw new Error('Em cần gõ bài làm hoặc đính kèm ít nhất một ảnh/file');
    if (!await confirmDialog('Nộp bài?', `${picker.files.length ? `Kèm ${picker.files.length} file. ` : ''}${pastDue ? 'Bài sẽ bị đánh dấu nộp muộn. ' : ''}Em chắc chắn muốn nộp?`, 'Nộp bài')) return;
    document.getElementById('bar-wrap').classList.remove('hidden');
    const files = await uploadFiles(picker.files, document.getElementById('bar'));
    await api('POST', `/api/my/tasks/${id}/submit`, { content: data.content, files });
    toast('Đã nộp bài thành công!');
    await sTaskDetail(id, true);
    typeset();
  });
}

// ================================================================ điều hướng

const routes = [
  { re: /^#\/login$/, fn: viewLogin, open: true },
  { re: /^#\/setup$/, fn: viewSetup, open: true },
  { re: /^#\/doi-mat-khau$/, fn: viewChangePw },
  { re: /^#\/gv\/nhiem-vu$/, fn: tTaskList, role: 'teacher' },
  { re: /^#\/gv\/nhiem-vu\/moi$/, fn: () => tTaskForm(null), role: 'teacher' },
  { re: /^#\/gv\/nhiem-vu\/(\d+)$/, fn: tTaskDetail, role: 'teacher' },
  { re: /^#\/gv\/nhiem-vu\/(\d+)\/sua$/, fn: tTaskForm, role: 'teacher' },
  { re: /^#\/gv\/nhiem-vu\/(\d+)\/hs\/(\d+)$/, fn: tReview, role: 'teacher' },
  { re: /^#\/gv\/hoc-sinh$/, fn: tStudents, role: 'teacher' },
  { re: /^#\/gv\/tong-hop$/, fn: tOverview, role: 'teacher' },
  { re: /^#\/gv\/cai-dat$/, fn: tSettings, role: 'teacher' },
  { re: /^#\/hs\/nhiem-vu$/, fn: sTaskList, role: 'student' },
  { re: /^#\/hs\/nhiem-vu\/(\d+)$/, fn: id => sTaskDetail(id, false), role: 'student' },
];

function home() {
  if (!state.user) return '#/login';
  return state.user.role === 'teacher' ? '#/gv/nhiem-vu' : '#/hs/nhiem-vu';
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

async function render() {
  const hash = location.hash || '#/';
  const route = routes.find(r => r.re.test(hash));
  if (!route) return go(home());
  if (!route.open && !state.user) return go('#/login');
  if (state.user && state.user.must_change_pw && route.fn !== viewChangePw && !route.open) return go('#/doi-mat-khau');
  if (route.role && state.user.role !== route.role) return go(home());
  document.querySelectorAll('.modal-backdrop').forEach(m => m.remove());
  window.scrollTo(0, 0);
  try {
    await route.fn(...hash.match(route.re).slice(1));
    typeset();
  } catch (err) {
    view.innerHTML = `<div class="error-box">${esc(err.message)}</div><a href="${home()}">← Về trang chính</a>`;
  }
}

(async function init() {
  try {
    const me = await api('GET', '/api/me');
    state.user = me.user;
    state.teamName = me.teamName;
    state.storage = me.storage;
  } catch (err) {
    view.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    return;
  }
  window.addEventListener('hashchange', render);
  render();
})();
