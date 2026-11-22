import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { auth, db } from './firebase';
import {
  DEFAULT_SYSTEM_SETTINGS,
  isBootstrapAdminEmail,
  type StaffMember,
  type StaffRole,
  type SystemSettings,
} from './types';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ClientPortal } from './components/ClientPortal';
import { AdminLoginPortal } from './components/AdminLoginPortal';
import { AdminDashboard } from './components/AdminDashboard';

function AppContent() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const [viewMode, setViewMode] = useState<'public' | 'admin'>('public');
  const [checkingRole, setCheckingRole] = useState(false);
  const [resolvedRole, setResolvedRole] = useState<StaffRole | null>(null);
  const [authRefreshTick, setAuthRefreshTick] = useState(0);

  const [settings, setSettings] = useState<Omit<SystemSettings, 'updatedAt'>>(
    DEFAULT_SYSTEM_SETTINGS
  );

  // Listen for Firebase Auth state
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  // Listen for public system settings (with safe defaults)
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'settings', 'public'),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as SystemSettings;
          setSettings({
            whatsappNumber: data.whatsappNumber || DEFAULT_SYSTEM_SETTINGS.whatsappNumber,
            supportEmail: data.supportEmail || DEFAULT_SYSTEM_SETTINGS.supportEmail,
            tier1Amount: data.tier1Amount || DEFAULT_SYSTEM_SETTINGS.tier1Amount,
            tier2Amount: data.tier2Amount || DEFAULT_SYSTEM_SETTINGS.tier2Amount,
            tier3Amount: data.tier3Amount || DEFAULT_SYSTEM_SETTINGS.tier3Amount,
            otpNoticeText: data.otpNoticeText || DEFAULT_SYSTEM_SETTINGS.otpNoticeText,
          });
        }
      },
      () => {
        // Fallback to default settings if unreadable
      }
    );
    return () => unsub();
  }, []);

  // Resolve staff role when accessing the hidden Admin Portal
  useEffect(() => {
    if (viewMode !== 'admin') return;
    if (!authReady || !user || !user.email || !user.emailVerified) {
      setResolvedRole(null);
      setCheckingRole(false);
      return;
    }

    const emailLower = user.email.toLowerCase();
    if (isBootstrapAdminEmail(emailLower)) {
      setResolvedRole('super_admin');
      setCheckingRole(false);
      return;
    }

    let cancelled = false;
    setCheckingRole(true);
    getDoc(doc(db, 'staffAccess', emailLower))
      .then((snap) => {
        if (cancelled) return;
        if (snap.exists()) {
          const data = snap.data() as StaffMember;
          setResolvedRole(data.active ? data.role : null);
        } else {
          setResolvedRole(null);
        }
      })
      .catch(() => {
        if (!cancelled) setResolvedRole(null);
      })
      .finally(() => {
        if (!cancelled) setCheckingRole(false);
      });

    return () => {
      cancelled = true;
    };
  }, [viewMode, authReady, user, authRefreshTick]);

  const handleOpenAdminPortal = () => {
    setViewMode('admin');
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  };

  const handleBackToWebsite = () => {
    setViewMode('public');
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  };

  const handleRefreshAuth = async () => {
    if (auth.currentUser) {
      await auth.currentUser.reload();
      await auth.currentUser.getIdToken(true);
      setUser(auth.currentUser);
      setAuthRefreshTick((t) => t + 1);
    }
  };

  if (viewMode === 'admin') {
    if (user && resolvedRole && !checkingRole) {
      return (
        <AdminDashboard
          user={user}
          role={resolvedRole}
          settings={settings}
          onBackToWebsite={handleBackToWebsite}
        />
      );
    }
    return (
      <AdminLoginPortal
        user={user}
        checkingRole={checkingRole}
        resolvedRole={resolvedRole}
        onBackToWebsite={handleBackToWebsite}
        onRefreshAuth={handleRefreshAuth}
      />
    );
  }

  return (
    <ClientPortal
      settings={settings}
      onOpenAdminPortal={handleOpenAdminPortal}
    />
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}
