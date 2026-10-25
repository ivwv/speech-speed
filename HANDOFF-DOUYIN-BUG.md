# 抖音网页版倍速扩展失效问题 · 排查交接文档

> 生成时间：2026-10-25。供下一个 AI / 开发者接手排查使用。
> 扩展仓库：`E:\.Learn\github\speech-speed`（Chrome MV3 扩展，核心逻辑在 `content.js`）

---

## 1. 扩展是什么（一句话）

通过 `video.captureStream()` 捕获当前播放视频的音频 → Web Audio `AnalyserNode` 做过零检测估算语速（音节/秒）→ 根据目标语速动态调整 `video.playbackRate`（变速不变调的"语速归一"）。

## 2. 故障现象（用户原话归纳）

1. **前几天一切正常**：抖音首页推荐流里每个视频都能自动倍速。
2. **某天（抖音前端更新后）开始失效**：页面刷新后只能监听到**第一个**（或前 1~2 个）视频；继续往下刷，新视频不再有倍速，速度衰减回 1.0x。
3. **关键复现线索**：从后面的视频**往回刷**，刷回到最早被成功监听的那个视频时，倍速又能恢复；再往后刷到新视频又失效。
4. 结论性推断：**扩展的音频管线一直挂在最早那个 `<video>` 元素上，从未切换到后续任何新视频元素**。往回刷到旧视频时该元素恢复播放、旧音频流复活，所以倍速"复活"。

## 3. 抖音前端到底改了什么（HTML 证据）

用户提供了失效时的完整页面 HTML，关键证据：

- `scmVersion: 1.0.9.4913`（新版前端）。
- AB 灰度配置：`"reuseVideo": 2`、`"reuseVideoDiscover": 0`、`"useNewDyVideoPlayer": 2`。
- 页面 DOM 里同时存在**多个** `feed-item` slide，每个视频 slide 有 `data-e2e="feed-video"` 容器；当前活动项是 `data-e2e="feed-active-video"`（其余是 `feed-video`）。
- `<video>` 元素都带 `id="sliderVideo"`（多个元素共享同一 id），播放器容器为 `.basePlayerContainer` / `.douyin-player`。
- 推荐流切换视频的方式从「替换/新建 `<video>` DOM 元素」变成了「**复用同一批既有元素、换媒体源（src / MSE detach+attach）**」，且许多切换操作不派发 `play` 事件、不触发 MutationObserver 的 childList 变化（旧扩展依赖的两个信号全部失效）。
- 站点还会在切换时**自行把 `playbackRate` 重置为 1**，原扩展没监听 `ratechange`，导致倍速也被清掉。

## 4. 扩展原架构（content.js，789 行时的版本）

核心流程：

```
loadState() → init() → findAndAttach()
  ├─ findBestVideo()：querySelectorAll('video') 按评分挑最佳（播放中×1000、可见×3、面积）
  ├─ attachToVideo(video)：teardownAudio() 后记录 originalPlaybackRate
  │    └─ readyState>=2 时 setupAudio(video)
  │         └─ video.captureStream() → getAudioTracks()
  │              → MediaStreamSource → highpass(300Hz) → lowpass(3kHz) → Analyser(fftSize 2048)
  │              → startPolling(): 每 80ms getFloatTimeDomainData → 过零计数 → syllableRate
  │              → targetSpeed = targetRate / naturalRate → clamp(min,max) → 平滑 → applySpeed()
  ├─ observeDom()：MutationObserver(childList, subtree)，检测到 video 增删则防抖 900ms 重扫
  └─ setupGlobalListeners()：document 上捕获 phase 监听 'play' 事件，target 是新 video 就 attachToVideo
```

换视频检测原来完全依赖两条路径：
1. MutationObserver 看到 `<video>` 节点增删；
2. document 捕获 `play` 事件且 target ≠ activeVideo。

**新版抖音把这两条路都绕开了** → 扩展挂在第一个视频上不动。

## 5. 已尝试的修复（两轮，均已写入当前 content.js，~905 行）

### 第一轮：事件层修补（效果不足）

1. `ratechange` 监听：`playbackRate` 被站点改回 1 且与 `lastAppliedPlaybackRate` 不一致时立即 `applySpeed()` 恢复。
2. 同元素重捕获 `recaptureAudio(video)`：`loadeddata` / `durationchange` / 捕获音轨的 `ended` 事件触发时，在**同一元素**上 `teardownAudio(false)` + `setupAudio(video)` 重建管线。
3. 死流自愈：轮询中视频在播但 rms 连续 4 秒为 0 → `recaptureAudio`。

**结果：用户实测仍不行**——因为这些事件在新版抖音的切换路径上根本不派发（或时序对不上）。

### 第二轮：主动轮询（当前版本，用户反馈仍不行）

