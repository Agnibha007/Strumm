import { EventDispatcher } from "./EventDispatcher";
import { WebSocketClient } from "./WebSocketClient";
import { getRoomIceServers } from "./iceServers";

type VoiceSignal = { channel: "voice"; type: "offer" | "answer" | "candidate"; value: RTCSessionDescriptionInit | RTCIceCandidateInit };

export class RoomVoiceChat {
  private peers = new Map<string, RTCPeerConnection>();
  private pendingOffers = new Map<string, RTCSessionDescriptionInit>();
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  private stream: MediaStream | null = null;
  private remoteAudio = new Map<string, HTMLAudioElement>();
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dispatch = EventDispatcher.getInstance();
  private readonly ws = WebSocketClient.getInstance();
  private disposed = false;
  private readonly unsubscribePeers: () => void;
  private readonly unsubscribeSignal: () => void;

  constructor(private roomId: string, private deviceId: string, private onOffer: (available: boolean) => void) {
    this.unsubscribePeers = this.dispatch.on("room:peers", (data) => {
      if (data?.roomId !== this.roomId || !this.stream) return;
      for (const peer of (data.peers || []) as Array<{ deviceId: string }>) {
        if (this.deviceId < peer.deviceId && !this.peers.has(peer.deviceId)) void this.offer(peer.deviceId).catch(() => undefined);
      }
    });
    this.unsubscribeSignal = this.dispatch.on("room:signal", (data) => {
      if (data?.roomId !== this.roomId || data?.signal?.channel !== "voice" || typeof data.fromDeviceId !== "string") return;
      void this.handleSignal(data.fromDeviceId, data.signal).catch(() => undefined);
    });
  }

  private signal(targetDeviceId: string, signal: VoiceSignal) {
    this.ws.send("room:signal", { roomId: this.roomId, targetDeviceId, signal });
  }

  private async createPeer(peerId: string) {
    const iceServers = await getRoomIceServers(this.roomId);
    if (this.disposed) throw new Error("Room voice chat has been disposed");
    const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });
    this.peers.set(peerId, pc);
    pc.onicecandidate = (event) => {
      if (event.candidate) this.signal(peerId, { channel: "voice", type: "candidate", value: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) return;
      let audio = this.remoteAudio.get(peerId);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        audio.srcObject = stream;
        this.remoteAudio.set(peerId, audio);
      }
      void audio.play().catch(() => undefined);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        const timer = this.disconnectTimers.get(peerId);
        if (timer) clearTimeout(timer);
        this.disconnectTimers.delete(peerId);
      } else if (pc.connectionState === "disconnected") {
        if (!this.disconnectTimers.has(peerId)) {
          const timer = setTimeout(() => {
            this.disconnectTimers.delete(peerId);
            if (pc.connectionState === "disconnected") this.recoverPeer(peerId, pc);
          }, 10000);
          this.disconnectTimers.set(peerId, timer);
        }
      } else if (pc.connectionState === "failed") {
        this.recoverPeer(peerId, pc);
      } else if (pc.connectionState === "closed") {
        this.closePeer(peerId);
      }
    };
    return pc;
  }

  async start() {
    if (this.disposed || this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  }

  private async offer(peerId: string) {
    if (!this.stream || this.peers.has(peerId) || this.disposed) return;
    const pc = await this.createPeer(peerId);
    try {
      for (const track of this.stream.getAudioTracks()) pc.addTrack(track, this.stream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signal(peerId, { channel: "voice", type: "offer", value: offer });
    } catch (error) {
      this.closePeer(peerId);
      throw error;
    }
  }

  async accept(peerId?: string) {
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    }
    const entries = peerId ? [[peerId, this.pendingOffers.get(peerId)] as const] : [...this.pendingOffers.entries()];
    for (const [from, offer] of entries) {
      if (!offer || this.disposed) continue;
      this.discardPeerConnection(from);
      const pc = await this.createPeer(from);
      await pc.setRemoteDescription(offer);
      await this.flushCandidates(from, pc);
      for (const track of this.stream.getAudioTracks()) pc.addTrack(track, this.stream);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signal(from, { channel: "voice", type: "answer", value: answer });
      this.pendingOffers.delete(from);
    }
    this.onOffer(this.pendingOffers.size > 0);
    this.ws.subscribeRoom(this.roomId, this.deviceId);
  }

  private async handleSignal(peerId: string, signal: VoiceSignal) {
    if (this.disposed) return;
    const pc = this.peers.get(peerId);
    if (signal.type === "offer") {
      this.pendingOffers.set(peerId, signal.value as RTCSessionDescriptionInit);
      if (this.stream) void this.accept(peerId).catch(() => undefined);
      else this.onOffer(true);
    } else if (signal.type === "answer" && pc) {
      await pc.setRemoteDescription(signal.value as RTCSessionDescriptionInit);
      await this.flushCandidates(peerId, pc);
    } else if (signal.type === "candidate") {
      const candidate = signal.value as RTCIceCandidateInit;
      if (!pc || !pc.remoteDescription) {
        const queued = this.pendingCandidates.get(peerId) || [];
        queued.push(candidate);
        this.pendingCandidates.set(peerId, queued);
      } else {
        try { await pc.addIceCandidate(candidate); } catch { }
      }
    }
  }

  private async flushCandidates(peerId: string, pc: RTCPeerConnection) {
    const candidates = this.pendingCandidates.get(peerId) || [];
    this.pendingCandidates.delete(peerId);
    for (const candidate of candidates) {
      try { await pc.addIceCandidate(candidate); } catch { }
    }
  }

  setMuted(muted: boolean) {
    for (const track of this.stream?.getAudioTracks() || []) track.enabled = !muted;
  }

  get isActive() { return !!this.stream; }

  private discardPeerConnection(peerId: string) {
    const pc = this.peers.get(peerId);
    if (pc) {
      pc.onconnectionstatechange = null;
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.close();
    }
    this.peers.delete(peerId);
    const audio = this.remoteAudio.get(peerId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
    }
    this.remoteAudio.delete(peerId);
    const timer = this.disconnectTimers.get(peerId);
    if (timer) clearTimeout(timer);
    this.disconnectTimers.delete(peerId);
  }

  private recoverPeer(peerId: string, pc: RTCPeerConnection) {
    if (this.peers.get(peerId) !== pc) return;
    this.closePeer(peerId);
    if (!this.disposed) this.ws.subscribeRoom(this.roomId, this.deviceId);
  }

  private closePeer(peerId: string) {
    const timer = this.disconnectTimers.get(peerId);
    if (timer) clearTimeout(timer);
    this.disconnectTimers.delete(peerId);
    this.peers.get(peerId)?.close();
    this.peers.delete(peerId);
    const audio = this.remoteAudio.get(peerId);
    if (audio) { audio.pause(); audio.srcObject = null; }
    this.remoteAudio.delete(peerId);
    this.pendingOffers.delete(peerId);
    this.pendingCandidates.delete(peerId);
  }

  dispose() {
    this.disposed = true;
    this.unsubscribePeers();
    this.unsubscribeSignal();
    for (const peerId of [...this.peers.keys()]) this.closePeer(peerId);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.pendingOffers.clear();
    this.pendingCandidates.clear();
  }
}
