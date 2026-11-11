import { EventDispatcher } from "./EventDispatcher";
import { WebSocketClient } from "./WebSocketClient";
import { getRoomIceServers } from "./iceServers";

type PeerDescriptor = { deviceId: string; userId: string };
type SignalPayload = { type: "offer" | "answer" | "candidate"; value: RTCSessionDescriptionInit | RTCIceCandidateInit };

export class RoomPeerSync {
  private peers = new Map<string, RTCPeerConnection>();
  private channels = new Map<string, RTCDataChannel>();
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  private clockOffsets = new Map<string, number>();
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private clockSyncTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly dispatch = EventDispatcher.getInstance();
  private readonly ws = WebSocketClient.getInstance();
  private disposed = false;
  private readonly unsubscribePeers: () => void;
  private readonly unsubscribeSignal: () => void;

  constructor(private roomId: string, private deviceId: string, private isHost: boolean, private onCommand: (command: any) => void) {
    this.unsubscribePeers = this.dispatch.on("room:peers", (data) => {
      if (data?.roomId !== this.roomId || !this.isHost) return;
      for (const peer of (data.peers || []) as PeerDescriptor[]) {
        if (peer.deviceId !== this.deviceId && !this.peers.has(peer.deviceId)) void this.createOffer(peer.deviceId).catch(() => undefined);
      }
    });
    this.unsubscribeSignal = this.dispatch.on("room:signal", (data) => {
      if (data?.roomId === this.roomId && data?.signal?.channel !== "voice" && typeof data.fromDeviceId === "string") void this.handleSignal(data.fromDeviceId, data.signal).catch(() => undefined);
    });
  }

  private sendSignal(targetDeviceId: string, signal: SignalPayload) {
    this.ws.send("room:signal", { roomId: this.roomId, targetDeviceId, signal });
  }

