<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  defineAsyncComponent,
  nextTick
} from "vue";
import type { WatchStopHandle } from "vue";
import { useWebSocket, useResizeObserver } from "@vueuse/core";
import { useRouteParams } from "@vueuse/router";
import { roomStore } from "@/stores/room";
import { ElNotification, ElMessage } from "element-plus";
import { useMovieApi } from "@/hooks/useMovie";
import { useRoomApi, useRoomPermission } from "@/hooks/useRoom";
import artplayerPluginDanmuku from "artplayer-plugin-danmuku";
import { strLengthLimit, blobToUint8Array, formatTime } from "@/utils";
import { MessageType, Message, Status, messageTypeToJSON } from "@/proto/message";
import type { options } from "@/components/Player.vue";
import RoomInfo from "@/components/cinema/RoomInfo.vue";
import MovieList from "@/components/cinema/MovieList.vue";
import MoviePush from "@/components/cinema/MoviePush.vue";
import { RoomMemberPermission } from "@/types/Room";
import artplayerPluginAss from "@/plugins/artplayer-plugin-ass";
import { newSyncPlugin } from "@/plugins/sync";
import artplayerPluginMediaControl from "@/plugins/control";
import { artplayPluginSource, PLAYER_SOURCE_PLUGIN_NAME } from "@/plugins/source";
import type { PlayerSourcePlugin, ResolvedPlayerSource } from "@/plugins/source";
import { currentMovieApi } from "@/services/apis/movie";
import { userStore } from "@/stores/user";
import { roomInfoApi } from "@/services/apis/room";
import { artplayerSubtitle } from "@/plugins/subtitle";
import type { SubtitleCoordinator } from "@/plugins/subtitle";
import {
  artplayerEmbeddedSubtitle,
  EMBEDDED_SUBTITLE_PLUGIN_NAME
} from "@/plugins/embeddedSubtitle/artplayerBridge";
import type { EmbeddedSubtitleBridge } from "@/plugins/embeddedSubtitle/artplayerBridge";
import {
  buildPlayerSourceDescriptors,
  createRefreshGuard,
  EMBEDDED_SUBTITLE_FAILURE_MESSAGE,
  movieIdentity,
  restoredTrackId
} from "@/plugins/playerSources";
import { sendDanmu, artplayerStreamDanmu } from "@/plugins/danmu";
import { indexStore } from "@/stores";

const { settings } = indexStore();

const Player = defineAsyncComponent(() => import("@/components/Player.vue"));

const { token } = userStore();
// 获取房间信息
const room = roomStore();
const roomID = useRouteParams<string>("roomId");

const watchers: WatchStopHandle[] = [];
onBeforeUnmount(() => {
  watchers.forEach((w) => w());
});

const { getMovies, getCurrentMovie, isLoadingCurrent } = useMovieApi(token.value, roomID.value);
const { getMyInfo, myInfo } = useRoomApi();
const { state: roomInfo, execute: reqRoomInfoApi } = roomInfoApi();
const { hasMemberPermission } = useRoomPermission();

let player: Artplayer | undefined;

const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
const { status, data, send, open } = useWebSocket(
  `${wsProtocol}//${window.location.host}/api/room/ws?roomId=${roomID.value}`,
  {
    ...(token.value ? { protocols: [token.value] } : {}),
    autoReconnect: {
      retries: 3,
      delay: 1000,
      onFailed() {
        ElMessage.error("Websocket 自动重连失败！");
      }
    },
    autoClose: true,
    immediate: false
  }
);

const sendElement = (msg: Message) => {
  if (!msg.timestamp) {
    msg.timestamp = Date.now();
  }
  console.groupCollapsed("Ws Send");
  console.log(messageTypeToJSON(msg.type));
  console.log(msg);
  console.groupEnd();
  return send(Message.encode(msg).finish() as any, false);
};

// 消息列表
const chatMsgList = ref<string[]>([]);
const sendChatText = (msg: string, onSuccess?: () => any, onFailed?: () => any) => {
  if (msg.length === 0) {
    ElMessage({
      message: "发送的消息不能为空",
      type: "warning"
    });
    if (onFailed) onFailed();
    return;
  }

  strLengthLimit(msg, 4096);
  sendElement(
    Message.create({
      type: MessageType.CHAT,
      chatContent: msg
    })
  );
  if (onSuccess) onSuccess();
};

const sendChatMsg_ = ref("");
const onSendSuccess = () => {
  sendChatMsg_.value = "";
};

