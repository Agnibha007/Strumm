"use client";

import { AnimatePresence, motion } from "framer-motion";

interface MobileNavOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

export default function MobileNavOverlay({ isOpen, onClose, children }: MobileNavOverlayProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-background/70 backdrop-blur-sm md:hidden"
            aria-label="Close navigation"
          />
          <motion.aside
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 260 }}
            className="fixed inset-y-0 left-0 z-50 w-[82vw] max-w-80 bg-surface border-r border-border/70 flex flex-col justify-between shadow-2xl md:hidden"
          >
            {children}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
