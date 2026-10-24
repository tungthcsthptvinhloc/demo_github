'use strict';
// Cơ sở dữ liệu PostgreSQL.
// - Trên Vercel: dùng Neon Postgres qua biến môi trường DATABASE_URL (Vercel tự tạo khi gắn Neon).
// - Chạy thử trên máy (không có DATABASE_URL): dùng PGlite, một Postgres chạy ngay trong Node, lưu ở thư mục .devdata.
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  class_name     TEXT NOT NULL DEFAULT '',
  role           TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  must_change_pw INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_at      TEXT,
  assign_all  INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_assignees (
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, student_id)
);

-- Trạng thái của từng học sinh với từng nhiệm vụ.
-- status: NULL (chưa nộp; "đã xem" suy ra từ first_viewed_at) | 'submitted' | 'graded' | 'redo'
CREATE TABLE IF NOT EXISTS progress (
  task_id         INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  student_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_viewed_at TEXT,
  last_viewed_at  TEXT,
  view_count      INTEGER NOT NULL DEFAULT 0,
  status          TEXT,
  submitted_at    TEXT,
  late            INTEGER NOT NULL DEFAULT 0,
  score           DOUBLE PRECISION,
  feedback        TEXT,
  graded_at       TEXT,
  PRIMARY KEY (task_id, student_id)
);

CREATE TABLE IF NOT EXISTS submissions (
  id         SERIAL PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL DEFAULT '',
  late       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- File đính kèm của đề (owner_type = 'task') hoặc của bài nộp (owner_type = 'submission').
-- Nội dung file nằm trên Vercel Blob; bảng này chỉ lưu đường dẫn.
CREATE TABLE IF NOT EXISTS files (
  id         SERIAL PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('task', 'submission')),
  owner_id   INTEGER NOT NULL,
  orig_name  TEXT NOT NULL,
  url        TEXT NOT NULL,
  mime       TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_submissions_task ON submissions(task_id, student_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`;

// Câu lệnh viết bằng dấu ? cho gọn; đổi sang $1, $2... theo cú pháp Postgres.
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Địa chỉ kết nối Neon. Khi gắn Neon, Vercel có thể thêm tiền tố vào tên biến (VD: STORAGE_DATABASE_URL).
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const found = Object.entries(process.env)
    .find(([k, v]) => /_(DATABASE_URL|POSTGRES_URL)$/.test(k) && /^postgres(ql)?:\/\//.test(v || ''));
  return found ? found[1] : '';
}

async function createDriver() {
  const url = databaseUrl();
  if (!url && process.env.VERCEL) {
    throw new Error('Chưa kết nối cơ sở dữ liệu Neon. Vào Vercel → Storage, gắn Neon vào dự án, rồi Redeploy. '
      + 'Kiểm tra kết nối tại /api/health');
  }
  if (url) {
    const { Pool } = require('pg');
    // Giữ kết nối rảnh 60 giây để các lần bấm liên tiếp không phải bắt tay lại với Neon (mỗi lần mất vài lượt đi-về).
    const pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 60000 });
    try {
      // Trên Vercel: đóng gọn kết nối rảnh trước khi máy chủ tạm ngưng, tránh rò kết nối.
      require('@vercel/functions').attachDatabasePool(pool);
    } catch { /* chạy ngoài Vercel */ }
    return {
      exec: sql => pool.query(sql),
      query: (sql, params) => pool.query(toPg(sql), params).then(r => r.rows),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn((sql, params) => client.query(toPg(sql), params).then(r => r.rows));
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const dir = path.join(process.env.DEV_DATA_DIR || path.join(__dirname, '..', '.devdata'), 'pg');
  require('fs').mkdirSync(path.dirname(dir), { recursive: true });
  const db = new PGlite(dir);
  return {
    exec: sql => db.exec(sql),
    query: (sql, params) => db.query(toPg(sql), params).then(r => r.rows),
    tx: fn => db.transaction(t => fn((sql, params) => t.query(toPg(sql), params).then(r => r.rows))),
  };
}

let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = createDriver();
    readyPromise.catch(() => { readyPromise = null; });
  }
  return readyPromise;
}

// Bảng chỉ được tạo khi truy vấn báo "chưa có bảng" (mã 42P01), để mỗi lần khởi động không tốn thêm một lượt gọi Neon.
let schemaPromise = null;
function ensureSchema(driver) {
  if (!schemaPromise) {
    schemaPromise = driver.exec(SCHEMA).catch(async () => {
      // Hai phiên bản hàm khởi động cùng lúc có thể đụng nhau khi tạo bảng: thử lại một lần.
      await new Promise(r => setTimeout(r, 300));
      return driver.exec(SCHEMA);
    });
    schemaPromise.catch(() => { schemaPromise = null; });
  }
  return schemaPromise;
}

async function withSchema(fn) {
  const driver = await ready();
  try {
    return await fn(driver);
  } catch (err) {
    if (!err || err.code !== '42P01') throw err;
    await ensureSchema(driver);
    return fn(driver);
  }
}

const wrap = q => ({
  all: (sql, ...params) => q(sql, params),
  get: async (sql, ...params) => (await q(sql, params))[0],
  run: (sql, ...params) => q(sql, params),
});

const all = (sql, ...params) => withSchema(d => d.query(sql, params));
const get = async (sql, ...params) => (await all(sql, ...params))[0];
const run = all;
const tx = fn => withSchema(d => d.tx(q => fn(wrap(q))));

// Tên máy chủ Neon (không chứa mật khẩu), dùng để biết cơ sở dữ liệu đặt ở vùng nào.
function databaseHost() {
  try {
    return new URL(databaseUrl()).hostname;
  } catch {
    return '';
  }
}

module.exports = { all, get, run, tx, ready, databaseUrl, databaseHost };