const MAX_MESSAGE_COUNT = 64; // 设定聊天记录的最大长度
const sendMsg = (msg: string) => {
  chatMsgList.value.push(msg);
  // 如果超过聊天记录最大长度，则从前面开始删除多余的消息
  nextTick(() => {
    if (chatMsgList.value.length > MAX_MESSAGE_COUNT) {
      chatMsgList.value.splice(0, chatMsgList.value.length - MAX_MESSAGE_COUNT);
    }
    // 将新消息存储到 sessionStorage
    sessionStorage.setItem(`chatMessages-${roomID}`, JSON.stringify(chatMsgList.value));
  });

  // 确保聊天区域滚动到底部
  nextTick(() => {
    if (chatArea.value) chatArea.value.scrollTop = chatArea.value.scrollHeight;
  });
};

/**
 * Identity of the option build that produced the live player. Plugin callbacks
 * capture their own build token and compare against this, so a callback owned
 * by a discarded or superseded build can never write into the current menu.
 * The computed only records the newest build; the token is promoted in
 * `getPlayerInstance`, which is the real instance lifecycle event.
 */
let latestOptionToken: object | null = null;
let activeOptionToken: object | null = null;

/**
 * Plugin lookups always go through the live `player` instance: `playerOption`
 * is a computed, so a rebuilt player replaces every plugin object and cached
 * references would point at a destroyed instance.
 */
const sourcePlugin = (): PlayerSourcePlugin | null => {
  try {
    return (player?.plugins?.[PLAYER_SOURCE_PLUGIN_NAME] as PlayerSourcePlugin | undefined) ?? null;
  } catch {
    return null;
  }
};

const embeddedBridge = (): EmbeddedSubtitleBridge | null => {
  try {
    return (
      (player?.plugins?.[EMBEDDED_SUBTITLE_PLUGIN_NAME] as EmbeddedSubtitleBridge | undefined) ??
      null
    );
  } catch {
    return null;
  }
};

const subtitleCoordinator = (): SubtitleCoordinator | null => {
  try {
    return (player?.plugins?.["artplayerSubtitle"] as SubtitleCoordinator | undefined) ?? null;
  } catch {
    return null;
  }
};

/** Fixed text only: media URLs and tokens must never reach the UI or console. */
const notifyEmbeddedSubtitleFailure = () => {
  ElNotification({
    title: EMBEDDED_SUBTITLE_FAILURE_MESSAGE,
    type: "warning"
  });
};

/**
 * Invalidates the embedded subtitle state of the source being replaced. This is
 * awaited by the source plugin before `art.url` is written, so it must never
 * touch the network: `updateSource(null)` bumps the controller generation and
 * clears tracks/renderer synchronously, and only its resource cleanup is async,
 * so the promise is deliberately not awaited. A hanging Range request must
 * never be able to block a source switch.
 */
const invalidateEmbeddedSourceBeforeSwitch = () => {
  const bridge = embeddedBridge();
  if (!bridge) return;
  void bridge.updateSource(null).then(
    () => undefined,
    () => undefined
  );
};

/**
 * Points the bridge at the source that is now playing and starts discovery.
 * Tracks reach the menu through `onTracksChanged`, which is generation guarded,
 * so nothing is written into the coordinator from here.
 */
const applyEmbeddedSourceAfterSwitch = async (next: ResolvedPlayerSource) => {
  const bridge = embeddedBridge();
  if (!bridge || !next.embeddedSubtitle) return;
  try {
    await bridge.updateSource(next.embeddedSubtitle);
  } catch {
    // Fail-open: embedded subtitles stay off for this source.
  }
};

