"use client";

import { useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { signIn } from "next-auth/react";
import { Mail, ShieldAlert, ArrowRight, Chrome, Send, Lock, User, AtSign, Eye, EyeOff, RotateCcw } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { apiUrl, cleanText, cleanUsername } from "web/lib/api";
import BrandLogo from "web/components/BrandLogo";

type AuthMode = "login" | "signup" | "otp";

export default function AuthSystem() {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devOtpHint, setDevOtpHint] = useState<string | null>(null);
  const [forgotPasswordMode, setForgotPasswordMode] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotMessage, setForgotMessage] = useState<string | null>(null);
  
  const { login } = useAuthStore();

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forgotEmail.trim()) {
      setForgotMessage("Please enter your email address.");
      return;
    }
    
    setLoading(true);
    setForgotMessage(null);
    
    try {
      const cleanedEmail = cleanText(forgotEmail, 254).toLowerCase();
      const response = await fetch(apiUrl("/auth/forgot-password"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: cleanedEmail }),
      });
      
      const json = await response.json();
      if (json.success) {
        setForgotMessage(json.message || "Password reset link sent to your email.");
        setForgotEmail("");
        setTimeout(() => {
          setForgotPasswordMode(false);
          setForgotMessage(null);
        }, 5000);
      } else {
        setForgotMessage(json.error || "Failed to send reset link.");
      }
    } catch (err) {
      setForgotMessage("Cannot connect to Strumm API. Verify server connection.");
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError("Please enter both email and password.");
      return;
    }
    
    setLoading(true);
    setError(null);
    setDevOtpHint(null);
    
    try {
      const cleanedEmail = cleanText(email, 254).toLowerCase();
      const response = await fetch(apiUrl("/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: cleanedEmail, password }),
      });
      
      const json = await response.json();
      if (json.success && json.data) {
        login(json.data.token, json.data.user);
      } else {
        setError(json.error || "Invalid email or password.");
      }
    } catch (err) {
      setError("Cannot connect to Strumm Auth API. Please verify the backend is running.");
    } finally {
      setLoading(false);
    }
  };

  const handleSendSignupOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !username.trim() || !displayName.trim() || !password.trim()) {
      setError("All fields are required for sign-up.");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters long.");
      return;
    }
    
    setLoading(true);
    setError(null);
    setDevOtpHint(null);
    
    try {
      const cleanedEmail = cleanText(email, 254).toLowerCase();
      const cleanedUsername = cleanUsername(username);
      const cleanedDisplayName = cleanText(displayName, 120);
      const response = await fetch(apiUrl("/auth/signup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: cleanedEmail,
          username: cleanedUsername,
          displayName: cleanedDisplayName,
          password: password
        }),
      });
      
      const json = await response.json();
      if (json.success) {
        setMode("otp");
        if (json.data.dev_otp) {
          setDevOtpHint(json.data.dev_otp);
        }
      } else {
        setError(json.error || "Failed to generate signup code.");
      }
    } catch (err) {
      setError("Cannot connect to Strumm API. Verify server connection.");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otp.trim()) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(apiUrl("/auth/verify"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: cleanText(email, 254).toLowerCase(), otp: cleanText(otp, 6) }),
      });
      
      const json = await response.json();
      if (json.success && json.data) {
        login(json.data.token, json.data.user);
      } else {
        setError(json.error || "Invalid validation code.");
      }
    } catch (err) {
      setError("Verification failed. Check network link.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      await signIn("google");
    } catch (err) {
      setError("Google OAuth connection error.");
      setLoading(false);
    }
  };

  return (
    <div className="bg-surface/90 backdrop-blur-xl border border-border/40 rounded-2xl p-8 max-w-md w-full shadow-2xl relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-[3px] bg-gradient-to-r from-primary to-accent box-glow" />
      
      <div className="flex flex-col items-center text-center mb-6">
        <BrandLogo size="md" priority />
        <p className="text-[10px] tracking-wider uppercase text-primary font-semibold leading-none">
          Where your music lives.
        </p>
      </div>

      <AnimatePresence mode="wait">
        {mode === "login" && (
          <motion.div
            key="login"
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 10 }}
            transition={{ duration: 0.2 }}
            className="space-y-5"
          >
            <div className="text-center mb-4">
              <h3 className="font-editorial text-xl text-text leading-tight font-bold">Welcome Back.</h3>
              <p className="text-[11px] text-muted mt-1 leading-snug">Return to your music universe.</p>
            </div>

            {!forgotPasswordMode ? (
              <form onSubmit={handlePasswordLogin} className="space-y-4">
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold">
                    Email Address
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-3.5 w-4 h-4 text-muted" />
                    <input
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="w-full bg-background border border-border rounded-lg pl-10 pr-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold">
                    Password
                  </label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-3.5 w-4 h-4 text-muted" />
                    <input
                      type={showPassword ? "text" : "password"}
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      className="w-full bg-background border border-border rounded-lg pl-10 pr-10 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-3 text-muted hover:text-text transition focus:outline-none"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setForgotPasswordMode(true)}
                  className="text-right text-[10px] text-primary hover:underline font-semibold cursor-pointer transition"
                >
                  Forgot password?
                </button>

                {error && (
                  <div className="flex items-center gap-2 text-xs text-primary bg-primary/5 border border-primary/20 p-3 rounded-lg">
                    <ShieldAlert className="w-4 h-4 flex-shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 bg-text text-background hover:bg-white font-editorial text-sm font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50"
                >
                  {loading ? "Entering..." : "Enter Strumm"}
                  <ArrowRight className="w-4 h-4 text-background" />
                </button>

                <div className="relative my-4 flex items-center justify-center">
                  <div className="absolute inset-0 border-t border-border/40" />
                  <span className="relative px-3 bg-surface text-[9px] text-muted tracking-widest uppercase">
                    Or Connect With
                  </span>
                </div>

                <button
                  type="button"
                  onClick={handleGoogleLogin}
                  disabled={loading}
                  className="w-full py-2.5 bg-surface-elevated hover:bg-surface border border-border/80 text-text text-xs rounded-lg flex items-center justify-center gap-2 cursor-pointer transition"
                >
                  <Chrome className="w-3.5 h-3.5 text-accent" />
                  Sign in with Google
                </button>
              </form>
            ) : (
              <form onSubmit={handleForgotPassword} className="space-y-3">
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-muted mb-1 font-semibold">
                    Email Address
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-3 w-4 h-4 text-muted" />
                    <input
                      type="email"
                      placeholder="you@example.com"
                      value={forgotEmail}
                      onChange={(e) => setForgotEmail(e.target.value)}
                      required
                      className="w-full bg-background border border-border rounded-lg pl-10 pr-4 py-2 text-sm text-text focus:outline-none focus:border-primary/50 transition"
                    />
                  </div>
                </div>

                {forgotMessage && (
                  <div className={`flex items-center gap-2 text-xs p-2.5 rounded-lg ${
                    forgotMessage.includes("sent") ? "text-emerald-500 bg-emerald-500/10 border border-emerald-500/20" : "text-primary bg-primary/5 border border-primary/20"
                  }`}>
                    <RotateCcw className="w-4 h-4 flex-shrink-0" />
                    <span>{forgotMessage}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2 bg-primary hover:bg-primary-hover text-white font-editorial text-sm font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50"
                >
                  {loading ? "Sending..." : "Send Reset Link"}
                  <ArrowRight className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={() => { setForgotPasswordMode(false); setForgotMessage(null); }}
                  className="w-full py-2 text-xs text-muted hover:text-text cursor-pointer transition text-center"
                >
                  Back to login
                </button>
              </form>
            )}

            <div className="text-center pt-2">
              <span className="text-xs text-muted">
                New to Strumm?{" "}
                <button
                  onClick={() => {
                    setMode("signup");
                    setError(null);
                    setPassword("");
                  }}
                  className="text-primary hover:underline font-semibold cursor-pointer"
                >
                  Create your space
                </button>
              </span>
            </div>
          </motion.div>
        )}

        {mode === "signup" && (
          <motion.div
            key="signup"
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 10 }}
            transition={{ duration: 0.2 }}
            className="space-y-5"
          >
            <div className="text-center mb-4">
              <h3 className="font-editorial text-xl text-text leading-tight font-bold">Create your space.</h3>
              <p className="text-[11px] text-muted mt-1 leading-snug">Register your music passport to start listening.</p>
            </div>

            <form onSubmit={handleSendSignupOtp} className="space-y-3.5">
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-muted mb-1 font-semibold">
                  Display Name
                </label>
                <div className="relative">
                  <User className="absolute left-3.5 top-3 w-4 h-4 text-muted" />
                  <input
                    type="text"
                    placeholder="e.g. Robin Curation"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    required
                    className="w-full bg-background border border-border rounded-lg pl-10 pr-4 py-2 text-sm text-text focus:outline-none focus:border-primary/50 transition"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] uppercase tracking-wider text-muted mb-1 font-semibold">
                  Choose Username
                </label>
                <div className="relative">
                  <AtSign className="absolute left-3.5 top-3 w-4 h-4 text-muted" />
                  <input
                    type="text"
                    placeholder="robin_curator"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    className="w-full bg-background border border-border rounded-lg pl-10 pr-4 py-2 text-sm text-text focus:outline-none focus:border-primary/50 transition lowercase"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] uppercase tracking-wider text-muted mb-1 font-semibold">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-3 w-4 h-4 text-muted" />
                  <input
                    type="email"
                    placeholder="robin@strumm.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full bg-background border border-border rounded-lg pl-10 pr-4 py-2 text-sm text-text focus:outline-none focus:border-primary/50 transition"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] uppercase tracking-wider text-muted mb-1 font-semibold">
                  Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-3 w-4 h-4 text-muted" />
                  <input
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full bg-background border border-border rounded-lg pl-10 pr-10 py-2 text-sm text-text focus:outline-none focus:border-primary/50 transition"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-2 text-muted hover:text-text transition focus:outline-none"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 text-xs text-primary bg-primary/5 border border-primary/20 p-2.5 rounded-lg">
                  <ShieldAlert className="w-4 h-4 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 bg-primary hover:bg-primary-hover text-white font-editorial text-sm font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50"
              >
                {loading ? "Preparing your space..." : "Start your journey"}
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>

            <div className="text-center pt-2">
              <span className="text-xs text-muted">
                Already registered?{" "}
                <button
                  onClick={() => {
                    setMode("login");
                    setError(null);
                    setPassword("");
                  }}
                  className="text-primary hover:underline font-semibold cursor-pointer"
                >
                  Log in
                </button>
              </span>
            </div>
          </motion.div>
        )}

        {mode === "otp" && (
          <motion.div
            key="otp"
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 10 }}
            transition={{ duration: 0.2 }}
            className="space-y-5"
          >
            <div className="text-center mb-4">
              <h3 className="font-editorial text-xl text-text leading-tight font-bold">Input Passcode</h3>
              <p className="text-[11px] text-muted mt-1 leading-snug">
                Enter the 6-digit code sent to <strong className="text-text">{email}</strong>.
              </p>
            </div>

            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold">
                  Verification Code
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-3.5 w-4 h-4 text-muted" />
                  <input
                    type="text"
                    placeholder="6-digit code"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    required
                    maxLength={6}
                    className="w-full bg-background border border-border rounded-lg pl-10 pr-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition tracking-widest text-center font-bold font-mono"
                  />
                </div>
                
                {devOtpHint && (
                  <div className="mt-3 text-center p-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 text-xs rounded font-mono">
                    Development OTP: <strong className="text-sm tracking-widest">{devOtpHint}</strong>
                  </div>
                )}
              </div>

              {error && (
                <div className="flex items-center gap-2 text-xs text-primary bg-primary/5 border border-primary/20 p-3 rounded-lg">
                  <ShieldAlert className="w-4 h-4 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 bg-primary hover:bg-primary-hover text-white font-editorial text-sm font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50"
              >
                {loading ? "Verifying..." : "Verify and Access"}
                <Send className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={() => {
                  setMode(username ? "signup" : "login");
                  setError(null);
                }}
                className="w-full py-2 text-xs text-muted hover:text-text cursor-pointer transition text-center"
              >
                Back to credentials entry
              </button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
