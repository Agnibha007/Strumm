"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { useNotificationStore } from "web/store/useNotificationStore";
import { apiUrl } from "web/lib/api";
import {
  MessageSquareText, Bug, Sparkles, Lightbulb, MessageCircle,
  Send, Loader2, CheckCircle2, Clock, ArrowRight, AlertCircle,
  X, Search,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";

type FeedbackCategory = "bug" | "feature" | "improvement" | "general" | "other";
type FeedbackStatus = "open" | "in_progress" | "resolved" | "closed";

interface FeedbackItem {
  id: string;
  title: string;
  description: string;
  category: FeedbackCategory;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
  adminNote?: string | null;
}

interface FeedbackPageData {
  items: FeedbackItem[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

const CATEGORY_OPTIONS: { value: FeedbackCategory; label: string; icon: typeof Bug }[] = [
  { value: "bug", label: "Bug Report", icon: Bug },
  { value: "feature", label: "Feature Request", icon: Sparkles },
  { value: "improvement", label: "Improvement", icon: Lightbulb },
  { value: "general", label: "General", icon: MessageCircle },
];

const STATUS_CONFIG: Record<FeedbackStatus, { label: string; color: string; icon: typeof Clock }> = {
  open: { label: "Open", color: "text-blue-400 bg-blue-500/10 border-blue-500/20", icon: Clock },
  in_progress: { label: "In Progress", color: "text-amber-400 bg-amber-500/10 border-amber-500/20", icon: AlertCircle },
  resolved: { label: "Resolved", color: "text-green-400 bg-green-500/10 border-green-500/20", icon: CheckCircle2 },
  closed: { label: "Closed", color: "text-muted bg-surface-elevated/30 border-border/40", icon: X },
};

export default function FeedbackPage() {
  const { user } = useAuthStore();
  const { show } = useNotificationStore();

  // Form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<FeedbackCategory>("general");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // History state
  const [feedbackData, setFeedbackData] = useState<FeedbackPageData | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<FeedbackStatus | "all">("all");
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Load feedback history
  const loadHistory = useCallback(async () => {
    if (!user) return;
    setLoadingHistory(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (statusFilter !== "all") params.set("status", statusFilter);

      const { token } = useAuthStore.getState();
      const response = await fetch(apiUrl(`/feedback?${params}`), {
        headers: token ? { "Authorization": `Bearer ${token}` } : undefined,
      });
      const json = await response.json();
      if (json.success) {
        setFeedbackData(json.data);
      }
    } catch (e) {
      console.warn("Failed to load feedback history.");
    } finally {
      setLoadingHistory(false);
    }
  }, [user, page, statusFilter]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (user?.email) setEmail(user.email);
  }, [user]);

  // Submit feedback
  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;

    setSubmitting(true);
    try {
      const { token } = useAuthStore.getState();
      const fbHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (token) fbHeaders["Authorization"] = `Bearer ${token}`;
      const response = await fetch(apiUrl("/feedback"), {
        method: "POST",
        headers: fbHeaders,
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
        setTitle("");
        setDescription("");
        setCategory("general");
        loadHistory(); // Refresh history
      } else {
        show(json.error || json.detail || "Failed to submit feedback.", "error");
      }
    } catch (e) {
      show("Unable to connect to the server. Please try again.", "error");
    } finally {
      setSubmitting(false);
    }
  }, [title, description, category, email, show, loadHistory]);

  if (!user) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-center p-6 gap-4">
        <MessageSquareText className="w-12 h-12 text-primary opacity-50" />
        <h3 className="font-editorial text-2xl text-text font-bold">Feedback Portal</h3>
        <p className="text-sm text-muted">Sign in to submit feedback and track your submissions.</p>
      </div>
    );
  }

  return (
    <div className="space-y-10 max-w-4xl mx-auto pb-10">
      {/* Header */}
      <div>
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
          Community
        </span>
        <h2 className="text-4xl font-editorial text-text tracking-tight font-bold mt-1">
          Feedback &amp; Suggestions
        </h2>
        <p className="text-sm text-muted mt-2 max-w-xl">
          Help shape the future of Strumm. Submit feedback, report bugs, or request features.
        </p>
      </div>

      {/* Submit Form */}
      <div className="bg-surface/40 border border-border/60 rounded-xl p-6 space-y-5">
        <div className="flex items-center gap-3 border-b border-border/20 pb-3">
          <div className="p-2 bg-primary/10 border border-primary/20 rounded-lg text-primary">
            <MessageSquareText className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-editorial text-xl text-text font-bold">Submit Feedback</h3>
            <p className="text-[10px] uppercase tracking-wider text-muted font-semibold">
              We review every submission
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Category */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
              rows={4}
              required
              maxLength={5000}
            />
            <p className="text-[9px] text-muted/60 text-right">{description.length}/5000</p>
          </div>

          {/* Email */}
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

          <button
            type="submit"
            disabled={submitting || !title.trim() || !description.trim()}
            className="w-full py-3 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-xl transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Submitting...
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                Submit Feedback
              </>
            )}
          </button>
        </form>
      </div>

      {/* History */}
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-border/20 pb-2">
          <h3 className="font-editorial text-xl text-text font-bold">Your Submissions</h3>
          <div className="flex items-center gap-2">
            {(["all", "open", "in_progress", "resolved", "closed"] as const).map((s) => (
              <button
                key={s}
                onClick={() => { setStatusFilter(s); setPage(1); }}
                className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold transition cursor-pointer ${
                  statusFilter === s
                    ? "bg-primary/10 text-primary border border-primary/20"
                    : "text-muted hover:text-text border border-transparent"
                }`}
              >
                {s === "all" ? "All" : s === "in_progress" ? "In Progress" : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {loadingHistory ? (
          <div className="flex items-center justify-center py-12 text-muted gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
            <span className="text-xs">Loading feedback history...</span>
          </div>
        ) : !feedbackData || feedbackData.items.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-border/60 rounded-xl bg-surface/20">
            <MessageSquareText className="w-8 h-8 text-muted mx-auto mb-2" />
            <p className="text-xs text-muted">No feedback submissions yet.</p>
            <p className="text-[10px] text-muted/60 mt-1">Submit your first piece of feedback above.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {feedbackData.items.map((item) => {
              const statusCfg = STATUS_CONFIG[item.status];
              const StatusIcon = statusCfg.icon;
              const catOption = CATEGORY_OPTIONS.find(c => c.value === item.category);
              const CatIcon = catOption?.icon || MessageCircle;

              return (
                <div
                  key={item.id}
                  className="p-4 bg-surface/30 border border-border/40 hover:border-border/70 rounded-xl transition cursor-pointer"
                  onClick={() => setSelectedId(selectedId === item.id ? null : item.id)}
                >
                  <div className="flex items-start justify-between gap-4 min-w-0">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <CatIcon className="w-4 h-4 text-muted flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <h4 className="text-sm font-bold text-text truncate">{item.title}</h4>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-[10px] text-muted">{new Date(item.createdAt).toLocaleDateString()}</span>
                          <span className="text-[10px] text-muted capitalize">{item.category}</span>
                        </div>
                      </div>
                    </div>
                    <span className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold border flex items-center gap-1.5 flex-shrink-0 ${statusCfg.color}`}>
                      <StatusIcon className="w-3 h-3" />
                      {statusCfg.label}
                    </span>
                  </div>

                  <AnimatePresence>
                    {selectedId === item.id && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="pt-3 mt-3 border-t border-border/20 space-y-3">
                          <p className="text-xs text-muted leading-relaxed whitespace-pre-wrap">{item.description}</p>
                          {item.adminNote && (
                            <div className="p-3 bg-primary/5 border border-primary/10 rounded-lg">
                              <span className="text-[10px] uppercase tracking-wider text-primary font-bold block mb-1">Admin Note</span>
                              <p className="text-xs text-text">{item.adminNote}</p>
                            </div>
                          )}
                          <p className="text-[10px] text-muted/60">
                            Last updated: {new Date(item.updatedAt).toLocaleString()}
                          </p>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}

            {/* Pagination */}
            {feedbackData.pages > 1 && (
              <div className="flex items-center justify-center gap-3 pt-4">
                <button
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page === 1}
                  className="px-4 py-2 bg-surface-elevated hover:bg-surface border border-border/80 text-xs font-semibold rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer text-text"
                >
                  Previous
                </button>
                <span className="text-xs text-muted font-medium">
                  Page <span className="text-text font-bold">{page}</span> of <span className="text-text font-bold">{feedbackData.pages}</span>
                </span>
                <button
                  onClick={() => setPage(Math.min(feedbackData.pages, page + 1))}
                  disabled={page === feedbackData.pages}
                  className="px-4 py-2 bg-surface-elevated hover:bg-surface border border-border/80 text-xs font-semibold rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer text-text"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer links */}
      <div className="flex items-center justify-center gap-6 text-xs text-muted border-t border-border/20 pt-6">
        <Link href="/feature-request" className="hover:text-text transition flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5" />
          Feature Request
        </Link>
        <Link href="/report-bug" className="hover:text-text transition flex items-center gap-1.5">
          <Bug className="w-3.5 h-3.5" />
          Report Bug
        </Link>
        <Link href="/contact" className="hover:text-text transition flex items-center gap-1.5">
          <MessageCircle className="w-3.5 h-3.5" />
          Contact
        </Link>
      </div>
    </div>
  );
}
