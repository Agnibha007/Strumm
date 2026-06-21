import Image from "next/image";

interface BrandLogoProps {
  variant?: "full" | "mark";
  size?: "sm" | "md" | "lg";
  className?: string;
  priority?: boolean;
}

const sizeClasses = {
  full: {
    sm: "w-32",
    md: "w-44",
    lg: "w-56",
  },
  mark: {
    sm: "w-9 h-9",
    md: "w-12 h-12",
    lg: "w-16 h-16",
  },
};

export default function BrandLogo({
  variant = "full",
  size = "md",
  className = "",
  priority = false,
}: BrandLogoProps) {
  const isFull = variant === "full";

  return (
    <Image
      src={isFull ? "/strumm-logo.png" : "/strumm-icon.png"}
      alt="Strumm"
      width={isFull ? 800 : 512}
      height={isFull ? 800 : 512}
      priority={priority}
      className={`${sizeClasses[variant][size]} object-contain ${className}`}
    />
  );
}