const playerOption = computed<options>(() => {
  const optionToken = {};
  latestOptionToken = optionToken;
  if (!room.currentMovie.base!.url) {
    return {
      url: ""
    };
  }
  let option: options = {
    url: room.currentMovie.base!.url,
    type: room.currentMovie.base!.type,
    isLive: room.currentMovie.base!.live,
    headers: room.currentMovie.base!.headers,
    p2pZone: settings?.p2pZone,
    plugins: [
      // 弹幕
      artplayerPluginDanmuku({
        danmuku: room.currentMovie.base!.danmu || [],
        speed: 8,
        async beforeEmit(danmu: any) {
          if (danmu.direct) {
            return true;
          }
          sendChatText(danmu.text);
          return false;
        }
      }),
      // WARN: room.currentStatus 变了会导致重载
      newSyncPlugin(sendElement, room.currentStatus, () => room.currentExpireId),
      artplayerPluginMediaControl()
    ]
  };

  const descriptors = buildPlayerSourceDescriptors(room.currentMovie.base!);
  const embeddedSource = descriptors[0]?.embeddedSubtitle ?? null;
  const embeddedCapable = descriptors.some((item) => item.embeddedSubtitle !== null);

  if (room.currentMovie.base!.moreSources) {
    option.plugins!.push(
      artplayPluginSource(descriptors, {
        // Runs before `art.url` is written so the bridge never reads packets
        // from the source that is being replaced.
        beforeSwitch: () => invalidateEmbeddedSourceBeforeSwitch(),
        afterSwitch: (next) => applyEmbeddedSourceAfterSwitch(next)
      })
    );
  }

  // Registered whenever ANY source slot can host embedded subtitles. A null
  // initial source performs zero discovery, so no Range probe is issued until a
  // capable source actually starts playing.
  if (embeddedCapable) {
    option.plugins!.push(
      artplayerEmbeddedSubtitle({
        source: embeddedSource,
        onTracksChanged: (tracks) => {
          if (optionToken !== activeOptionToken) return;
          subtitleCoordinator()?.updateEmbeddedTracks(tracks);
        },
        onFailure: () => {
          if (optionToken !== activeOptionToken) return;
          notifyEmbeddedSubtitleFailure();
        }
      })
    );
  }

  const subtitles = room.currentMovie.base!.subtitles;

  // The coordinator owns the whole subtitle menu, so it must also be present for
  // a pure embedded-subtitle MKV that ships no external subtitles at all.
  if (subtitles || embeddedCapable) {
    let defaultUrl;
    let useAssPlugin = false;

    // deep copy
    const subtitle = Object.assign({}, subtitles);

    for (let key in subtitle) {
      if (subtitle[key].type === "ass") {
        useAssPlugin = true;
        defaultUrl = subtitle[key].url;
        break;
      }
    }

    option.plugins!.push(
      artplayerSubtitle(subtitle, {
        getEmbeddedBridge: embeddedBridge,
        embeddedEnabled: embeddedCapable
      })
    );
    // return;
    useAssPlugin &&
      option.plugins!.push(
        artplayerPluginAss({
          // debug: true,
          subUrl: defaultUrl
        })
      );
  }

  if (room.currentMovie.base!.streamDanmu) {
    option.plugins!.push(artplayerStreamDanmu(room.currentMovie.base!.streamDanmu));
  }

  return option;
});

const { state: currentMovie, execute: reqCurrentMovieApi } = currentMovieApi();

/** Overlapping EXPIRED refreshes: only the newest response may be applied. */
const refreshGuard = createRefreshGuard();

/**
 * Re-points the embedded bridge at the refreshed URL of the source that is
 * currently playing and restores the previously selected track when it survived
 * the refresh. Ineligible sources are disabled instead of probed.
 */
const reapplyEmbeddedSourceAfterRefresh = async (
  source: ResolvedPlayerSource | null,
  refreshToken: number,
  identity: string
) => {
  const bridge = embeddedBridge();
  if (!bridge) return;

  const stillCurrent = () =>
    refreshGuard.isCurrent(refreshToken, identity) && movieIdentity(room.currentMovie) === identity;

  const previousTrackId = bridge.selectedTrack?.id ?? null;

  if (!source?.embeddedSubtitle) {
    try {
      await bridge.disable();
      if (!stillCurrent()) return;
      await bridge.updateSource(null);
    } catch {
      // Fail-open.
    }
    if (!stillCurrent()) return;
    subtitleCoordinator()?.updateEmbeddedTracks([]);
    return;
  }

  try {
    const tracks = await bridge.updateSource(source.embeddedSubtitle);
    if (!stillCurrent()) return;
    subtitleCoordinator()?.updateEmbeddedTracks(tracks);
    const restored = restoredTrackId(previousTrackId, tracks);
    if (restored) {
      if (!stillCurrent()) return;
      await bridge.selectTrack(restored);
    }
  } catch {
    // Fail-open: embedded subtitles turn off, playback continues.
  }
};

