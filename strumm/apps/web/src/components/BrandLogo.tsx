import { motion } from "framer-motion";

interface BrandLogoProps {
  variant?: "full" | "mark";
  size?: "sm" | "md" | "lg";
  className?: string;
  priority?: boolean;
}

const sizeClasses = {
  full: {
    sm: "text-lg",
    md: "text-2xl",
    lg: "text-3xl",
  },
  mark: {
    sm: "w-6 h-6",
    md: "w-9 h-9",
    lg: "w-12 h-12",
  },
};

export default function BrandLogo({
  variant = "full",
  size = "md",
  className = "",
}: BrandLogoProps) {
  const isFull = variant === "full";

  return (
    <div className={`flex items-center justify-center gap-2.5 select-none ${className}`}>
      {/* Premium resonance wave icon representing string vibration */}
      <svg 
        className={`${isFull ? "w-5 h-5" : sizeClasses.mark[size]} text-primary flex-shrink-0`} 
        viewBox="0 0 24 24" 
        fill="none" 
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* String vibrations */}
        <path 
          d="M3 12C6 9 8 15 12 12C16 9 18 15 21 12" 
          stroke="currentColor" 
          strokeWidth="2" 
          strokeLinecap="round"
        >
          <animate 
            attributeName="d" 
            dur="2.5s" 
            repeatCount="indefinite" 
            values="M3 12C6 9 8 15 12 12C16 9 18 15 21 12; M3 12C6 15 8 9 12 12C16 15 18 9 21 12; M3 12C6 9 8 15 12 12C16 9 18 15 21 12" 
          />
        </path>
        <path d="M3 8C6 6 8 10 12 8C16 6 18 10 21 8" stroke="currentColor" strokeWidth="1" opacity="0.3" strokeLinecap="round" />
        <path d="M3 16C6 14 8 18 12 16C16 14 18 18 21 16" stroke="currentColor" strokeWidth="1" opacity="0.3" strokeLinecap="round" />
      </svg>
      {isFull && (
        <span className={`font-editorial ${sizeClasses.full[size]} font-bold tracking-tight text-text leading-none`}>
          strumm<span className="text-primary font-light">~</span>
        </span>
      )}
    </div>
  );
}
