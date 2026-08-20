// Copia a la extensión los ficheros de cliente que comparte con la web.
// `public/` es la única fuente de verdad: la extensión no puede cargar scripts
// remotos (lo prohíbe la CSP de Manifest V3), así que necesita su propia copia.
// Ejecutar tras tocar cualquiera de ellos:  npm run sync-ext
const fs = require('fs');
const path = require('path');

const SHARED = ['audio-lib.js', 'langs.js'];
const from = path.join(__dirname, '..', 'public');
const to = path.join(__dirname, '..', 'extension');

if (!fs.existsSync(to)) {
  console.error(`No existe ${to} — nada que sincronizar.`);
  process.exit(1);
}

for (const file of SHARED) {
  fs.copyFileSync(path.join(from, file), path.join(to, file));
  console.log(`public/${file} → extension/${file}`);
}
console.log('Extensión sincronizada.');
