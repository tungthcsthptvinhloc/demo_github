'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { get, all, run, tx, databaseHost } = require('./db');
const storage = require('./storage');

const SESSION_DAYS = 30;
const MAX_FILE_MB = 10;
const MAX_FILES = 10;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
// Trên Vercel, nội dung JSON có thể đã được đọc sẵn vào req.body; khi đó không đọc lại.
const jsonParser = express.json({ limit: '1mb' });
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return next();
  jsonParser(req, res, next);
});
// Trên Vercel, thư mục public do CDN phục vụ; dòng này dùng khi chạy thử trên máy.
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------- tiện ích

const now = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const str = (v, max = 1000) => String(v ?? '').trim().slice(0, max);
const toId = v => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) fail(400, 'Mã không hợp lệ');
  return n;
};

async function getSetting(key, fallback = '') {
  const row = await get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}
async function setSetting(key, value) {
  await run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

// Tên gọi đứng cuối trong họ tên tiếng Việt, dùng để sắp xếp danh sách theo tên.
const givenName = fullName => fullName.trim().split(/\s+/).pop() || '';
const byVietnameseName = (a, b) =>
  givenName(a.full_name).localeCompare(givenName(b.full_name), 'vi') ||
  a.full_name.localeCompare(b.full_name, 'vi');

// Máy chủ Vercel chạy giờ UTC nên phải chỉ rõ múi giờ Việt Nam khi xuất Excel.
const fmtTime = iso => iso
  ? new Date(iso).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric',
  })
  : '';

// ---------------------------------------------------------------- kiểm tra kết nối

// Mở https://<địa chỉ>/api/health để xem đã kết nối Neon, Blob và đặt SETUP_CODE chưa (không lộ thông tin bí mật).
// Vùng AWS của Neon -> vùng Vercel gần nhất.
const NEAR_REGION = {
  'ap-southeast-1': 'sin1 (Singapore)', 'ap-southeast-2': 'syd1 (Sydney)', 'ap-northeast-1': 'hnd1 (Tokyo)',
  'ap-south-1': 'bom1 (Mumbai)', 'us-east-1': 'iad1 (Washington)', 'us-east-2': 'cle1 (Cleveland)',
  'us-west-2': 'pdx1 (Portland)', 'eu-central-1': 'fra1 (Frankfurt)', 'eu-west-2': 'lhr1 (London)',
  'sa-east-1': 'gru1 (São Paulo)',
};
const instanceStartedAt = Date.now();
let requestCount = 0;

app.get('/api/health', async (req, res) => {
  const out = {};
  const ms = async fn => { const t = Date.now(); await fn(); return Date.now() - t; };
  try {
    // Lần 1 có thể gồm cả thời gian mở kết nối / đánh thức Neon; lần 2 là độ trễ thật của một truy vấn.
    const first = await ms(() => get('SELECT 1 AS ok'));
    const second = await ms(() => get('SELECT 1 AS ok'));
    out.database = 'ok';
    out.do_tre_csdl_ms = { lan_dau: first, lan_sau: second };
  } catch (err) {
    out.database = 'LỖI: ' + err.message;
  }
  const dbRegion = (databaseHost().match(/\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech$/) || [])[1] || '';
  out.vung_may_chu = process.env.VERCEL_REGION || '(chạy trên máy)';
  out.vung_csdl = dbRegion || '(không rõ)';
  const near = NEAR_REGION[dbRegion];
  if (near && process.env.VERCEL_REGION && !near.startsWith(process.env.VERCEL_REGION)) {
    out.khuyen_nghi = `Máy chủ và CSDL ở xa nhau. Vào Settings → Functions → Function Region, chọn ${near}, rồi Redeploy.`;
  }
  out.may_chu_vua_khoi_dong = ++requestCount === 1 && Date.now() - instanceStartedAt < 15000;
  out.blob = { blob: 'ok', missing: 'LỖI: ' + storage.MISSING_MESSAGE, local: 'chạy thử trên máy (.devdata)' }[storage.MODE];
  out.setup_code = process.env.SETUP_CODE ? 'đã đặt' : (process.env.VERCEL ? 'LỖI: chưa đặt SETUP_CODE' : 'không cần khi chạy thử');
  // Chỉ liệt kê TÊN các biến liên quan (không bao giờ hiện giá trị) để dễ dò lỗi cấu hình.
  out.bien_moi_truong = Object.keys(process.env)
    .filter(k => /BLOB|STORE|READ_WRITE|DATABASE_URL|POSTGRES_URL|SETUP_CODE/.test(k)).sort();
  res.json(out);
});

// ---------------------------------------------------------------- phiên đăng nhập

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const cookieFlags = req => `HttpOnly; SameSite=Lax; Path=/${req.secure ? '; Secure' : ''}`;

async function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await run('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?, ?, ?, ?)', token, userId, now(), expires);
  await run('DELETE FROM sessions WHERE expires_at < ?', now());
  res.setHeader('Set-Cookie', `sid=${token}; ${cookieFlags(req)}; Max-Age=${SESSION_DAYS * 86400}`);
}

