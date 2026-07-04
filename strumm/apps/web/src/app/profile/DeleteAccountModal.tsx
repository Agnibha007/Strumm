"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Trash2, AlertCircle, X } from "lucide-react";

interface DeleteAccountModalProps {
  isOpen: boolean;
  deleting: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export default function DeleteAccountModal({ isOpen, deleting, onClose, onConfirm }: DeleteAccountModalProps) {
  const [confirmationInput, setConfirmationInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (confirmationInput.trim().toUpperCase() !== "DELETE") {
      setError("Please type DELETE to confirm.");
      return;
    }
    setError(null);
    await onConfirm();
    setConfirmationInput("");
  };

  const handleClose = () => {
    setConfirmationInput("");
    setError(null);
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="absolute inset-0 bg-background/80 backdrop-blur-md"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: "spring", duration: 0.35 }}
            className="relative w-full max-w-md bg-surface border border-border/80 rounded-xl p-6 shadow-2xl space-y-6 z-10"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-primary/15 border border-primary/25 text-primary rounded-lg">
                  <Trash2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-editorial text-xl text-text font-bold leading-tight">Delete Account</h3>
                  <p className="text-[10px] uppercase tracking-wider text-muted font-semibold mt-0.5">
                    This action is irreversible
                  </p>
                </div>
              </div>
              <button
                onClick={handleClose}
                className="p-1 hover:bg-surface-elevated text-muted hover:text-text rounded transition cursor-pointer"
              >
                <X className="w-4.5 h-4.5" />
              </button>
            </div>

            <div className="text-xs text-muted leading-relaxed space-y-2.5">
              <p>Your profile, playlists, liked songs, history, stats, and player state will be permanently erased.</p>
              <div className="bg-primary/5 border border-primary/10 rounded-lg p-3 text-primary">
                Type <span className="font-bold">DELETE</span> below to confirm.
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-xs text-primary bg-primary/5 border border-primary/20 p-3 rounded-lg">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <input
              type="text"
              placeholder="DELETE"
              value={confirmationInput}
              onChange={(e) => setConfirmationInput(e.target.value)}
              className="w-full bg-background border border-border rounded-lg px-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition font-semibold tracking-wider text-center"
            />

            <div className="flex gap-3">
              <button
                onClick={handleClose}
                className="flex-1 py-2.5 border border-border hover:bg-surface-elevated text-text text-xs font-semibold rounded-lg transition cursor-pointer select-none"
              >
                Keep Account
              </button>
              <button
                onClick={handleConfirm}
                disabled={confirmationInput.trim().toUpperCase() !== "DELETE" || deleting}
                className="flex-1 py-2.5 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-lg transition cursor-pointer select-none disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {deleting ? "Deleting..." : "Confirm Delete"}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
