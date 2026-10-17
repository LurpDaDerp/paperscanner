// Copies the prebuilt OpenCV.js bundle into public/ so it can be loaded as a
// classic script (it is ~10 MB and must not go through the bundler).
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const src = require.resolve('@techstark/opencv-js/dist/opencv.js');
const dest = resolve(root, 'public/vendor/opencv.js');

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log('Copied OpenCV.js -> public/vendor/opencv.js');