const updateSources = async () => {
  const identity = movieIdentity(room.currentMovie);
  const refreshToken = refreshGuard.begin(identity);
  try {
    await reqCurrentMovieApi({
      headers: { Authorization: token.value, "X-Room-Id": roomID.value }
    });
    if (!currentMovie.value) return;
    // A newer refresh started, or the room moved to another movie while this
    // request was in flight: the whole response is stale and must be dropped.
    if (!refreshGuard.isCurrent(refreshToken, movieIdentity(room.currentMovie))) return;
    if (currentMovie.value.movie.base.url.startsWith("/")) {
      currentMovie.value.movie.base.url = `${window.location.origin}${currentMovie.value.movie.base.url}`;
    }
    if (
      currentMovie.value.movie.base.moreSources &&
      currentMovie.value.movie.base.moreSources.length > 0
    ) {
      for (let i = 0; i < currentMovie.value.movie.base.moreSources.length; i++) {
        if (currentMovie.value.movie.base.moreSources[i].url.startsWith("/")) {
          currentMovie.value.movie.base.moreSources[
            i
          ].url = `${window.location.origin}${currentMovie.value.movie.base.moreSources[i].url}`;
        }
      }
    }
    // Updated before any player work so the expire id stays fresh even when no
    // player is mounted.
    room.currentExpireId = currentMovie.value.expireId;
    if (!player) return;

    const base = currentMovie.value.movie.base;
    const descriptors = buildPlayerSourceDescriptors(base);
    const sources = sourcePlugin();

    if (sources) {
      // Restores by key, not by label: the source plugin re-runs beforeSwitch /
      // afterSwitch, which re-points the bridge at the refreshed URL.
      sources.updateSources(descriptors);
    } else {
      // Single-source movies have no source plugin, so the bridge has to be
      // re-pointed here.
      await reapplyEmbeddedSourceAfterRefresh(descriptors[0] ?? null, refreshToken, identity);
    }

    if (!refreshGuard.isCurrent(refreshToken, movieIdentity(room.currentMovie))) return;
    // EXPIRED also rotates external subtitle URLs.
    subtitleCoordinator()?.updateSubtitles(base.subtitles ?? {});
  } catch (err: any) {
    ElNotification({
      title: "获取影片列表失败",
      message: err?.response?.data?.error ?? err?.message ?? "未知错误",
      type: "error"
    });
  }
};

const getPlayerInstance = (art: Artplayer) => {
  activeOptionToken = latestOptionToken;
  player = art;
  listenPlayerType(player);
  startEmbeddedSubtitleDiscovery(art);
};

/**
 * Discovery is kicked off after `ready` so the media element and the subtitle
 * plumbing exist. Tracks reach the menu through `onTracksChanged`, so the
 * returned value is only used to keep the promise handled.
 */
const startEmbeddedSubtitleDiscovery = (art: Artplayer) => {
  art.once("ready", () => {
    const bridge =
      (art.plugins?.[EMBEDDED_SUBTITLE_PLUGIN_NAME] as EmbeddedSubtitleBridge | undefined) ?? null;
    if (!bridge) return;
    void bridge.discover().then(
      () => undefined,
      () => undefined
    );
  });
};

const playType = ref<string | undefined>();

const listenPlayerType = (player: Artplayer) => {
  player.once("ready", () => {
    playType.value = player?.option.type;
    player.on("restart", () => {
      playType.value = player?.option.type;
    });
    player.on("destroy", () => {
      playType.value = undefined;
    });
  });
};

const setPlayerStatus = (status: Status) => {
  if (!player) return;
  player.plugins["syncPlugin"].setAndNoPublishStatus(status);
};

// key: userId:connId
const peerConnections = ref<{ [key: string]: RTCPeerConnection }>({});
const localStream = ref<MediaStream | undefined>(undefined);
let remoteAudioElements: { [key: string]: HTMLAudioElement } = {};

const peerConnectionsLengthWithUserId = computed(() => {
  const userIdSet = new Set(Object.keys(peerConnections.value).map((key) => key.split(":")[0]));
  return userIdSet.size;
});

// 音频设备列表
const audioInputDevices = ref<MediaDeviceInfo[]>([]);
const audioOutputDevices = ref<MediaDeviceInfo[]>([]);
const selectedAudioInput = ref("");
const selectedAudioOutput = ref("");

const outputVolume = ref(1.0); // 扬声器音量
const isMuted = ref(false); // 麦克风静音状态

// 获取音频设备列表
const getAudioDevices = async () => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  audioInputDevices.value = devices.filter((device) => device.kind === "audioinput");
  audioOutputDevices.value = devices.filter((device) => device.kind === "audiooutput");
};

// 切换麦克风静音状态
const toggleMute = () => {
  if (!localStream.value) return;
  isMuted.value = !isMuted.value;
  localStream.value.getAudioTracks().forEach((track) => {
    track.enabled = !isMuted.value;
  });
};

