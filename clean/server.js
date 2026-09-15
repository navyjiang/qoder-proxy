const { createApp } = require('./app');
const { log } = require('./logger');
const { getBackend } = require('./qoder-api');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);

const app = createApp();

app.listen(PORT, HOST, () => {
  const backend = getBackend();
  log(`Qoder Proxy listening on http://${HOST}:${PORT}`);
  log('model server', {
    backend: backend.name,
    host: backend.modelHost,
    auth_home: backend.authDir,
  });
});
