# 低延迟 CMAF 直播播放器（LL-CMAF Player）

面向校园运动会场景的自研低延迟网页直播系统。基于 **Media Source Extensions** 手动消费
**CMAF 分块（chunked CMAF）**，按 200ms 一个 chunk 边下边喂，端到端延迟稳定在 **2 秒左右
（目标 ≤3s）**，替代动辄十几秒延迟的现成播放器。

## 核心能力

| 需求 | 实现 |
| --- | --- |
| 吃 CMAF 分片、按分块边下边喂 | 服务端按墙钟 200ms 广播 moof+mdat；`LiveTransport` 增量分帧，`MseEngine` 串行 appendBuffer |
| 码率自适应，网络变差 2s 内降档 | `AbrController`：快 EWMA(1s) 驱动即时降档、慢 EWMA(4s)+迟滞+冷却驱动升级，卡顿强制退档 |
| 延迟落后时轻微加速追回 | `CatchUpController`：延迟超目标+死区时播放速率最高 1.10× 温和追帧，回到区间自动恢复 1.0 |
| 卡顿与延迟实时曲线 | 纯 Canvas `LineChart`，无第三方图表库，含 3s 目标阈值线 |
| 多赛场切换不黑屏 | `VenueSwitcher` 双 video 元素轮换，备用元素预拉流、首帧上屏后再交换可见性 |
| 统计页记录起播时间与卡顿次数 | 播放器每 2s 上报累计快照，服务端按 sessionId 覆盖，120s 心跳过期 |
| 调试页模拟带宽抖动与丢包 | 服务端 `NetworkSimulator`：带宽管道、固定延迟、均匀抖动、按概率丢包，种子可复现 |
| 端到端延迟 ≤3s | 实测稳定 ~2.0s（见下文实测数据） |
| TypeScript | 全量 strict 模式，零 `any` 逃逸（仅测试 mock 例外） |

## 目录结构

```
shared/            客户端/服务端共享
  protocol.ts      协议类型与常量
  boxes.ts         ISO-BMFF box 解析、tfdt 重写、chunk 切分、时间戳补丁预编译
scripts/
  generate.ts      ffmpeg 生成 3 赛场 × 3 码率的 fMP4 并拆成 init + 2s 分片
  probe-live.ts    直播流探针（分帧/延迟/tfdt 单调性）
server/
  stream-store.ts  分片池加载、墙钟广播器、按码率隔离订阅、循环 tfdt 重打
  network-sim.ts   带宽/延迟/抖动/丢包模拟器（确定性 RNG）
  stats-store.ts   观众统计存储
  main.ts          零依赖 HTTP 服务（清单/直播分帧/统计/静态托管）
player/
  transport.ts     16 字节分帧的直播流传输层 + 逐 chunk 吞吐统计
  abr.ts           自适应码率控制器
  catchup.ts       追帧变速控制器
  mse-engine.ts    MSE/SourceBuffer 队列、changeType 切档、缓冲回收
  metrics.ts       卡顿/切换/延迟/缓冲指标采集
  player.ts        主播放器，串联以上模块
  venue-switcher.ts 双 video 无黑屏赛场切换
web/               三个页面（播放页 index / 调试台 debug / 观众统计 stats）
test/              40 个单元/集成测试 + 3 个真实 Chrome E2E
```

## 快速开始

```bash
npm install
npm run gen        # 1) 用 ffmpeg 造测试流（3 赛场 × 3 码率，约 21MB）
npm run build      # 2) 构建前端到 dist/
npm run server     # 3) 启动 origin：http://localhost:8080
```

浏览器打开：

- http://localhost:8080/index.html — 播放器（赛场切换、ABR、实时曲线）
- http://localhost:8080/debug.html — 调试台（带宽/延迟/抖动/丢包模拟）
- http://localhost:8080/stats.html — 观众统计

开发模式（前端热更新，代理到 8080）：`npm run dev`

## 测试流规格

`npm run gen` 调用 ffmpeg 生成，每路均为 H.264(High) + AAC-LC、25fps、GOP=2s：

| 档位 | 分辨率 | 码率 |
| --- | --- | --- |
| 480p | 854×480 | 0.9 Mbps |
| 720p | 1280×720 | 1.8 Mbps |
| 1080p | 1920×1080 | 3.6 Mbps |

每个赛场是 20s 循环池（10 个 2s 分片，每分片 10 个 200ms chunk）。服务端循环推送并在
推送时重写 tfdt（升级为 64 位 v1），保证媒体时间戳跨循环单调递增，可长期运行不溢出。

## 线协议

直播流 `GET /api/live/:venue/:rendition` 是长连接，逐帧二进制分帧（大端）：

```
u64 publishAtMs | u32 seq | u32 byteLength | payload(CMAF bytes)
```

- `seq === 0xFFFFFFFF` 表示首帧 init segment；其余为媒体 chunk
- `publishAtMs` 是服务端计划发布的墙钟毫秒，客户端据此计算端到端延迟
- 调试参数：`simBw`(bps) / `simLatency` / `simJitter` / `simLoss`(0~1) / `simSeed`

## 实测数据

真实 Chrome（Playwright 自动化）在本机 origin 上连续采样 20s：

```
端到端延迟：min 1918ms / avg 1989ms / max 2033ms，20/20 低于 3s
播放速率：追帧后稳定收敛回 1.00×
```

## 测试

```bash
npm test                 # 40 个单元 + 集成测试（box 解析、tfdt、ABR、追帧、传输、网络模拟、服务端冒烟）
npm run test:e2e         # 3 个真实 Chrome E2E（起播/亚3s延迟、无黑屏切换、弱网自动降档）
npm run test:all         # 两者都跑
```

## 关键设计说明

- **起播 seek 到直播边缘**：服务端长时间运行后媒体时间戳累积到数千秒，新观众 currentTime=0
  会远离缓冲区间，播放器在首次播放前 seek 到 buffered 起点，否则无可解码帧。
- **按码率隔离订阅**：每个直播连接只收自己请求的那一路 chunk，避免把全部码率推给同一连接。
- **64 位时间戳**：墙钟毫秒已超 2³²，帧头 publishAt 与 tfdt 均用 64 位，杜绝回绕。
- **AAC priming 尾巴**：ffmpeg 末尾会产生纯音频 moof，分片器按「含视频 traf 的 moof」切边界，
  纯音频 moof 并入前一 chunk，保证每个 chunk 以视频帧为界。
