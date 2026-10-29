// bump-versions.js
// Gives every page the same cache version for script.js, script.css and the other
// src/ files, so browsers never keep an old copy after you update the site.
//
// Run it from your project folder after each update:
//     node bump-versions.js
// (or choose your own number:  node bump-versions.js 20261105a)
const fs = require('fs');
const path = require('path');

const version = process.argv[2] || new Date().toISOString().slice(0, 10).replace(/-/g, '') + 'a';
const skip = new Set(['node_modules', '.git', '.vercel', 'dist']);
let changedFiles = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) walk(path.join(dir, entry.name));
    } else if (entry.name.toLowerCase().endsWith('.html')) {
      bump(path.join(dir, entry.name));
    }
  }
}

function bump(file) {
  const original = fs.readFileSync(file, 'utf8'); // keeps line endings and special characters as they are
  // Every local .js / .css file gets "?v=<version>" (added when missing, replaced when present).
  // Outside addresses (https://..., //cdn...) are never touched.
  const updated = original.replace(
    /((?:src|href)=["'])([^"'?#]*\.(?:js|css))(\?v=[^"'#]*)?(["'])/g,
    (match, start, target, _oldVersion, quote) => {
      const isOutsideAddress = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(target); // http://, https://, //cdn...
      return isOutsideAddress ? match : `${start}${target}?v=${version}${quote}`;
    },
  );
  if (updated !== original) {
    fs.writeFileSync(file, updated, 'utf8');
    changedFiles += 1;
    console.log('updated', path.relative(process.cwd(), file));
  }
}

walk(process.cwd());
console.log(`\nDone. Version ${version} applied in ${changedFiles} file(s).`);
