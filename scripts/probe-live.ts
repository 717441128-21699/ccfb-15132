/**
 * 直播流探针：连接指定 live URL 若干秒，报告分帧、延迟、tfdt 单调性。
 * 用法：npx tsx scripts/probe-live.ts [url] [durationMs]
 */
import { LiveTransport, type LiveFrame, type MediaFrame } from '../player/transport.ts';
import { parseBoxes, findBox, readTfdt, isInitSegment } from '../shared/boxes.ts';

const url = process.argv[2] ?? 'http://localhost:8080/api/live/track/720p';
const duration = Number(process.argv[3] ?? 6000);

const resp = await fetch(url);
if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
const reader = resp.body.getReader();
const frames: LiveFrame[] = [];
const transport = new LiveTransport('probe', { onFrame: (f) => frames.push(f) });

const start = Date.now();
while (Date.now() - start < duration) {
  const { value, done } = await reader.read();
  if (done) break;
  transport.feed(value);
}
await reader.cancel();

const media = frames.filter((f): f is MediaFrame => f.kind === 'media');
const init = frames.find((f) => f.kind === 'init');
console.log('init frame valid:', init ? isInitSegment(init.data) : false);
console.log('media frames in', duration, 'ms:', media.length, '(expect ~', Math.round(duration / 200), ')');

// tfdt 单调与重复
let nonMono = 0;
let dup = 0;
const samples: Array<{ seq: number; v: bigint; a: bigint }> = [];
for (const f of media) {
  const moof = parseBoxes(f.data).find((b) => b.type === 'moof')!;
  const tfs = new Map<number, bigint>();
  for (const traf of moof.children.filter((n) => n.type === 'traf')) {
    const tfhd = findBox(traf.children, ['tfhd'])!;
    const tfdt = findBox(traf.children, ['tfdt'])!;
    const id = new DataView(tfhd.payload!.buffer, tfhd.payload!.byteOffset).getUint32(4);
    tfs.set(id, readTfdt(tfdt));
  }
  samples.push({ seq: f.seq, v: tfs.get(1)!, a: tfs.get(2)! });
}
for (let i = 1; i < samples.length; i++) {
  if (samples[i].v <= samples[i - 1].v || samples[i].a <= samples[i - 1].a) nonMono++;
  if (samples[i].v === samples[i - 1].v) dup++;
}
console.log('tfdt non-monotonic:', nonMono, '| duplicate video tfdt:', dup);
console.log('seq strictly follows chunk order:', media.every((f, i) => i === 0 || f.seq >= media[i - 1].seq));

const lat = media.map((f) => f.receivedAt - f.publishAt);
console.log('edge->client latency avg/min/max ms:',
  Math.round(lat.reduce((a, b) => a + b, 0) / lat.length), Math.min(...lat), Math.max(...lat));
const sizes = media.map((f) => f.bytes);
console.log('chunk bytes avg/min/max:',
  Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length), Math.min(...sizes), Math.max(...sizes));
console.log('first sample:', { seq: samples[0]?.seq, v: samples[0]?.v.toString() },
  'last:', { seq: samples.at(-1)?.seq, v: samples.at(-1)?.v.toString() });
