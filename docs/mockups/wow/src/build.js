const fs = require('fs'), path = require('path');
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['B', 'D', 'E', 'F'];
for (const id of ids) {
  const f = path.join(__dirname, id + '.js');
  if (!fs.existsSync(f)) continue;
  delete require.cache[require.resolve(f)];
  const html = require(f);
  fs.writeFileSync(path.join(__dirname, '..', 'wow-' + id + '.html'), html);
  // syntax-check every inline script
  const scripts = [...html.matchAll(/<script(?: type="module")?>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  scripts.forEach((s, k) => { const tmp = path.join(__dirname, `_chk_${id}_${k}.mjs`); fs.writeFileSync(tmp, s); try { require('child_process').execSync(`node --check ${tmp}`, { stdio: 'pipe' }); } catch (e) { console.log(id, 'script', k, 'SYNTAX', e.stderr.toString().split('\n').slice(0, 6).join('\n')); } fs.unlinkSync(tmp); });
  console.log('built wow-' + id + '.html', (html.length / 1024).toFixed(1) + ' KB');
}
