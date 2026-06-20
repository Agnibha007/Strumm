"use client";

import { useNotificationStore } from "web/store/useNotificationStore";
import { CheckCircle, AlertCircle, Info, AlertTriangle, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export default function NotificationToast() {
  const { notifications, dismiss } = useNotificationStore();

  return (
    <div className="fixed bottom-24 right-6 z-[100000] flex flex-col gap-3 w-full max-w-sm pointer-events-none px-4 md:px-0">
      <AnimatePresence>
        {notifications.map((n) => {
          let bgColor = "bg-surface/90 border-border/40 text-text";
          let Icon = Info;
          let iconColor = "text-accent";

          if (n.type === "success") {
            bgColor = "bg-green-950/80 border-green-500/30 text-green-100";
            Icon = CheckCircle;
            iconColor = "text-green-400";
          } else if (n.type === "error") {
            bgColor = "bg-red-950/80 border-red-500/30 text-red-100";
            Icon = AlertCircle;
            iconColor = "text-red-400";
          } else if (n.type === "warning") {
            bgColor = "bg-amber-950/80 border-amber-500/30 text-amber-100";
            Icon = AlertTriangle;
            iconColor = "text-amber-400";
          }

          return (
            <motion.div
              key={n.id}
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -20, scale: 0.95 }}
              className={`flex items-center gap-3 p-4 rounded-xl border backdrop-blur-md shadow-2xl pointer-events-auto ${bgColor}`}
            >
              <Icon className={`w-5 h-5 flex-shrink-0 ${iconColor}`} />
              <p className="text-sm font-medium flex-grow leading-snug">{n.message}</p>
              <button
                onClick={() => dismiss(n.id)}
                className="p-1 rounded-lg hover:bg-white/10 transition text-muted hover:text-text cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
