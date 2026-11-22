import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Eye,
  EyeOff,
  Lock,
  MessageCircle,
  Phone,
  RefreshCw,
  ShieldCheck,
  User as UserIcon,
  X,
} from 'lucide-react';
import {
  doc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { Enrolment, IntentionType, SystemSettings } from '../types';
import { SafeImage } from './SafeImage';

interface ClientPortalProps {
  settings: Omit<SystemSettings, 'updatedAt'>;
  onOpenAdminPortal: () => void;
}

type FlowStep = 'step2_info' | 'step3_received' | 'step3_otp' | 'step4_package' | 'step5_complete';

const MAX_OTP_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 300; // 5 minutes

function formatCooldown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export function ClientPortal({ settings, onOpenAdminPortal }: ClientPortalProps) {
  // Active in-progress enrolment state (kept only for current wizard session; submissions are never listed publicly)
  const [flowStep, setFlowStep] = useState<FlowStep>('step2_info');
  const [activeEnrolmentId, setActiveEnrolmentId] = useState<string | null>(null);
  const [activeEnrolment, setActiveEnrolment] = useState<Enrolment | null>(null);

  // Step 1 (1st Form: Registration)
  const [fullName, setFullName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [email, setEmail] = useState('');
  const [secretPin, setSecretPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showPin, setShowPin] = useState(false);

  // Step 3 (OTP Verification)
  const [otpInput, setOtpInput] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [resendNotified, setResendNotified] = useState(false);

  // Step 4 (2nd Form: Final Submission)
  const [selectedAmount, setSelectedAmount] = useState<number>(settings.tier1Amount);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [intention, setIntention] = useState<IntentionType>('Loan Support');
  const [confirmPhoneNumber, setConfirmPhoneNumber] = useState('');
  const [comment, setComment] = useState('');
  const [showTermsModal, setShowTermsModal] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formNotice, setFormNotice] = useState<string | null>(null);

  const packageOptions = useMemo(
    () => [
      {
        amount: settings.tier1Amount,
        label: `KES ${settings.tier1Amount.toLocaleString()}`,
        desc: 'Starter support package',
      },
      {
        amount: settings.tier2Amount,
        label: `KES ${settings.tier2Amount.toLocaleString()}`,
        desc: 'Standard growth tier',
      },
      {
        amount: settings.tier3Amount,
        label: `KES ${settings.tier3Amount.toLocaleString()}`,
        desc: 'Priority extended support',
      },
    ],
    [settings.tier1Amount, settings.tier2Amount, settings.tier3Amount]
  );

  useEffect(() => {
    setSelectedAmount(settings.tier1Amount);
  }, [settings.tier1Amount]);

  // Listen only to the currently active wizard document while in progress
  useEffect(() => {
    if (!activeEnrolmentId) {
      setActiveEnrolment(null);
      return;
    }

    const unsub = onSnapshot(
      doc(db, 'enrolments', activeEnrolmentId),
      (snap) => {
        if (!snap.exists()) {
          setActiveEnrolment(null);
          return;
        }
        const data = {
          id: snap.id,
          ...(snap.data() as Omit<Enrolment, 'id'>),
        };
        setActiveEnrolment(data);
        setConfirmPhoneNumber((prev) => prev || data.phoneNumber);
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, `enrolments/${activeEnrolmentId}`);
      }
    );

    return () => unsub();
  }, [activeEnrolmentId]);

  // Tick every second while in OTP step for live 5-minute resend cooldown & expiry check
  useEffect(() => {
    if (flowStep !== 'step3_otp') return;
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [flowStep]);

  const resendCooldownSeconds = useMemo(() => {
    const lastTs = activeEnrolment?.lastResendRequestedAt;
    if (!lastTs) return 0;
    try {
      const lastMs = lastTs.toMillis();
      const diffSec = Math.ceil((lastMs + RESEND_COOLDOWN_SECONDS * 1000 - nowMs) / 1000);
      return diffSec > 0 ? diffSec : 0;
    } catch {
      return 0;
    }
  }, [activeEnrolment?.lastResendRequestedAt, nowMs]);

  const isOtpExpired = useMemo(() => {
    if (!activeEnrolment?.otpExpiresAt) return false;
    try {
      return nowMs > activeEnrolment.otpExpiresAt.toMillis();
    } catch {
      return false;
    }
  }, [activeEnrolment?.otpExpiresAt, nowMs]);

  const attemptsUsed = activeEnrolment?.otpAttempts ?? 0;
  const attemptsRemaining = Math.max(0, MAX_OTP_ATTEMPTS - attemptsUsed);
  const otpIssued = Boolean(activeEnrolment?.otpIssued);
  const otpVerified = Boolean(activeEnrolment?.otpVerified);

  const whatsappDigits = settings.whatsappNumber.replace(/[^0-9]/g, '');
  const whatsappUrl = `https://wa.me/${whatsappDigits}`;

  const handleStep1Register = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFormNotice(null);

    const cleanName = fullName.trim();
    const cleanPhone = phoneNumber.trim();
    const cleanEmail = email.trim();
    const cleanPin = secretPin.trim();
    const cleanConfirmPin = confirmPin.trim();

    if (cleanName.length < 2) {
      setFormError('Please enter your full name (at least 2 characters).');
      return;
    }
    if (!/^[+0-9\s-]{7,20}$/.test(cleanPhone)) {
      setFormError('Please enter a valid mobile number (e.g. 0711234567 or +254711234567).');
      return;
    }
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setFormError('Please enter a valid email address or leave it blank.');
      return;
    }
    if (!/^[0-9]{4,8}$/.test(cleanPin)) {
      setFormError('Secret PIN must be 4 to 8 numeric digits.');
      return;
    }
    if (cleanPin !== cleanConfirmPin) {
      setFormError('Secret PIN and Confirm PIN do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: cleanName,
          phoneNumber: cleanPhone,
          email: cleanEmail,
          pin: cleanPin,
        }),
      });
      const rawText = await response.text();
      let data: { enrolmentId?: string; applicationRef?: string; error?: string } = {};
      try {
        data = rawText ? (JSON.parse(rawText) as typeof data) : {};
      } catch {
        data = {};
      }

      if (!response.ok || !data.enrolmentId) {
        setFormError(
          data.error ||
            `Registration service returned HTTP ${response.status}. Ensure the latest backend API deployment is live.`
        );
        return;
      }

      setActiveEnrolmentId(data.enrolmentId);
      setConfirmPhoneNumber(cleanPhone);
      setSecretPin('');
      setConfirmPin('');
      setFlowStep('step3_received');
      setFormError(null);
    } catch {
      setFormError('Unable to reach the registration server. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFormNotice(null);

    if (!activeEnrolment) {
      setFormError('No active application record found.');
      return;
    }

    const trimmed = otpInput.trim();
    if (!/^[A-Za-z0-9]{4,12}$/.test(trimmed)) {
      setFormError('Please enter the verification code received from the external source.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrolmentId: activeEnrolment.id,
          applicationRef: activeEnrolment.applicationRef,
          otpCode: trimmed,
        }),
      });
      const rawText = await response.text();
      let data: { verified?: boolean; error?: string } = {};
      try {
        data = rawText ? (JSON.parse(rawText) as typeof data) : {};
      } catch {
        data = {};
      }

      if (!response.ok || !data.verified) {
        setFormError(
          data.error ||
            `Verification failed (HTTP ${response.status}). Please check the code and try again.`
        );
        return;
      }

      setOtpInput('');
      setFormError(null);
      setFormNotice('Phone number verified. Final submission form unlocked.');
      setFlowStep('step4_package');
    } catch {
      setFormError('Unable to reach the verification server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResendOtpRequest = async () => {
    if (!activeEnrolment || resendCooldownSeconds > 0 || submitting) return;
    setFormError(null);
    setFormNotice(null);
    setSubmitting(true);

    try {
      const response = await fetch('/api/otp/resend-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrolmentId: activeEnrolment.id,
          applicationRef: activeEnrolment.applicationRef,
        }),
      });
      const rawText = await response.text();
      let data: { ok?: boolean; error?: string } = {};
      try {
        data = rawText ? (JSON.parse(rawText) as typeof data) : {};
      } catch {
        data = {};
      }

      if (!response.ok || !data.ok) {
        setFormError(data.error || `Could not send resend request (HTTP ${response.status}).`);
        return;
      }

      setNowMs(Date.now());
      setResendNotified(true);
      setFormNotice(
        'Resend notification recorded in the admin panel. A 5-minute cooldown now applies.'
      );
    } catch {
      setFormError('Unable to reach the server to notify the admin panel. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStep4Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFormNotice(null);

    if (!activeEnrolment) {
      setFormError('No active enrolment found. Please start from Step 1.');
      return;
    }
    if (!activeEnrolment.otpVerified || activeEnrolment.stage !== 'otp_verified') {
      setFormError('Please complete OTP verification before submitting the final form.');
      return;
    }
    const cleanPhone = confirmPhoneNumber.trim();
    if (!/^[+0-9\s-]{7,20}$/.test(cleanPhone)) {
      setFormError('Please enter a valid mobile number (e.g. 0711234567).');
      return;
    }
    if (!acceptedTerms) {
      setFormError('Please accept the Terms and Conditions to continue.');
      return;
    }
    if (!intention) {
      setFormError('Please select your intention from the dropdown.');
      return;
    }

    setSubmitting(true);
    try {
      const label = `KES ${selectedAmount.toLocaleString()}`;
      await updateDoc(doc(db, 'enrolments', activeEnrolment.id), {
        phoneNumber: cleanPhone.slice(0, 20),
        packageAmount: selectedAmount,
        packageLabel: label,
        acceptedTerms: true,
        intention,
        comment: comment.trim().slice(0, 500),
        stage: 'final_submitted',
        updatedAt: serverTimestamp(),
      });
      setFlowStep('step5_complete');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `enrolments/${activeEnrolment.id}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetWizard = () => {
    setActiveEnrolmentId(null);
    setActiveEnrolment(null);
    setFlowStep('step2_info');
    setFullName('');
    setPhoneNumber('');
    setConfirmPhoneNumber('');
    setEmail('');
    setSecretPin('');
    setConfirmPin('');
    setComment('');
    setAcceptedTerms(false);
    setOtpInput('');
    setResendNotified(false);
    setFormError(null);
    setFormNotice(null);
  };

  const currentStepNumber =
    flowStep === 'step2_info'
      ? 1
      : flowStep === 'step3_received'
        ? 2
        : flowStep === 'step3_otp'
          ? 3
          : flowStep === 'step4_package'
            ? 4
            : 5;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-sm border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Brand Wordmark */}
          <a
            href="#home"
            className="flex items-center gap-2.5 font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            <span className="w-8 h-8 rounded-lg bg-blue-700 text-white flex items-center justify-center">
              <ShieldCheck className="w-4 h-4" />
            </span>
            Client Support
          </a>

          {/* Zone 2: 4 Concise Single-Line Nav Links */}
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <a href="#home" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Home
            </a>
            <a href="#about" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              About
            </a>
            <a href="#enrol" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Enrol
            </a>
            <a href="#contact" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Contact
            </a>
          </nav>

          {/* Zone 3: Single Primary Action */}
          <div className="flex items-center gap-3 shrink-0">
            <a
              href="#enrol"
              onClick={() => {
                if (flowStep === 'step5_complete') handleResetWizard();
              }}
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              Enroll Now
            </a>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* Step 1: Welcoming Dashboard Hero */}
        <section id="home" className="bg-white border-b border-slate-200">
          <div className="max-w-7xl mx-auto px-6 py-12 lg:py-20 grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-stretch">
            <div className="lg:col-span-7 flex flex-col justify-center">
              <p className="text-sm font-medium text-blue-700 mb-3">
                Client Enrolment · Structured Funding · Phone Verification
              </p>
              <h1
                className="font-display font-bold tracking-tight text-slate-900 leading-[1.1] mb-5"
                style={{ fontSize: 'clamp(2.25rem, 4vw, 3.75rem)', textWrap: 'balance' }}
              >
                Get Funded and Realize Your Goals
              </h1>
              <p className="text-base lg:text-lg text-slate-600 leading-relaxed max-w-2xl mb-8">
                Join thousands of clients who have accessed timely loan support, business capital,
                and education financing through a transparent, verified enrolment process.
              </p>

              <div className="flex flex-wrap items-center gap-4">
                <a
                  href="#enrol"
                  onClick={() => {
                    if (flowStep === 'step5_complete') handleResetWizard();
                  }}
                  className="inline-flex items-center gap-2.5 px-6 py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  Enroll Now
                  <ArrowRight className="w-4 h-4" />
                </a>
                <a
                  href="#contact"
                  className="inline-flex items-center gap-2 px-5 py-3.5 text-sm font-semibold text-slate-700 hover:text-slate-900 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                >
                  Need Help?
                </a>
              </div>

              <div className="mt-10 pt-8 border-t border-slate-200 grid grid-cols-3 gap-6 max-w-xl">
                <div>
                  <div className="font-display text-2xl font-bold text-slate-900 tabular-nums">10–20 min</div>
                  <div className="text-xs text-slate-500 mt-0.5">Account review window</div>
                </div>
                <div>
                  <div className="font-display text-2xl font-bold text-slate-900 tabular-nums">
                    KES {settings.tier1Amount.toLocaleString()}+
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">Flexible support tiers</div>
                </div>
                <div>
                  <div className="font-display text-2xl font-bold text-slate-900 tabular-nums">PIN + OTP</div>
                  <div className="text-xs text-slate-500 mt-0.5">Protected verification</div>
                </div>
              </div>
            </div>

            <div className="lg:col-span-5 flex">
              <div className="w-full rounded-xl overflow-hidden border border-slate-200 bg-slate-100">
                <SafeImage
                  src="/src/assets/images/hero_client_portrait_1795287539423.jpg"
                  alt="Smiling client giving a confident thumbs up after enrolment"
                  className="w-full h-72 sm:h-96 lg:h-full object-cover"
                  fallbackTitle="Client Support Enrolment"
                />
              </div>
            </div>
          </div>
        </section>

        {/* About & Funding Pathways */}
        <section id="about" className="max-w-7xl mx-auto px-6 py-16 lg:py-20">
          <div className="max-w-2xl mb-12">
            <h2 className="font-display text-2xl lg:text-3xl font-bold text-slate-900 tracking-tight mb-3">
              Built for Everyday Financial Milestones
            </h2>
            <p className="text-slate-600 leading-relaxed">
              Register with your details and secret PIN, verify your mobile number once an external
              code is issued, and complete your package selection for private admin review.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
              <SafeImage
                src="/src/assets/images/client_business_growth_1795287539590.jpg"
                alt="Small retail business owner checking orders on a tablet"
                className="w-full h-56 object-cover"
                fallbackTitle="Business Support"
              />
              <div className="p-6 flex-1 flex flex-col justify-between">
                <div>
                  <h3 className="font-display text-lg font-bold text-slate-900 mb-2">
                    01. Business &amp; Inventory Capital
                  </h3>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    Grow your retail shop, restock fast-moving inventory, or bridge working-capital cycles
                    with straightforward package selection and fast verification.
                  </p>
                </div>
                <div className="mt-5 pt-4 border-t border-slate-100 text-xs text-slate-500">
                  Intention: Business · Loan Support
                </div>
              </div>
            </div>

            <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
              <SafeImage
                src="/src/assets/images/client_education_support_1795287539518.jpg"
                alt="University student studying with a laptop and notebooks"
                className="w-full h-56 object-cover"
                fallbackTitle="Education Funding"
              />
              <div className="p-6 flex-1 flex flex-col justify-between">
                <div>
                  <h3 className="font-display text-lg font-bold text-slate-900 mb-2">
                    02. Education &amp; College Fees
                  </h3>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    Cover semester tuition, exam fees, and study materials without delaying academic
                    registration deadlines.
                  </p>
                </div>
                <div className="mt-5 pt-4 border-t border-slate-100 text-xs text-slate-500">
                  Intention: Education · Personal Goal
                </div>
              </div>
            </div>

            <div className="lg:col-span-3 bg-slate-900 text-white rounded-xl p-6 flex flex-col justify-between">
              <div>
                <h3 className="font-display text-lg font-bold mb-4">03. Five-Step Verification</h3>
                <ol className="space-y-3 text-sm text-slate-300">
                  <li className="flex gap-3">
                    <span className="font-mono text-xs text-emerald-400 pt-0.5 tabular-nums">01</span>
                    <span>Register name, mobile, optional email &amp; secret PIN</span>
                  </li>
                  <li className="flex gap-3">
                    <span className="font-mono text-xs text-emerald-400 pt-0.5 tabular-nums">02</span>
                    <span>Receive application reference &amp; queue confirmation</span>
                  </li>
                  <li className="flex gap-3">
                    <span className="font-mono text-xs text-emerald-400 pt-0.5 tabular-nums">03</span>
                    <span>Verify externally issued OTP code (up to 5 attempts)</span>
                  </li>
                  <li className="flex gap-3">
                    <span className="font-mono text-xs text-emerald-400 pt-0.5 tabular-nums">04</span>
                    <span>Select package price, intention &amp; submit final form</span>
                  </li>
                  <li className="flex gap-3">
                    <span className="font-mono text-xs text-emerald-400 pt-0.5 tabular-nums">05</span>
                    <span>Check back in your account after 10–20 minutes</span>
                  </li>
                </ol>
              </div>
              <a
                href="#enrol"
                className="mt-6 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-white text-slate-900 font-semibold text-sm rounded-lg hover:bg-slate-100 transition-colors"
              >
                Start Enrolment
                <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          </div>
        </section>

        {/* Interactive Client Enrolment & Verification Flow */}
        <section id="enrol" className="bg-white border-y border-slate-200 py-16 lg:py-20">
          <div className="max-w-4xl mx-auto px-6">
            <div className="mb-8">
              <h2 className="font-display text-2xl lg:text-3xl font-bold text-slate-900 tracking-tight mb-2">
                Client Enrolment &amp; Verification
              </h2>
              <p className="text-sm text-slate-600">
                Complete the steps below. Submitted records are confidential and reviewed privately by
                our verification administrators.
              </p>
            </div>

            {/* Step Progress Rail */}
            <div className="mb-8 grid grid-cols-5 gap-2">
              {[
                { num: 1, label: 'Registration' },
                { num: 2, label: 'Received' },
                { num: 3, label: 'Verify OTP' },
                { num: 4, label: 'Final Form' },
                { num: 5, label: 'Submitted' },
              ].map((step) => {
                const isDone = currentStepNumber > step.num;
                const isCurrent = currentStepNumber === step.num;
                return (
                  <div key={step.num} className="flex flex-col gap-1.5">
                    <div
                      className={`h-1.5 rounded-full transition-colors ${
                        isDone ? 'bg-emerald-600' : isCurrent ? 'bg-blue-700' : 'bg-slate-200'
                      }`}
                    />
                    <span
                      className={`text-xs font-medium truncate ${
                        isCurrent ? 'text-blue-700' : isDone ? 'text-emerald-700' : 'text-slate-500'
                      }`}
                    >
                      {step.num}. {step.label}
                    </span>
                  </div>
                );
              })}
            </div>

            {formError && (
              <div className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">
                {formError}
              </div>
            )}

            {formNotice && (
              <div className="mb-6 p-4 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-900">
                {formNotice}
              </div>
            )}

            {/* Main Wizard Card */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 sm:p-8">
              {/* STEP 1: Client Registration (1st Form) */}
              {flowStep === 'step2_info' && (
                <form onSubmit={handleStep1Register} className="space-y-5">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                    <div className="flex items-center gap-2.5">
                      <UserIcon className="w-5 h-5 text-blue-700" />
                      <h3 className="font-display text-lg font-bold text-slate-900">
                        Client Registration (1st Form)
                      </h3>
                    </div>
                    <span className="text-xs text-slate-500 font-mono">Step 1 of 5</span>
                  </div>

                  <div>
                    <label htmlFor="fullName" className="block text-sm font-medium text-slate-800 mb-1.5">
                      Full Name <span className="text-red-600">*</span>
                    </label>
                    <input
                      id="fullName"
                      type="text"
                      required
                      maxLength={100}
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Enter your full name"
                      className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                    />
                  </div>

                  <div>
                    <label htmlFor="phoneNumber" className="block text-sm font-medium text-slate-800 mb-1.5">
                      Mobile Number <span className="text-red-600">*</span>
                    </label>
                    <input
                      id="phoneNumber"
                      type="tel"
                      required
                      maxLength={20}
                      value={phoneNumber}
                      onChange={(e) => setPhoneNumber(e.target.value)}
                      placeholder="e.g. 0711234567"
                      className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-lg text-sm font-mono tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                    />
                  </div>

                  <div>
                    <label htmlFor="email" className="block text-sm font-medium text-slate-800 mb-1.5">
                      Email Address <span className="text-slate-400 font-normal">(optional)</span>
                    </label>
                    <input
                      id="email"
                      type="email"
                      maxLength={150}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="Enter email (optional)"
                      className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="secretPin" className="block text-sm font-medium text-slate-800 mb-1.5">
                        Create Secret PIN <span className="text-red-600">*</span>
                      </label>
                      <div className="relative">
                        <input
                          id="secretPin"
                          type={showPin ? 'text' : 'password'}
                          inputMode="numeric"
                          required
                          minLength={4}
                          maxLength={8}
                          value={secretPin}
                          onChange={(e) => setSecretPin(e.target.value.replace(/[^0-9]/g, ''))}
                          placeholder="4–8 digit PIN"
                          className="w-full pl-4 pr-10 py-2.5 bg-white border border-slate-300 rounded-lg text-sm font-mono tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPin((p) => !p)}
                          aria-label={showPin ? 'Hide secret PIN' : 'Show secret PIN'}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                        >
                          {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    <div>
                      <label htmlFor="confirmPin" className="block text-sm font-medium text-slate-800 mb-1.5">
                        Confirm Secret PIN <span className="text-red-600">*</span>
                      </label>
                      <input
                        id="confirmPin"
                        type={showPin ? 'text' : 'password'}
                        inputMode="numeric"
                        required
                        minLength={4}
                        maxLength={8}
                        value={confirmPin}
                        onChange={(e) => setConfirmPin(e.target.value.replace(/[^0-9]/g, ''))}
                        placeholder="Re-enter PIN"
                        className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-lg text-sm font-mono tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-slate-500">
                    Your secret PIN is securely hashed before storage and is never visible to administrators.
                  </p>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full py-3 px-6 bg-blue-700 hover:bg-blue-800 text-white font-semibold text-sm rounded-lg transition-colors cursor-pointer disabled:opacity-60"
                  >
                    {submitting ? 'Submitting Registration...' : 'Submit Details'}
                  </button>
                </form>
              )}

              {/* STEP 2: Form Submitted to Admin Panel */}
              {flowStep === 'step3_received' && activeEnrolment && (
                <div className="py-6 text-center max-w-md mx-auto">
                  <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto mb-5">
                    <CheckCircle2 className="w-9 h-9" />
                  </div>
                  <h3 className="font-display text-2xl font-bold text-slate-900 mb-2">
                    Data Received!
                  </h3>
                  <div className="inline-block px-3.5 py-1.5 rounded-lg bg-white border border-slate-200 text-xs font-mono font-semibold text-slate-800 mb-4">
                    Application Ref: {activeEnrolment.applicationRef}
                  </div>
                  <p className="text-sm text-slate-600 leading-relaxed mb-7">
                    Your registration has been recorded. Please proceed to OTP phone verification to
                    unlock the final submission form.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setFormError(null);
                      setFormNotice(null);
                      setNowMs(Date.now());
                      setFlowStep('step3_otp');
                    }}
                    className="px-8 py-3 bg-blue-700 hover:bg-blue-800 text-white font-semibold text-sm rounded-lg transition-colors cursor-pointer"
                  >
                    OK
                  </button>
                </div>
              )}

              {/* STEP 3: Verify Phone Number with External OTP */}
              {flowStep === 'step3_otp' && activeEnrolment && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                    <h3 className="font-display text-lg font-bold text-slate-900">
                      Verify Phone Number with OTP
                    </h3>
                    <span className="text-xs text-slate-500 font-mono">Step 3 of 5</span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
                    {/* Left: External OTP Verification Status Card */}
                    <div className="md:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                      <div className="text-xs font-semibold text-slate-500">
                        Phone Verification Status
                      </div>
                      <div className="text-xs text-slate-600">
                        Application Ref:{' '}
                        <span className="font-mono font-semibold text-slate-900">
                          {activeEnrolment.applicationRef}
                        </span>
                      </div>
                      <div className="text-xs text-slate-600">
                        Target phone:{' '}
                        <span className="font-mono font-semibold text-slate-900 tabular-nums">
                          {activeEnrolment.phoneNumber}
                        </span>
                      </div>

                      <div
                        className={`p-3.5 rounded-lg border text-xs leading-relaxed ${
                          !otpIssued
                            ? 'bg-slate-50 border-slate-200 text-slate-600'
                            : attemptsUsed >= MAX_OTP_ATTEMPTS || isOtpExpired
                              ? 'bg-red-50 border-red-200 text-red-900'
                              : 'bg-emerald-50 border-emerald-200 text-emerald-900'
                        }`}
                      >
                        {!otpIssued ? (
                          <span>
                            Waiting for verification code dispatch. If you have not received a code,
                            click Resend Code to notify the admin.
                          </span>
                        ) : attemptsUsed >= MAX_OTP_ATTEMPTS ? (
                          <span>
                            Maximum of 5 incorrect attempts reached. Please request a new code via
                            Resend Code.
                          </span>
                        ) : isOtpExpired ? (
                          <span>
                            This verification code has expired. Please request a new code via Resend
                            Code.
                          </span>
                        ) : (
                          <span>
                            Verification code active for your application. Enter the code received
                            externally ({attemptsRemaining} of {MAX_OTP_ATTEMPTS} attempts
                            remaining).
                          </span>
                        )}
                      </div>

                      <p className="text-xs text-slate-500 leading-relaxed">
                        {settings.otpNoticeText}
                      </p>
                    </div>

                    {/* Right: OTP Input & Resend */}
                    <form onSubmit={handleVerifyOtp} className="md:col-span-7 space-y-4">
                      <div>
                        <label htmlFor="otpCode" className="block text-sm font-medium text-slate-800 mb-1.5">
                          Enter OTP Code
                        </label>
                        <input
                          id="otpCode"
                          type="text"
                          inputMode="numeric"
                          maxLength={12}
                          disabled={submitting || otpVerified || attemptsUsed >= MAX_OTP_ATTEMPTS}
                          value={otpInput}
                          onChange={(e) => setOtpInput(e.target.value.replace(/[^A-Za-z0-9]/g, ''))}
                          placeholder="Enter OTP code"
                          className="w-full px-4 py-3 bg-white border border-slate-300 rounded-lg text-lg font-mono tracking-[0.22em] tabular-nums text-slate-900 placeholder:font-sans placeholder:text-sm placeholder:tracking-normal placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:border-emerald-600 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed"
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={submitting || otpVerified || attemptsUsed >= MAX_OTP_ATTEMPTS}
                        className="w-full py-3 px-6 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm rounded-lg transition-colors cursor-pointer disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed"
                      >
                        {submitting ? 'Verifying Code...' : 'Verify Code'}
                      </button>

                      <div className="pt-2 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <button
                          type="button"
                          disabled={submitting || resendCooldownSeconds > 0 || otpVerified}
                          onClick={handleResendOtpRequest}
                          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          {resendCooldownSeconds > 0
                            ? `Resend Requested (${formatCooldown(resendCooldownSeconds)})`
                            : 'Resend Code'}
                        </button>
                        <span className="text-xs text-slate-500">
                          {resendCooldownSeconds > 0
                            ? 'Admin panel notified · 5-minute cooldown active'
                            : resendNotified || activeEnrolment.otpResendRequested
                              ? 'Admin notified for OTP dispatch'
                              : '5-minute cooldown applies per request'}
                        </span>
                      </div>
                    </form>
                  </div>
                </div>
              )}

              {/* STEP 4: Final Submission Form (2nd Form - Unlocked ONLY after server-verified OTP) */}
              {flowStep === 'step4_package' && activeEnrolment && (
                <form onSubmit={handleStep4Submit} className="space-y-6">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                    <div>
                      <h3 className="font-display text-lg font-bold text-slate-900">
                        Final Enrolment Form (2nd Form)
                      </h3>
                      <p className="text-xs text-slate-500 mt-0.5 font-mono">
                        Application Ref: {activeEnrolment.applicationRef}
                      </p>
                    </div>
                    <span className="text-xs text-slate-500 font-mono">Step 4 of 5</span>
                  </div>

                  {/* Verification Status */}
                  <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-between gap-4">
                    <div>
                      <div className="text-xs font-semibold text-emerald-900">
                        Verification Status
                      </div>
                      <div className="text-xs text-emerald-800 mt-0.5">
                        Phone OTP verified on server · Final form unlocked
                      </div>
                    </div>
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-emerald-600 text-white text-xs font-semibold shrink-0">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      OTP Verified
                    </span>
                  </div>

                  {/* Selected Price */}
                  <div>
                    <label className="block text-sm font-medium text-slate-800 mb-2.5">
                      Selected Price (Choose Your Package)
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {packageOptions.map((pkg) => {
                        const selected = selectedAmount === pkg.amount;
                        return (
                          <button
                            key={pkg.amount}
                            type="button"
                            onClick={() => setSelectedAmount(pkg.amount)}
                            className={`p-4 rounded-lg border text-left transition-colors cursor-pointer ${
                              selected
                                ? 'bg-blue-50 border-blue-700 ring-1 ring-blue-700'
                                : 'bg-white border-slate-200 hover:border-slate-300'
                            }`}
                          >
                            <div className="font-display text-xl font-bold text-slate-900 tabular-nums">
                              {pkg.label}
                            </div>
                            <div className="text-xs text-slate-500 mt-1">{pkg.desc}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Mobile Number */}
                  <div>
                    <label htmlFor="confirmPhone" className="block text-sm font-medium text-slate-800 mb-1.5">
                      Mobile Number <span className="text-red-600">*</span>
                    </label>
                    <input
                      id="confirmPhone"
                      type="tel"
                      required
                      maxLength={20}
                      value={confirmPhoneNumber}
                      onChange={(e) => setConfirmPhoneNumber(e.target.value)}
                      placeholder="Confirm mobile number"
                      className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-lg text-sm font-mono tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  {/* Client Intention */}
                  <div>
                    <label htmlFor="intentionSelect" className="block text-sm font-medium text-slate-800 mb-1.5">
                      Client Intention
                    </label>
                    <select
                      id="intentionSelect"
                      value={intention}
                      onChange={(e) => setIntention(e.target.value as IntentionType)}
                      className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                      <option value="Loan Support">Loan Support</option>
                      <option value="Business">Business</option>
                      <option value="Education">Education</option>
                      <option value="Personal Goal">Personal Goal</option>
                      <option value="Emergency Relief">Emergency Relief</option>
                    </select>
                  </div>

                  {/* Additional Comment */}
                  <div>
                    <label htmlFor="commentBox" className="block text-sm font-medium text-slate-800 mb-1.5">
                      Additional Comment
                    </label>
                    <textarea
                      id="commentBox"
                      rows={3}
                      maxLength={500}
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder="Any additional information..."
                      className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  {/* Terms */}
                  <div className="flex items-start gap-3">
                    <input
                      id="termsCheckbox"
                      type="checkbox"
                      checked={acceptedTerms}
                      onChange={(e) => setAcceptedTerms(e.target.checked)}
                      className="mt-0.5 w-4 h-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600 cursor-pointer"
                    />
                    <label htmlFor="termsCheckbox" className="text-sm text-slate-700">
                      I accept the{' '}
                      <button
                        type="button"
                        onClick={() => setShowTermsModal(true)}
                        className="text-blue-700 underline hover:text-blue-900 font-medium cursor-pointer"
                      >
                        Terms and Conditions
                      </button>
                    </label>
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full inline-flex items-center justify-center gap-2 py-3 px-6 bg-blue-700 hover:bg-blue-800 text-white font-semibold text-sm rounded-lg transition-colors cursor-pointer disabled:opacity-60"
                  >
                    {submitting ? 'Submitting Final Form...' : 'Submit Final Form'}
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </form>
              )}

              {/* STEP 5: Final Submission Confirmation */}
              {flowStep === 'step5_complete' && (
                <div className="py-6 text-center max-w-md mx-auto">
                  <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto mb-5">
                    <ClipboardCheck className="w-9 h-9" />
                  </div>
                  <h3 className="font-display text-2xl font-bold text-slate-900 mb-2">
                    Details Submitted!
                  </h3>
                  {activeEnrolment?.applicationRef && (
                    <div className="inline-block px-3.5 py-1.5 rounded-lg bg-white border border-slate-200 text-xs font-mono font-semibold text-slate-800 mb-4">
                      Application Ref: {activeEnrolment.applicationRef}
                    </div>
                  )}
                  <p className="text-sm text-slate-600 leading-relaxed mb-7">
                    Your data has been recorded. Please check your website account after 10–20
                    minutes or contact our support team on WhatsApp if you need assistance.
                  </p>
                  <button
                    type="button"
                    onClick={handleResetWizard}
                    className="px-8 py-3 bg-blue-700 hover:bg-blue-800 text-white font-semibold text-sm rounded-lg transition-colors cursor-pointer"
                  >
                    OK
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Contact Us via WhatsApp */}
        <section id="contact" className="max-w-7xl mx-auto px-6 py-16">
          <div className="bg-emerald-950 text-white rounded-2xl p-8 lg:p-12 flex flex-col lg:flex-row lg:items-center justify-between gap-8">
            <div className="max-w-xl">
              <div className="inline-flex items-center gap-2 text-emerald-300 text-sm font-medium mb-3">
                <MessageCircle className="w-4 h-4" />
                Direct WhatsApp Support
              </div>
              <h2 className="font-display text-2xl lg:text-3xl font-bold tracking-tight mb-3">
                Need Help? Chat with us on WhatsApp
              </h2>
              <p className="text-emerald-100/80 text-sm leading-relaxed">
                Have questions about your package tier, OTP verification, or account review?
                Reach our support desk directly on WhatsApp or email {settings.supportEmail}.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 shrink-0">
              <a
                href={whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-3 px-6 py-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-display font-bold text-base rounded-xl transition-colors whitespace-nowrap"
              >
                <Phone className="w-5 h-5" />
                <span className="font-mono tabular-nums">{settings.whatsappNumber}</span>
              </a>
            </div>
          </div>
        </section>
      </main>

      {/* Footer with Dedicated Admin Login Navigation Menu */}
      <footer className="bg-slate-950 text-slate-300 border-t border-slate-900">
        <div className="max-w-7xl mx-auto px-6 py-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
          <div>
            <div className="flex items-center gap-2 font-display text-base font-bold text-white mb-3">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              Client Support
            </div>
            <p className="text-xs text-slate-400 leading-relaxed max-w-xs">
              Structured client enrolment, package selection, and verified phone onboarding for
              business, education, and loan support goals.
            </p>
          </div>

          <div className="text-xs space-y-2.5">
            <div className="font-semibold text-white mb-2">Navigation</div>
            <div>
              <a href="#home" className="text-slate-400 hover:text-white transition-colors">
                Home
              </a>
            </div>
            <div>
              <a href="#about" className="text-slate-400 hover:text-white transition-colors">
                Programs &amp; Process
              </a>
            </div>
            <div>
              <a href="#enrol" className="text-slate-400 hover:text-white transition-colors">
                Enroll Now
              </a>
            </div>
            <div>
              <a href="#contact" className="text-slate-400 hover:text-white transition-colors">
                Contact Support
              </a>
            </div>
          </div>

          <div className="text-xs space-y-2.5">
            <div className="font-semibold text-white mb-2">Support Desk</div>
            <div className="text-slate-400 font-mono tabular-nums">
              WhatsApp: {settings.whatsappNumber}
            </div>
            <div className="text-slate-400">{settings.supportEmail}</div>
          </div>

          {/* Footer Admin Navigation Menu */}
          <nav aria-label="Admin Footer Navigation" className="text-xs space-y-2.5">
            <div className="font-semibold text-white mb-2">Administration</div>
            <div>
              <button
                type="button"
                onClick={onOpenAdminPortal}
                className="inline-flex items-center gap-2 text-slate-400 hover:text-white transition-colors cursor-pointer"
              >
                <Lock className="w-3.5 h-3.5 text-slate-500" />
                <span>Admin Login</span>
              </button>
            </div>
            <div>
              <button
                type="button"
                onClick={onOpenAdminPortal}
                className="text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
              >
                Staff Portal &amp; Dashboard
              </button>
            </div>
          </nav>
        </div>

        <div className="border-t border-slate-900">
          <div className="max-w-7xl mx-auto px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500">
            <span>© {new Date().getFullYear()} Client Support. All rights reserved.</span>
            <button
              type="button"
              onClick={onOpenAdminPortal}
              className="inline-flex items-center gap-1.5 text-slate-500 hover:text-white transition-colors cursor-pointer"
            >
              <Lock className="w-3 h-3" />
              <span>Admin Portal Login</span>
            </button>
          </div>
        </div>
      </footer>

      {/* Terms and Conditions Modal */}
      {showTermsModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-lg font-bold text-slate-900">Terms and Conditions</h3>
              <button
                type="button"
                onClick={() => setShowTermsModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3 text-sm text-slate-600 leading-relaxed max-h-72 overflow-y-auto pr-1">
              <p>
                1. All personal details provided during client registration (full name, mobile
                number, and optional email) are used solely to verify eligibility and process your
                chosen package.
              </p>
              <p>
                2. Your secret PIN is securely hashed and never exposed to staff or administrators.
                Phone verification using an externally issued OTP is required before final
                submission.
              </p>
              <p>
                3. Verification reviews typically complete within 10–20 minutes after final
                submission. Contact WhatsApp support at {settings.whatsappNumber} if you need
                assistance.
              </p>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setAcceptedTerms(true);
                  setShowTermsModal(false);
                }}
                className="px-5 py-2.5 bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold rounded-lg cursor-pointer"
              >
                Accept &amp; Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
