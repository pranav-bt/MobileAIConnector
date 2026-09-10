// Downloads the openWakeWord models (Apache-2.0) into the app's assets and
// the reference preprocessing source for verification.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RELEASE = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1';
const FILES = [
  [`${RELEASE}/melspectrogram.onnx`, 'android/app/src/main/assets/oww/melspectrogram.onnx'],
  [`${RELEASE}/embedding_model.onnx`, 'android/app/src/main/assets/oww/embedding_model.onnx'],
  [`${RELEASE}/hey_jarvis_v0.1.onnx`, 'android/app/src/main/assets/oww/hey_jarvis_v0.1.onnx'],
  ['https://raw.githubusercontent.com/dscripka/openWakeWord/main/openwakeword/utils.py', 'tools/oww-utils-reference.py'],
];

for (const [url, out] of FILES) {
  const target = resolve(out);
  mkdirSync(resolve(target, '..'), { recursive: true });
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    console.error(`FAILED ${url}: ${response.status}`);
    process.exit(1);
  }
  const data = Buffer.from(await response.arrayBuffer());
  writeFileSync(target, data);
  console.log(`${out} — ${(data.length / 1024).toFixed(0)} KB`);
}