app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/files/')) return next();
  const token = parseCookies(req).sid;
  if (token) {
    const user = await get(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`, token, now());
    if (user) {
      req.user = user;
      req.sessionToken = token;
    }
  }
  next();
});

const publicUser = u => ({
  id: u.id, username: u.username, full_name: u.full_name, class_name: u.class_name,
  role: u.role, must_change_pw: !!u.must_change_pw,
});

function requireLogin(req, res, next) {
  if (!req.user) fail(401, 'Bạn cần đăng nhập');
  next();
}
const requireRole = role => (req, res, next) => {
  if (!req.user) fail(401, 'Bạn cần đăng nhập');
  if (role && req.user.role !== role) fail(403, 'Bạn không có quyền thực hiện thao tác này');
  if (req.user.must_change_pw) fail(403, 'Bạn cần đổi mật khẩu trước khi tiếp tục');
  next();
};
const requireTeacher = requireRole('teacher');
const requireStudent = requireRole('student');
const requireActiveUser = requireRole(null);

// ---------------------------------------------------------------- file đính kèm

// Danh sách file trình duyệt gửi kèm sau khi đã tải lên kho: [{ url, name, size, type }]
function readFilesInput(list, user) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) fail(400, 'Danh sách file không hợp lệ');
  if (list.length > MAX_FILES) fail(400, `Tối đa ${MAX_FILES} file mỗi lần`);
  const prefix = storage.uploadPrefix(user);
  return list.map(f => {
    if (!f || !storage.isOwnFileUrl(f.url, prefix)) fail(400, 'File đính kèm không hợp lệ, vui lòng tải lại');
    const size = Number(f.size) || 0;
    if (size > MAX_FILE_MB * 1024 * 1024) fail(400, `Mỗi file tối đa ${MAX_FILE_MB} MB`);
    return { url: f.url, name: str(f.name, 255) || 'file', size, type: str(f.type, 100) };
  });
}

async function saveFiles(q, ownerType, ownerId, files) {
  for (const f of files) {
    await q.run(`INSERT INTO files(owner_type, owner_id, orig_name, url, mime, size, created_at)
                 VALUES(?, ?, ?, ?, ?, ?, ?)`, ownerType, ownerId, f.name, f.url, f.type, f.size, now());
  }
}

function filesOf(ownerType, ownerId) {
  return all('SELECT id, orig_name, mime, size FROM files WHERE owner_type = ? AND owner_id = ? ORDER BY id', ownerType, ownerId);
}

// Cấp "vé" để trình duyệt tải file thẳng lên Vercel Blob.
app.post('/api/upload', async (req, res) => {
  if (storage.MODE === 'missing') fail(503, storage.MISSING_MESSAGE);
  if (storage.MODE !== 'blob') fail(404, 'Không tìm thấy');
  const { handleUpload } = require('@vercel/blob/client');
  const body = req.body || {};
  if (body.type !== 'blob.generate-client-token') fail(400, 'Yêu cầu không hợp lệ');
  if (!req.user) fail(401, 'Bạn cần đăng nhập');
  if (req.user.must_change_pw) fail(403, 'Bạn cần đổi mật khẩu trước khi tiếp tục');
  const user = req.user;
  const result = await handleUpload({
    token: storage.BLOB_TOKEN,
    body,
    request: req,
    onBeforeGenerateToken: async pathname => {
      if (typeof pathname !== 'string' || !pathname.startsWith(storage.uploadPrefix(user)) || pathname.includes('..')) {
        fail(403, 'Đường dẫn file không hợp lệ');
      }
      return { maximumSizeInBytes: MAX_FILE_MB * 1024 * 1024, addRandomSuffix: true };
    },
  });
  res.json(result);
});

// Bản chạy thử trên máy: nhận file qua máy chủ và lưu vào ổ đĩa.
if (storage.MODE === 'local') {
  const multer = require('multer');
  const fs = require('fs');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 } });
  app.post('/api/dev-upload', requireActiveUser, upload.single('file'), (req, res) => {
    if (!req.file) fail(400, 'Thiếu file');
    const pathname = String(req.body.pathname || '');
    if (!pathname.startsWith(storage.uploadPrefix(req.user)) || pathname.includes('..')) fail(403, 'Đường dẫn file không hợp lệ');
    const ext = path.extname(pathname);
    const stored = `${pathname.slice(0, pathname.length - ext.length)}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    const target = path.join(storage.LOCAL_DIR, stored);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, req.file.buffer);
    res.json({ url: storage.LOCAL_PREFIX + stored, pathname: stored });
  });
  app.use(storage.LOCAL_PREFIX, express.static(storage.LOCAL_DIR));
}

// ---------------------------------------------------------------- trạng thái nhiệm vụ

// new: chưa xem | viewed: đã xem, chưa làm | submitted: đã nộp | graded: đã chấm | redo: phải làm lại
function statusOf(p) {
  if (p && p.status) return p.status;
  return p && p.first_viewed_at ? 'viewed' : 'new';
}
const isOverdue = (status, task) =>
  !!task.due_at && ['new', 'viewed', 'redo'].includes(status) && task.due_at < now();

async function isAssigned(taskId, studentId) {
  return !!await get(
    `SELECT 1 AS ok FROM tasks t JOIN users u ON u.id = ? AND u.role = 'student' AND u.active = 1
     WHERE t.id = ? AND (t.assign_all = 1 OR EXISTS (
       SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.student_id = u.id))`,
    studentId, taskId);
}