  private async createPeer(peerId: string) {
    const iceServers = await getRoomIceServers(this.roomId);
    if (this.disposed) throw new Error("Room peer sync has been disposed");
    const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });
    this.peers.set(peerId, pc);
    pc.onicecandidate = (event) => {
      if (event.candidate) this.sendSignal(peerId, { type: "candidate", value: event.candidate.toJSON() });
    };
    pc.ondatachannel = (event) => this.attachChannel(peerId, event.channel);
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
        this.channels.delete(peerId);
        this.peers.delete(peerId);
      }
    };
    return pc;
  }

  private recoverPeer(peerId: string, pc: RTCPeerConnection) {
    if (this.peers.get(peerId) !== pc) return;
    const timer = this.disconnectTimers.get(peerId);
    if (timer) clearTimeout(timer);
    this.disconnectTimers.delete(peerId);
    this.channels.get(peerId)?.close();
    this.channels.delete(peerId);
    this.peers.delete(peerId);
    this.pendingCandidates.delete(peerId);
    pc.close();
    if (!this.disposed) this.ws.send("room:subscribe", { roomId: this.roomId, deviceId: this.deviceId });
  }

  private attachChannel(peerId: string, channel: RTCDataChannel) {
    this.channels.set(peerId, channel);
    channel.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message?.type === "clock:ping" && this.isHost && typeof message.sentAt === "number") {
          channel.send(JSON.stringify({
            type: "clock:pong",
            sentAt: message.sentAt,
            hostReceivedAt: Date.now(),
            hostSentAt: Date.now(),
          }));
          return;
        }
        if (message?.type === "clock:pong" && !this.isHost &&
            typeof message.sentAt === "number" &&
            typeof message.hostReceivedAt === "number" &&
            typeof message.hostSentAt === "number") {
          const guestReceivedAt = Date.now();
          const offset = ((message.hostReceivedAt - message.sentAt) +
            (message.hostSentAt - guestReceivedAt)) / 2;
          const previous = this.clockOffsets.get(peerId);
          this.clockOffsets.set(peerId, previous === undefined ? offset : previous * 0.7 + offset * 0.3);
          return;
        }
        if (typeof message?.executeAt === "number" && !this.isHost) {
          message.executeAt -= this.clockOffsets.get(peerId) || 0;
        }
        this.onCommand(message);
      } catch { /* Ignore malformed peer messages. */ }
    };
    let clockSyncStarted = false;
    const startClockSync = () => {
      if (this.isHost || clockSyncStarted || channel.readyState !== "open") return;
      clockSyncStarted = true;
      const ping = () => {
        if (channel.readyState === "open") channel.send(JSON.stringify({ type: "clock:ping", sentAt: Date.now() }));
      };
      ping();
      const timer = setInterval(ping, 2000);
      this.clockSyncTimers.set(peerId, timer);
    };
    channel.onopen = startClockSync;
    if (channel.readyState === "open") startClockSync();
    channel.onclose = () => {
      this.channels.delete(peerId);
      const timer = this.clockSyncTimers.get(peerId);
      if (timer) clearInterval(timer);
      this.clockSyncTimers.delete(peerId);
      this.clockOffsets.delete(peerId);
    };
  }

  private async createOffer(peerId: string) {
    if (this.disposed || this.peers.has(peerId)) return;
    const pc = await this.createPeer(peerId);
    try {
      this.attachChannel(peerId, pc.createDataChannel("strumm-room", { ordered: true }));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal(peerId, { type: "offer", value: offer });
    } catch (error) {
      this.channels.get(peerId)?.close();
      pc.close();
      this.channels.delete(peerId);
      this.peers.delete(peerId);
      throw error;
    }
  }

  private async handleSignal(peerId: string, signal: SignalPayload) {
    if (!signal || this.disposed) return;
    let pc = this.peers.get(peerId);
    if (signal.type === "offer") {
      if (this.isHost) return;
      if (pc) {
        pc.onconnectionstatechange = null;
        pc.onicecandidate = null;
        pc.ondatachannel = null;
        pc.close();
        this.channels.get(peerId)?.close();
        this.channels.delete(peerId);
        this.peers.delete(peerId);
      }
      pc = await this.createPeer(peerId);
      await pc.setRemoteDescription(signal.value as RTCSessionDescriptionInit);
      await this.flushCandidates(peerId, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.sendSignal(peerId, { type: "answer", value: answer });
    } else if (signal.type === "answer" && pc && this.isHost) {
      await pc.setRemoteDescription(signal.value as RTCSessionDescriptionInit);
      await this.flushCandidates(peerId, pc);
    } else if (signal.type === "candidate") {
      const candidate = signal.value as RTCIceCandidateInit;
      if (!pc || !pc.remoteDescription) {
        const queued = this.pendingCandidates.get(peerId) || [];
        queued.push(candidate);
        this.pendingCandidates.set(peerId, queued);
      } else {
        try { await pc.addIceCandidate(candidate); } catch { /* Ignore invalid or expired ICE candidates. */ }
      }
    }
  }

  private async flushCandidates(peerId: string, pc: RTCPeerConnection) {
    const candidates = this.pendingCandidates.get(peerId) || [];
    this.pendingCandidates.delete(peerId);
    for (const candidate of candidates) {
      try { await pc.addIceCandidate(candidate); } catch { /* Ignore invalid or expired ICE candidates. */ }
    }
  }

  broadcast(command: Record<string, unknown>) {
    const payload = JSON.stringify(command);
    for (const channel of this.channels.values()) {
      if (channel.readyState === "open") channel.send(payload);
    }
    return this.channels.size;
  }

  get connectedPeers() {
    return [...this.channels.values()].filter((channel) => channel.readyState === "open").length;
  }

  dispose() {
    this.disposed = true;
    this.unsubscribePeers();
    this.unsubscribeSignal();
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
    this.channels.clear();
    this.pendingCandidates.clear();
    for (const timer of this.clockSyncTimers.values()) clearInterval(timer);
    this.clockSyncTimers.clear();
    this.clockOffsets.clear();
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    this.disconnectTimers.clear();
  }
}
