"use client";

import { useState, useCallback } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { useNotificationStore } from "web/store/useNotificationStore";
import { apiUrl } from "web/lib/api";
import { MessageSquareText, X, Send, Loader2, Bug, Sparkles, Lightbulb, MessageCircle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

type FeedbackCategory = "bug" | "feature" | "improvement" | "general" | "other";

const CATEGORY_OPTIONS: { value: FeedbackCategory; label: string; icon: typeof Bug }[] = [
  { value: "bug", label: "Bug Report", icon: Bug },
  { value: "feature", label: "Feature Request", icon: Sparkles },
  { value: "improvement", label: "Improvement", icon: Lightbulb },
  { value: "general", label: "General", icon: MessageCircle },
];

export default function FeedbackButton() {
  const { user } = useAuthStore();
  const { show } = useNotificationStore();
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<FeedbackCategory>("general");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const resetForm = useCallback(() => {
    setTitle("");
    setDescription("");
    setCategory("general");
    setEmail(user?.email || "");
    setSubmitting(false);
  }, [user]);

  const handleOpen = useCallback(() => {
    setIsOpen(true);
    if (user?.email) setEmail(user.email);
  }, [user]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    resetForm();
  }, [resetForm]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;

    setSubmitting(true);
    try {
      const response = await fetch(apiUrl("/feedback"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          category,
          email: email.trim() || undefined,
        }),
      });
      const json = await response.json();
      if (json.success) {
        show("Thank you! Your feedback has been submitted.", "success", 4000);
        handleClose();
      } else {
        show(json.error || json.detail || "Failed to submit feedback.", "error");
      }
    } catch (e) {
      show("Unable to connect to the server. Please try again.", "error");
    } finally {
      setSubmitting(false);
    }
  }, [title, description, category, email, show, handleClose]);

  const selectedCategory = CATEGORY_OPTIONS.find(c => c.value === category);
  const SelectedIcon = selectedCategory?.icon || MessageCircle;

  return (
    <>
      {/* Floating trigger button */}
      <button
        onClick={handleOpen}
        className="fixed bottom-6 right-6 z-[9999] w-14 h-14 rounded-full bg-primary hover:bg-primary-hover text-white shadow-2xl flex items-center justify-center cursor-pointer transition-all hover:scale-110 active:scale-95 border border-primary/30 box-glow"
        title="Give Feedback"
        aria-label="Open feedback form"
      >
        {isOpen ? (
          <X className="w-6 h-6" />
        ) : (
          <MessageSquareText className="w-6 h-6" />
        )}
      </button>

      {/* Modal overlay */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9998] bg-background/70 backdrop-blur-sm flex items-end md:items-center justify-center p-0 md:p-4"
            onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
          >
            <motion.div
              initial={{ opacity: 0, y: 50, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 50, scale: 0.95 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="w-full md:max-w-lg bg-surface border border-border/80 rounded-t-2xl md:rounded-2xl shadow-2xl overflow-hidden md:max-h-[85vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between p-5 border-b border-border/20">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-primary/10 border border-primary/20 rounded-lg text-primary">
                    <MessageSquareText className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-editorial text-lg text-text font-bold">Share Feedback</h3>
                    <p className="text-[10px] uppercase tracking-wider text-muted font-semibold">
                      Help us improve Strumm
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleClose}
                  className="p-1.5 hover:bg-surface-elevated text-muted hover:text-text rounded-lg transition cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Form */}
              <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto flex-1">
                {/* Category selection */}
                <div className="grid grid-cols-2 gap-2">
                  {CATEGORY_OPTIONS.map((option) => {
                    const Icon = option.icon;
                    const isActive = category === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setCategory(option.value)}
                        className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-xs font-semibold transition cursor-pointer ${
                          isActive
                            ? "bg-primary/10 border-primary/30 text-primary"
                            : "bg-surface-elevated/30 border-border/40 text-muted hover:text-text hover:border-border/70"
                        }`}
                      >
                        <Icon className={`w-4 h-4 ${isActive ? "text-primary" : ""}`} />
                        {option.label}
                      </button>
                    );
                  })}
                </div>

                {/* Title */}
                <div className="space-y-1.5">
                  <label className="text-[10px] uppercase tracking-wider text-muted font-semibold">
                    Title <span className="text-primary">*</span>
                  </label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Brief summary of your feedback"
                    className="w-full bg-background border border-border/60 rounded-xl px-3.5 py-2.5 text-sm text-text placeholder:text-muted/50 focus:outline-none focus:border-primary/50 transition"
                    required
                    maxLength={200}
                  />
                  <p className="text-[9px] text-muted/60 text-right">{title.length}/200</p>
                </div>

                {/* Description */}
                <div className="space-y-1.5">
                  <label className="text-[10px] uppercase tracking-wider text-muted font-semibold">
                    Description <span className="text-primary">*</span>
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe your feedback in detail. What would you like to see changed or improved?"
                    className="w-full bg-background border border-border/60 rounded-xl px-3.5 py-2.5 text-sm text-text placeholder:text-muted/50 focus:outline-none focus:border-primary/50 transition resize-none"
                    rows={5}
                    required
                    maxLength={5000}
                  />
                  <p className="text-[9px] text-muted/60 text-right">{description.length}/5000</p>
                </div>

                {/* Email (optional) */}
                <div className="space-y-1.5">
                  <label className="text-[10px] uppercase tracking-wider text-muted font-semibold">
                    Email <span className="text-muted/50">(optional — for status updates)</span>
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full bg-background border border-border/60 rounded-xl px-3.5 py-2.5 text-sm text-text placeholder:text-muted/50 focus:outline-none focus:border-primary/50 transition"
                    maxLength={320}
                  />
                </div>

                {/* Submit */}
                <div className="flex gap-3 pt-2 border-t border-border/20">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="flex-1 py-2.5 border border-border/80 hover:bg-surface-elevated text-text text-xs font-semibold rounded-xl transition cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting || !title.trim() || !description.trim()}
                    className="flex-1 py-2.5 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-xl transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Submitting...
                      </>
                    ) : (
                      <>
                        <Send className="w-4 h-4" />
                        Send Feedback
                      </>
                    )}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
