const fs = require('fs');
const path = require('path');
const root = process.cwd();
const targets = ['data', 'public/uploads'];
const manifest = { generatedAt: new Date().toISOString(), targets: [] };
for (const target of targets) {
  const full = path.join(root, target);
  if (!fs.existsSync(full)) continue;
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else {
        const stat = fs.statSync(abs);
        files.push({ file: path.relative(root, abs), size: stat.size, mtime: stat.mtime.toISOString() });
      }
    }
  };
  walk(full);
  manifest.targets.push({ target, fileCount: files.length, files });
}
console.log(JSON.stringify(manifest, null, 2));
