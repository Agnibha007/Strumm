import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");

    // Warm up the youtubei.js (InnerTube) instance so the first search
    // doesn't pay the cold-start penalty of fetching YouTube's player script.
    const { warmUpInnertube } = await import("web/services/search/YouTubeInnerTubeProvider");
    warmUpInnertube();
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
