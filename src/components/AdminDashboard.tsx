import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Bell,
  Check,
  CheckCircle2,
  ClipboardList,
  Clock,
  Download,
  Handshake,
  Home,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  Pencil,
  Plus,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Trash2,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType, signOutUser } from '../firebase';
import type {
  AccountStatus,
  Enrolment,
  EnrolmentStatus,
  OtpRequest,
  StaffMember,
  StaffRole,
  SystemSettings,
} from '../types';
import { BOOTSTRAP_ADMIN_EMAIL } from '../types';

type AdminTab =
  | 'dashboard'
  | 'clients'
  | 'submissions'
  | 'otp'
  | 'users'
  | 'reports'
  | 'settings';

interface AdminDashboardProps {
  user: User;
  role: StaffRole;
  settings: Omit<SystemSettings, 'updatedAt'>;
  onBackToWebsite: () => void;
}

const ROLE_LABELS: Record<StaffRole, string> = {
  super_admin: 'Super Admin',
  verification_officer: 'Verification Officer',
  support_agent: 'Support Agent',
};

function formatDateTime(ts: Enrolment['createdAt']): string {
  if (!ts) return '—';
  try {
    return ts.toDate().toLocaleString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function AdminDashboard({ user, role, settings, onBackToWebsite }: AdminDashboardProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Live collections
  const [enrolments, setEnrolments] = useState<Enrolment[]>([]);
  const [otpRequests, setOtpRequests] = useState<OtpRequest[]>([]);
  const [staffList, setStaffList] = useState<StaffMember[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  // Live clock
  const [nowStr, setNowStr] = useState(() =>
    new Date().toLocaleString('en-GB', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  );

  // Search & filters
  const [clientSearch, setClientSearch] = useState('');
  const [submissionFilter, setSubmissionFilter] = useState<'all' | 'final' | 'otp_verified' | 'stage1'>('all');

  // Modals (Admins never view PIN hashes or generate/issue/send OTPs)
  const [editingClient, setEditingClient] = useState<Enrolment | null>(null);
  const [editForm, setEditForm] = useState({
    fullName: '',
    phoneNumber: '',
    packageAmount: settings.tier1Amount,
    status: 'Pending' as EnrolmentStatus,
    accountStatus: 'Active' as AccountStatus,
    comment: '',
  });
  const [deletingClient, setDeletingClient] = useState<Enrolment | null>(null);

  // Manage Users (RBAC) state
  const [newStaffEmail, setNewStaffEmail] = useState('');
  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffRole, setNewStaffRole] = useState<StaffRole>('verification_officer');

  // Settings state
  const [settingsForm, setSettingsForm] = useState(settings);
  const [actionBusy, setActionBusy] = useState(false);
  const [feedbackBanner, setFeedbackBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const canVerify = role === 'super_admin' || role === 'verification_officer';
  const isSuperAdmin = role === 'super_admin';

  useEffect(() => {
    setSettingsForm(settings);
  }, [settings]);

  useEffect(() => {
    const id = setInterval(() => {
      setNowStr(
        new Date().toLocaleString('en-GB', {
          weekday: 'short',
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      );
    }, 30000);
    return () => clearInterval(id);
  }, []);

  // Subscribe to all Firestore admin feeds
  useEffect(() => {
    setLoadingData(true);
    const unsubEnrolments = onSnapshot(
      query(collection(db, 'enrolments'), orderBy('createdAt', 'desc')),
      (snap) => {
        setEnrolments(
          snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<Enrolment, 'id'>),
          }))
        );
        setLoadingData(false);
      },
      (err) => {
        setLoadingData(false);
        handleFirestoreError(err, OperationType.LIST, 'enrolments');
      }
    );

    const unsubOtp = onSnapshot(
      query(collection(db, 'otpRequests'), orderBy('createdAt', 'desc')),
      (snap) => {
        setOtpRequests(
          snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<OtpRequest, 'id'>),
          }))
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'otpRequests')
    );

    const unsubStaff = onSnapshot(
      collection(db, 'staffAccess'),
      (snap) => {
        setStaffList(snap.docs.map((d) => d.data() as StaffMember));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'staffAccess')
    );

    return () => {
      unsubEnrolments();
      unsubOtp();
      unsubStaff();
    };
  }, []);

  const kpis = useMemo(() => {
    const total = enrolments.length;
    const verified = enrolments.filter((e) => e.status === 'Verified').length;
    const pending = enrolments.filter((e) => e.status === 'Pending').length;
    const pendingOtp = otpRequests.filter((r) => r.status === 'Pending').length;
    return { total, verified, pending, pendingOtp };
  }, [enrolments, otpRequests]);

  const pendingOtpList = useMemo(
    () => otpRequests.filter((r) => r.status === 'Pending'),
    [otpRequests]
  );

  const secondFormSubmissions = useMemo(
    () => enrolments.filter((e) => e.stage === 'final_submitted'),
    [enrolments]
  );

  const filteredClients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase();
    if (!q) return enrolments;
    return enrolments.filter(
      (e) =>
        e.fullName.toLowerCase().includes(q) ||
        e.phoneNumber.toLowerCase().includes(q) ||
        (e.applicationRef || '').toLowerCase().includes(q) ||
        e.email.toLowerCase().includes(q)
    );
  }, [enrolments, clientSearch]);

  const filteredSubmissions = useMemo(() => {
    if (submissionFilter === 'final') {
      return enrolments.filter((e) => e.stage === 'final_submitted');
    }
    if (submissionFilter === 'otp_verified') {
      return enrolments.filter((e) => e.stage === 'otp_verified');
    }
    if (submissionFilter === 'stage1') {
      return enrolments.filter((e) => e.stage === 'stage1_submitted');
    }
    return enrolments;
  }, [enrolments, submissionFilter]);

  const reportStats = useMemo(() => {
    const totalVolume = secondFormSubmissions.reduce((acc, e) => acc + (e.packageAmount || 0), 0);
    const verifiedRate =
      enrolments.length > 0
        ? Math.round((enrolments.filter((e) => e.status === 'Verified').length / enrolments.length) * 100)
        : 0;
    const byIntention: Record<string, number> = {};
    for (const e of secondFormSubmissions) {
      const key = e.intention || 'Unspecified';
      byIntention[key] = (byIntention[key] || 0) + 1;
    }
    return { totalVolume, verifiedRate, byIntention };
  }, [enrolments, secondFormSubmissions]);

  const showBanner = (type: 'success' | 'error', text: string) => {
    setFeedbackBanner({ type, text });
    setTimeout(() => setFeedbackBanner(null), 4000);
  };

  const openEditModal = (client: Enrolment) => {
    setEditingClient(client);
    setEditForm({
      fullName: client.fullName,
      phoneNumber: client.phoneNumber,
      packageAmount: client.packageAmount || settings.tier1Amount,
      status: client.status,
      accountStatus: client.accountStatus,
      comment: client.comment || '',
    });
  };

  const handleSaveClientEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingClient) return;

    setActionBusy(true);
    try {
      const payload = canVerify
        ? {
            fullName: editForm.fullName.trim().slice(0, 100),
            phoneNumber: editForm.phoneNumber.trim().slice(0, 20),
            packageAmount: Number(editForm.packageAmount) || 0,
            packageLabel: `KES ${(Number(editForm.packageAmount) || 0).toLocaleString()}`,
            status: editForm.status,
            accountStatus: editForm.accountStatus,
            comment: editForm.comment.trim().slice(0, 500),
            updatedAt: serverTimestamp(),
          }
        : {
            comment: editForm.comment.trim().slice(0, 500),
            updatedAt: serverTimestamp(),
          };

      await updateDoc(doc(db, 'enrolments', editingClient.id), payload);
      setEditingClient(null);
      showBanner('success', `Updated record for ${editForm.fullName}.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `enrolments/${editingClient.id}`);
    } finally {
      setActionBusy(false);
    }
  };

  const handleConfirmDeleteClient = async () => {
    if (!deletingClient || !isSuperAdmin) return;
    setActionBusy(true);
    try {
      await deleteDoc(doc(db, 'enrolments', deletingClient.id));
      showBanner('success', `Deleted client record for ${deletingClient.fullName}.`);
      setDeletingClient(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `enrolments/${deletingClient.id}`);
    } finally {
      setActionBusy(false);
    }
  };

  const handleAcknowledgeOtpRequest = async (req: OtpRequest) => {
    setActionBusy(true);
    try {
      await updateDoc(doc(db, 'otpRequests', req.id), {
        status: 'Acknowledged',
        updatedAt: serverTimestamp(),
      });
      showBanner('success', `Acknowledged resend notification for ${req.clientName} (${req.applicationRef}).`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `otpRequests/${req.id}`);
    } finally {
      setActionBusy(false);
    }
  };

  const handleAddStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin) return;
    const cleanEmail = newStaffEmail.trim().toLowerCase();
    const cleanName = newStaffName.trim();
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(cleanEmail)) {
      showBanner('error', 'Please enter a valid email address.');
      return;
    }
    if (cleanName.length < 1) {
      showBanner('error', 'Please enter a display name.');
      return;
    }

    setActionBusy(true);
    try {
      await setDoc(doc(db, 'staffAccess', cleanEmail), {
        email: cleanEmail,
        displayName: cleanName.slice(0, 100),
        role: newStaffRole,
        active: true,
        addedBy: (user.email || BOOTSTRAP_ADMIN_EMAIL).toLowerCase(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setNewStaffEmail('');
      setNewStaffName('');
      showBanner('success', `Added ${cleanEmail} as ${ROLE_LABELS[newStaffRole]}.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `staffAccess/${cleanEmail}`);
    } finally {
      setActionBusy(false);
    }
  };

  const handleToggleStaffActive = async (member: StaffMember) => {
    if (!isSuperAdmin || member.email === BOOTSTRAP_ADMIN_EMAIL) return;
    try {
      await updateDoc(doc(db, 'staffAccess', member.email), {
        active: !member.active,
        updatedAt: serverTimestamp(),
      });
      showBanner('success', `${member.email} is now ${!member.active ? 'Active' : 'Inactive'}.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `staffAccess/${member.email}`);
    }
  };

  const handleRemoveStaff = async (member: StaffMember) => {
    if (!isSuperAdmin || member.email === BOOTSTRAP_ADMIN_EMAIL) return;
    try {
      await deleteDoc(doc(db, 'staffAccess', member.email));
      showBanner('success', `Removed ${member.email} from staff access.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `staffAccess/${member.email}`);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin) return;
    setActionBusy(true);
    try {
      await setDoc(doc(db, 'settings', 'public'), {
        whatsappNumber: settingsForm.whatsappNumber.trim().slice(0, 25),
        supportEmail: settingsForm.supportEmail.trim().slice(0, 150),
        tier1Amount: Number(settingsForm.tier1Amount),
        tier2Amount: Number(settingsForm.tier2Amount),
        tier3Amount: Number(settingsForm.tier3Amount),
        otpNoticeText: settingsForm.otpNoticeText.trim().slice(0, 300),
        updatedAt: serverTimestamp(),
      });
      showBanner('success', 'System settings updated.');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/public');
    } finally {
      setActionBusy(false);
    }
  };

  const handleExportCsv = () => {
    const headers = [
      'Application Ref',
      'Full Name',
      'Phone Number',
      'Email',
      'Package',
      'Intention',
      'OTP Verified',
      'Status',
      'Comment',
      'Date',
    ];
    const rows = filteredSubmissions.map((e) => [
      `"${e.applicationRef || '—'}"`,
      `"${e.fullName.replace(/"/g, '""')}"`,
      `"${e.phoneNumber}"`,
      `"${e.email}"`,
      `"${e.packageLabel || 'N/A'}"`,
      `"${e.intention || 'N/A'}"`,
      `"${e.otpVerified ? 'Verified' : 'Pending'}"`,
      `"${e.status}"`,
      `"${(e.comment || '').replace(/"/g, '""')}"`,
      `"${formatDateTime(e.createdAt)}"`,
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `client-enrolments-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const whatsappDigits = settings.whatsappNumber.replace(/[^0-9]/g, '');
  const lastSignIn = user.metadata.lastSignInTime
    ? new Date(user.metadata.lastSignInTime).toLocaleString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : nowStr;

  const navItems: { id: AdminTab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" /> },
    { id: 'clients', label: 'Clients Accounts', icon: <Users className="w-4 h-4" /> },
    { id: 'submissions', label: 'Form Submissions', icon: <ClipboardList className="w-4 h-4" /> },
    {
      id: 'otp',
      label: 'OTP Notifications',
      icon: <Bell className="w-4 h-4" />,
      badge: kpis.pendingOtp,
    },
    { id: 'users', label: 'Manage Users', icon: <Shield className="w-4 h-4" /> },
    { id: 'reports', label: 'Reports', icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'settings', label: 'Settings', icon: <Settings className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen flex bg-slate-100 text-slate-900">
      {/* Dark Navy Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-[#0B2447] text-slate-100 flex flex-col justify-between transition-transform lg:static lg:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div>
          <div className="p-5 border-b border-white/10 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-blue-600/30 border border-blue-400/30 flex items-center justify-center text-white">
                <Handshake className="w-5 h-5" />
              </div>
              <div className="leading-tight">
                <div className="font-display text-sm font-bold text-white">Client Enrolment</div>
                <div className="text-xs text-slate-300">Admin Panel</div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="lg:hidden p-1 text-slate-300 hover:text-white cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <nav className="p-3 space-y-1">
            {navItems.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setActiveTab(item.id);
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                    active
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-300 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <span className="flex items-center gap-3">
                    {item.icon}
                    {item.label}
                  </span>
                  {typeof item.badge === 'number' && item.badge > 0 && (
                    <span className="px-2 py-0.5 text-xs font-mono font-bold bg-red-600 text-white rounded-full tabular-nums">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}

            <div className="pt-3 mt-3 border-t border-white/10 space-y-1">
              <button
                type="button"
                onClick={onBackToWebsite}
                className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
              >
                <Home className="w-4 h-4" />
                Public Website
              </button>
              <button
                type="button"
                onClick={() => void signOutUser()}
                className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </button>
            </div>
          </nav>
        </div>

        {/* Bottom WhatsApp Support Card */}
        <div className="p-4">
          <a
            href={`https://wa.me/${whatsappDigits}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 p-3.5 rounded-xl bg-white/5 border border-white/15 hover:bg-white/10 transition-colors"
          >
            <div className="w-9 h-9 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0">
              <MessageCircle className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-white">Support</div>
              <div className="text-xs font-mono text-emerald-300 truncate tabular-nums">
                {settings.whatsappNumber}
              </div>
            </div>
          </a>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 rounded-lg border border-slate-200 text-slate-700 cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <h1 className="font-display text-xl font-bold text-slate-900 truncate">
                Welcome, {user.displayName?.split(' ')[0] || 'Admin'}
              </h1>
              <p className="text-xs text-slate-500 truncate">
                Role: {ROLE_LABELS[role]} · Manage clients and monitor enrolment activity
              </p>
            </div>
          </div>

          <div className="flex items-center gap-5 shrink-0">
            <span className="hidden sm:inline text-xs font-mono text-slate-600 tabular-nums">
              {nowStr}
            </span>
            <button
              type="button"
              onClick={() => void signOutUser()}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 hover:text-slate-900 cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              Logout
            </button>
          </div>
        </header>

        {/* Feedback Banner */}
        {feedbackBanner && (
          <div
            className={`mx-6 mt-5 px-4 py-3 rounded-lg border text-sm font-medium ${
              feedbackBanner.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-red-50 border-red-200 text-red-800'
            }`}
          >
            {feedbackBanner.text}
          </div>
        )}

        <main className="flex-1 p-6 space-y-6">
          {/* 4 KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="rounded-xl bg-blue-600 text-white p-5 flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-white/15 flex items-center justify-center shrink-0">
                <Users className="w-6 h-6" />
              </div>
              <div>
                <div className="text-xs font-medium text-blue-100">Total Clients</div>
                <div className="font-display text-3xl font-bold tabular-nums">{kpis.total}</div>
              </div>
            </div>

            <div className="rounded-xl bg-emerald-600 text-white p-5 flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-white/15 flex items-center justify-center shrink-0">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <div className="text-xs font-medium text-emerald-100">Verified Clients</div>
                <div className="font-display text-3xl font-bold tabular-nums">{kpis.verified}</div>
              </div>
            </div>

            <div className="rounded-xl bg-amber-500 text-slate-950 p-5 flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-black/10 flex items-center justify-center shrink-0">
                <Clock className="w-6 h-6" />
              </div>
              <div>
                <div className="text-xs font-semibold text-amber-950/80">Pending Verification</div>
                <div className="font-display text-3xl font-bold tabular-nums">{kpis.pending}</div>
              </div>
            </div>

            <div className="rounded-xl bg-purple-700 text-white p-5 flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-white/15 flex items-center justify-center shrink-0">
                <Bell className="w-6 h-6" />
              </div>
              <div>
                <div className="text-xs font-medium text-purple-100">OTP Resend Requests</div>
                <div className="font-display text-3xl font-bold tabular-nums">{kpis.pendingOtp}</div>
              </div>
            </div>
          </div>

          {/* DASHBOARD OVERVIEW TAB */}
          {activeTab === 'dashboard' && (
            <div className="space-y-6">
              {/* Row 1: Recent Clients + OTP Notifications */}
              <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
                {/* Recent Clients */}
                <section className="xl:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="bg-[#0F2C59] text-white px-5 py-3.5 flex items-center justify-between">
                    <div className="flex items-center gap-2.5 font-display text-sm font-bold">
                      <Users className="w-4 h-4" />
                      Recent Clients
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveTab('clients')}
                      className="text-xs font-medium text-blue-200 hover:text-white cursor-pointer"
                    >
                      View All →
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                          <th className="py-2.5 px-4">#</th>
                          <th className="py-2.5 px-4">App Ref</th>
                          <th className="py-2.5 px-4">Name</th>
                          <th className="py-2.5 px-4">Phone Number</th>
                          <th className="py-2.5 px-4">Package</th>
                          <th className="py-2.5 px-4">Status</th>
                          <th className="py-2.5 px-4">Date</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-xs">
                        {loadingData ? (
                          <tr>
                            <td colSpan={7} className="py-6 px-4 text-center text-slate-500">
                              Loading client records...
                            </td>
                          </tr>
                        ) : enrolments.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="py-6 px-4 text-center text-slate-500">
                              No clients enrolled yet.
                            </td>
                          </tr>
                        ) : (
                          enrolments.slice(0, 5).map((client, idx) => (
                            <tr key={client.id} className="hover:bg-slate-50">
                              <td className="py-2.5 px-4 font-mono tabular-nums text-slate-500">
                                {idx + 1}
                              </td>
                              <td className="py-2.5 px-4 font-mono text-slate-700">
                                {client.applicationRef || '—'}
                              </td>
                              <td className="py-2.5 px-4 font-semibold text-slate-900">
                                {client.fullName}
                              </td>
                              <td className="py-2.5 px-4 font-mono tabular-nums text-slate-600">
                                {client.phoneNumber}
                              </td>
                              <td className="py-2.5 px-4 font-mono tabular-nums text-slate-800">
                                {client.packageLabel || 'Pending'}
                              </td>
                              <td className="py-2.5 px-4">
                                <span
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold ${
                                    client.status === 'Verified'
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : client.status === 'Rejected'
                                        ? 'bg-red-100 text-red-800'
                                        : 'bg-amber-100 text-amber-800'
                                  }`}
                                >
                                  {client.status}
                                </span>
                              </td>
                              <td className="py-2.5 px-4 font-mono tabular-nums text-slate-500">
                                {formatDateTime(client.createdAt)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>

                {/* OTP Resend Notifications (Admin Panel Only — No OTP generation/sending) */}
                <section className="xl:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="bg-red-700 text-white px-5 py-3.5 flex items-center justify-between">
                    <div className="flex items-center gap-2.5 font-display text-sm font-bold">
                      <Bell className="w-4 h-4" />
                      OTP Notifications
                      <span className="px-2 py-0.5 text-xs font-mono bg-white text-red-700 rounded-full tabular-nums">
                        {pendingOtpList.length}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveTab('otp')}
                      className="text-xs font-medium text-red-100 hover:text-white cursor-pointer"
                    >
                      View All →
                    </button>
                  </div>
                  <div className="p-4 space-y-3">
                    <div className="px-3.5 py-2.5 rounded-lg bg-red-50 border border-red-200 text-xs font-medium text-red-800">
                      {pendingOtpList.length > 0
                        ? 'Clients requested an OTP resend (handled via external process)'
                        : 'No pending OTP resend requests'}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-slate-200 text-xs font-semibold text-slate-600">
                            <th className="py-2 px-2">Client Name</th>
                            <th className="py-2 px-2">Phone</th>
                            <th className="py-2 px-2">App Ref</th>
                            <th className="py-2 px-2">Request Time</th>
                            <th className="py-2 px-2 text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-xs">
                          {pendingOtpList.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="py-5 text-center text-slate-400">
                                Queue is clear
                              </td>
                            </tr>
                          ) : (
                            pendingOtpList.slice(0, 4).map((req) => (
                              <tr key={req.id}>
                                <td className="py-2.5 px-2 font-semibold text-slate-900">
                                  {req.clientName}
                                </td>
                                <td className="py-2.5 px-2 font-mono tabular-nums text-slate-600">
                                  {req.phoneNumber}
                                </td>
                                <td className="py-2.5 px-2 font-mono text-slate-700">
                                  {req.applicationRef}
                                </td>
                                <td className="py-2.5 px-2 font-mono tabular-nums text-slate-500">
                                  {formatDateTime(req.createdAt)}
                                </td>
                                <td className="py-2.5 px-2 text-right">
                                  <button
                                    type="button"
                                    disabled={actionBusy}
                                    onClick={() => void handleAcknowledgeOtpRequest(req)}
                                    className="px-2.5 py-1 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                                  >
                                    Acknowledge
                                  </button>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </section>
              </div>

              {/* Row 2: Second Form Submissions + Manage Clients Accounts */}
              <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
                {/* Second Form Submissions */}
                <section className="xl:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="bg-emerald-700 text-white px-5 py-3.5 flex items-center justify-between">
                    <div className="flex items-center gap-2.5 font-display text-sm font-bold">
                      <ClipboardList className="w-4 h-4" />
                      Second Form Submissions
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveTab('submissions')}
                      className="text-xs font-medium text-emerald-100 hover:text-white cursor-pointer"
                    >
                      View All →
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                          <th className="py-2.5 px-3">App Ref</th>
                          <th className="py-2.5 px-3">Client Name</th>
                          <th className="py-2.5 px-3">Price</th>
                          <th className="py-2.5 px-3">Intention</th>
                          <th className="py-2.5 px-3">Phone No.</th>
                          <th className="py-2.5 px-3">Verification</th>
                          <th className="py-2.5 px-3">Comment</th>
                          <th className="py-2.5 px-3">Date</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-xs">
                        {secondFormSubmissions.length === 0 ? (
                          <tr>
                            <td colSpan={8} className="py-6 px-4 text-center text-slate-500">
                              No second-form submissions recorded yet.
                            </td>
                          </tr>
                        ) : (
                          secondFormSubmissions.slice(0, 5).map((sub) => (
                            <tr key={sub.id} className="hover:bg-slate-50">
                              <td className="py-2.5 px-3 font-mono text-slate-600">
                                {sub.applicationRef || '—'}
                              </td>
                              <td className="py-2.5 px-3 font-semibold text-slate-900">
                                {sub.fullName}
                              </td>
                              <td className="py-2.5 px-3 font-mono tabular-nums text-slate-800">
                                {sub.packageLabel}
                              </td>
                              <td className="py-2.5 px-3 text-slate-700">{sub.intention}</td>
                              <td className="py-2.5 px-3 font-mono tabular-nums text-slate-600">
                                {sub.phoneNumber}
                              </td>
                              <td className="py-2.5 px-3">
                                <span
                                  className={`inline-block px-2 py-0.5 rounded font-semibold ${
                                    sub.otpVerified
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : 'bg-amber-100 text-amber-800'
                                  }`}
                                >
                                  {sub.otpVerified ? 'OTP Verified' : 'Pending'}
                                </span>
                              </td>
                              <td className="py-2.5 px-3 text-slate-600 max-w-[140px] truncate">
                                {sub.comment || '—'}
                              </td>
                              <td className="py-2.5 px-3 font-mono tabular-nums text-slate-500">
                                {formatDateTime(sub.updatedAt)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>

                {/* Manage Clients Accounts */}
                <section className="xl:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="bg-[#0F2C59] text-white px-5 py-3.5 flex items-center gap-2.5 font-display text-sm font-bold">
                    <UserCheck className="w-4 h-4" />
                    Manage Clients Accounts
                  </div>
                  <div className="p-4 space-y-4">
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={clientSearch}
                          onChange={(e) => setClientSearch(e.target.value)}
                          placeholder="Search by name, phone, or APP ref..."
                          className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setActiveTab('clients')}
                        className="px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold rounded-lg cursor-pointer"
                      >
                        Search
                      </button>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-slate-200 text-xs font-semibold text-slate-600">
                            <th className="py-2 px-2">#</th>
                            <th className="py-2 px-2">Name</th>
                            <th className="py-2 px-2">Phone</th>
                            <th className="py-2 px-2">Status</th>
                            <th className="py-2 px-2 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-xs">
                          {filteredClients.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="py-5 text-center text-slate-400">
                                No matching clients
                              </td>
                            </tr>
                          ) : (
                            filteredClients.slice(0, 5).map((c, idx) => (
                              <tr key={c.id}>
                                <td className="py-2.5 px-2 font-mono tabular-nums text-slate-500">
                                  {idx + 1}
                                </td>
                                <td className="py-2.5 px-2 font-semibold text-slate-900">
                                  {c.fullName}
                                </td>
                                <td className="py-2.5 px-2 font-mono tabular-nums text-slate-600">
                                  {c.phoneNumber}
                                </td>
                                <td className="py-2.5 px-2">
                                  <span
                                    className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${
                                      c.accountStatus === 'Active'
                                        ? 'bg-emerald-100 text-emerald-800'
                                        : 'bg-red-100 text-red-800'
                                    }`}
                                  >
                                    {c.accountStatus}
                                  </span>
                                </td>
                                <td className="py-2.5 px-2 text-right">
                                  <div className="inline-flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => openEditModal(c)}
                                      title="Edit client"
                                      className="p-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded cursor-pointer"
                                    >
                                      <Pencil className="w-3.5 h-3.5" />
                                    </button>
                                    {isSuperAdmin && (
                                      <button
                                        type="button"
                                        onClick={() => setDeletingClient(c)}
                                        title="Delete client"
                                        className="p-1.5 bg-red-600 hover:bg-red-700 text-white rounded cursor-pointer"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          )}

          {/* CLIENTS ACCOUNTS TAB */}
          {activeTab === 'clients' && (
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="font-display text-lg font-bold text-slate-900">Clients Accounts</h2>
                  <p className="text-xs text-slate-500">
                    Search, verify, update, or suspend enrolled client accounts. Client PINs are hashed and never displayed.
                  </p>
                </div>
                <div className="relative w-full sm:w-72">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={clientSearch}
                    onChange={(e) => setClientSearch(e.target.value)}
                    placeholder="Filter by name, phone, APP ref..."
                    className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4">#</th>
                      <th className="py-3 px-4">App Ref</th>
                      <th className="py-3 px-4">Full Name</th>
                      <th className="py-3 px-4">Phone</th>
                      <th className="py-3 px-4">Email</th>
                      <th className="py-3 px-4">Package</th>
                      <th className="py-3 px-4">OTP</th>
                      <th className="py-3 px-4">Verification</th>
                      <th className="py-3 px-4">Account</th>
                      <th className="py-3 px-4">Date</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {filteredClients.map((c, idx) => (
                      <tr key={c.id} className="hover:bg-slate-50">
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-500">{idx + 1}</td>
                        <td className="py-3 px-4 font-mono text-slate-700">{c.applicationRef || '—'}</td>
                        <td className="py-3 px-4 font-semibold text-slate-900">{c.fullName}</td>
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-600">
                          {c.phoneNumber}
                        </td>
                        <td className="py-3 px-4 text-slate-600">{c.email || '—'}</td>
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-800">
                          {c.packageLabel || '—'}
                        </td>
                        <td className="py-3 px-4">
                          <span
                            className={`px-2 py-0.5 rounded font-semibold ${
                              c.otpVerified
                                ? 'bg-emerald-100 text-emerald-800'
                                : c.otpIssued
                                  ? 'bg-blue-100 text-blue-800'
                                  : 'bg-slate-100 text-slate-600'
                            }`}
                          >
                            {c.otpVerified ? 'Verified' : c.otpIssued ? 'Issued' : 'Not Issued'}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <span
                            className={`px-2 py-0.5 rounded font-semibold ${
                              c.status === 'Verified'
                                ? 'bg-emerald-100 text-emerald-800'
                                : c.status === 'Rejected'
                                  ? 'bg-red-100 text-red-800'
                                  : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {c.status}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <span
                            className={`px-2 py-0.5 rounded font-semibold ${
                              c.accountStatus === 'Active'
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-red-100 text-red-800'
                            }`}
                          >
                            {c.accountStatus}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-500">
                          {formatDateTime(c.createdAt)}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => openEditModal(c)}
                              className="p-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded cursor-pointer"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            {isSuperAdmin && (
                              <button
                                type="button"
                                onClick={() => setDeletingClient(c)}
                                className="p-1.5 bg-red-600 hover:bg-red-700 text-white rounded cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* FORM SUBMISSIONS TAB */}
          {activeTab === 'submissions' && (
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="p-5 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h2 className="font-display text-lg font-bold text-slate-900">Form Submissions</h2>
                  <p className="text-xs text-slate-500">
                    Complete audit trail of client registrations, OTP verification, and second-form submissions.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                    {[
                      { id: 'all', label: 'All' },
                      { id: 'final', label: 'Second Form Submitted' },
                      { id: 'otp_verified', label: 'OTP Verified' },
                      { id: 'stage1', label: 'Registered Only' },
                    ].map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setSubmissionFilter(f.id as typeof submissionFilter)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                          submissionFilter === f.id
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={handleExportCsv}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download CSV
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4">App Ref</th>
                      <th className="py-3 px-4">Client Name</th>
                      <th className="py-3 px-4">Price</th>
                      <th className="py-3 px-4">Intention</th>
                      <th className="py-3 px-4">Mobile No.</th>
                      <th className="py-3 px-4">Verification Status</th>
                      <th className="py-3 px-4">Stage</th>
                      <th className="py-3 px-4">Comment</th>
                      <th className="py-3 px-4">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {filteredSubmissions.map((sub) => (
                      <tr key={sub.id} className="hover:bg-slate-50">
                        <td className="py-3 px-4 font-mono text-slate-700">{sub.applicationRef || '—'}</td>
                        <td className="py-3 px-4 font-semibold text-slate-900">{sub.fullName}</td>
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-800">
                          {sub.packageLabel || '—'}
                        </td>
                        <td className="py-3 px-4 text-slate-700">{sub.intention || '—'}</td>
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-600">
                          {sub.phoneNumber}
                        </td>
                        <td className="py-3 px-4">
                          <span
                            className={`px-2 py-0.5 rounded font-semibold ${
                              sub.otpVerified
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {sub.otpVerified ? 'OTP Verified' : 'Pending OTP'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-600">
                          {sub.stage === 'final_submitted'
                            ? 'Final Submitted'
                            : sub.stage === 'otp_verified'
                              ? 'OTP Verified'
                              : 'Registered'}
                        </td>
                        <td className="py-3 px-4 text-slate-600 max-w-xs truncate">
                          {sub.comment || '—'}
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-500">
                          {formatDateTime(sub.updatedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* OTP NOTIFICATIONS TAB */}
          {activeTab === 'otp' && (
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="p-5 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <h2 className="font-display text-lg font-bold text-slate-900">
                    OTP Resend Notifications
                  </h2>
                  <p className="text-xs text-slate-500">
                    Notifications submitted by clients requesting an OTP resend. OTP codes are issued strictly via the external verification process and never generated or sent from this panel.
                  </p>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4">#</th>
                      <th className="py-3 px-4">Client Name</th>
                      <th className="py-3 px-4">Phone Number</th>
                      <th className="py-3 px-4">Application Reference</th>
                      <th className="py-3 px-4">Request Time</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {otpRequests.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-500">
                          No OTP resend notifications logged.
                        </td>
                      </tr>
                    ) : (
                      otpRequests.map((req, idx) => (
                        <tr key={req.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4 font-mono tabular-nums text-slate-500">
                            {idx + 1}
                          </td>
                          <td className="py-3 px-4 font-semibold text-slate-900">
                            {req.clientName}
                          </td>
                          <td className="py-3 px-4 font-mono tabular-nums text-slate-600">
                            {req.phoneNumber}
                          </td>
                          <td className="py-3 px-4 font-mono text-slate-800">
                            {req.applicationRef}
                          </td>
                          <td className="py-3 px-4 font-mono tabular-nums text-slate-500">
                            {formatDateTime(req.createdAt)}
                          </td>
                          <td className="py-3 px-4">
                            <span
                              className={`px-2 py-0.5 rounded font-semibold ${
                                req.status === 'Pending'
                                  ? 'bg-red-100 text-red-800'
                                  : 'bg-emerald-100 text-emerald-800'
                              }`}
                            >
                              {req.status}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right">
                            {req.status === 'Pending' ? (
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() => void handleAcknowledgeOtpRequest(req)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white font-semibold rounded-md cursor-pointer disabled:opacity-50"
                              >
                                <Check className="w-3 h-3" />
                                Acknowledge
                              </button>
                            ) : (
                              <span className="text-slate-400">Acknowledged</span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* MANAGE USERS (RBAC) TAB */}
          {activeTab === 'users' && (
            <div className="space-y-6">
              {isSuperAdmin && (
                <section className="bg-white border border-slate-200 rounded-xl p-6">
                  <h2 className="font-display text-lg font-bold text-slate-900 mb-1">
                    Authorize Staff User
                  </h2>
                  <p className="text-xs text-slate-500 mb-4">
                    Grant role-based access to additional staff Google accounts for the hidden footer portal.
                  </p>
                  <form onSubmit={handleAddStaff} className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    <input
                      type="email"
                      required
                      value={newStaffEmail}
                      onChange={(e) => setNewStaffEmail(e.target.value)}
                      placeholder="staff@example.com"
                      className="px-3.5 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                    <input
                      type="text"
                      required
                      value={newStaffName}
                      onChange={(e) => setNewStaffName(e.target.value)}
                      placeholder="Full Name"
                      className="px-3.5 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                    <select
                      value={newStaffRole}
                      onChange={(e) => setNewStaffRole(e.target.value as StaffRole)}
                      className="px-3.5 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                      <option value="verification_officer">Verification Officer</option>
                      <option value="support_agent">Support Agent</option>
                      <option value="super_admin">Super Admin</option>
                    </select>
                    <button
                      type="submit"
                      disabled={actionBusy}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold rounded-lg cursor-pointer disabled:opacity-60"
                    >
                      <Plus className="w-4 h-4" />
                      Grant Access
                    </button>
                  </form>
                </section>
              )}

              <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="p-5 border-b border-slate-200">
                  <h2 className="font-display text-lg font-bold text-slate-900">
                    Staff Role Directory
                  </h2>
                  <p className="text-xs text-slate-500">
                    Active roles enforced by Firestore security rules.
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">Staff Email</th>
                        <th className="py-3 px-4">Name</th>
                        <th className="py-3 px-4">Role</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      <tr className="bg-blue-50/40">
                        <td className="py-3 px-4 font-mono text-slate-900">{BOOTSTRAP_ADMIN_EMAIL}</td>
                        <td className="py-3 px-4 font-semibold text-slate-900">Primary Owner</td>
                        <td className="py-3 px-4 font-semibold text-blue-800">Super Admin</td>
                        <td className="py-3 px-4">
                          <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-semibold">
                            Active
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right text-slate-400">System Owner</td>
                      </tr>
                      {staffList
                        .filter((m) => m.email !== BOOTSTRAP_ADMIN_EMAIL)
                        .map((member) => (
                          <tr key={member.email}>
                            <td className="py-3 px-4 font-mono text-slate-900">{member.email}</td>
                            <td className="py-3 px-4 font-semibold text-slate-900">
                              {member.displayName}
                            </td>
                            <td className="py-3 px-4 text-slate-700">{ROLE_LABELS[member.role]}</td>
                            <td className="py-3 px-4">
                              <span
                                className={`px-2 py-0.5 rounded font-semibold ${
                                  member.active
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : 'bg-slate-200 text-slate-700'
                                }`}
                              >
                                {member.active ? 'Active' : 'Inactive'}
                              </span>
                            </td>
                            <td className="py-3 px-4 text-right">
                              {isSuperAdmin ? (
                                <div className="inline-flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => void handleToggleStaffActive(member)}
                                    className="px-2.5 py-1 border border-slate-300 rounded text-slate-700 hover:bg-slate-100 cursor-pointer"
                                  >
                                    {member.active ? 'Disable' : 'Enable'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleRemoveStaff(member)}
                                    className="p-1.5 bg-red-600 hover:bg-red-700 text-white rounded cursor-pointer"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ) : (
                                <span className="text-slate-400">View only</span>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}

          {/* REPORTS TAB */}
          {activeTab === 'reports' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                <h2 className="font-display text-lg font-bold text-slate-900">
                  Enrolment Summary Metrics
                </h2>
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                    <div className="text-xs text-slate-500">Total Package Volume</div>
                    <div className="font-display text-2xl font-bold text-slate-900 tabular-nums mt-1">
                      KES {reportStats.totalVolume.toLocaleString()}
                    </div>
                  </div>
                  <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                    <div className="text-xs text-slate-500">Verification Rate</div>
                    <div className="font-display text-2xl font-bold text-emerald-700 tabular-nums mt-1">
                      {reportStats.verifiedRate}%
                    </div>
                  </div>
                </div>
              </section>

              <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                <h2 className="font-display text-lg font-bold text-slate-900">
                  Submissions by Intention
                </h2>
                {Object.keys(reportStats.byIntention).length === 0 ? (
                  <p className="text-sm text-slate-500">No package intentions recorded yet.</p>
                ) : (
                  <div className="space-y-3">
                    {Object.entries(reportStats.byIntention).map(([label, count]) => (
                      <div key={label} className="flex items-center justify-between text-sm">
                        <span className="font-medium text-slate-700">{label}</span>
                        <span className="font-mono font-bold tabular-nums text-slate-900">
                          {count}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* SETTINGS TAB */}
          {activeTab === 'settings' && (
            <section className="bg-white border border-slate-200 rounded-xl p-6 max-w-2xl">
              <h2 className="font-display text-lg font-bold text-slate-900 mb-1">
                Platform Settings
              </h2>
              <p className="text-xs text-slate-500 mb-6">
                Configure WhatsApp support contact, package pricing tiers, and client OTP notice text.
              </p>
              <form onSubmit={handleSaveSettings} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      WhatsApp Support Number
                    </label>
                    <input
                      type="text"
                      disabled={!isSuperAdmin}
                      value={settingsForm.whatsappNumber}
                      onChange={(e) =>
                        setSettingsForm((prev) => ({ ...prev, whatsappNumber: e.target.value }))
                      }
                      className="w-full px-3.5 py-2 border border-slate-300 rounded-lg text-sm font-mono tabular-nums disabled:bg-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Support Email
                    </label>
                    <input
                      type="email"
                      disabled={!isSuperAdmin}
                      value={settingsForm.supportEmail}
                      onChange={(e) =>
                        setSettingsForm((prev) => ({ ...prev, supportEmail: e.target.value }))
                      }
                      className="w-full px-3.5 py-2 border border-slate-300 rounded-lg text-sm disabled:bg-slate-100"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Tier 1 (KES)
                    </label>
                    <input
                      type="number"
                      disabled={!isSuperAdmin}
                      value={settingsForm.tier1Amount}
                      onChange={(e) =>
                        setSettingsForm((prev) => ({ ...prev, tier1Amount: Number(e.target.value) }))
                      }
                      className="w-full px-3.5 py-2 border border-slate-300 rounded-lg text-sm font-mono tabular-nums disabled:bg-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Tier 2 (KES)
                    </label>
                    <input
                      type="number"
                      disabled={!isSuperAdmin}
                      value={settingsForm.tier2Amount}
                      onChange={(e) =>
                        setSettingsForm((prev) => ({ ...prev, tier2Amount: Number(e.target.value) }))
                      }
                      className="w-full px-3.5 py-2 border border-slate-300 rounded-lg text-sm font-mono tabular-nums disabled:bg-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Tier 3 (KES)
                    </label>
                    <input
                      type="number"
                      disabled={!isSuperAdmin}
                      value={settingsForm.tier3Amount}
                      onChange={(e) =>
                        setSettingsForm((prev) => ({ ...prev, tier3Amount: Number(e.target.value) }))
                      }
                      className="w-full px-3.5 py-2 border border-slate-300 rounded-lg text-sm font-mono tabular-nums disabled:bg-slate-100"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    OTP Resend Policy Message
                  </label>
                  <textarea
                    rows={3}
                    disabled={!isSuperAdmin}
                    value={settingsForm.otpNoticeText}
                    onChange={(e) =>
                      setSettingsForm((prev) => ({ ...prev, otpNoticeText: e.target.value }))
                    }
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-lg text-sm disabled:bg-slate-100"
                  />
                </div>

                {isSuperAdmin ? (
                  <button
                    type="submit"
                    disabled={actionBusy}
                    className="px-5 py-2.5 bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold rounded-lg cursor-pointer disabled:opacity-60"
                  >
                    {actionBusy ? 'Saving...' : 'Save Settings'}
                  </button>
                ) : (
                  <p className="text-xs text-slate-500">
                    Only Super Admins can modify system settings.
                  </p>
                )}
              </form>
            </section>
          )}
        </main>

        {/* Admin Bottom Footer Bar */}
        <footer className="bg-[#0B2447] text-slate-200 px-6 py-3 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs">
          <div>
            <span className="font-semibold text-white">Client Enrolment System</span> · Secure ·
            Reliable · Efficient
          </div>
          <div className="flex items-center gap-2 font-mono tabular-nums text-slate-300">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            Last Login: {lastSignIn}
          </div>
        </footer>
      </div>

      {/* Edit Client Modal (No PIN visibility, No OTP generation/editing) */}
      {editingClient && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-display text-lg font-bold text-slate-900">Edit Client Record</h3>
                <p className="text-xs font-mono text-slate-500">
                  Ref: {editingClient.applicationRef || '—'} · OTP:{' '}
                  {editingClient.otpVerified ? 'Verified' : 'Pending'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingClient(null)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveClientEdit} className="space-y-4">
              {canVerify && (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Full Name
                    </label>
                    <input
                      type="text"
                      required
                      value={editForm.fullName}
                      onChange={(e) => setEditForm((p) => ({ ...p, fullName: e.target.value }))}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Phone Number
                      </label>
                      <input
                        type="text"
                        required
                        value={editForm.phoneNumber}
                        onChange={(e) => setEditForm((p) => ({ ...p, phoneNumber: e.target.value }))}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Package (KES)
                      </label>
                      <input
                        type="number"
                        value={editForm.packageAmount}
                        onChange={(e) =>
                          setEditForm((p) => ({ ...p, packageAmount: Number(e.target.value) }))
                        }
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono tabular-nums"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Verification Status
                      </label>
                      <select
                        value={editForm.status}
                        onChange={(e) =>
                          setEditForm((p) => ({ ...p, status: e.target.value as EnrolmentStatus }))
                        }
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                      >
                        <option value="Pending">Pending</option>
                        <option value="Verified">Verified</option>
                        <option value="Rejected">Rejected</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Account Status
                      </label>
                      <select
                        value={editForm.accountStatus}
                        onChange={(e) =>
                          setEditForm((p) => ({
                            ...p,
                            accountStatus: e.target.value as AccountStatus,
                          }))
                        }
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                      >
                        <option value="Active">Active</option>
                        <option value="Suspended">Suspended</option>
                      </select>
                    </div>
                  </div>
                </>
              )}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Comment</label>
                <textarea
                  rows={2}
                  value={editForm.comment}
                  onChange={(e) => setEditForm((p) => ({ ...p, comment: e.target.value }))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingClient(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionBusy}
                  className="px-5 py-2 bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold rounded-lg cursor-pointer disabled:opacity-60"
                >
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingClient && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-sm w-full p-6 shadow-xl">
            <h3 className="font-display text-lg font-bold text-slate-900 mb-2">
              Delete Client Record
            </h3>
            <p className="text-sm text-slate-600 mb-6">
              Are you sure you want to permanently remove{' '}
              <span className="font-semibold text-slate-900">{deletingClient.fullName}</span>? This
              action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeletingClient(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={actionBusy}
                onClick={handleConfirmDeleteClient}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-lg cursor-pointer"
              >
                Delete Record
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
