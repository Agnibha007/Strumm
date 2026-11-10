export type RoomPlaybackPhase = "preparing" | "committed";

function phaseRank(phase: RoomPlaybackPhase | null): number {
  if (phase === "committed") return 1;
  if (phase === "preparing") return 0;
  return -1;
}

export function isStaleRoomPlaybackSnapshot(
  incomingSequence: number,
  incomingPhase: RoomPlaybackPhase,
  lastSequence: number,
  lastPhase: RoomPlaybackPhase | null,
): boolean {
  return incomingSequence < lastSequence
    || (incomingSequence === lastSequence && phaseRank(incomingPhase) < phaseRank(lastPhase));
}

export function isNewRoomPlaybackCommand(
  incomingSequence: number,
  incomingPhase: RoomPlaybackPhase,
  lastSequence: number,
  lastPhase: RoomPlaybackPhase | null,
): boolean {
  return incomingSequence > lastSequence
    || (incomingSequence === lastSequence && phaseRank(incomingPhase) > phaseRank(lastPhase));
}
