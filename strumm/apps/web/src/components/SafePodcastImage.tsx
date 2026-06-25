"use client";

import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { apiUrl } from "web/lib/api";

type SafePodcastImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src?: string;
};

export default function SafePodcastImage({ src, alt, className, ...props }: SafePodcastImageProps) {
  const [currentSrc, setCurrentSrc] = useState(src || "/strumm-icon.png");
  const [errorCount, setErrorCount] = useState(0);

  useEffect(() => {
    setCurrentSrc(src || "/strumm-icon.png");
    setErrorCount(0);
  }, [src]);

  const handleError = () => {
    if (errorCount === 0 && src) {
      setErrorCount(1);
      setCurrentSrc(apiUrl(`/image-proxy?url=${encodeURIComponent(src)}`));
    } else if (errorCount === 1) {
      setErrorCount(2);
      setCurrentSrc("/strumm-icon.png");
    }
  };

  return (
    <img
      src={currentSrc}
      alt={alt || ""}
      onError={handleError}
      className={className}
      loading="lazy"
      decoding="async"
      {...props}
    />
  );
}