// 切换麦克风
const switchMicrophone = async () => {
  if (!localStream.value) return;

  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: selectedAudioInput.value,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // 停止旧轨道
    localStream.value.getTracks().forEach((track) => track.stop());

    // 替换所有PeerConnection中的轨道
    const [audioTrack] = newStream.getTracks();
    audioTrack.enabled = !isMuted.value; // 保持当前的静音状态

    for (const pc of Object.values(peerConnections.value)) {
      const sender = pc.getSenders().find((s: any) => s.track?.kind === "audio");
      if (sender) {
        await sender.replaceTrack(audioTrack);
      }
    }

    localStream.value = newStream;
  } catch (err) {
    ElMessage.error(`切换麦克风失败: ${err}`);
  }
};

// 切换扬声器
const switchSpeaker = async () => {
  try {
    for (const audio of Object.values(remoteAudioElements)) {
      if ("setSinkId" in audio) {
        await (audio as any).setSinkId(selectedAudioOutput.value);
        audio.volume = outputVolume.value;
      }
    }
  } catch (err) {
    ElMessage.error(`切换扬声器失败: ${err}`);
  }
};

// 调整扬声器音量
const adjustOutputVolume = () => {
  Object.values(remoteAudioElements).forEach((audio) => {
    audio.volume = outputVolume.value;
  });
};

const joinWebRTC = async () => {
  try {
    await getAudioDevices();
    localStream.value = await navigator.mediaDevices.getUserMedia({
      audio: selectedAudioInput.value ? { deviceId: selectedAudioInput.value } : true
    });
  } catch (err) {
    ElMessage.error(`获取媒体流失败！${err}`);
    return;
  }
  await sendElement(
    Message.create({
      type: MessageType.WEBRTC_JOIN
    })
  );
};

const exitWebRTC = async () => {
  await sendElement(
    Message.create({
      type: MessageType.WEBRTC_LEAVE
    })
  );
  for (const id in peerConnections.value) {
    const pc = peerConnections.value[id];
    pc.close();
    delete peerConnections.value[id];
  }
  localStream.value!.getTracks().forEach((track) => track.stop());
  localStream.value = undefined;
};

const handleWebrtcJoin = async (msg: Message) => {
  const pc = createPeerConnection(msg.webrtcData!.from);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendElement(
    Message.create({
      type: MessageType.WEBRTC_OFFER,
      webrtcData: {
        data: JSON.stringify(offer),
        to: msg.webrtcData!.from
      }
    })
  );
};

const handleWebrtcLeave = async (msg: Message) => {
  closePeerConnection(msg.webrtcData!.from);
};

const closePeerConnection = (id: string) => {
  const pc = peerConnections.value[id];
  if (pc) {
    pc.close();
    delete peerConnections.value[id];
  }
  const remoteAudio = remoteAudioElements[id];
  if (remoteAudio) {
    remoteAudio.pause();
    remoteAudio.srcObject = null;
    delete remoteAudioElements[id];
  }
};

const handleWebrtcOffer = async (msg: Message) => {
  const data = JSON.parse(msg.webrtcData!.data);
  const pc = createPeerConnection(msg.webrtcData!.from);
  await pc.setRemoteDescription(new RTCSessionDescription(data));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  // 将Answer发送给发送Offer的用户
  sendElement(
    Message.create({
      type: MessageType.WEBRTC_ANSWER,
      webrtcData: {
        data: JSON.stringify(answer),
        to: msg.webrtcData!.from
      }
    })
  );
};

const createPeerConnection = (id: string) => {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    iceCandidatePoolSize: 10
  });
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendElement(
        Message.create({
          type: MessageType.WEBRTC_ICE_CANDIDATE,
          webrtcData: {
            data: JSON.stringify(event.candidate),
            to: id
          }
        })
      );
    }
  };
  pc.ontrack = (event) => {
    const remoteAudio = document.createElement("audio");
    remoteAudio.srcObject = event.streams[0];
    remoteAudio.volume = outputVolume.value;
    if (selectedAudioOutput.value && "setSinkId" in remoteAudio) {
      (remoteAudio as any).setSinkId(selectedAudioOutput.value).catch((error: any) => {
        console.error("扬声器设置失败:", error);
      });
    }
    remoteAudio.style.display = "none";
    remoteAudio.onended = () => {
      document.body.removeChild(remoteAudio);
      delete remoteAudioElements[id];
    };
    remoteAudioElements[id] = remoteAudio;
    remoteAudio.play().catch((error) => {
      console.error("Audio playback failed:", error);
    });
  };

  localStream.value!.getTracks().forEach((track) => pc.addTrack(track, localStream.value!));
  peerConnections.value[id] = pc;
  return pc;
};

