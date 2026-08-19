/**
 * Inline the payload and the reader into one self-contained page.
 *
 *     node scripts/static-site/build.mjs <site-data.json> <out.html>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [dataPath, outPath = 'site.html'] = process.argv.slice(2);

const [template, script, data] = await Promise.all([
  readFile(join(here, 'template.html'), 'utf8'),
  readFile(join(here, 'app.js'), 'utf8'),
  readFile(dataPath, 'utf8'),
]);

// `</script>` inside a JSON string would close the tag it is sitting in.
const safe = data.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

const html = template.replace('__DATA__', () => safe).replace('__SCRIPT__', () => script);
await writeFile(outPath, html, 'utf8');

console.log(`${outPath}: ${(html.length / 1024).toFixed(0)} KB`);
