/**
 * 极简 ISO-BMFF（fMP4 / CMAF）box 解析与改写工具。
 *
 * 设计：parseBoxes 把一段 buffer 解析成 box 树，容器 box（moov/traf/moof...）
 * 递归展开；叶子 box 持有原始 DataView 切片。序列化时重新拼装，叶子原样写回，
 * 被改写的叶子（如 tfdt）用 buildBox 重建，所有父 box 的 size 自动重算。
 */

export const CONTAINER_TYPES = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'moof',
  'traf',
  'mvex',
  'edts',
  'udta',
  'meta',
  'mfra',
  'skip',
]);

export interface BoxNode {
  type: string;
  /** 该 box 的原始起始偏移（相对于解析入口 buffer） */
  start: number;
  /** 该 box 的总长度（含 8/16 字节头） */
  size: number;
  headerSize: number;
  children: BoxNode[];
  /** 叶子 box 的负载视图（不含 box 头） */
  payload: Uint8Array | null;
}

const TE = new TextEncoder();
const TD = new TextDecoder();

export function fourCc(bytes: Uint8Array, offset = 0): string {
  return TD.decode(bytes.subarray(offset, offset + 4));
}

export function fourCcBytes(s: string): Uint8Array {
  return TE.encode(s.padEnd(4, ' ').slice(0, 4));
}

/** 遍历顶层 box（不会跨入子 box）。 */
export function iterTopLevel(buf: Uint8Array): Array<{ type: string; start: number; size: number; headerSize: number }> {
  const out: Array<{ type: string; start: number; size: number; headerSize: number }> = [];
  let p = 0;
  while (p + 8 <= buf.length) {
    const size32 = dv(buf).getUint32(p);
    const type = fourCc(buf, p + 4);
    let size = size32;
    let headerSize = 8;
    if (size32 === 1) {
      if (p + 16 > buf.length) throw new Error('64-bit box header truncated');
      size = Number(dv(buf).getBigUint64(p + 8));
      headerSize = 16;
    } else if (size32 === 0) {
      size = buf.length - p; // box 延伸到文件结尾
    }
    if (size < headerSize || p + size > buf.length) {
      throw new Error(`malformed box "${type}" at offset ${p}: size=${size}`);
    }
    out.push({ type, start: p, size, headerSize });
    p += size;
  }
  return out;
}

export function parseBoxes(buf: Uint8Array): BoxNode[] {
  const walk = (slice: Uint8Array, base: number): BoxNode[] =>
    iterTopLevel(slice).map((b) => {
      const payloadStart = b.start + b.headerSize;
      const node: BoxNode = {
        type: b.type,
        start: base + b.start,
        size: b.size,
        headerSize: b.headerSize,
        children: [],
        payload: null,
      };
      const body = slice.subarray(payloadStart, b.start + b.size);
      if (CONTAINER_TYPES.has(b.type)) {
        node.children = walk(body, base + payloadStart);
      } else {
        // meta 是容器但前面带 4 字节 version/flags；这里流里不依赖 meta，保持叶子即可
        node.payload = body.slice();
      }
      return node;
    });
  return walk(buf, 0);
}

export function findBox(nodes: BoxNode[], path: string[]): BoxNode | null {
  let list = nodes;
  let hit: BoxNode | null = null;
  for (const type of path) {
    hit = list.find((n) => n.type === type) ?? null;
    if (!hit) return null;
    list = hit.children;
  }
  return hit;
}

