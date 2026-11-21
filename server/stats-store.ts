/**
 * 观众统计存储：按 sessionId 覆盖保存累计快照，长时间不上报的会话自动过期。
 */
import type { ViewerReport, ViewerRecord } from '../shared/protocol.ts';

const TTL_MS = 120_000;

export class StatsStore {
  private viewers = new Map<string, ViewerRecord>();

  upsert(report: ViewerReport, now: number = Date.now()): ViewerRecord {
    const existing = this.viewers.get(report.sessionId);
    const record: ViewerRecord = {
      ...report,
      serverSeenAt: existing?.serverSeenAt ?? now,
    };
    this.viewers.set(report.sessionId, record);
    return record;
  }

  list(now: number = Date.now()): ViewerRecord[] {
    for (const [id, r] of this.viewers) {
      if (now - r.updatedAt > TTL_MS) this.viewers.delete(id);
    }
    return [...this.viewers.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  size(): number {
    return this.viewers.size;
  }
}
