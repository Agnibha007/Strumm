import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  enableLogs: false,

  beforeSend(event) {
    // Drop unhandled rejections whose only frames are from the injected
    // `executors/*` runtime. No file like that is served by this app (verified
    // against the deployed bundle), so these events come from third-party
    // scripts running inside the page — e.g. the 2k+ "reading 'M_ID'" errors.
    const frames = event.exception?.values?.[0]?.stacktrace?.frames;
    if (frames && frames.length > 0 && frames.every((frame) => frame.filename?.includes("/executors/"))) {
      return null;
    }
    return event;
  },

  integrations: [
    Sentry.replayIntegration(),
  ],
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
