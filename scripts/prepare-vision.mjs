import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import * as ort from 'onnxruntime-node';

// Encode the fixed English prompts once during deployment. The live API only needs the vision encoder.
const dir = '.vision';
await mkdir(dir, { recursive: true });
const root = 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/';
async function download(remote, local) {
  const response = await fetch(root + remote, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error('Model download failed: ' + remote + ' HTTP ' + response.status);
  await pipeline(response.body, createWriteStream(dir + '/' + local));
}
await Promise.all([download('tokenizer.json', 'tokenizer.json'), download('onnx/text_model_quantized.onnx', 'text.onnx'), download('onnx/vision_model_quantized.onnx', 'vision.onnx')]);
const { model } = JSON.parse(await readFile(dir + '/tokenizer.json', 'utf8'));
const ranks = new Map(model.merges.map((pair, i) => [Array.isArray(pair) ? pair.join(' ') : pair, i]));
function encodeWord(word) {
  const parts = [...word];
  parts[parts.length - 1] += '</w>';
  while (parts.length > 1) {
    let best = Infinity, index = -1;
    for (let i = 0; i < parts.length - 1; i++) {
      const rank = ranks.get(parts[i] + ' ' + parts[i + 1]);
      if (rank < best) { best = rank; index = i; }
    }
    if (index < 0) break;
    parts.splice(index, 2, parts[index] + parts[index + 1]);
  }
  return parts.map(p => model.vocab[p]);
}
// Food labels come from the shared list the TypeScript matcher also reads.
const foods = JSON.parse(await readFile('src/lib/services/scanner-labels.json', 'utf8')).foods;
const negatives = ['a screenshot of a website','a document containing text','a person posing for a portrait','a room with furniture','an outdoor landscape','an electronic device','a drawing or diagram','an empty plate'];
const session = await ort.InferenceSession.create(dir + '/text.onnx', {intraOpNumThreads: 2});
const entries = [];
for (const label of [...foods, ...negatives]) {
  const food = foods.includes(label);
  const sentence = food ? 'a close up food photo of ' + label : label;
  const ids = [49406, ...sentence.split(' ').flatMap(encodeWord), 49407];
  const shape = [1, ids.length];
  const inputs = { input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), shape) };
  if (session.inputNames.includes('attention_mask')) inputs.attention_mask = new ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), shape);
  const outputs = await session.run(inputs);
  const vector = Array.from(outputs.text_embeds.data);
  const norm = Math.hypot(...vector);
  entries.push({ label, food, vector: vector.map(x => x / norm) });
}
await writeFile(dir + '/labels.json', JSON.stringify(entries));
await session.release();
await rm(dir + '/text.onnx');
console.log('Prepared free food recognition API with ' + foods.length + ' food labels.');