export function findAll(nodes: BoxNode[], type: string): BoxNode[] {
  const out: BoxNode[] = [];
  const walk = (list: BoxNode[]): void => {
    for (const n of list) {
      if (n.type === type) out.push(n);
      if (n.children.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** 用给定负载构建一个普通 32 位 size 的 box。 */
export function buildBox(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const view = dv(out);
  view.setUint32(0, out.length);
  out.set(fourCcBytes(type), 4);
  out.set(payload, 8);
  return out;
}

/** 序列化 box 树：叶子写回原始字节，被改写过的节点按 payload 重建，size 自动重算。 */
export function serializeBoxes(nodes: BoxNode[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writeNode = (n: BoxNode): void => {
    if (n.children.length) {
      const body = serializeBoxes(n.children);
      chunks.push(buildBox(n.type, body));
    } else if (n.payload) {
      chunks.push(buildBox(n.type, n.payload));
    }
  };
  for (const n of nodes) writeNode(n);
  return concat(chunks);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 读取 tfdt（track fragment decode time）。返回 bigint，兼容 v0/v1。 */
export function readTfdt(node: BoxNode): bigint {
  const p = node.payload;
  if (!p || p.length < 5) throw new Error('tfdt box missing payload');
  const version = p[0];
  const view = dv(p);
  if (version === 1) {
    if (p.length < 12) throw new Error('tfdt v1 truncated');
    return view.getBigUint64(4);
  }
  return BigInt(view.getUint32(4));
}

/**
 * 把 tfdt 改写为 v1（64 位）并设置新的 baseMediaDecodeTime。
 * 直接替换节点 payload，序列化时父 box size 自动重算。
 */
export function writeTfdtV1(node: BoxNode, baseMediaDecodeTime: bigint): void {
  if (node.type !== 'tfdt') throw new Error('expected tfdt node');
  const payload = new Uint8Array(12);
  const view = dv(payload);
  payload[0] = 1; // version=1, flags=0
  view.setBigUint64(4, baseMediaDecodeTime);
  node.payload = payload;
}

/** 读取 mdhd 中的 track timescale（v0/v1 均在 version 后第 4 字节）。 */
export function readTimescale(mdhd: BoxNode): number {
  const p = mdhd.payload;
  if (!p || p.length < 12) throw new Error('mdhd box missing payload');
  const version = p[0];
  // v0: version(1)+flags(3)+creation(4)+modification(4)+timescale(4)
  // v1: version(1)+flags(3)+creation(8)+modification(8)+timescale(4)
  const off = version === 1 ? 20 : 12;
  return dv(p).getUint32(off);
}

/** 读取 mvhd timescale（v0 偏移 12，v1 偏移 20）。 */
export function readMvhdTimescale(mvhd: BoxNode): number {
  const p = mvhd.payload;
  if (!p) throw new Error('mvhd missing');
  const version = p[0];
  return dv(p).getUint32(version === 1 ? 20 : 12);
}

/**
 * 从 init segment（moov）提取每条 track 的信息：
 * trackId、timescale、handler 类型（vide/soun）、RFC6381 codec 串。
 */
export interface TrackInfo {
  trackId: number;
  timescale: number;
  handler: string;
  codec: string;
}

export function extractTracks(moov: BoxNode): TrackInfo[] {
  const tracks: TrackInfo[] = [];
  for (const trak of moov.children.filter((n) => n.type === 'trak')) {
    const tkhd = findBox(trak.children, ['tkhd']);
    const mdhd = findBox(trak.children, ['mdia', 'mdhd']);
    const hdlr = findBox(trak.children, ['mdia', 'hdlr']);
    const stsd = findBox(trak.children, ['mdia', 'minf', 'stbl', 'stsd']);
    if (!tkhd || !mdhd || !hdlr || !stsd?.payload) {
      throw new Error('moov trak missing required boxes');
    }
    const trackId = readTrackId(tkhd);
    const timescale = readTimescale(mdhd);
    const handler = fourCc(hdlr.payload!, 8);
    const codec = codecFromStsd(stsd.payload, handler);
    tracks.push({ trackId, timescale, handler, codec });
  }
  return tracks;
}

function readTrackId(tkhd: BoxNode): number {
  const p = tkhd.payload!;
  const version = p[0];
  // v0: ...creation(4) modification(4) trackId(4)；v1 时间字段各 8 字节
  return dv(p).getUint32(version === 1 ? 20 : 12);
}

/**
 * stsd 负载布局：version/flags(4) + entry_count(4) + sample entry...
 * 视频 sample entry 内部找到 avc1/.../avcC，音频找到 mp4a/esds。
 */
function codecFromStsd(stsdPayload: Uint8Array, handler: string): string {
  const view = dv(stsdPayload);
  const entryCount = view.getUint32(4);
  if (entryCount < 1) throw new Error('stsd has no sample entry');
  // stsd payload: version/flags(4) + entry_count(4) + sample entries...
  // sample entry 自身也是一个 box：size(4)+type(4)+固定字段+嵌套 box
  const entryBoxStart = 8;
  const entryType = fourCc(stsdPayload, entryBoxStart + 4);

  if (handler === 'vide') {
    // VisualSampleEntry：size/type(8) + 固定字段 78 字节，其后为嵌套 box
    const nestedStart = entryBoxStart + 8 + 78;
    const avcC = findNestedPayload(stsdPayload, nestedStart, 'avcC');
    if (entryType === 'avc1' && avcC) {
      // avcC: configurationVersion(1) AVCProfileIndication(1)
      //       profile_compatibility(1) AVCLevelIndication(1)
      const profile = avcC[1];
      const compat = avcC[2];
      const level = avcC[3];
      return `avc1.${hex(profile)}${hex(compat)}${hex(level)}`;
    }
    // 其它编码（H.265/AV1）本项目测试流不会出现，退化为 entry 四字符码
    return `${entryType.toLowerCase()}.unknown`;
  }

  if (handler === 'soun') {
    // AudioSampleEntry：size/type(8) + 固定字段 28 字节，其后为嵌套 box
    const nestedStart = entryBoxStart + 8 + 28;
    const esds = findNestedPayload(stsdPayload, nestedStart, 'esds');
    if (entryType === 'mp4a' && esds) {
      const oti = readAudioObjectType(esds);
      return `mp4a.40.${oti}`;
    }
    return entryType.toLowerCase();
  }
  return entryType.toLowerCase();
}

/** 在一段字节内按顶层 box 规则查找目标 box（用于 sample entry 内部）。 */
function findNestedPayload(buf: Uint8Array, from: number, type: string): Uint8Array | null {
  let p = from;
  while (p + 8 <= buf.length) {
    const size = dv(buf).getUint32(p);
    if (size < 8 || p + size > buf.length) return null;
    if (fourCc(buf, p + 4) === type) return buf.subarray(p + 8, p + size);
    p += size;
  }
  return null;
}

/**
 * 从 esds 解析 AAC audioObjectType（AAC-LC=2）。
 * 严格按 ES_Descriptor -> DecoderConfigDescriptor -> DecoderSpecificInfo
 * 的标签与变长 size 规则走，避免用字节扫描误命中长度字段。
 */
function readAudioObjectType(esds: Uint8Array): number {
  let p = 4; // 跳过 version/flags

  // ES_Descriptor (tag 0x03)
  if (esds[p++] !== 0x03) throw new Error('esds: missing ES_Descriptor');
  p += readDescriptorSize(esds, p).sizeBytes;
  p += 2; // ES_ID
  const esFlags = esds[p++];
  if (esFlags & 0x80) p += 2; // dependsOn_ES_ID
  if (esFlags & 0x40) p += 1 + esds[p]; // URL
  if (esFlags & 0x20) p += 2; // OCR_ES_Id

  // DecoderConfigDescriptor (tag 0x04)
  if (esds[p++] !== 0x04) throw new Error('esds: missing DecoderConfigDescriptor');
  p += readDescriptorSize(esds, p).sizeBytes;
  p += 1 + 1 + 3 + 4 + 4; // objectTypeIndication, streamType+upStream+reserved, bufferSizeDB, max/avgBitrate

  // DecoderSpecificInfo (tag 0x05) -> AudioSpecificConfig
  if (esds[p++] !== 0x05) throw new Error('esds: missing DecoderSpecificInfo');
  const asc = readDescriptorSize(esds, p);
  p += asc.sizeBytes;
  if (asc.size < 1 || p >= esds.length) throw new Error('esds: empty AudioSpecificConfig');

  let audioObjectType = esds[p] >> 3; // 高 5 位
  if (audioObjectType === 31) {
    // 5 位转义：实际值 = 32 + 6 位拼接
    audioObjectType = 32 + ((esds[p] & 0x07) << 3) + (esds[p + 1] >> 5);
  }
  return audioObjectType;
}

/** 读取 ISO/IEC 14496-1 描述符的变长 size，返回 size 与占用字节数。 */
function readDescriptorSize(b: Uint8Array, p: number): { size: number; sizeBytes: number } {
  const start = p;
  let size = 0;
  let cur = b[p++];
  while (cur & 0x80) {
    size = (size << 7) | (cur & 0x7f);
    cur = b[p++];
  }
  size = (size << 7) | cur;
  return { size, sizeBytes: p - start };
}

function hex(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** 从单个 media segment（moof+mdat...）中读出每条 track 的 tfdt。 */
export function readSegmentTfdt(segment: Uint8Array): Map<number, bigint> {
  const root = parseBoxes(segment);
  const moof = root.find((n) => n.type === 'moof');
  if (!moof) throw new Error('media segment has no moof');
  const out = new Map<number, bigint>();
  for (const traf of moof.children.filter((n) => n.type === 'traf')) {
    const tfhd = findBox(traf.children, ['tfhd']);
    const tfdt = findBox(traf.children, ['tfdt']);
    if (!tfhd?.payload || !tfdt) throw new Error('traf missing tfhd/tfdt');
    // tfhd: version/flags(4)，默认 track_ID 在偏移 4；flags 位 0x01 表示带 base-data-offset
    const trackId = dv(tfhd.payload).getUint32(4);
    out.set(trackId, readTfdt(tfdt));
  }
  return out;
}

/**
 * 重写 media segment 中所有 track 的 tfdt（统一升级为 v1/64 位）。
 * @param overrides trackId -> 新的 baseMediaDecodeTime（track timescale 单位）
 */
export function retimestampSegment(segment: Uint8Array, overrides: Map<number, bigint>): Uint8Array {
  const root = parseBoxes(segment);
  const moof = root.find((n) => n.type === 'moof');
  if (!moof) throw new Error('media segment has no moof');
  for (const traf of moof.children.filter((n) => n.type === 'traf')) {
    const tfhd = findBox(traf.children, ['tfhd']);
    const tfdt = findBox(traf.children, ['tfdt']);
    if (!tfhd?.payload || !tfdt) throw new Error('traf missing tfhd/tfdt');
    const trackId = dv(tfhd.payload).getUint32(4);
    const next = overrides.get(trackId);
    if (next !== undefined) writeTfdtV1(tfdt, next);
  }
  return serializeBoxes(root);
}

/** 判断一段 fMP4 数据是否为 init segment（含 moov，不含 moof）。 */
export function isInitSegment(buf: Uint8Array): boolean {
  const tops = iterTopLevel(buf);
  return tops.some((b) => b.type === 'moov') && !tops.some((b) => b.type === 'moof');
}

/** 读出一个 moof 节点内所有 traf 的 trackId。 */
export function moofTrackIds(moof: BoxNode): number[] {
  const ids: number[] = [];
  for (const traf of moof.children.filter((n) => n.type === 'traf')) {
    const tfhd = findBox(traf.children, ['tfhd']);
    if (tfhd?.payload) ids.push(dv(tfhd.payload).getUint32(4));
  }
  return ids;
}

/**
 * 把一个 media segment 按「含视频 track 的 moof」切成 chunk。
 * 纯音频 moof（AAC priming 尾巴）并入前一个 chunk，保证每个 chunk
 * 都以视频 moof 起始，且 chunk 数严格等于视频 fragment 数。
 */
export function splitChunksByVideoMoof(segment: Uint8Array, videoTrackId: number): Uint8Array[] {
  const tops = iterTopLevel(segment);
  const groups: Uint8Array[][] = [];
  let current: Uint8Array[] | null = null;
  for (const b of tops) {
    const bytes = segment.subarray(b.start, b.start + b.size);
    if (b.type === 'moof') {
      const node = parseBoxes(bytes)[0];
      if (moofTrackIds(node).includes(videoTrackId)) {
        if (current) groups.push(current);
        current = [bytes];
      } else {
        if (!current) throw new Error('audio-only moof before any video moof');
        current.push(bytes);
      }
    } else {
      if (!current) throw new Error(`box ${b.type} outside any chunk`);
      current.push(bytes);
    }
  }
  if (current) groups.push(current);
  return groups.map(concat);
}

export interface TfdtPatch {
  /** v1 tfdt 的 64 位 baseMediaDecodeTime 字段在 chunk 字节中的绝对偏移 */
  valueOffset: number;
  trackId: number;
  /** 原始（单轮循环内）基准值 */
  base: bigint;
}

export interface PreparedChunk {
  /** tfdt 已统一升级为 v1 的 chunk 字节（可直接拷贝后打补丁） */
  bytes: Uint8Array;
  patches: TfdtPatch[];
}

/**
 * 预编译一个 chunk：把其中所有 moof/traf 的 tfdt 升级为 64 位 v1，
 * 记录每个值字段的固定偏移。广播时只需 slice 后 setBigUint64，
 * 无需再解析 box，每 200ms 的开销可忽略。
 */
export function prepareTfdtPatching(chunk: Uint8Array): PreparedChunk {
  const root = parseBoxes(chunk);
  for (const moof of root.filter((n) => n.type === 'moof')) {
    for (const traf of moof.children.filter((n) => n.type === 'traf')) {
      const tfdt = findBox(traf.children, ['tfdt']);
      if (tfdt) writeTfdtV1(tfdt, readTfdt(tfdt));
    }
  }
  const bytes = serializeBoxes(root);

  const root2 = parseBoxes(bytes);
  const patches: TfdtPatch[] = [];
  for (const moof of root2.filter((n) => n.type === 'moof')) {
    for (const traf of moof.children.filter((n) => n.type === 'traf')) {
      const tfhd = findBox(traf.children, ['tfhd']);
      const tfdt = findBox(traf.children, ['tfdt']);
      if (!tfhd?.payload || !tfdt) throw new Error('traf missing tfhd/tfdt after rewrite');
      const trackId = dv(tfhd.payload).getUint32(4);
      patches.push({
        valueOffset: tfdt.start + tfdt.headerSize + 4, // version/flags 之后
        trackId,
        base: readTfdt(tfdt),
      });
    }
  }
  return { bytes, patches };
}

/** 在预编译 chunk 的副本上应用循环轮次偏移，返回可发送字节。 */
export function applyLoopRound(prepared: PreparedChunk, loopDeltaByTrack: Map<number, bigint>, loopRound: number): Uint8Array {
  const out = prepared.bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const round = BigInt(loopRound);
  for (const p of prepared.patches) {
    const delta = loopDeltaByTrack.get(p.trackId);
    if (delta === undefined) throw new Error(`no loop delta for track ${p.trackId}`);
    view.setBigUint64(p.valueOffset, p.base + delta * round);
  }
  return out;
}

function dv(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}
