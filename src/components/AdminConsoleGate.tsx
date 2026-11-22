import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  ShieldCheck,
} from 'lucide-react';

interface AdminConsoleGateProps {
  onUnlocked: (token: string) => void;
  onBackToWebsite: () => void;
}

type GateMode = 'loading' | 'unset' | 'env' | 'claimed';

export function AdminConsoleGate({
  onUnlocked,
  onBackToWebsite,
}: AdminConsoleGateProps) {
  const [mode, setMode] = useState<GateMode>('loading');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadGateStatus = async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin-console/status');
      const data = (await res.json()) as {
        configured?: boolean;
        mode?: 'env' | 'claimed' | 'unset';
        error?: string;
      };
      if (!res.ok) {
        setError(data.error || 'Unable to check Admin Console status.');
        setMode('claimed');
        return;
      }
      setMode(data.mode || (data.configured ? 'claimed' : 'unset'));
    } catch {
      setError('Unable to reach server. Please check your connection and try again.');
      setMode('claimed');
    }
  };

  useEffect(() => {
    void loadGateStatus();
  }, []);

  const handleSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError('Admin Console password must be at least 8 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/admin-console/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, confirmPassword }),
      });
      const data = (await res.json()) as {
        unlocked?: boolean;
        token?: string;
        error?: string;
      };
      if (!res.ok || !data.unlocked || !data.token) {
        setError(data.error || 'Unable to set Admin Console password.');
        if (res.status === 409) {
          void loadGateStatus();
        }
        return;
      }
      setPassword('');
      setConfirmPassword('');
      onUnlocked(data.token);
    } catch {
      setError('Unable to reach server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUnlockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!password) {
      setError('Please enter the Admin Console password.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/admin-console/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json()) as {
        unlocked?: boolean;
        token?: string;
        needsSetup?: boolean;
        error?: string;
      };
      if (!res.ok || !data.unlocked || !data.token) {
        if (data.needsSetup) {
          setMode('unset');
        }
        setError(data.error || 'Incorrect Admin Console password.');
        return;
      }
      setPassword('');
      onUnlocked(data.token);
    } catch {
      setError('Unable to reach server. Please try again.');
    } finally {
      setSubmitting(false);
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
          {mode === 'unset' ? <KeyRound className="w-6 h-6" /> : <Lock className="w-6 h-6" />}
        </div>

        <h1 className="font-display text-2xl font-bold tracking-tight text-white mb-2">
          {mode === 'unset' ? 'Configure Admin Console Password' : 'Protected Admin Console'}
        </h1>
        <p className="text-sm text-slate-400 leading-relaxed mb-6">
          {mode === 'unset'
            ? 'Set a dedicated URL access password before opening the Admin Console. Once saved, anyone visiting /admin-console must enter this password first.'
            : 'This Admin Console URL is password-protected. Enter the console password to proceed to staff authentication.'}
        </p>

        {error && (
          <div className="mb-5 p-3.5 rounded-lg bg-red-950/60 border border-red-800 text-xs text-red-200 leading-relaxed">
            {error}
          </div>
        )}

        {mode === 'loading' ? (
          <div className="py-6 text-center text-sm text-slate-300">
            Checking Admin Console security status...
          </div>
        ) : mode === 'unset' ? (
          <form onSubmit={handleSetupSubmit} className="space-y-4">
            <div>
              <label htmlFor="setupConsolePassword" className="block text-xs font-semibold text-slate-300 mb-1.5">
                New Console Password
              </label>
              <div className="relative">
                <input
                  id="setupConsolePassword"
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
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

            <div>
              <label htmlFor="confirmConsolePassword" className="block text-xs font-semibold text-slate-300 mb-1.5">
                Confirm Console Password
              </label>
              <input
                id="confirmConsolePassword"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={8}
                maxLength={128}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter console password"
                className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 px-5 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm rounded-lg transition-colors cursor-pointer disabled:opacity-60"
            >
              {submitting ? 'Saving Password...' : 'Set Password & Unlock Console'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleUnlockSubmit} className="space-y-4">
            <div>
              <label htmlFor="consoleGatePassword" className="block text-xs font-semibold text-slate-300 mb-1.5">
                Console Password
              </label>
              <div className="relative">
                <input
                  id="consoleGatePassword"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter Admin Console password"
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
              disabled={submitting}
              className="w-full py-3 px-5 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm rounded-lg transition-colors cursor-pointer disabled:opacity-60"
            >
              {submitting ? 'Verifying...' : 'Unlock Admin Console'}
            </button>

            <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center gap-2.5 text-xs text-slate-400">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>Server-verified password protection · /admin-console</span>
            </div>
          </form>
        )}
      </div>

      <div className="text-center text-xs text-slate-600">
        Client Support · Restricted Admin Console
      </div>
    </div>
  );
}