const handleWebrtcAnswer = async (msg: Message) => {
  const data = JSON.parse(msg.webrtcData!.data);
  const pc = peerConnections.value[msg.webrtcData!.from];
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(data));
};

const handleWebrtcIceCandidate = async (msg: Message) => {
  const data: RTCIceCandidateInit = JSON.parse(msg.webrtcData!.data);
  const pc = peerConnections.value[msg.webrtcData!.from];
  if (!pc) return;
  await pc.addIceCandidate(new RTCIceCandidate(data));
};

const handleElementMessage = (msg: Message) => {
  console.groupCollapsed("Ws Message");
  console.log(messageTypeToJSON(msg.type));
  console.info(msg);
  console.groupEnd();
  switch (msg.type) {
    case MessageType.ERROR: {
      console.error(msg.errorMessage);
      ElNotification({
        title: "错误",
        message: msg.errorMessage,
        type: "error"
      });
      break;
    }

    case MessageType.WEBRTC_JOIN: {
      handleWebrtcJoin(msg);
      break;
    }
    case MessageType.WEBRTC_LEAVE: {
      handleWebrtcLeave(msg);
      break;
    }
    case MessageType.WEBRTC_OFFER: {
      handleWebrtcOffer(msg);
      break;
    }
    case MessageType.WEBRTC_ANSWER: {
      handleWebrtcAnswer(msg);
      break;
    }
    case MessageType.WEBRTC_ICE_CANDIDATE: {
      handleWebrtcIceCandidate(msg);
      break;
    }

    // 聊天消息
    case MessageType.CHAT: {
      if (!msg.chatContent) {
        return;
      }
      const currentTime = formatTime(new Date()); // 格式化时间
      const senderName = msg.sender?.username;
      const messageContent = `${senderName}: ${msg.chatContent}`;
      const messageWithTime = `${messageContent} <small>[${currentTime}]</small>`;
      // 添加消息到消息列表
      sendMsg(messageWithTime);
      sendDanmu({ text: messageContent, border: true }, player);
      break;
    }
    case MessageType.STATUS:
    case MessageType.CHECK_STATUS:
    case MessageType.SYNC: {
      switch (msg.type) {
        case MessageType.CHECK_STATUS:
          ElNotification({
            title: "状态不同步，同步中...",
            type: "warning"
          });
          break;
        case MessageType.SYNC:
          ElNotification({
            title: "同步成功",
            type: "success"
          });
          break;
      }
      setPlayerStatus(msg.playbackStatus!);
      break;
    }

    case MessageType.EXPIRED: {
      ElNotification({
        title: "链接过期,刷新中",
        type: "info"
      });
      void updateSources().catch(() => undefined);
      break;
    }

    // 设置正在播放的影片
    case MessageType.CURRENT: {
      getCurrentMovie();
      break;
    }

    // 播放列表更新
    case MessageType.MOVIES: {
      // 如果有权限则获取
      if (can(RoomMemberPermission.PermissionGetMovieList)) getMovies();
      break;
    }

    case MessageType.VIEWER_COUNT: {
      room.viewerCount = msg.viewerCount!;
      break;
    }

    case MessageType.MY_STATUS: {
      try {
        getMyInfo(roomID.value);
      } catch (err: any) {
        console.error(err);
        ElNotification({
          title: "错误",
          message: err.response.data.error || err.message,
          type: "error"
        });
        return;
      }
      break;
    }
  }
};

const noPlayArea = ref();
const playArea = ref();

// 消息区域
const chatArea = ref();

// 设置聊天框高度
const resetChatAreaHeight = () => {
  const h = playArea.value ? playArea : noPlayArea;
  if (!chatArea.value || !h.value) return;

  // 计算基础高度
  let baseHeight = h.value.scrollHeight - 112;

  // 如果有语音控制面板,减去其高度
  if (audioControls.value && audioControls.value instanceof HTMLElement) {
    baseHeight -= audioControls.value.offsetHeight + 16; // 16px for margin
  }

  chatArea.value.style.height = `${baseHeight}px`;
};

const card = ref(null);
useResizeObserver(card, resetChatAreaHeight);

const audioControls = ref<HTMLElement | null>(null);
useResizeObserver(audioControls, resetChatAreaHeight);