4. **看门狗** `startWatchdog()`（init 时启动，2s 间隔）：
   - `findBestVideo()` 的 best ≠ activeVideo 且 activeVideo 已暂停/不可见 → `attachToVideo(best, true)` 强制切换；
   - best === activeVideo 且在播但管线死（无 analyser/pollTimer）→ `recaptureAudio`。
5. **8 秒静音全量重查**：轮询中视频在播但连续 8s 无语音（限频 10s）→ `fullRecheck()`：重新评分全页视频，不同则切换、相同则重捕。
6. **canplay 兜底**：attach 时 readyState<2 只等一次 canplay，1.5s 后仍未建管线则主动 setupAudio。

**用户实测：还是只能监听到刷新后一两个视频**。

## 6. 当前最可疑的方向（给下一个 AI 的重点）

第二轮的看门狗理论上不依赖事件、每 2s 直接查 DOM，为什么仍失败？可能性按概率排序：

### 假设 A：findBestVideo 评分选不出新视频（最可能）

新版抖音的推荐流可能：
- 新视频的 `<video>` **初始 `paused=true`**，由站点内部控制播放（如通过 MSE 时代理播放状态，或 autoplay 属性但 paused 状态特殊）；
- 或者旧视频元素**从不真正 pause**（UI 层面"切换"但元素层面仍标记为播放中，实际输出被站点静音/隐藏）；
- 或者多个 video 都在"播放中"，旧的那个评分一直更高（面积大、可见——因为往回刷能恢复，说明旧元素在回刷时确实是活动的那一个；但往下刷时旧元素的状态是什么需要实测）。

**验证方法**：在控制台对每个 video 打印 `{paused, currentTime, readyState, getBoundingClientRect, muted, volume, src}`，往下刷一个视频后立刻对比前后快照，看新视频元素到底处于什么状态、旧元素是否真的 paused。

**修复方向**：不要用"paused/面积"评分，改用抖音自己的 DOM 标记：
- 找 `data-e2e="feed-active-video"` 容器（或 `id="sliderVideo"` 且有 `data-e2e="feed-active-video"` 的那个）内的 `<video>`；
- 兜底用 `intersectionRatio`（IntersectionObserver）最大的那个 video；
- 或监听页面 URL hash 变化（抖音切换视频会改 `location.pathname`，如 `/0289b74...` 的 video id）来触发重扫。

### 假设 B：captureStream 在新播放器架构下行为变化

新版 `useNewDyVideoPlayer:2` 可能改用 MSE/WebCodecs（`webcodecRecommend` 灰度也在开启列表里）。MSE 模式下 `captureStream()` 返回的流可能在**换源后音频轨直接失效但 `ended` 不触发**，而重捕 `recaptureAudio` 又因某种条件（比如 `activeVideo !== video` 或 `readyState < 2`）没执行成功。

**验证方法**：看门狗触发 `recaptureAudio` 后加日志确认 `setupAudio` 是否真的走到 `createMediaStreamSource`，以及新流的 `getAudioTracks().length` 和 track.readyState。

**修复方向**：考虑放弃 `captureStream`，改用 `video.getAudioTracks?.()`（部分站点有）或干脆**不检测音频，改为 UI 挂钩**：直接监听抖音自己的倍速菜单/进度条 DOM，或者用 `MediaElementAudioSourceNode`（注意一个元素只能 create 一次，需缓存）。

### 假设 C：content script 的事件被抖音的监听器拦截

抖音 HTML 里有大量安全 SDK（secsdk、sdk-glue、bdms 等）。若 `play` 等事件是 `stopPropagation` 的（非捕获阶段被吞），document 捕获监听其实应该仍能收到（capture 在 target 前触发）……除非站点用 `addEventListener(..., {capture: true})` + `stopImmediatePropagation()`。这能解释 `play` 收不到，但解释不了主动轮询失败，所以只是叠加因素。

### 假设 D：看门狗逻辑 bug

`currentOk` 要求 `!activeVideo.paused && isVisibleVideo(activeVideo)` 才不切换。若旧元素 paused=false 且仍可见（抖音把多个 slide 都渲染在视口外但 rect 不为 0？——用户 HTML 里 slidelist 是 translate3d 位移容器，非活动 slide 的 video rect 可能仍在视口内但面积大），看门狗就不会切换。**这个很值得查**：用户 HTML 显示 slidelist 用 `transform: translate3d(0px, -1954px, 0px)` 整体位移，被刷过的视频可能 rect 仍在窗口内（溢出可见）。

