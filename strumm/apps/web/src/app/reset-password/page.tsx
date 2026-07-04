"use client";

import { useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { apiUrl } from "web/lib/api";
import { Loader2, CheckCircle2, AlertCircle, Lock } from "lucide-react";
import Link from "next/link";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token");
  const email = searchParams.get("email");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const validatePassword = (pwd: string): string | null => {
    if (pwd.length < 8) return "Password must be at least 8 characters.";
    if (!/[A-Z]/.test(pwd)) return "Include at least one uppercase letter.";
    if (!/[a-z]/.test(pwd)) return "Include at least one lowercase letter.";
    if (!/[0-9]/.test(pwd)) return "Include at least one number.";
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    const validationError = validatePassword(password);
    if (validationError) {
      setError(validationError);
      return;
    }

    if (!token || !email) {
      setError("Invalid reset link. Missing token or email.");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(apiUrl("/auth/reset-password"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, token, new_password: password }),
      });
      const json = await response.json();
      if (json.success) {
        setMessage("Password reset successfully! Redirecting to login...");
        setTimeout(() => router.push("/login"), 2500);
      } else {
        setError(json.error || "Failed to reset password.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (!token || !email) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-center p-6 space-y-4">
        <AlertCircle className="w-12 h-12 text-primary opacity-50 mx-auto" />
        <h3 className="font-editorial text-2xl text-text font-bold">Invalid Reset Link</h3>
        <p className="text-sm text-muted">This password reset link is missing required parameters. Please request a new one.</p>
        <Link href="/login" className="px-6 py-2.5 bg-primary text-white text-xs font-semibold rounded-lg hover:bg-primary-hover transition">Back to Login</Link>
      </div>
    );
  }

  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-4">
      <div className="bg-surface/50 backdrop-blur-xl border border-border/40 p-8 rounded-[2rem] max-w-md w-full shadow-2xl soft-enter">
        <div className="text-center mb-8 space-y-2">
          <div className="p-3 bg-primary/10 rounded-full w-fit mx-auto">
            <Lock className="w-6 h-6 text-primary" />
          </div>
          <h2 className="font-editorial text-2xl text-text font-bold">Reset Password</h2>
          <p className="text-xs text-muted">Choose a strong password for your Strumm account.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold">New Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" className="w-full bg-background border border-border rounded-lg px-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition" required minLength={8} />
            <div className="flex gap-1.5 mt-2">
              {[password.length >= 8, /[A-Z]/.test(password), /[a-z]/.test(password), /[0-9]/.test(password)].map((valid, i) => (
                <div key={i} className={`h-1 flex-1 rounded-full ${valid ? "bg-primary" : "bg-border"}`} />
              ))}
            </div>
            <p className="text-[10px] text-muted mt-1">8+ chars, upper + lower + number</p>
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold">Confirm Password</label>
            <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Repeat your password" className="w-full bg-background border border-border rounded-lg px-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition" required />
          </div>

          {error && <div className="flex items-center gap-2 text-xs text-primary bg-primary/5 border border-primary/20 p-3 rounded-lg"><AlertCircle className="w-4 h-4 flex-shrink-0" /><span>{error}</span></div>}
          {message && <div className="flex items-center gap-2 text-xs text-emerald-500 bg-emerald-500/5 border border-emerald-500/20 p-3 rounded-lg"><CheckCircle2 className="w-4 h-4 flex-shrink-0" /><span>{message}</span></div>}

          <button type="submit" disabled={loading} className="w-full py-2.5 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-lg transition disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {loading ? "Resetting..." : "Reset Password"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div className="min-h-[70vh] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    }>
      <ResetPasswordForm />
    </Suspense>
  );
}