const can = (p: RoomMemberPermission) => {
  if (!myInfo.value) return;
  const myP = myInfo.value.permissions;
  return hasMemberPermission(myP, p);
};

const p = async () => {
  if (can(RoomMemberPermission.PermissionGetMovieList)) await getMovies();
  await getCurrentMovie();
};

onMounted(async () => {
  // 获取房间信息
  try {
    await reqRoomInfoApi({
      headers: { Authorization: token.value, "X-Room-Id": roomID.value }
    });
  } catch (err: any) {
    console.error(err);
    ElNotification({
      title: "错误",
      message: err.response.data.error || err.message,
      type: "error"
    });
    return;
  }

  // 获取用户信息
  try {
    await getMyInfo(roomID.value);
  } catch (err: any) {
    console.error(err);
    ElNotification({
      title: "错误",
      message: err.response.data.error || err.message,
      type: "error"
    });
    return;
  }

  // 从 sessionStorage 获取存储的聊天消息
  const storedMessages = sessionStorage.getItem(`chatMessages-${roomID}`);
  if (storedMessages) {
    chatMsgList.value = JSON.parse(storedMessages);
  }

  // 启动websocket连接
  open();

  // 监听ws信息变化
  watchers.push(
    watch(
      () => data.value,
      async () => {
        try {
          const arr = await blobToUint8Array(data.value);
          handleElementMessage(Message.decode(arr));
        } catch (err: any) {
          console.error(err);
          ElMessage.error(err.message);
        }
      }
    )
  );

  await p();

  // 获取初始音频设备列表
  await getAudioDevices();

  // 监听设备变化
  navigator.mediaDevices.addEventListener("devicechange", getAudioDevices);
});

onBeforeUnmount(() => {
  navigator.mediaDevices.removeEventListener("devicechange", getAudioDevices);
  // Player.vue destroys the instance on unmount too, which tears the bridge
  // down via Artplayer's `destroy` event. This is the belt-and-braces path for
  // when Cinema unmounts before the child component does.
  const bridge = embeddedBridge();
  player = undefined;
  if (bridge) {
    void bridge.destroy().then(
      () => undefined,
      () => undefined
    );
  }
});
</script>