// Nạp toàn bộ dữ liệu giao việc vào bộ nhớ (đội tuyển nhỏ nên rất nhanh).
async function loadMatrix() {
  const [students, tasks, assignees, progressRows, subRows] = await Promise.all([
    all(`SELECT id, username, full_name, class_name FROM users WHERE role = 'student' AND active = 1`),
    all('SELECT * FROM tasks ORDER BY created_at DESC, id DESC'),
    all('SELECT task_id, student_id FROM task_assignees'),
    all('SELECT * FROM progress'),
    all('SELECT task_id, student_id, COUNT(*)::int AS n FROM submissions GROUP BY task_id, student_id'),
  ]);
  students.sort(byVietnameseName);
  const assigned = new Set(assignees.map(r => `${r.task_id}:${r.student_id}`));
  const progress = new Map(progressRows.map(p => [`${p.task_id}:${p.student_id}`, p]));
  const subCounts = new Map(subRows.map(r => [`${r.task_id}:${r.student_id}`, r.n]));
  return {
    students,
    tasks,
    isAssigned: (t, s) => t.assign_all === 1 || assigned.has(`${t.id}:${s.id}`),
    cell(t, s) {
      const p = progress.get(`${t.id}:${s.id}`) || null;
      const status = statusOf(p);
      return {
        status,
        overdue: isOverdue(status, t),
        late: !!(p && p.late),
        first_viewed_at: p ? p.first_viewed_at : null,
        last_viewed_at: p ? p.last_viewed_at : null,
        view_count: p ? p.view_count : 0,
        submitted_at: p ? p.submitted_at : null,
        score: p ? p.score : null,
        feedback: p ? p.feedback : null,
        submission_count: subCounts.get(`${t.id}:${s.id}`) || 0,
      };
    },
  };
}

function taskCounts(m, t) {
  const c = { total: 0, new: 0, viewed: 0, submitted: 0, graded: 0, redo: 0, overdue: 0, late: 0 };
  for (const s of m.students) {
    if (!m.isAssigned(t, s)) continue;
    const cell = m.cell(t, s);
    c.total++;
    c[cell.status]++;
    if (cell.overdue) c.overdue++;
    if (cell.late) c.late++;
  }
  return c;
}

const STATUS_LABEL = {
  new: 'Chưa xem', viewed: 'Đã xem - chưa làm', submitted: 'Đã nộp', graded: 'Đã chấm', redo: 'Cần làm lại',
};

// ---------------------------------------------------------------- tài khoản

const teacherExists = async () => !!await get("SELECT 1 AS ok FROM users WHERE role = 'teacher'");
// Trên Vercel bắt buộc có mã khởi tạo, để người lạ không chiếm quyền giáo viên trước khi thầy/cô tạo tài khoản.
const setupCodeRequired = () => !!(process.env.SETUP_CODE || process.env.VERCEL);
const validUsername = u => /^[a-z0-9._]{3,30}$/.test(u);
const validPassword = p => typeof p === 'string' && p.length >= 6 && p.length <= 100;
const hash = p => bcrypt.hashSync(p, 10);
const genPassword = () => String(crypto.randomInt(100000, 1000000));
const normUsername = u => str(u, 30).toLowerCase();

function makeUsername(fullName, taken) {
  const parts = stripDiacritics(fullName).toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
  // "Nguyễn Văn An" -> "annv"
  const base = (parts.length ? parts[parts.length - 1] + parts.slice(0, -1).map(p => p[0]).join('') : 'hocsinh').slice(0, 24);
  let name = base.length >= 3 ? base : base + 'hs';
  for (let i = 2; taken.has(name); i++) name = base + i;
  taken.add(name);
  return name;
}

app.get('/api/setup-status', async (req, res) => {
  res.json({ needsSetup: !await teacherExists(), needsSetupCode: setupCodeRequired(), teamName: await getSetting('team_name') });
});

app.post('/api/setup', async (req, res) => {
  if (await teacherExists()) fail(400, 'Đã có tài khoản giáo viên');
  if (setupCodeRequired()) {
    if (!process.env.SETUP_CODE) fail(400, 'Chưa đặt biến môi trường SETUP_CODE trên Vercel (xem hướng dẫn)');
    const given = Buffer.from(String(req.body.setup_code || ''));
    const expected = Buffer.from(process.env.SETUP_CODE);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) fail(403, 'Mã khởi tạo không đúng');
  }
  const username = normUsername(req.body.username);
  const fullName = str(req.body.full_name, 100);
  if (!validUsername(username)) fail(400, 'Tên đăng nhập 3-30 ký tự, chỉ gồm chữ không dấu, số, dấu chấm hoặc gạch dưới');
  if (!fullName) fail(400, 'Vui lòng nhập họ tên');
  if (!validPassword(req.body.password)) fail(400, 'Mật khẩu phải có ít nhất 6 ký tự');
  const [user] = await run(`INSERT INTO users(username, password_hash, full_name, role, created_at)
                            VALUES(?, ?, ?, 'teacher', ?) RETURNING *`, username, hash(req.body.password), fullName, now());
  await setSetting('team_name', str(req.body.team_name, 150) || 'Đội tuyển học sinh giỏi');
  await createSession(req, res, user.id);
  res.json({ user: publicUser(user) });
});

