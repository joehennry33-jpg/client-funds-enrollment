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
import { AdminConsoleGate } from './components/AdminConsoleGate';
import { AdminLoginPortal } from './components/AdminLoginPortal';
import { AdminDashboard } from './components/AdminDashboard';

function isAdminConsoleLocation(): boolean {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  const hash = window.location.hash.toLowerCase();
  return (
    pathname === '/admin-console' ||
    pathname === '/admin' ||
    hash === '#admin-console' ||
    hash === '#admin'
  );
}

function AppContent() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const [isAdminRoute, setIsAdminRoute] = useState<boolean>(() => isAdminConsoleLocation());
  // Keep URL unlock Bearer token strictly in React memory (never persisted to Web Storage)
  const [adminConsoleToken, setAdminConsoleToken] = useState<string | null>(null);
  const [checkingRole, setCheckingRole] = useState(false);
  const [resolvedRole, setResolvedRole] = useState<StaffRole | null>(null);
  const [authRefreshTick, setAuthRefreshTick] = useState(0);

  const [settings, setSettings] = useState<Omit<SystemSettings, 'updatedAt'>>(
    DEFAULT_SYSTEM_SETTINGS
  );

  // Sync URL route for /admin-console (and normalize /admin -> /admin-console)
  useEffect(() => {
    const normalizePath = () => {
      const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
      const hash = window.location.hash.toLowerCase();
      if (pathname === '/admin' || hash === '#admin' || hash === '#admin-console') {
        window.history.replaceState({}, '', '/admin-console');
        setIsAdminRoute(true);
      } else {
        setIsAdminRoute(pathname === '/admin-console');
      }
    };

    normalizePath();
    window.addEventListener('popstate', normalizePath);
    window.addEventListener('hashchange', normalizePath);
    return () => {
      window.removeEventListener('popstate', normalizePath);
      window.removeEventListener('hashchange', normalizePath);
    };
  }, []);

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

  // Resolve staff role when accessing the unlocked /admin-console route
  useEffect(() => {
    if (!isAdminRoute || !adminConsoleToken) return;
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
  }, [isAdminRoute, adminConsoleToken, authReady, user, authRefreshTick]);

  const handleBackToWebsite = () => {
    setAdminConsoleToken(null);
    setIsAdminRoute(false);
    window.history.pushState({}, '', '/');
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

  if (isAdminRoute) {
    if (!adminConsoleToken) {
      return (
        <AdminConsoleGate
          onUnlocked={(token) => setAdminConsoleToken(token)}
          onBackToWebsite={handleBackToWebsite}
        />
      );
    }

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

  return <ClientPortal settings={settings} />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}