<template>
  <el-row :gutter="20">
    <el-col :md="18" class="mb-5 max-sm:my-2">
      <div class="card" ref="card">
        <div
          class="card-title flex flex-wrap justify-between max-sm:text-sm max-sm:pb-4"
          v-if="playerOption.url"
        >
          <el-tag v-if="playType">{{ playType }}</el-tag>
          {{ room.currentMovie.base!.name }}
          <small class="ml-2">👁‍🗨 {{ room.viewerCount }} </small>
        </div>
        <div class="card-title flex flex-wrap justify-between max-sm:text-sm" v-else>
          当前没有影片播放，快去添加几部吧~<small class="font-normal"
            >👁‍🗨 {{ room.viewerCount }}
          </small>
        </div>
        <div class="card-body max-sm:p-0 pb-4" ref="playArea" v-if="playerOption.url">
          <div class="art-player">
            <Player @get-instance="getPlayerInstance" :options="playerOption"></Player>
          </div>
        </div>
        <div class="card-body max-sm:pb-3 max-sm:px-3" ref="noPlayArea" v-else>
          <div v-if="isLoadingCurrent" class="flex justify-center items-center h-[550px]">
            <div class="loading-spinner">
              <div class="bounce1"></div>
              <div class="bounce2"></div>
              <div class="bounce3"></div>
            </div>
          </div>
          <img v-else class="mx-auto" src="/src/assets/something-lost.webp" />
        </div>
      </div>
    </el-col>
    <el-col :md="6" class="mb-5 max-sm:mb-2">
      <div class="card h-full">
        <div class="card-title">
          在线聊天
          <el-button
            v-if="!localStream && can(RoomMemberPermission.PermissionWebRTC)"
            @click="joinWebRTC"
            type="primary"
            size="small"
            style="float: right"
            >加入语音</el-button
          >
          <el-button
            v-else-if="localStream && can(RoomMemberPermission.PermissionWebRTC)"
            @click="exitWebRTC"
            type="primary"
            size="small"
            style="float: right"
            >退出语音 ({{ peerConnectionsLengthWithUserId }})</el-button
          >
        </div>
        <div
          ref="audioControls"
          v-show="localStream"
          class="card-body mb-2 audio-controls-container"
        >
          <div class="audio-controls">
            <el-select
              v-model="selectedAudioInput"
              placeholder="选择麦克风"
              @change="switchMicrophone"
            >
              <el-option
                v-for="device in audioInputDevices"
                :key="device.deviceId"
                :label="device.label || `麦克风 ${device.deviceId.slice(0, 8)}`"
                :value="device.deviceId"
              />
            </el-select>

            <el-select
              v-model="selectedAudioOutput"
              placeholder="选择扬声器"
              @change="switchSpeaker"
            >
              <el-option
                v-for="device in audioOutputDevices"
                :key="device.deviceId"
                :label="device.label || `扬声器 ${device.deviceId.slice(0, 8)}`"
                :value="device.deviceId"
              />
            </el-select>

            <div class="volume-control">
              <span>扬声器音量:</span>
              <el-slider
                v-model="outputVolume"
                :min="0"
                :max="1"
                :step="0.1"
                @change="adjustOutputVolume"
              />
            </div>

            <el-button
              @click="toggleMute"
              :type="isMuted ? 'danger' : 'primary'"
              size="small"
              style="width: 100%"
            >
              {{ isMuted ? "取消闭麦" : "闭麦" }}
            </el-button>
          </div>
        </div>
        <div class="card-body mb-2">
          <div class="chatArea" ref="chatArea">
            <div class="message" v-for="item in chatMsgList" :key="item">
              <div v-html="item"></div>
            </div>
          </div>
        </div>
        <div
          v-if="can(RoomMemberPermission.PermissionSendChatMessage)"
          class="card-footer"
          style="justify-content: center; padding: 0.5rem"
        >
          <input
            type="text"
            @keyup.enter="() => sendChatText(sendChatMsg_, onSendSuccess)"
            v-model="sendChatMsg_"
            placeholder="按 Enter 键即可发送..."
            class="l-input w-full bg-transparent"
            autocomplete="off"
          />
          <button
            class="btn w-24 m-2.5 ml-0"
            @click="() => sendChatText(sendChatMsg_, onSendSuccess)"
          >
            发送
          </button>
        </div>
      </div>
    </el-col>
  </el-row>

  <el-row :gutter="20">
    <!-- 房间信息 -->
    <el-col :lg="6" :md="8" :sm="9" :xs="24" class="mb-5 max-sm:mb-2">
      <RoomInfo v-if="roomInfo" :status="status" :token="token" :roomId="roomID" :info="roomInfo" />
    </el-col>

    <!-- 影片列表 -->
    <el-col
      v-if="can(RoomMemberPermission.PermissionGetMovieList)"
      :lg="12"
      :md="16"
      :sm="15"
      :xs="24"
      class="mb-5 max-sm:mb-2"
    >
      <MovieList @send-msg="sendMsg" :token="token" :roomId="roomID" />
    </el-col>

    <!-- 添加影片 -->
    <el-col
      v-if="can(RoomMemberPermission.PermissionAddMovie)"
      :lg="6"
      :md="14"
      :xs="24"
      class="mb-5 max-sm:mb-2"
    >
      <MoviePush :token="token" :roomId="roomID" />
    </el-col>
  </el-row>
</template>

<style lang="less" scoped>
.chatArea {
  overflow-y: scroll;
  height: 67vh;
  transition: height 0.3s ease;
}

.loading-spinner {
  margin: 0 auto;
  width: 70px;
  text-align: center;

  > div {
    width: 18px;
    height: 18px;
    background-color: #409eff;
    border-radius: 100%;
    display: inline-block;
    animation: bounce 1.4s infinite ease-in-out both;
    margin: 0 3px;
  }

  .bounce1 {
    animation-delay: -0.32s;
  }

  .bounce2 {
    animation-delay: -0.16s;
  }
}

.audio-controls-container {
  transition: all 0.3s ease-in-out;
  transform-origin: top;
  animation: slideDown 0.3s ease-in-out;
}

.audio-controls {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 10px;

  .el-select {
    width: 100%;
    animation: fadeIn 0.3s ease-in-out;
  }

  .volume-control {
    animation: fadeIn 0.3s ease-in-out 0.1s;
  }

  .el-button {
    animation: fadeIn 0.3s ease-in-out 0.2s;
  }
}

@keyframes slideDown {
  from {
    transform: scaleY(0);
    opacity: 0;
  }
  to {
    transform: scaleY(1);
    opacity: 1;
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes bounce {
  0%,
  80%,
  100% {
    transform: scale(0);
  }
  40% {
    transform: scale(1);
  }
}
</style>
