import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
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
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { Enrolment, IntentionType, SystemSettings } from '../types';
import { SafeImage } from './SafeImage';

interface ClientPortalProps {
  settings: Omit<SystemSettings, 'updatedAt'>;
  onOpenAdminPortal: () => void;
}

type FlowStep = 'step2_info' | 'step3_received' | 'step4_package' | 'step5_otp' | 'step6_complete';

function generateCapabilityId(prefix: string): string {
  const raw =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${raw}`.slice(0, 48);
}

export function ClientPortal({ settings, onOpenAdminPortal }: ClientPortalProps) {
  // Active in-progress enrolment state (kept only for current wizard session; submissions are never listed publicly)
  const [flowStep, setFlowStep] = useState<FlowStep>('step2_info');
  const [activeEnrolmentId, setActiveEnrolmentId] = useState<string | null>(null);
  const [activeEnrolment, setActiveEnrolment] = useState<Enrolment | null>(null);

  // Step 2 (1st Form)
  const [fullName, setFullName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [email, setEmail] = useState('');

  // Step 4 (2nd Form)
  const [selectedAmount, setSelectedAmount] = useState<number>(settings.tier1Amount);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [intention, setIntention] = useState<IntentionType>('Loan Support');
  const [comment, setComment] = useState('');
  const [showTermsModal, setShowTermsModal] = useState(false);

  // Step 5 (OTP)
  const [otpInput, setOtpInput] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendNotified, setResendNotified] = useState(false);

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

  // Listen only to the currently active wizard document while in progress (e.g., to receive Admin-dispatched OTP)
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
        setActiveEnrolment({
          id: snap.id,
          ...(snap.data() as Omit<Enrolment, 'id'>),
        });
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, `enrolments/${activeEnrolmentId}`);
      }
    );

    return () => unsub();
  }, [activeEnrolmentId]);

  // Cooldown timer for OTP resend button
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  const whatsappDigits = settings.whatsappNumber.replace(/[^0-9]/g, '');
  const whatsappUrl = `https://wa.me/${whatsappDigits}`;

  const handleStep2Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFormNotice(null);

    const cleanName = fullName.trim();
    const cleanPhone = phoneNumber.trim();
    const cleanEmail = email.trim();

    if (cleanName.length < 2) {
      setFormError('Please enter your full name (at least 2 characters).');
      return;
    }
    if (!/^[+0-9\s-]{7,20}$/.test(cleanPhone)) {
      setFormError('Please enter a valid phone number (e.g. 0711234567 or +254711234567).');
      return;
    }
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setFormError('Please enter a valid email address or leave it blank.');
      return;
    }

    setSubmitting(true);
    const newId = generateCapabilityId('enr');

    try {
      await setDoc(doc(db, 'enrolments', newId), {
        ownerId: 'public_client',
        fullName: cleanName.slice(0, 100),
        phoneNumber: cleanPhone.slice(0, 20),
        email: cleanEmail.slice(0, 150),
        packageAmount: 0,
        packageLabel: '',
        acceptedTerms: false,
        intention: '',
        comment: '',
        otpCode: '',
        otpVerified: false,
        otpResendRequested: false,
        stage: 'stage1_submitted',
        status: 'Pending',
        accountStatus: 'Active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      setActiveEnrolmentId(newId);
      setFlowStep('step3_received');
      setFormError(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `enrolments/${newId}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStep4Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!activeEnrolment) {
      setFormError('No active enrolment found. Please start from Step 1.');
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
        packageAmount: selectedAmount,
        packageLabel: label,
        acceptedTerms: true,
        intention,
        comment: comment.trim().slice(0, 500),
        stage: 'awaiting_otp',
        updatedAt: serverTimestamp(),
      });
      setOtpInput('');
      setResendNotified(false);
      setFlowStep('step5_otp');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `enrolments/${activeEnrolment.id}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFormNotice(null);

    if (!activeEnrolment) {
      setFormError('No active enrolment record found.');
      return;
    }

    const trimmed = otpInput.trim();
    if (!/^[0-9]{6}$/.test(trimmed)) {
      setFormError('Please enter a valid 6-digit OTP code.');
      return;
    }

    setSubmitting(true);
    try {
      await updateDoc(doc(db, 'enrolments', activeEnrolment.id), {
        otpCode: trimmed,
        otpVerified: true,
        otpResendRequested: false,
        stage: 'final_submitted',
        updatedAt: serverTimestamp(),
      });
      setFlowStep('step6_complete');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `enrolments/${activeEnrolment.id}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleResendOtpRequest = async () => {
    if (!activeEnrolment || resendCooldown > 0) return;
    setFormError(null);
    setSubmitting(true);

    const requestId = generateCapabilityId('otp');
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'enrolments', activeEnrolment.id), {
        otpResendRequested: true,
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, 'otpRequests', requestId), {
        enrolmentId: activeEnrolment.id,
        ownerId: 'public_client',
        clientName: activeEnrolment.fullName,
        phoneNumber: activeEnrolment.phoneNumber,
        status: 'Pending',
        dispatchedOtp: '',
        sentByEmail: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await batch.commit();

      setResendNotified(true);
      setResendCooldown(15);
      setFormNotice(
        'Resend request sent. The admin team has been notified to send a fresh OTP code.'
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `otpRequests/${requestId}`);
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
    setEmail('');
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
        : flowStep === 'step4_package'
          ? 3
          : flowStep === 'step5_otp'
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
                if (flowStep === 'step6_complete') handleResetWizard();
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
                    if (flowStep === 'step6_complete') handleResetWizard();
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
                  <div className="font-display text-2xl font-bold text-slate-900 tabular-nums">6-Digit OTP</div>
                  <div className="text-xs text-slate-500 mt-0.5">Verified phone protection</div>
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
              Submit your contact details once, choose the package that matches your plan, and verify
              your mobile number via OTP for confidential review by our verification desk.
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
                    <span>Enter name, phone, and optional email</span>
                  </li>
                  <li className="flex gap-3">
                    <span className="font-mono text-xs text-emerald-400 pt-0.5 tabular-nums">02</span>
                    <span>Receive immediate admin queue confirmation</span>
                  </li>
                  <li className="flex gap-3">
                    <span className="font-mono text-xs text-emerald-400 pt-0.5 tabular-nums">03</span>
                    <span>Choose package, accept terms, state intention</span>
                  </li>
                  <li className="flex gap-3">
                    <span className="font-mono text-xs text-emerald-400 pt-0.5 tabular-nums">04</span>
                    <span>Verify phone number with 6-digit OTP</span>
                  </li>
                  <li className="flex gap-3">
                    <span className="font-mono text-xs text-emerald-400 pt-0.5 tabular-nums">05</span>
                    <span>Submit securely to our private admin team</span>
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

        {/* Steps 2 to 6: Interactive Client Enrolment & Verification Flow */}
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
                { num: 1, label: 'Client Info' },
                { num: 2, label: 'Received' },
                { num: 3, label: 'Package' },
                { num: 4, label: 'Verify OTP' },
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
              {/* STEP 2: 1st Form - Client Information */}
              {flowStep === 'step2_info' && (
                <form onSubmit={handleStep2Submit} className="space-y-5">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                    <div className="flex items-center gap-2.5">
                      <UserIcon className="w-5 h-5 text-blue-700" />
                      <h3 className="font-display text-lg font-bold text-slate-900">
                        Client Information (1st Form)
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
                      placeholder="Enter your name"
                      className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                    />
                  </div>

                  <div>
                    <label htmlFor="phoneNumber" className="block text-sm font-medium text-slate-800 mb-1.5">
                      Phone Number <span className="text-red-600">*</span>
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

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full py-3 px-6 bg-blue-700 hover:bg-blue-800 text-white font-semibold text-sm rounded-lg transition-colors cursor-pointer disabled:opacity-60"
                  >
                    {submitting ? 'Submitting Details...' : 'Submit Details'}
                  </button>
                </form>
              )}

              {/* STEP 3: Form Submitted to Admin Panel */}
              {flowStep === 'step3_received' && (
                <div className="py-6 text-center max-w-md mx-auto">
                  <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto mb-5">
                    <CheckCircle2 className="w-9 h-9" />
                  </div>
                  <h3 className="font-display text-2xl font-bold text-slate-900 mb-2">
                    Data Received!
                  </h3>
                  <p className="text-sm text-slate-600 leading-relaxed mb-7">
                    Your information has been successfully submitted to our admin panel. Please proceed
                    to choose your package and complete verification.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setFormError(null);
                      setFlowStep('step4_package');
                    }}
                    className="px-8 py-3 bg-blue-700 hover:bg-blue-800 text-white font-semibold text-sm rounded-lg transition-colors cursor-pointer"
                  >
                    OK
                  </button>
                </div>
              )}

              {/* STEP 4: Select Price, Accept Terms & Add Comment */}
              {flowStep === 'step4_package' && (
                <form onSubmit={handleStep4Submit} className="space-y-6">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                    <h3 className="font-display text-lg font-bold text-slate-900">
                      Choose Your Package &amp; Details
                    </h3>
                    <span className="text-xs text-slate-500 font-mono">Step 3 of 5</span>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-800 mb-2.5">
                      Choose Your Package
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

                  <div>
                    <label htmlFor="intentionSelect" className="block text-sm font-medium text-slate-800 mb-1.5">
                      Your Intention
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

                  <div>
                    <label htmlFor="commentBox" className="block text-sm font-medium text-slate-800 mb-1.5">
                      Your Comment
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

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full inline-flex items-center justify-center gap-2 py-3 px-6 bg-blue-700 hover:bg-blue-800 text-white font-semibold text-sm rounded-lg transition-colors cursor-pointer disabled:opacity-60"
                  >
                    {submitting ? 'Saving Selection...' : 'Proceed'}
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </form>
              )}

              {/* STEP 5: Verify Phone Number with OTP */}
              {flowStep === 'step5_otp' && activeEnrolment && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                    <h3 className="font-display text-lg font-bold text-slate-900">
                      Verify Phone Number with OTP
                    </h3>
                    <span className="text-xs text-slate-500 font-mono">Step 4 of 5</span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
                    {/* Left: SMS Verification Status Card */}
                    <div className="md:col-span-5 bg-white border border-slate-200 rounded-xl p-5">
                      <div className="text-xs font-semibold text-slate-500 mb-3">
                        Phone Verification Status
                      </div>
                      <p className="text-xs text-slate-600 mb-3">
                        Target phone:{' '}
                        <span className="font-mono font-semibold text-slate-900 tabular-nums">
                          {activeEnrolment.phoneNumber}
                        </span>
                      </p>
                      <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700 leading-relaxed">
                        Our admin team sends your 6-digit verification code externally to your phone.
                        Enter the code you received from that external message to complete your
                        enrolment.
                      </div>
                      <p className="text-xs text-slate-500 mt-4 leading-relaxed">
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
                          maxLength={6}
                          value={otpInput}
                          onChange={(e) => setOtpInput(e.target.value.replace(/[^0-9]/g, ''))}
                          placeholder="Enter 6-digit code"
                          className="w-full px-4 py-3 bg-white border border-slate-300 rounded-lg text-lg font-mono tracking-[0.2em] tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:border-emerald-600"
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={submitting}
                        className="w-full py-3 px-6 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm rounded-lg transition-colors cursor-pointer disabled:opacity-60"
                      >
                        {submitting ? 'Verifying...' : 'Verify Code'}
                      </button>

                      <div className="pt-2 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <button
                          type="button"
                          disabled={submitting || resendCooldown > 0}
                          onClick={handleResendOtpRequest}
                          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          {resendCooldown > 0
                            ? `Resend Requested (${resendCooldown}s)`
                            : 'Resend Code (Notify Admin)'}
                        </button>
                        <span className="text-xs text-slate-500">
                          {resendNotified || activeEnrolment.otpResendRequested
                            ? 'Admin notified for OTP dispatch'
                            : 'Standard wait: 5 min'}
                        </span>
                      </div>
                    </form>
                  </div>
                </div>
              )}

              {/* STEP 6: Submit Final Form (2nd Form) */}
              {flowStep === 'step6_complete' && (
                <div className="py-6 text-center max-w-md mx-auto">
                  <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto mb-5">
                    <ClipboardCheck className="w-9 h-9" />
                  </div>
                  <h3 className="font-display text-2xl font-bold text-slate-900 mb-2">
                    Details Submitted!
                  </h3>
                  <p className="text-sm text-slate-600 leading-relaxed mb-7">
                    Your data has been recorded. Please check back in your account after 10–20 minutes
                    or contact our support team on WhatsApp if you need assistance.
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

        {/* Step 7: Contact Us via WhatsApp */}
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
                Have questions about your package tier, OTP code delivery, or account verification?
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
                1. All personal details provided during client enrolment (full name, phone number, and
                optional email) are used solely to verify eligibility and process your chosen package.
              </p>
              <p>
                2. Phone verification via 6-digit OTP is mandatory before final submission. If your
                code is delayed, use the Resend Code button to notify an administrator.
              </p>
              <p>
                3. Verification reviews typically complete within 10–20 minutes after final submission.
                Please contact WhatsApp support at {settings.whatsappNumber} if you need help.
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
