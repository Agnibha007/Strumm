let hostAudioElement: HTMLAudioElement | null = null;

export function registerHostAudioElement(element: HTMLAudioElement) {
  hostAudioElement = element;
  return () => {
    if (hostAudioElement === element) hostAudioElement = null;
  };
}

export function playHostAudioUrl(url: string): Promise<void> {
  if (!hostAudioElement) {
    return Promise.reject(new Error("The audio player is not ready."));
  }
  if (hostAudioElement.src !== url) {
    hostAudioElement.pause();
    hostAudioElement.src = url;
    hostAudioElement.load();
  }
  return hostAudioElement.play();
}
