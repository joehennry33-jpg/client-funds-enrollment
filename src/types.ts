import type { Timestamp } from 'firebase/firestore';

export type StaffRole = 'super_admin' | 'verification_officer' | 'support_agent';

export type EnrolmentStage = 'stage1_submitted' | 'awaiting_otp' | 'final_submitted';

export type EnrolmentStatus = 'Pending' | 'Verified' | 'Rejected';

export type AccountStatus = 'Active' | 'Suspended';

export type IntentionType =
  | ''
  | 'Loan Support'
  | 'Business'
  | 'Education'
  | 'Personal Goal'
  | 'Emergency Relief';

export interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  phone?: string;
  accountStatus: AccountStatus;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface Enrolment {
  id: string;
  ownerId: string;
  fullName: string;
  phoneNumber: string;
  email: string;
  packageAmount: number;
  packageLabel: string;
  acceptedTerms: boolean;
  intention: IntentionType;
  comment: string;
  otpCode: string;
  otpVerified: boolean;
  otpResendRequested: boolean;
  stage: EnrolmentStage;
  status: EnrolmentStatus;
  accountStatus: AccountStatus;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface OtpRequest {
  id: string;
  enrolmentId: string;
  ownerId: string;
  clientName: string;
  phoneNumber: string;
  status: 'Pending' | 'Sent';
  dispatchedOtp: string;
  sentByEmail: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface StaffMember {
  email: string;
  displayName: string;
  role: StaffRole;
  active: boolean;
  addedBy: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface SystemSettings {
  whatsappNumber: string;
  supportEmail: string;
  tier1Amount: number;
  tier2Amount: number;
  tier3Amount: number;
  otpNoticeText: string;
  updatedAt: Timestamp | null;
}

export const DEFAULT_SYSTEM_SETTINGS: Omit<SystemSettings, 'updatedAt'> = {
  whatsappNumber: '+254711559098',
  supportEmail: 'support@clientsupport.co.ke',
  tier1Amount: 1200,
  tier2Amount: 1800,
  tier3Amount: 2400,
  otpNoticeText: 'If you do not receive the code within 5 minutes, click Resend Code to notify our admin team.',
};

export const BOOTSTRAP_ADMIN_EMAIL = 'joehennry33@gmail.com';
export const BOOTSTRAP_ADMIN_EMAILS = ['joehennry33@gmail.com', 'joehenry33@gmail.com'];

export function isBootstrapAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  return BOOTSTRAP_ADMIN_EMAILS.includes(email.toLowerCase());
}
