const http = require('http');
const port = process.env.PORT || 3000;
const path = process.env.HEALTH_PATH || '/readyz';
const req = http.get({ host: '127.0.0.1', port, path, timeout: 5000 }, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
      console.log(data || 'ok');
      process.exit(0);
    }
    console.error(data || `Healthcheck failed with status ${res.statusCode}`);
    process.exit(1);
  });
});
req.on('timeout', () => { console.error('Healthcheck timed out'); req.destroy(); process.exit(1); });
req.on('error', (err) => { console.error(err.message); process.exit(1); });
