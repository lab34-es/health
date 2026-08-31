// tsc only emits .ts — the report template's CSS and browser JS, and the
// SQL migrations, are copied verbatim so they stay editable as real files.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('.', import.meta.url)));
const out = join(root, process.argv[2] ?? 'dist');

for (const dir of ['report/assets', 'db/migrations']) {
  await mkdir(join(out, dir), { recursive: true });
  await cp(join(root, 'src', dir), join(out, dir), { recursive: true });
}
