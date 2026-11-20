import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

type Label = { label: string; food: boolean; vector: number[] };
/** A scanner label with the best CLIP cosine similarity seen across all image crops. */
export interface ScoredLabel { label: string; score: number }

let loaded: Promise<[ort.InferenceSession, Label[]]> | undefined;
let running = false;

/** Minimum CLIP similarity for a food label to count as detected. */
export const CLIP_DETECTION_THRESHOLD = 0.20;

/**
 * Runs CLIP over the photo and crops, and returns each detected food label with its best
 * similarity score. The score is what the caller uses to estimate confidence.
 */
export async function recognizeFoodsScored(bytes: Buffer): Promise<ScoredLabel[]> {
  if (running) throw new Error('Another photo is being analyzed. Try again in a few seconds.');
  running = true;
  try {
    const dir = join(process.cwd(), '.vision');
    loaded ??= Promise.all([
      ort.InferenceSession.create(join(dir, 'vision.onnx'), {intraOpNumThreads: 2, interOpNumThreads: 1, enableCpuMemArena: false}),
      readFile(join(dir, 'labels.json'), 'utf8').then(data => JSON.parse(data) as Label[]),
    ]).catch(err => { loaded = undefined; throw err; });
    const [session, labels] = await loaded;
    const normalized = await sharp(bytes, {limitInputPixels: 40000000}).rotate().resize(448,448,{fit:'contain',background:'white'}).removeAlpha().toColourspace('srgb').png().toBuffer();
    const views = [[0,0,448]];
    for (const top of [64,168,272]) for (const left of [64,168,272]) views.push([left,top,112]);
    const found = new Map<string, number>();
    for (const [left,top,width] of views) {
      const data = await sharp(normalized).extract({left, top, width, height:width}).resize(224,224).raw().toBuffer();
      const plane = 224*224, pixels = new Float32Array(plane*3);
      const means = [0.48145466,0.4578275,0.40821073], stds = [0.26862954,0.26130258,0.27577711];
      for (let c=0;c<3;c++) for (let p=0;p<plane;p++) pixels[c*plane+p]=(data[p*3+c]/255-means[c])/stds[c];
      const output = await session.run({pixel_values:new ort.Tensor('float32',pixels,[1,3,224,224])});
      const embedding = output.image_embeds.data as Float32Array;
      const norm = Math.hypot(...embedding);
      const ranked = labels.map(entry=>({ entry, score:entry.vector.reduce((sum,v,i)=>sum+v*embedding[i],0)/norm })).sort((a,b)=>b.score-a.score);
      const best = ranked[0];
      if (width===448 && !best.entry.food) return [];
      if (best.entry.food && best.score>=CLIP_DETECTION_THRESHOLD) {
        found.set(best.entry.label, Math.max(found.get(best.entry.label) ?? 0, best.score));
      }
    }
    return [...found].map(([label, score]) => ({ label, score })).sort((a, b) => b.score - a.score);
  } finally { running = false; }
}

/** Food labels only, for callers that do not need scores. */
export async function recognizeFoods(bytes: Buffer): Promise<string[]> {
  return (await recognizeFoodsScored(bytes)).map((f) => f.label);
}
