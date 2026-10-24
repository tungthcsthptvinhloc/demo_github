// Chạy thử ứng dụng trên máy (không cần Neon/Blob): npm run dev
const app = require('./lib/app');
const { ready } = require('./lib/db');

const PORT = Number(process.env.PORT) || 3000;

ready().then(() => {
  app.listen(PORT, () => console.log(`Bản chạy thử: http://localhost:${PORT}`));
});
