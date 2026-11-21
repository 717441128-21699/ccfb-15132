/**
 * 客户端与服务端共享的协议类型与常量。
 * 所有时间戳单位均为毫秒（除媒体时间轴自身的 timescale 单位外）。
 */

export interface RenditionInfo {
  /** 码率档位 id，例如 "720p" */
  id: string;
  /** 平均码率 bps */
  bitrate: number;
  width: number;
  height: number;
  /** RFC 6381 编解码串，例如 "avc1.640028,mp4a.40.2" */
  codecs: string;
}

export interface VenueManifest {
  id: string;
  name: string;
  /** 分片时长 ms */
  targetDurationMs: number;
  /** 分片内 chunk（moof+mdat）时长 ms */
  chunkDurationMs: number;
  /** 循环池中的分片数量 */
  poolSegments: number;
  renditions: RenditionInfo[];
}

export interface ManifestResponse {
  generatedAt: number;
  venues: VenueManifest[];
}

/** GET /api/edge/:venue 的响应：直播边缘信息 */
export interface EdgeInfo {
  /** 当前正在发布的分片序号（从 0 开始单调递增） */
  seq: number;
  /** 该分片第一个 chunk 的计划发布墙钟时间 ms */
  publishAt: number;
  /** 该分片对应的循环池下标 */
  loopIndex: number;
}

/**
 * 观众端上报的播放统计。POST /api/stats 为「累计快照」语义，
 * 服务端按 sessionId 覆盖保存。
 */
export interface ViewerReport {
  sessionId: string;
  venue: string;
  /** 页面创建播放器的墙钟时间 */
  startAt: number;
  /** 首帧呈现墙钟时间，未起播时为 0 */
  firstFrameAt: number;
  /** 起播耗时 ms（首帧 - startAt） */
  startupMs: number;
  /** 累计卡顿次数 */
  stalls: number;
  /** 累计卡顿时长 ms */
  stallMs: number;
  /** 当前端到端延迟 ms */
  latencyMs: number;
  /** 最低档→最高档累计切换次数 */
  switches: number;
  /** 赛场切换次数 */
  venueSwitches: number;
  /** 最近一次上报时间 */
  updatedAt: number;
}

export interface ViewerRecord extends ViewerReport {
  /** 服务端首次见到该 session 的时间 */
  serverSeenAt: number;
}

export interface StatsResponse {
  viewers: ViewerRecord[];
}

export const LIVE_PATH = '/api/live';
export const MANIFEST_PATH = '/api/manifest';
export const EDGE_PATH = '/api/edge';
export const STATS_PATH = '/api/stats';

export function liveUrl(venue: string, rendition: string, seq: number): string {
  return `${LIVE_PATH}/${encodeURIComponent(venue)}/${encodeURIComponent(rendition)}?seq=${seq}`;
}

export function edgeUrl(venue: string): string {
  return `${EDGE_PATH}/${encodeURIComponent(venue)}`;
}