**验证方法**：往下滑后立刻在控制台执行：
```js
[...document.querySelectorAll('video')].map(v => ({
  paused: v.paused, rate: v.playbackRate,
  rect: v.getBoundingClientRect().toJSON().top,
  vis: !!(v.offsetWidth && v.offsetHeight),
  e2e: v.closest('[data-e2e^="feed-"]')?.dataset.e2e
}))
```
把结果对比。若旧视频 rect 仍在视口内且 paused=false（被站点静音播放），则看门狗的 `currentOk` 恒为 true → 永不切换。**修复**：把 `data-e2e="feed-active-video"` 的权重加到评分里，或直接要求目标必须是 active 容器内的 video。

## 7. 当前 content.js 的结构索引（行号近似）

- L4-L73：配置常量、状态变量（含新增 `recaptureTimer`、`deadStreamTicks`、`watchdogTimer`、`lastFullRecheckAt`）
- L127-L148：siteKey / 开关逻辑（按 origin 存 sitePrefs）
- L172-L199：storage 变更监听
- L201-L220：runtime 消息（getStatus/toggle/setEnabled/updateSettings）
- L291-L303：init()（含 startWatchdog）
- L305-L313：全局 play 捕获监听
- L316-L383：isVisibleVideo / findBestVideo（评分制）
- L385-L407：startWatchdog / stopWatchdog / fullRecheck
- L410-L436：mutationTouchesVideo / observeDom
- L438-L453：findAndAttach / attachToVideo（含 1.5s canplay 兜底）
- L455-L522：setupAudio（captureStream → WebAudio 管线，含音轨 ended 监听）
- L524-L546：isSetupCurrent / recaptureAudio
- L548-L573：setupVideoListeners（pause/ended/play/emptied + ratechange + loadeddata/durationchange）
- L575-L600：resetDetector / startPolling / stopPolling
- L602-L680：pollAnalyser（含死流检测、8 秒静音全量重查）
- L682-L695：addLogEntry / applySpeed
- L697-L735：teardownAudio / closeAudioContext
- L737-L760：teardown（含 stopWatchdog）
- L762+：overlay UI（Shadow DOM 面板）

## 8. 复现与调试方法

1. `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选本目录；改动后点刷新图标。
2. 抖音首页（`https://www.douyin.com/?recommend=1`）刷新，等第一个视频开始倍速（角标显示 x.x）。
3. 往下刷 2~3 个视频 → 观察角标是否衰减回 1.0x（故障复现）。
4. 打开 popup 开启「调试日志」，Console 过滤 `[SpeechSpeed]`，关注：
   - `Watchdog: switching video`（看门狗切换是否触发）
   - `Recapturing audio stream on same <video>`（重捕是否触发）
   - `Dead audio stream detected`（死流检测）
   - `fullRecheck: prolonged silence while playing`（静音重查）
5. 故障时在控制台跑第 6 节"假设 D"里的 video 状态快照脚本，把输出发给 AI 分析。

## 9. 给下一个 AI 的建议切入顺序

1. 先跑第 8 节第 5 步的快照脚本，确认失效时各 video 的真实状态（paused/rect/e2e 标记）——**这一步能直接证伪/证实假设 A 或 D**。
2. 若确认是"旧元素假播放"：改 findBestVideo，把 `closest('[data-e2e="feed-active-video"]')` 作为硬性优先条件。
3. 若元素选对了但音频还是死的：查 captureStream 在 MSE 换源后的行为，考虑改用 MediaElementAudioSourceNode（需注意单实例限制）或干脆放弃音频检测改为"固定倍速 + 站点菜单联动"的降级方案。
4. 事件层（ratechange/loadeddata 等）第一轮已加，保留即可，但不要再往事件方向堆代码——已被证明不可靠。

## 10. 附：用户提供的失效时抖音 HTML 关键片段

```html
<!-- 推荐流容器：整体用 transform 位移切换 slide -->
<div id="slidelist" data-active="true" class="... recommend-slidelist">
  <div class="RFe2KjM2 uLD680jl" style="transform: translate3d(0px, -1954px, 0px);">
    <!-- 多个 slide，每个 965px 高 -->
    <div class="... dySwiperSlide ..." data-e2e="feed-item" style="height: 965px">
      <!-- 当前活动视频：data-e2e="feed-active-video" -->
      <div data-e2e="feed-active-video" data-e2e-vid="7700001523137018944" id="sliderVideo" class="... video_7700001523137018944 sliderVideo">
        <div class="... basePlayerContainer ... douyin-recommend-player">
          <div class="douyin-player ...">
            <div class="douyin-player-video-container">
              <video autoplay=""></video>
            </div>
            <!-- 站点自己的倍速菜单（0.75x ~ 3.0x） -->
            <dy-icon class="douyin-player-playback-setting">...</dy-icon>
```

AB 灰度（RENDER_DATA 内）：
```json
"reuseVideo": 2,
"useNewDyVideoPlayer": 2,
"webcodecRecommend": {"open": true, "scene": "recommend"},
"preloadDashLoaderType": 1
```
