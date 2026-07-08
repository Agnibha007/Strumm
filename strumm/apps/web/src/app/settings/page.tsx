"use client";

import { useState, useEffect } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { useNotificationStore } from "web/store/useNotificationStore";
import ThemeSwitcher from "web/components/ThemeSwitcher";
import {
  User, Image, Save, AlertCircle, CheckCircle2, Upload, Gauge, WifiLow, Zap,
  Shield, Key, Download, Trash2, Monitor, Smartphone, Eye, EyeOff,
  AlertTriangle, RefreshCw, Mail, LogOut
} from "lucide-react";
import { apiUrl, cleanText } from "web/lib/api";

const QUALITY_OPTIONS = [
  { id: "data-saver", label: "Data Saver", detail: "Lower video quality and lighter media preload.", icon: WifiLow },
  { id: "balanced", label: "Balanced", detail: "Default quality for everyday listening.", icon: Gauge },
  { id: "high", label: "High", detail: "Prefer higher YouTube video quality when available.", icon: Zap },
] as const;

interface Session {
  _id: string;
  device: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
}

export default function SettingsPage() {
  const { user, token, setUser, logout } = useAuthStore();
  const { audioQuality, setAudioQuality } = usePlayerStore();
  const { show: showToast } = useNotificationStore();

  // Profile state
  const [displayName, setDisplayName] = useState(user?.displayName || "");
  const [username, setUsername] = useState(user?.username || "");
  const [avatar, setAvatar] = useState(user?.avatar || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Email change state
  const [newEmail, setNewEmail] = useState(user?.email || "");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSuccess, setEmailSuccess] = useState<string | null>(null);

  // Password change state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState<string | null>(null);

  // Sessions state
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [revokeAllLoading, setRevokeAllLoading] = useState(false);
  const [revokeAllSuccess, setRevokeAllSuccess] = useState<string | null>(null);

  // Danger zone state
  const [confirmDelete, setConfirmDelete] = useState("");

  const handleChangeEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.includes("@")) {
      setEmailError("Please enter a valid email address.");
      return;
    }
    if (newEmail === user?.email) {
      setEmailError("New email is the same as your current email.");
      return;
    }
    setEmailLoading(true);
    setEmailError(null);
    setEmailSuccess(null);
    try {
      const response = await fetch(apiUrl("/auth/change-email"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password: emailPassword, newEmail }),
      });
      const json = await response.json();
      if (json.success) {
        setUser({ ...user!, email: newEmail });
        setEmailSuccess("Email address changed successfully.");
        showToast(`Email changed to ${newEmail}`, "success");
        setEmailPassword("");
      } else {
        setEmailError(json.error || "Failed to change email.");
      }
    } catch {
      setEmailError("Unable to connect to backend server.");
    } finally {
      setEmailLoading(false);
    }
  };
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Export state
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Active tab
  const [activeSection, setActiveSection] = useState<string>("profile");

  // Fetch sessions on mount
  useEffect(() => {
    if (!user) return;
    const fetchSessions = async () => {
      setSessionsLoading(true);
      try {
        const res = await fetch(apiUrl("/auth/sessions"), {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json();
        if (json.success && json.data) {
          setSessions(json.data.sessions || []);
        }
      } catch {
        setSessionsError("Failed to load sessions.");
      } finally {
        setSessionsLoading(false);
      }
    };
    fetchSessions();
  }, [token]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) {
      setError("File size must be less than 1.5MB.");
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === "string") {
        setAvatar(reader.result);
        setError(null);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(apiUrl("/profile"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          displayName: cleanText(displayName, 120),
          username: cleanText(username, 50).trim().toLowerCase(),
          avatar: avatar.startsWith("data:image/") ? avatar : cleanText(avatar, 1500),
        }),
      });
      const json = await response.json();
      if (json.success && json.data) {
        setUser(json.data);
        setSuccess("Profile settings updated successfully.");
      } else {
        setError(json.error || "Failed to update profile.");
      }
    } catch {
      setError("Unable to connect to backend server.");
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setPwError("New passwords do not match.");
      return;
    }
    if (newPassword.length < 8) {
      setPwError("Password must be at least 8 characters long.");
      return;
    }
    setPwLoading(true);
    setPwError(null);
    setPwSuccess(null);
    try {
      const response = await fetch(apiUrl("/auth/change-password"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const json = await response.json();
      if (json.success) {
        setPwSuccess("Password changed successfully.");
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      } else {
        setPwError(json.error || "Failed to change password.");
      }
    } catch {
      setPwError("Unable to connect to backend server.");
    } finally {
      setPwLoading(false);
    }
  };

  const handleRevokeSession = async (sessionId: string) => {
    const session = sessions.find((s) => s._id === sessionId);
    const deviceLabel = session?.device
      ? session.device.substring(0, 60)
      : "this device";
    const confirmed = window.confirm(
      `Sign out from "${deviceLabel}"? The session will be revoked immediately.`
    );
    if (!confirmed) return;

    try {
      const response = await fetch(apiUrl(`/auth/sessions/${sessionId}`), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await response.json();
      if (json.success) {
        setSessions((prev) => prev.filter((s) => s._id !== sessionId));
      }
    } catch {
      setSessionsError("Failed to revoke session.");
    }
  };

  const handleRevokeAllSessions = async () => {
    const otherCount = sessions.length;
    if (otherCount === 0) {
      setRevokeAllSuccess("No other active sessions to revoke.");
      return;
    }
    const confirmed = window.confirm(
      `This will sign out ${otherCount} other device(s). Your current session will remain active. Continue?`
    );
    if (!confirmed) return;

    setRevokeAllLoading(true);
    setRevokeAllSuccess(null);
    setSessionsError(null);
    try {
      const response = await fetch(apiUrl("/auth/sessions"), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await response.json();
      if (json.success && json.data) {
        setRevokeAllSuccess(json.data.message || "Other sessions revoked.");
      } else {
        setSessionsError(json.error || "Failed to revoke sessions.");
      }
    } catch {
      setSessionsError("Unable to connect to backend server.");
    }

    // Always refresh the sessions list after the operation
    try {
      const res = await fetch(apiUrl("/auth/sessions"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const sessionsJson = await res.json();
      if (sessionsJson.success && sessionsJson.data) {
        setSessions(sessionsJson.data.sessions || []);
      }
    } catch {
      // Silently fail on the refresh — the delete already succeeded
    } finally {
      setRevokeAllLoading(false);
    }
  };

  const handleExportData = async () => {
    setExportLoading(true);
    setExportError(null);
    try {
      const response = await fetch(apiUrl("/profile/export"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await response.json();
      if (json.success && json.data) {
        const blob = new Blob([JSON.stringify(json.data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `strumm-export-${user?.username || "data"}.json`;
        a.click();
        URL.revokeObjectURL(url);
        setSuccess("Data exported successfully.");
      } else {
        setExportError(json.error || "Failed to export data.");
      }
    } catch {
      setExportError("Unable to connect to backend server.");
    } finally {
      setExportLoading(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (confirmDelete !== user?.username) {
      setDeleteError("Username does not match. Type your username to confirm deletion.");
      return;
    }
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      const response = await fetch(apiUrl("/profile"), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await response.json();
      if (json.success) {
        logout();
      } else {
        setDeleteError(json.error || "Failed to delete account.");
      }
    } catch {
      setDeleteError("Unable to connect to backend server.");
    } finally {
      setDeleteLoading(false);
    }
  };

  if (!user) return null;

  const sections = [
    { id: "profile", label: "Profile", icon: User },
    { id: "security", label: "Security", icon: Shield },
    { id: "sessions", label: "Sessions", icon: Monitor },
    { id: "audio", label: "Audio", icon: Gauge },
    { id: "appearance", label: "Appearance", icon: Eye },
    { id: "export", label: "Export Data", icon: Download },
    { id: "danger", label: "Danger Zone", icon: Trash2 },
  ];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
          Control Panel
        </span>
        <h1 className="text-4xl font-editorial text-text tracking-tight font-bold mt-1">
          Settings
        </h1>
      </div>

      <div className="flex flex-col lg:flex-row gap-8">
        {/* Left: Section Navigation */}
        <nav className="lg:w-52 flex-shrink-0 space-y-1" aria-label="Settings sections">
          {sections.map((section) => {
            const Icon = section.icon;
            return (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-semibold transition cursor-pointer text-left ${
                  activeSection === section.id
                    ? "bg-primary/10 text-primary border border-primary/20"
                    : "text-muted hover:text-text hover:bg-surface-elevated/40 border border-transparent"
                }`}
                aria-current={activeSection === section.id ? "true" : undefined}
              >
                <Icon className="w-4 h-4" />
                {section.label}
              </button>
            );
          })}
        </nav>

        {/* Right: Active Section Content */}
        <div className="flex-1 min-w-0 space-y-6">
          {/* ─── PROFILE ─── */}
          {activeSection === "profile" && (
            <div className="bg-surface border border-border/60 rounded-xl p-6 space-y-6 soft-enter">
              <div>
                <h2 className="font-editorial text-xl text-text border-b border-border/20 pb-2">Profile Manager</h2>
              </div>
              <form onSubmit={handleSaveProfile} className="space-y-4">
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold" htmlFor="settings-username">Username</label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-2.5 text-muted text-sm font-semibold select-none" aria-hidden="true">@</span>
                    <input id="settings-username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" className="w-full bg-background border border-border rounded-lg pl-8 pr-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition font-mono" required />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold" htmlFor="settings-displayname">Display Name</label>
                  <div className="relative">
                    <User className="absolute left-3.5 top-3.5 w-4 h-4 text-muted" aria-hidden="true" />
                    <input id="settings-displayname" type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your display name" className="w-full bg-background border border-border rounded-lg pl-10 pr-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition" required />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold">Profile Picture</label>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="relative flex-grow">
                      <Image className="absolute left-3.5 top-3.5 w-4 h-4 text-muted" aria-hidden="true" />
                      <input type="text" value={avatar.startsWith("data:image/") ? "[Uploaded Base64 Image]" : avatar} onChange={(e) => { if (!e.target.value.startsWith("[Uploaded")) setAvatar(e.target.value); }} placeholder="https://example.com/avatar.jpg" className="w-full bg-background border border-border rounded-lg pl-10 pr-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition text-xs font-mono" />
                    </div>
                    <label className="py-2 px-4 bg-surface-elevated hover:bg-surface border border-border/80 text-text text-xs rounded-lg flex items-center justify-center gap-2 cursor-pointer transition select-none">
                      <Upload className="w-3.5 h-3.5 text-primary" aria-hidden="true" />
                      Upload Image
                      <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                    </label>
                  </div>
                  {avatar.startsWith("data:image/") && (
                    <div className="mt-2 flex items-center gap-3">
                      <img src={avatar} alt="Profile preview" className="w-12 h-12 rounded-full object-cover border border-primary shadow" />
                      <button type="button" onClick={() => setAvatar("")} className="text-[10px] text-primary hover:underline font-semibold">Remove uploaded image</button>
                    </div>
                  )}
                </div>
                {error && <ErrorBanner message={error} icon={AlertCircle} />}
                {success && <SuccessBanner message={success} icon={CheckCircle2} />}
                <button type="submit" disabled={loading} className="w-full py-2.5 bg-text hover:bg-white text-background font-editorial text-sm font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50">
                  <Save className="w-4 h-4 text-background" aria-hidden="true" />
                  {loading ? "Saving settings..." : "Save Profile Details"}
                </button>
              </form>
            </div>
          )}              {/* ─── SECURITY ─── */}
          {activeSection === "security" && (
            <div className="bg-surface border border-border/60 rounded-xl p-6 space-y-6 soft-enter">
              <div>
                <h2 className="font-editorial text-xl text-text border-b border-border/20 pb-2 flex items-center gap-2">
                  <Shield className="w-5 h-5 text-primary" aria-hidden="true" />
                  Security
                </h2>
              </div>

              {/* Email Change */}
              <form onSubmit={handleChangeEmail} className="space-y-4">
                <h4 className="text-sm font-semibold text-text flex items-center gap-2">
                  <Mail className="w-4 h-4 text-primary" aria-hidden="true" />
                  Change Email Address
                </h4>
                <p className="text-xs text-muted">
                  Current email: <strong className="text-text">{user?.email || "Not set"}</strong>
                </p>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold" htmlFor="settings-new-email">New Email</label>
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-3.5 w-4 h-4 text-muted" aria-hidden="true" />
                    <input id="settings-new-email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="new@email.com" className="w-full bg-background border border-border rounded-lg pl-10 pr-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition" required />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold" htmlFor="settings-email-pw">Current Password</label>
                  <div className="relative">
                    <input id="settings-email-pw" type="password" value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} placeholder="••••••••" className="w-full bg-background border border-border rounded-lg px-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition" required />
                  </div>
                </div>
                {emailError && <ErrorBanner message={emailError} icon={AlertCircle} />}
                {emailSuccess && <SuccessBanner message={emailSuccess} icon={CheckCircle2} />}
                <button type="submit" disabled={emailLoading || !newEmail || !emailPassword} className="w-full py-2.5 bg-primary hover:bg-primary-hover text-white font-editorial text-sm font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50">
                  <RefreshCw className="w-4 h-4" aria-hidden="true" />
                  {emailLoading ? "Updating email..." : "Update Email"}
                </button>
              </form>

              <hr className="border-border/40" />

              <form onSubmit={handleChangePassword} className="space-y-4">
                <h4 className="text-sm font-semibold text-text flex items-center gap-2">
                  <Key className="w-4 h-4 text-primary" aria-hidden="true" />
                  Change Password
                </h4>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold" htmlFor="settings-current-pw">Current Password</label>
                  <div className="relative">
                    <input id="settings-current-pw" type={showPassword ? "text" : "password"} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="••••••••" className="w-full bg-background border border-border rounded-lg px-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition" />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold" htmlFor="settings-new-pw">New Password</label>
                  <div className="relative">
                    <input id="settings-new-pw" type={showPassword ? "text" : "password"} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••" className="w-full bg-background border border-border rounded-lg pr-10 pl-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition" />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-3 text-muted hover:text-text transition focus:outline-none" aria-label={showPassword ? "Hide passwords" : "Show passwords"}>
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold" htmlFor="settings-confirm-pw">Confirm New Password</label>
                  <input id="settings-confirm-pw" type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="••••••••" className="w-full bg-background border border-border rounded-lg px-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition" />
                </div>
                {pwError && <ErrorBanner message={pwError} icon={AlertCircle} />}
                {pwSuccess && <SuccessBanner message={pwSuccess} icon={CheckCircle2} />}
                <button type="submit" disabled={pwLoading || !currentPassword || !newPassword || !confirmPassword} className="w-full py-2.5 bg-primary hover:bg-primary-hover text-white font-editorial text-sm font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50">
                  <RefreshCw className="w-4 h-4" aria-hidden="true" />
                  {pwLoading ? "Changing password..." : "Update Password"}
                </button>
              </form>
            </div>
          )}

          {/* ─── SESSIONS ─── */}
          {activeSection === "sessions" && (
            <div className="bg-surface border border-border/60 rounded-xl p-6 space-y-6 soft-enter">
              <div>
                <h2 className="font-editorial text-xl text-text border-b border-border/20 pb-2 flex items-center gap-2">
                  <Monitor className="w-5 h-5 text-primary" aria-hidden="true" />
                  Active Sessions
                </h2>
                <p className="text-xs text-muted mt-2">Manage devices where you&apos;re signed in to Strumm.</p>
              </div>

              {sessionsLoading ? (
                <div className="flex items-center justify-center py-8 text-muted text-sm">
                  <RefreshCw className="w-4 h-4 animate-spin mr-2" aria-hidden="true" />
                  Loading sessions...
                </div>
              ) : sessions.length === 0 ? (
                <div className="text-center py-8 text-muted text-sm border border-dashed border-border/40 rounded-xl">
                  <Monitor className="w-8 h-8 mx-auto mb-2 text-border" aria-hidden="true" />
                  <p>No active sessions found.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {sessions.map((session) => {
                    const device = session.device || "Unknown Device";
                    const isMobile = /mobile|iphone|ipad|android/i.test(device);
                    const createdAt = new Date(session.createdAt).toLocaleDateString();
                    const lastActive = new Date(session.lastActiveAt);
                    const now = new Date();
                    const hoursSinceActive = Math.floor((now.getTime() - lastActive.getTime()) / (1000 * 60 * 60));
                    let lastActiveLabel: string;
                    if (hoursSinceActive < 1) {
                      lastActiveLabel = "Just now";
                    } else if (hoursSinceActive < 24) {
                      lastActiveLabel = `${hoursSinceActive}h ago`;
                    } else if (hoursSinceActive < 24 * 7) {
                      lastActiveLabel = `${Math.floor(hoursSinceActive / 24)}d ago`;
                    } else {
                      lastActiveLabel = lastActive.toLocaleDateString();
                    }
                    return (
                      <div key={session._id} className="flex items-center justify-between p-3 bg-surface-elevated/20 border border-border/40 rounded-xl">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="p-2 rounded-lg bg-surface-elevated text-muted">
                            {isMobile ? <Smartphone className="w-4 h-4" aria-hidden="true" /> : <Monitor className="w-4 h-4" aria-hidden="true" />}
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-text truncate max-w-[200px]">{device.substring(0, 60)}</p>
                            <p className="text-[10px] text-muted mt-0.5">Connected since {createdAt}</p>
                            <p className="text-[10px] text-muted/60 mt-0.5 flex items-center gap-1">
                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                              Active {lastActiveLabel}
                            </p>
                          </div>
                        </div>
                        <button onClick={() => handleRevokeSession(session._id)} className="px-3 py-1.5 border border-red-500/30 text-red-400 hover:bg-red-500/10 text-[10px] font-bold rounded-lg transition cursor-pointer flex-shrink-0">
                          Revoke
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {revokeAllSuccess && <SuccessBanner message={revokeAllSuccess} icon={CheckCircle2} />}

              <div className="pt-2 border-t border-border/20">
                <button
                  onClick={handleRevokeAllSessions}
                  disabled={revokeAllLoading || sessions.length === 0}
                  className="w-full py-2.5 border border-red-500/30 text-red-400 hover:bg-red-500/10 text-sm font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <LogOut className="w-4 h-4" aria-hidden="true" />
                  {revokeAllLoading ? "Revoking sessions..." : "Logout from all other devices"}
                </button>
              </div>

              {sessionsError && <ErrorBanner message={sessionsError} icon={AlertCircle} />}
            </div>
          )}

          {/* ─── AUDIO ─── */}
          {activeSection === "audio" && (
            <div className="bg-surface border border-border/60 rounded-xl p-6 space-y-5 soft-enter">
              <div>
                <h2 className="font-editorial text-xl text-text border-b border-border/20 pb-2 flex items-center gap-2">
                  <Gauge className="w-5 h-5 text-primary" aria-hidden="true" />
                  Audio Quality
                </h2>
              </div>
              <div className="grid gap-3">
                {QUALITY_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  const selected = audioQuality === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => setAudioQuality(option.id)}
                      title={`Set streaming quality to ${option.label}: ${option.detail}`}
                      className={`w-full text-left border rounded-lg p-4 transition cursor-pointer flex items-start gap-3 ${
                        selected ? "border-primary bg-primary/10 text-text" : "border-border/60 bg-background/40 hover:border-border text-muted hover:text-text"
                      }`}
                    >
                      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${selected ? "text-primary" : "text-muted"}`} aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold">{option.label}</span>
                        <span className="block text-[11px] leading-relaxed mt-1 text-muted">{option.detail}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ─── APPEARANCE ─── */}
          {activeSection === "appearance" && (
            <div className="bg-surface border border-border/60 rounded-xl p-6 soft-enter">
              <div>
                <h2 className="font-editorial text-xl text-text border-b border-border/20 pb-2 flex items-center gap-2">
                  <Eye className="w-5 h-5 text-primary" aria-hidden="true" />
                  Appearance
                </h2>
              </div>
              <div className="mt-5">
                <ThemeSwitcher />
              </div>
            </div>
          )}

          {/* ─── EXPORT DATA ─── */}
          {activeSection === "export" && (
            <div className="bg-surface border border-border/60 rounded-xl p-6 space-y-5 soft-enter">
              <div>
                <h2 className="font-editorial text-xl text-text border-b border-border/20 pb-2 flex items-center gap-2">
                  <Download className="w-5 h-5 text-primary" aria-hidden="true" />
                  Export Your Data
                </h2>
                <p className="text-xs text-muted mt-2">
                  Download a copy of your Strumm data, including your profile, playlists, listening history, and settings.
                </p>
              </div>
              {exportError && <ErrorBanner message={exportError} icon={AlertCircle} />}
              <button
                onClick={handleExportData}
                disabled={exportLoading}
                className="w-full py-2.5 bg-primary hover:bg-primary-hover text-white font-editorial text-sm font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50"
              >
                <Download className="w-4 h-4" aria-hidden="true" />
                {exportLoading ? "Preparing your data..." : "Download My Data"}
              </button>
            </div>
          )}

          {/* ─── DANGER ZONE ─── */}
          {activeSection === "danger" && (
            <div className="bg-surface border border-red-500/30 rounded-xl p-6 space-y-5 soft-enter">
              <div>
                <h2 className="font-editorial text-xl text-red-400 border-b border-red-500/20 pb-2 flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5" aria-hidden="true" />
                  Danger Zone
                </h2>
                <p className="text-xs text-muted mt-2">
                  Irreversible actions that will permanently affect your account.
                </p>
              </div>

              <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-5 space-y-4">
                <div className="flex items-start gap-3">
                  <Trash2 className="w-5 h-5 text-red-400 mt-0.5 flex-shrink-0" aria-hidden="true" />
                  <div>
                    <h3 className="text-sm font-bold text-red-400">Delete Account</h3>
                    <p className="text-xs text-muted mt-1 leading-relaxed">
                      This will permanently delete your account, playlists, listening history, and all associated data. This action cannot be undone.
                    </p>
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold" htmlFor="settings-confirm-delete">
                    Type <strong className="text-red-400">{user.username}</strong> to confirm
                  </label>
                  <input id="settings-confirm-delete" type="text" value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} placeholder={user.username} className="w-full bg-background border border-red-500/30 rounded-lg px-4 py-2.5 text-sm text-text focus:outline-none focus:border-red-500/50 transition font-mono" />
                </div>
                {deleteError && <ErrorBanner message={deleteError} icon={AlertCircle} />}
                <button
                  onClick={handleDeleteAccount}
                  disabled={deleteLoading || confirmDelete !== user.username}
                  className="w-full py-2.5 bg-red-600 hover:bg-red-700 text-white font-editorial text-sm font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Trash2 className="w-4 h-4" aria-hidden="true" />
                  {deleteLoading ? "Deleting account..." : "Permanently Delete My Account"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ErrorBanner({ message, icon: Icon }: { message: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex items-center gap-2 text-xs text-primary bg-primary/5 border border-primary/20 p-3 rounded-lg" role="alert">
      <Icon className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function SuccessBanner({ message, icon: Icon }: { message: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex items-center gap-2 text-xs text-emerald-500 bg-emerald-500/5 border border-emerald-500/20 p-3 rounded-lg" role="status">
      <Icon className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