// Đếm số lần đăng nhập sai (trong bộ nhớ của từng phiên bản máy chủ).
const loginFails = new Map();
app.post('/api/login', async (req, res) => {
  const username = normUsername(req.body.username);
  const key = `${req.ip}|${username}`;
  const rec = loginFails.get(key);
  if (rec && rec.count >= 8 && Date.now() - rec.first < 10 * 60e3) {
    fail(429, 'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 10 phút hoặc nhờ giáo viên đặt lại mật khẩu.');
  }
  const user = await get('SELECT * FROM users WHERE username = ?', username);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    const r = rec && Date.now() - rec.first < 10 * 60e3 ? rec : { count: 0, first: Date.now() };
    r.count++;
    loginFails.set(key, r);
    fail(401, 'Sai tên đăng nhập hoặc mật khẩu');
  }
  if (!user.active) fail(403, 'Tài khoản đã bị khóa. Vui lòng liên hệ giáo viên.');
  loginFails.delete(key);
  await createSession(req, res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', async (req, res) => {
  if (req.sessionToken) await run('DELETE FROM sessions WHERE token = ?', req.sessionToken);
  res.setHeader('Set-Cookie', `sid=; ${cookieFlags(req)}; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  res.json({
    user: req.user ? publicUser(req.user) : null,
    teamName: await getSetting('team_name'),
    storage: storage.MODE,
    storageMessage: storage.MODE === 'missing' ? storage.MISSING_MESSAGE : '',
    maxFileMB: MAX_FILE_MB,
  });
});

app.post('/api/change-password', requireLogin, async (req, res) => {
  if (!bcrypt.compareSync(String(req.body.old_password || ''), req.user.password_hash)) fail(400, 'Mật khẩu hiện tại không đúng');
  if (!validPassword(req.body.new_password)) fail(400, 'Mật khẩu mới phải có ít nhất 6 ký tự');
  if (req.body.new_password === req.body.old_password) fail(400, 'Mật khẩu mới phải khác mật khẩu cũ');
  await run('UPDATE users SET password_hash = ?, must_change_pw = 0 WHERE id = ?', hash(req.body.new_password), req.user.id);
  await run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', req.user.id, req.sessionToken);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- giáo viên: cài đặt

app.get('/api/server-info', requireTeacher, async (req, res) => {
  res.json({ addresses: [`${req.protocol}://${req.get('host')}`], teamName: await getSetting('team_name') });
});

app.put('/api/settings', requireTeacher, async (req, res) => {
  const teamName = str(req.body.team_name, 150);
  if (!teamName) fail(400, 'Vui lòng nhập tên đội tuyển');
  await setSetting('team_name', teamName);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- giáo viên: học sinh

app.get('/api/students', requireTeacher, async (req, res) => {
  const m = await loadMatrix();
  const users = (await all("SELECT * FROM users WHERE role = 'student'")).sort(byVietnameseName);
  const rows = users.map(u => {
    const stat = { assigned: 0, done: 0, overdue: 0 };
    if (u.active) {
      for (const t of m.tasks) {
        if (!m.isAssigned(t, u)) continue;
        const c = m.cell(t, u);
        stat.assigned++;
        if (c.status === 'submitted' || c.status === 'graded') stat.done++;
        if (c.overdue) stat.overdue++;
      }
    }
    return { ...publicUser(u), active: !!u.active, created_at: u.created_at, ...stat };
  });
  res.json({ students: rows });
});

async function createStudents(list) {
  const taken = new Set((await all('SELECT username FROM users')).map(r => r.username));
  const prepared = list.map(s => {
    const fullName = str(s.full_name, 100);
    if (!fullName) fail(400, 'Vui lòng nhập họ tên học sinh');
    let username = normUsername(s.username);
    if (username) {
      if (!validUsername(username)) fail(400, `Tên đăng nhập "${username}" không hợp lệ`);
      if (taken.has(username)) fail(400, `Tên đăng nhập "${username}" đã tồn tại`);
      taken.add(username);
    } else {
      username = makeUsername(fullName, taken);
    }
    return { full_name: fullName, class_name: str(s.class_name, 50), username, password: genPassword() };
  });
  await tx(async q => {
    for (const c of prepared) {
      await q.run(`INSERT INTO users(username, password_hash, full_name, class_name, role, must_change_pw, created_at)
                   VALUES(?, ?, ?, ?, 'student', 1, ?)`, c.username, hash(c.password), c.full_name, c.class_name, now());
    }
  });
  return prepared;
}

app.post('/api/students', requireTeacher, async (req, res) => {
  res.json({ credentials: await createStudents([req.body]) });
});

app.post('/api/students/bulk', requireTeacher, async (req, res) => {
  const list = Array.isArray(req.body.students) ? req.body.students.slice(0, 200) : [];
  if (!list.length) fail(400, 'Danh sách trống');
  res.json({ credentials: await createStudents(list.map(s => ({ full_name: s.full_name, class_name: s.class_name }))) });
});

async function loadStudent(id) {
  const s = await get("SELECT * FROM users WHERE id = ? AND role = 'student'", toId(id));
  if (!s) fail(404, 'Không tìm thấy học sinh');
  return s;
}

app.put('/api/students/:id', requireTeacher, async (req, res) => {
  const s = await loadStudent(req.params.id);
  const fullName = str(req.body.full_name ?? s.full_name, 100);
  const className = str(req.body.class_name ?? s.class_name, 50);
  const username = normUsername(req.body.username ?? s.username);
  const active = req.body.active === undefined ? s.active : (req.body.active ? 1 : 0);
  if (!fullName) fail(400, 'Vui lòng nhập họ tên');
  if (!validUsername(username)) fail(400, 'Tên đăng nhập 3-30 ký tự, chỉ gồm chữ không dấu, số, dấu chấm hoặc gạch dưới');
  if (await get('SELECT 1 AS ok FROM users WHERE username = ? AND id <> ?', username, s.id)) fail(400, 'Tên đăng nhập đã tồn tại');
  await run('UPDATE users SET full_name = ?, class_name = ?, username = ?, active = ? WHERE id = ?',
    fullName, className, username, active, s.id);
  if (!active) await run('DELETE FROM sessions WHERE user_id = ?', s.id);
  res.json({ ok: true });
});

app.post('/api/students/:id/reset-password', requireTeacher, async (req, res) => {
  const s = await loadStudent(req.params.id);
  const password = genPassword();
  await run('UPDATE users SET password_hash = ?, must_change_pw = 1 WHERE id = ?', hash(password), s.id);
  await run('DELETE FROM sessions WHERE user_id = ?', s.id);
  loginFails.forEach((v, k) => { if (k.endsWith('|' + s.username)) loginFails.delete(k); });
  res.json({ credentials: [{ full_name: s.full_name, class_name: s.class_name, username: s.username, password }] });
});

app.delete('/api/students/:id', requireTeacher, async (req, res) => {
  const s = await loadStudent(req.params.id);
  const urls = await tx(async q => {
    const files = await q.all(`SELECT f.id, f.url FROM files f JOIN submissions sub ON f.owner_type = 'submission' AND f.owner_id = sub.id
                               WHERE sub.student_id = ?`, s.id);
    for (const f of files) await q.run('DELETE FROM files WHERE id = ?', f.id);
    await q.run('DELETE FROM users WHERE id = ?', s.id);
    return files.map(f => f.url);
  });
  await storage.removeFiles(urls);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- giáo viên: nhiệm vụ

async function loadTask(id) {
  const t = await get('SELECT * FROM tasks WHERE id = ?', toId(id));
  if (!t) fail(404, 'Không tìm thấy nhiệm vụ');
  return t;
}

function readTaskForm(body) {
  const title = str(body.title, 200);
  if (!title) fail(400, 'Vui lòng nhập tên nhiệm vụ');
  let dueAt = null;
  if (str(body.due_at)) {
    const d = new Date(body.due_at);
    if (Number.isNaN(d.getTime())) fail(400, 'Hạn nộp không hợp lệ');
    dueAt = d.toISOString();
  }
  const assignAll = body.assign_all === false || String(body.assign_all) === '0' ? 0 : 1;
  const studentIds = assignAll ? [] : (Array.isArray(body.student_ids) ? body.student_ids : []).map(Number).filter(Number.isInteger);
  if (!assignAll && !studentIds.length) fail(400, 'Vui lòng chọn ít nhất một học sinh');
  return { title, description: str(body.description, 20000), dueAt, assignAll, studentIds };
}

async function saveAssignees(q, taskId, form) {
  await q.run('DELETE FROM task_assignees WHERE task_id = ?', taskId);
  for (const sid of form.studentIds) {
    await q.run(`INSERT INTO task_assignees(task_id, student_id)
                 SELECT ?, id FROM users WHERE id = ? AND role = 'student' ON CONFLICT DO NOTHING`, taskId, sid);
  }
}

app.get('/api/tasks', requireTeacher, async (req, res) => {
  const [m, fileRows] = await Promise.all([
    loadMatrix(),
    all("SELECT owner_id, COUNT(*)::int AS n FROM files WHERE owner_type = 'task' GROUP BY owner_id"),
  ]);
  const fileCounts = new Map(fileRows.map(r => [r.owner_id, r.n]));
  res.json({
    tasks: m.tasks.map(t => ({
      id: t.id, title: t.title, due_at: t.due_at, assign_all: !!t.assign_all, created_at: t.created_at,
      file_count: fileCounts.get(t.id) || 0, counts: taskCounts(m, t),
    })),
  });
});

app.post('/api/tasks', requireTeacher, async (req, res) => {
  const form = readTaskForm(req.body);
  const files = readFilesInput(req.body.files, req.user);
  const id = await tx(async q => {
    const [t] = await q.run(`INSERT INTO tasks(title, description, due_at, assign_all, created_at, updated_at)
                             VALUES(?, ?, ?, ?, ?, ?) RETURNING id`,
      form.title, form.description, form.dueAt, form.assignAll, now(), now());
    await saveAssignees(q, t.id, form);
    await saveFiles(q, 'task', t.id, files);
    return t.id;
  });
  res.json({ id });
});

app.put('/api/tasks/:id', requireTeacher, async (req, res) => {
  const t = await loadTask(req.params.id);
  const form = readTaskForm(req.body);
  const files = readFilesInput(req.body.files, req.user);
  const removeIds = (Array.isArray(req.body.remove_file_ids) ? req.body.remove_file_ids : []).map(Number);
  const removed = await tx(async q => {
    await q.run('UPDATE tasks SET title = ?, description = ?, due_at = ?, assign_all = ?, updated_at = ? WHERE id = ?',
      form.title, form.description, form.dueAt, form.assignAll, now(), t.id);
    await saveAssignees(q, t.id, form);
    const old = (await q.all("SELECT id, url FROM files WHERE owner_type = 'task' AND owner_id = ?", t.id))
      .filter(f => removeIds.includes(f.id));
    for (const f of old) await q.run('DELETE FROM files WHERE id = ?', f.id);
    await saveFiles(q, 'task', t.id, files);
    return old.map(f => f.url);
  });
  await storage.removeFiles(removed);
  res.json({ id: t.id });
});

app.delete('/api/tasks/:id', requireTeacher, async (req, res) => {
  const t = await loadTask(req.params.id);
  const urls = await tx(async q => {
    const files = [
      ...await q.all("SELECT id, url FROM files WHERE owner_type = 'task' AND owner_id = ?", t.id),
      ...await q.all(`SELECT f.id, f.url FROM files f JOIN submissions sub ON f.owner_type = 'submission' AND f.owner_id = sub.id
                      WHERE sub.task_id = ?`, t.id),
    ];
    for (const f of files) await q.run('DELETE FROM files WHERE id = ?', f.id);
    await q.run('DELETE FROM tasks WHERE id = ?', t.id);
    return files.map(f => f.url);
  });
  await storage.removeFiles(urls);
  res.json({ ok: true });
});

app.get('/api/tasks/:id', requireTeacher, async (req, res) => {
  const t = await loadTask(req.params.id);
  const [m, files, assignees] = await Promise.all([
    loadMatrix(),
    filesOf('task', t.id),
    all('SELECT student_id FROM task_assignees WHERE task_id = ?', t.id),
  ]);
  const task = m.tasks.find(x => x.id === t.id);
  res.json({
    task: { ...task, assign_all: !!task.assign_all, files, counts: taskCounts(m, task) },
    assignee_ids: assignees.map(r => r.student_id),
    students: m.students.filter(s => m.isAssigned(task, s)).map(s => ({ ...s, ...m.cell(task, s) })),
  });
});

async function submissionsOf(taskId, studentId) {
  const subs = await all('SELECT id, content, late, created_at FROM submissions WHERE task_id = ? AND student_id = ? ORDER BY id DESC',
    taskId, studentId);
  const files = subs.length
    ? await all(`SELECT id, owner_id, orig_name, mime, size FROM files WHERE owner_type = 'submission'
                 AND owner_id IN (${subs.map(() => '?').join(',')}) ORDER BY id`, ...subs.map(s => s.id))
    : [];
  return subs.map(s => ({ ...s, late: !!s.late, files: files.filter(f => f.owner_id === s.id) }));
}

async function progressOf(task, studentId) {
  const p = await get('SELECT * FROM progress WHERE task_id = ? AND student_id = ?', task.id, studentId) || null;
  const status = statusOf(p);
  return {
    status,
    overdue: isOverdue(status, task),
    late: !!(p && p.late),
    first_viewed_at: p ? p.first_viewed_at : null,
    last_viewed_at: p ? p.last_viewed_at : null,
    view_count: p ? p.view_count : 0,
    submitted_at: p ? p.submitted_at : null,
    score: p ? p.score : null,
    feedback: p ? p.feedback : null,
    graded_at: p ? p.graded_at : null,
  };
}

app.get('/api/tasks/:id/students/:sid', requireTeacher, async (req, res) => {
  const t = await loadTask(req.params.id);
  const s = await loadStudent(req.params.sid);
  res.json({
    task: { id: t.id, title: t.title, due_at: t.due_at },
    student: publicUser(s),
    progress: await progressOf(t, s.id),
    submissions: await submissionsOf(t.id, s.id),
  });
});

const ensureProgressRow = (q, taskId, studentId) =>
  q.run('INSERT INTO progress(task_id, student_id) VALUES(?, ?) ON CONFLICT DO NOTHING', taskId, studentId);

app.post('/api/tasks/:id/students/:sid/grade', requireTeacher, async (req, res) => {
  const t = await loadTask(req.params.id);
  const s = await loadStudent(req.params.sid);
  if (!await get('SELECT 1 AS ok FROM submissions WHERE task_id = ? AND student_id = ?', t.id, s.id)) fail(400, 'Học sinh chưa nộp bài');
  let score = null;
  if (req.body.score !== null && req.body.score !== undefined && String(req.body.score).trim() !== '') {
    score = Number(String(req.body.score).replace(',', '.'));
    if (!Number.isFinite(score) || score < 0 || score > 100) fail(400, 'Điểm không hợp lệ');
  }
  await tx(async q => {
    await ensureProgressRow(q, t.id, s.id);
    await q.run(`UPDATE progress SET status = 'graded', score = ?, feedback = ?, graded_at = ? WHERE task_id = ? AND student_id = ?`,
      score, str(req.body.feedback, 5000), now(), t.id, s.id);
  });
  res.json({ ok: true });
});

app.post('/api/tasks/:id/students/:sid/redo', requireTeacher, async (req, res) => {
  const t = await loadTask(req.params.id);
  const s = await loadStudent(req.params.sid);
  if (!await get('SELECT 1 AS ok FROM submissions WHERE task_id = ? AND student_id = ?', t.id, s.id)) fail(400, 'Học sinh chưa nộp bài');
  await tx(async q => {
    await ensureProgressRow(q, t.id, s.id);
    await q.run(`UPDATE progress SET status = 'redo', score = NULL, feedback = ?, graded_at = ? WHERE task_id = ? AND student_id = ?`,
      str(req.body.feedback, 5000), now(), t.id, s.id);
  });
  res.json({ ok: true });
});

app.get('/api/overview', requireTeacher, async (req, res) => {
  const m = await loadMatrix();
  const tasks = [...m.tasks].reverse(); // cũ -> mới, đọc từ trái sang phải
  res.json({
    tasks: tasks.map(t => ({ id: t.id, title: t.title, due_at: t.due_at })),
    students: m.students.map(s => ({
      ...s,
      cells: tasks.map(t => {
        if (!m.isAssigned(t, s)) return null;
        const c = m.cell(t, s);
        return { status: c.status, overdue: c.overdue, late: c.late, score: c.score };
      }),
    })),
  });
});

// ---------------------------------------------------------------- giáo viên: xuất Excel

const STATUS_FILL = { new: 'FFE5E7EB', viewed: 'FFFEF3C7', submitted: 'FFDBEAFE', graded: 'FFD1FAE5', redo: 'FFFFEDD5' };

app.get('/api/export.xlsx', requireTeacher, async (req, res) => {
  const m = await loadMatrix();
  const teamName = await getSetting('team_name');
  const tasks = [...m.tasks].reverse();
  // Nạp ExcelJS khi cần (mất ~0,7 giây) thay vì ở mỗi lần máy chủ khởi động.
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Quản lý nhiệm vụ HSG';
  wb.created = new Date();

  const ws = wb.addWorksheet('Tổng hợp', { views: [{ state: 'frozen', xSplit: 3, ySplit: 3 }] });
  ws.getCell('A1').value = `${teamName} - Tổng hợp thực hiện nhiệm vụ (xuất lúc ${fmtTime(now())})`;
  ws.getCell('A1').font = { bold: true, size: 13 };
  const header = ['STT', 'Họ và tên', 'Lớp', ...tasks.map(t => t.title + (t.due_at ? `\n(hạn ${fmtTime(t.due_at)})` : '')),
    'Đã nộp / được giao', 'Quá hạn chưa nộp', 'Điểm TB'];
  const hr = ws.getRow(3);
  hr.values = header;
  hr.font = { bold: true };
  hr.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
  hr.height = 45;
  ws.getColumn(1).width = 5;
  ws.getColumn(2).width = 26;
  ws.getColumn(3).width = 8;
  tasks.forEach((t, i) => { ws.getColumn(4 + i).width = 16; });
  ws.getColumn(4 + tasks.length).width = 12;
  ws.getColumn(5 + tasks.length).width = 11;
  ws.getColumn(6 + tasks.length).width = 9;

  m.students.forEach((s, idx) => {
    const row = ws.getRow(4 + idx);
    let assigned = 0, done = 0, overdue = 0;
    const scores = [];
    row.getCell(1).value = idx + 1;
    row.getCell(2).value = s.full_name;
    row.getCell(3).value = s.class_name;
    tasks.forEach((t, i) => {
      const cell = row.getCell(4 + i);
      cell.alignment = { horizontal: 'center' };
      if (!m.isAssigned(t, s)) { cell.value = '—'; return; }
      const c = m.cell(t, s);
      assigned++;
      if (c.status === 'submitted' || c.status === 'graded') done++;
      if (c.overdue) overdue++;
      if (c.status === 'graded' && c.score !== null) scores.push(c.score);
      let text = c.status === 'graded' && c.score !== null ? String(c.score) : STATUS_LABEL[c.status];
      if (c.late) text += ' (muộn)';
      if (c.overdue) text += ' - quá hạn';
      cell.value = text;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.overdue ? 'FFFECACA' : STATUS_FILL[c.status] } };
    });
    row.getCell(4 + tasks.length).value = `${done}/${assigned}`;
    row.getCell(5 + tasks.length).value = overdue;
    row.getCell(6 + tasks.length).value = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 100) / 100 : '';
    [4, 5, 6].forEach(k => { row.getCell(k + tasks.length).alignment = { horizontal: 'center' }; });
  });
  const lastRow = 3 + m.students.length;
  for (let r = 3; r <= lastRow; r++) {
    for (let c = 1; c <= header.length; c++) {
      ws.getRow(r).getCell(c).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    }
  }

  const wd = wb.addWorksheet('Chi tiết', { views: [{ state: 'frozen', ySplit: 1 }] });
  wd.columns = [
    { header: 'STT', width: 5 }, { header: 'Nhiệm vụ', width: 30 }, { header: 'Hạn nộp', width: 17 },
    { header: 'Học sinh', width: 24 }, { header: 'Lớp', width: 8 }, { header: 'Trạng thái', width: 18 },
    { header: 'Xem lần đầu', width: 17 }, { header: 'Số lần xem', width: 10 }, { header: 'Nộp lúc', width: 17 },
    { header: 'Nộp muộn', width: 10 }, { header: 'Số lần nộp', width: 10 }, { header: 'Điểm', width: 8 },
    { header: 'Nhận xét', width: 40 },
  ];
  wd.getRow(1).font = { bold: true };
  let n = 0;
  for (const t of tasks) {
    for (const s of m.students) {
      if (!m.isAssigned(t, s)) continue;
      const c = m.cell(t, s);
      const row = wd.addRow([++n, t.title, fmtTime(t.due_at), s.full_name, s.class_name,
        STATUS_LABEL[c.status] + (c.overdue ? ' (quá hạn)' : ''), fmtTime(c.first_viewed_at), c.view_count,
        fmtTime(c.submitted_at), c.late ? 'Có' : '', c.submission_count, c.score ?? '', c.feedback || '']);
      row.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.overdue ? 'FFFECACA' : STATUS_FILL[c.status] } };
    }
  }

  const stamp = fmtTime(now()).split(' ').pop().replace(/\//g, '-');
  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`Tong-hop-nhiem-vu_${stamp}.xlsx`)}`);
  res.send(Buffer.from(buffer));
});

// ---------------------------------------------------------------- học sinh

app.get('/api/my/tasks', requireStudent, async (req, res) => {
  const [m, fileRows] = await Promise.all([
    loadMatrix(),
    all("SELECT owner_id, COUNT(*)::int AS n FROM files WHERE owner_type = 'task' GROUP BY owner_id"),
  ]);
  const fileCounts = new Map(fileRows.map(r => [r.owner_id, r.n]));
  const me = m.students.find(s => s.id === req.user.id);
  const tasks = me ? m.tasks.filter(t => m.isAssigned(t, me)).map(t => {
    const c = m.cell(t, me);
    return {
      id: t.id, title: t.title, due_at: t.due_at, created_at: t.created_at, file_count: fileCounts.get(t.id) || 0,
      status: c.status, overdue: c.overdue, late: c.late, score: c.score, submitted_at: c.submitted_at,
    };
  }) : [];
  res.json({ tasks });
});

async function loadMyTask(req) {
  const t = await loadTask(req.params.id);
  if (!await isAssigned(t.id, req.user.id)) fail(404, 'Không tìm thấy nhiệm vụ');
  return t;
}

app.get('/api/my/tasks/:id', requireStudent, async (req, res) => {
  const t = await loadMyTask(req);
  // Ghi nhận "đã xem" tự động khi học sinh mở nhiệm vụ (silent: tải lại sau khi nộp, không tính thêm lượt xem).
  if (!req.query.silent) {
    const ts = now();
    await run(`INSERT INTO progress(task_id, student_id, first_viewed_at, last_viewed_at, view_count) VALUES(?, ?, ?, ?, 1)
               ON CONFLICT (task_id, student_id) DO UPDATE SET
                 first_viewed_at = COALESCE(progress.first_viewed_at, excluded.first_viewed_at),
                 last_viewed_at = excluded.last_viewed_at, view_count = progress.view_count + 1`,
    t.id, req.user.id, ts, ts);
  }
  const [progress, files, submissions] = await Promise.all([
    progressOf(t, req.user.id), filesOf('task', t.id), submissionsOf(t.id, req.user.id),
  ]);
  res.json({
    task: { id: t.id, title: t.title, description: t.description, due_at: t.due_at, created_at: t.created_at, files },
    progress,
    submissions,
    can_submit: progress.status !== 'graded',
  });
});

app.post('/api/my/tasks/:id/submit', requireStudent, async (req, res) => {
  const t = await loadMyTask(req);
  const progress = await progressOf(t, req.user.id);
  if (progress.status === 'graded') fail(400, 'Bài đã được chấm, không thể nộp lại');
  const content = str(req.body.content, 20000);
  const files = readFilesInput(req.body.files, req.user);
  if (!content && !files.length) fail(400, 'Bài nộp cần có nội dung hoặc file đính kèm');
  const ts = now();
  const late = t.due_at && ts > t.due_at ? 1 : 0;
  await tx(async q => {
    const [sub] = await q.run('INSERT INTO submissions(task_id, student_id, content, late, created_at) VALUES(?, ?, ?, ?, ?) RETURNING id',
      t.id, req.user.id, content, late, ts);
    await saveFiles(q, 'submission', sub.id, files);
    await ensureProgressRow(q, t.id, req.user.id);
    await q.run(`UPDATE progress SET status = 'submitted', submitted_at = ?, late = ?,
                   first_viewed_at = COALESCE(first_viewed_at, ?) WHERE task_id = ? AND student_id = ?`,
    ts, late, ts, t.id, req.user.id);
  });
  res.json({ ok: true, late: !!late });
});

// ---------------------------------------------------------------- xem / tải file

app.get('/files/:id', requireLogin, async (req, res) => {
  const f = await get('SELECT * FROM files WHERE id = ?', toId(req.params.id));
  if (!f) fail(404, 'Không tìm thấy file');
  if (req.user.role !== 'teacher') {
    if (req.user.must_change_pw) fail(403, 'Bạn cần đổi mật khẩu trước');
    const ok = f.owner_type === 'task'
      ? await isAssigned(f.owner_id, req.user.id)
      : !!await get('SELECT 1 AS ok FROM submissions WHERE id = ? AND student_id = ?', f.owner_id, req.user.id);
    if (!ok) fail(403, 'Bạn không có quyền xem file này');
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.redirect(302, storage.fileHref(f.url, !!req.query.dl));
});

// ---------------------------------------------------------------- lỗi

app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.name === 'MulterError') {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Mỗi file tối đa ${MAX_FILE_MB} MB` : 'Lỗi tải file: ' + err.message });
  }
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Lỗi máy chủ: ' + err.message : err.message });
});

module.exports = app;
