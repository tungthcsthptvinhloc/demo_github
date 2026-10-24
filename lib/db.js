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

async function createDriver() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (url) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10000 });
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
    readyPromise = (async () => {
      const driver = await createDriver();
      try {
        await driver.exec(SCHEMA);
      } catch (err) {
        // Hai phiên bản hàm khởi động cùng lúc có thể đụng nhau khi tạo bảng: thử lại một lần.
        await new Promise(r => setTimeout(r, 300));
        await driver.exec(SCHEMA);
      }
      return driver;
    })();
    readyPromise.catch(() => { readyPromise = null; });
  }
  return readyPromise;
}

const wrap = q => ({
  all: (sql, ...params) => q(sql, params),
  get: async (sql, ...params) => (await q(sql, params))[0],
  run: (sql, ...params) => q(sql, params),
});

const all = async (sql, ...params) => (await ready()).query(sql, params);
const get = async (sql, ...params) => (await all(sql, ...params))[0];
const run = all;
const tx = async fn => (await ready()).tx(q => fn(wrap(q)));

module.exports = { all, get, run, tx, ready };
