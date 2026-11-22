import React, { useState } from 'react';
import {
  ArrowLeft,
  ExternalLink,
  Eye,
  EyeOff,
  Lock,
  LogOut,
  MailCheck,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import {
  sendResetPasswordEmail,
  sendVerificationEmail,
  signInWithEmail,
  signInWithGoogle,
  signOutUser,
} from '../firebase';
import type { StaffRole } from '../types';

interface AdminLoginPortalProps {
  user: User | null;
  checkingRole: boolean;
  resolvedRole: StaffRole | null;
  onBackToWebsite: () => void;
  onRefreshAuth: () => Promise<void>;
}

const FIREBASE_AUTH_PROVIDERS_URL =
  'https://console.firebase.google.com/project/gen-lang-client-0915453178/authentication/providers';

export function AdminLoginPortal({
  user,
  checkingRole,
  resolvedRole,
  onBackToWebsite,
  onRefreshAuth,
}: AdminLoginPortalProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [authError, setAuthError] = useState<string | null>(null);
  const [providerDisabled, setProviderDisabled] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const handleEmailPasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setProviderDisabled(false);
    setAuthNotice(null);

    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      setAuthError('Please enter both your admin email and password.');
      return;
    }

    setSigningIn(true);
    try {
      await signInWithEmail(cleanEmail, password);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to sign in.';
      if (msg.includes('auth/operation-not-allowed')) {
        setProviderDisabled(true);
      } else if (
        msg.includes('auth/invalid-credential') ||
        msg.includes('auth/wrong-password') ||
        msg.includes('auth/user-not-found')
      ) {
        setAuthError('Invalid admin email or password. Please check your credentials and try again.');
      } else {
        setAuthError(msg);
      }
    } finally {
      setSigningIn(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    setProviderDisabled(false);
    setAuthNotice(null);
    setSigningIn(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Unable to complete Google sign-in.');
    } finally {
      setSigningIn(false);
    }
  };

  const handleForgotPassword = async () => {
    setAuthError(null);
    setProviderDisabled(false);
    setAuthNotice(null);
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setAuthError('Enter your admin email address first to receive a password reset link.');
      return;
    }
    try {
      await sendResetPasswordEmail(cleanEmail);
      setAuthNotice(`Password reset email sent to ${cleanEmail}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not send password reset email.';
      if (msg.includes('auth/operation-not-allowed')) {
        setProviderDisabled(true);
      } else {
        setAuthError(msg);
      }
    }
  };

  const handleSendVerification = async () => {
    if (!user) return;
    setAuthError(null);
    setAuthNotice(null);
    try {
      await sendVerificationEmail(user);
      setAuthNotice(`Verification link sent to ${user.email}. Click the link, then click Refresh Status.`);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Failed to send verification email.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between p-6">
      <div>
        <button
          type="button"
          onClick={onBackToWebsite}
          className="inline-flex items-center gap-2 text-xs font-medium text-slate-400 hover:text-white transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          Return to Public Website
        </button>
      </div>

      <div className="max-w-md w-full mx-auto bg-slate-900 border border-slate-800 rounded-2xl p-8">
        <div className="w-12 h-12 rounded-xl bg-blue-600/15 border border-blue-500/30 text-blue-400 flex items-center justify-center mb-6">
          <Lock className="w-6 h-6" />
        </div>

        <h1 className="font-display text-2xl font-bold tracking-tight text-white mb-2">
          Admin Login Portal
        </h1>
        <p className="text-sm text-slate-400 leading-relaxed mb-6">
          Enter your authorized administrator email and password to access the Client Enrolment
          Admin Panel.
        </p>

        {providerDisabled && (
          <div className="mb-5 p-4 rounded-xl bg-amber-950/60 border border-amber-700/70 space-y-3 text-xs text-amber-100">
            <div className="font-semibold text-amber-200">
              Email/Password Provider Not Enabled Yet
            </div>
            <p className="text-amber-100/85 leading-relaxed">
              Your Firebase project currently only has Google Sign-In enabled. Choose either option
              to enter the Admin Panel:
            </p>
            <button
              type="button"
              disabled={signingIn}
              onClick={handleGoogleSignIn}
              className="w-full py-2.5 px-3 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-lg transition-colors cursor-pointer"
            >
              Sign In Now with Google
            </button>
            <div className="pt-2 border-t border-amber-800/60 space-y-1.5 text-amber-100/80">
              <div className="font-semibold text-amber-200">Or enable Email/Password once:</div>
              <div>1. Open Firebase Authentication Providers</div>
              <div>2. Enable Email/Password &amp; add your admin user</div>
              <a
                href={FIREBASE_AUTH_PROVIDERS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-blue-300 hover:text-blue-200 underline font-medium pt-1"
              >
                Open Firebase Authentication Console
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
        )}

        {authError && (
          <div className="mb-5 p-3.5 rounded-lg bg-red-950/60 border border-red-800 text-xs text-red-200 leading-relaxed">
            {authError}
          </div>
        )}

        {authNotice && (
          <div className="mb-5 p-3.5 rounded-lg bg-emerald-950/60 border border-emerald-800 text-xs text-emerald-200 leading-relaxed">
            {authNotice}
          </div>
        )}

        {checkingRole ? (
          <div className="py-6 text-center text-sm text-slate-300">
            Verifying administrator permissions...
          </div>
        ) : !user ? (
          <div className="space-y-5">
            <form onSubmit={handleEmailPasswordLogin} className="space-y-4">
              <div>
                <label htmlFor="adminEmail" className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Admin Email
                </label>
                <input
                  id="adminEmail"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter admin email"
                  className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="adminPassword" className="block text-xs font-semibold text-slate-300">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <input
                    id="adminPassword"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter admin password"
                    className="w-full pl-3.5 pr-10 py-2.5 bg-slate-950 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((p) => !p)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={signingIn}
                className="w-full py-3 px-5 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm rounded-lg transition-colors cursor-pointer disabled:opacity-60"
              >
                {signingIn ? 'Signing In...' : 'Sign In as Admin'}
              </button>
            </form>

            <div className="relative flex items-center py-1">
              <div className="flex-grow border-t border-slate-800" />
              <span className="shrink mx-3 text-xs text-slate-500">or</span>
              <div className="flex-grow border-t border-slate-800" />
            </div>

            <button
              type="button"
              disabled={signingIn}
              onClick={handleGoogleSignIn}
              className="w-full py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs rounded-lg transition-colors cursor-pointer disabled:opacity-60"
            >
              Sign In Instantly with Authorized Google Account
            </button>

            <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 space-y-1.5 text-xs text-slate-400">
              <div className="font-semibold text-slate-200 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                Role-Based Access Tiers
              </div>
              <div>· Super Admin · Verification Officer · Support Agent</div>
            </div>
          </div>
        ) : !user.emailVerified ? (
          <div className="space-y-5">
            <div className="p-4 rounded-xl bg-amber-950/40 border border-amber-800/70 space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-amber-300">
                <MailCheck className="w-4 h-4" />
                Email Verification Required
              </div>
              <p className="text-xs text-amber-200/80 leading-relaxed">
                Signed in as <span className="font-mono text-white">{user.email}</span>. Please
                verify your email address before accessing client records.
              </p>
            </div>

            <div className="flex flex-col gap-2.5">
              <button
                type="button"
                onClick={handleSendVerification}
                className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer"
              >
                Send Verification Email
              </button>
              <button
                type="button"
                onClick={() => void onRefreshAuth()}
                className="inline-flex items-center justify-center gap-1.5 w-full py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                I Verified My Email — Refresh Status
              </button>
              <button
                type="button"
                onClick={() => void signOutUser()}
                className="inline-flex items-center justify-center gap-1.5 w-full py-2 text-slate-400 hover:text-white text-xs cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign Out
              </button>
            </div>
          </div>
        ) : !resolvedRole ? (
          <div className="space-y-5">
            <div className="p-4 rounded-xl bg-red-950/50 border border-red-900/70 space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-red-300">
                <ShieldAlert className="w-4 h-4" />
                Access Denied
              </div>
              <p className="text-xs text-red-200/80 leading-relaxed">
                Signed in as <span className="font-mono text-white">{user.email}</span>. This account
                does not have an active role in the staff access directory.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                onClick={() => void signOutUser()}
                className="flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                Switch Admin Account
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="text-center text-xs text-slate-600">
        Client Enrolment System · Role-Based Access Control
      </div>
    </div>
  );
}
