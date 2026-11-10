"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { apiUrl } from "web/lib/api";
import { useAuthStore } from "web/store/useAuthStore";

function roomIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/rooms\/([a-f0-9]{24})(?:\/|$)/i);
  return match?.[1] ?? null;
}

export default function RoomNavigationGuard() {
  const pathname = usePathname();
  const token = useAuthStore((state) => state.token);
  const previousPathname = useRef(pathname);

  useEffect(() => {
    const previousRoomId = roomIdFromPath(previousPathname.current);
    const nextRoomId = roomIdFromPath(pathname);
    previousPathname.current = pathname;

    if (!previousRoomId || previousRoomId === nextRoomId || !token) return;

    // The room page closes its socket during unmount; this explicit request
    // makes navigation a deliberate leave rather than a transient disconnect.
    void fetch(apiUrl(`/social/rooms/${previousRoomId}/leave`), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      keepalive: true,
    }).catch(() => {});
  }, [pathname, token]);

  return null;
}
