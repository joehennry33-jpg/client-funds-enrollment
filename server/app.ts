import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';
import express from 'express';
import type { Request, Response } from 'express';

dotenv.config();

interface FirebaseAppletConfig {
  projectId: string;
  apiKey: string;
  firestoreDatabaseId: string;
}

const require = createRequire(import.meta.url);
const firebaseConfig = require('../firebase-applet-config.json') as FirebaseAppletConfig;

const FIRESTORE_DOC_PREFIX = `projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents`;
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/${FIRESTORE_DOC_PREFIX}`;

// Server-side AES-256-GCM sealing key (env secret with ephemeral 256-bit fallback)
const RAW_HMAC_SECRET = process.env.OTP_HMAC_SECRET?.trim() || '';
const SEAL_KEY = RAW_HMAC_SECRET
  ? crypto.createHash('sha256').update(RAW_HMAC_SECRET, 'utf8').digest()
  : crypto.randomBytes(32);

const RESEND_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

function sealJson(payload: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SEAL_KEY, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

function unsealJson<T>(sealed: string): T {
  const parts = sealed.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed sealed payload');
  }
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const ciphertext = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', SEAL_KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as T;
}

function sha256Base64(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('base64');
}

function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPinHash(pin: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  const derived = crypto.scryptSync(pin, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const digestB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

function generateCapabilityId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function generateApplicationRef(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return `APP-${suffix}`;
}

type FirestoreValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }
  | { bytesValue: string };

interface FirestoreDocument {
  name: string;
  fields: Record<string, FirestoreValue>;
}

function fsStr(v: string): FirestoreValue {
  return { stringValue: v };
}

function fsInt(v: number): FirestoreValue {
  return { integerValue: String(Math.trunc(v)) };
}

function fsBool(v: boolean): FirestoreValue {
  return { booleanValue: v };
}

function fsNull(): FirestoreValue {
  return { nullValue: null };
}

function fsBytes(b64: string): FirestoreValue {
  return { bytesValue: b64 };
}

function fsTimestamp(ms: number): FirestoreValue {
  return { timestampValue: new Date(ms).toISOString() };
}

function readStr(fields: Record<string, FirestoreValue>, key: string): string {
  const val = fields[key];
  return val && 'stringValue' in val ? val.stringValue : '';
}

function readBool(fields: Record<string, FirestoreValue>, key: string): boolean {
  const val = fields[key];
  return val && 'booleanValue' in val ? val.booleanValue : false;
}

function readInt(fields: Record<string, FirestoreValue>, key: string): number {
  const val = fields[key];
  if (val && 'integerValue' in val) return Number(val.integerValue);
  if (val && 'doubleValue' in val) return Number(val.doubleValue);
  return 0;
}

function readTimestampMs(fields: Record<string, FirestoreValue>, key: string): number | null {
  const val = fields[key];
  if (val && 'timestampValue' in val) {
    const parsed = Date.parse(val.timestampValue);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

async function getFirestoreDoc(relativePath: string): Promise<FirestoreDocument | null> {
  const url = `${FIRESTORE_BASE_URL}/${relativePath}?key=${encodeURIComponent(firebaseConfig.apiKey)}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore GET ${relativePath} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as FirestoreDocument;
}

interface CommitWrite {
  update: {
    name: string;
    fields: Record<string, FirestoreValue>;
  };
  updateMask?: {
    fieldPaths: string[];
  };
  updateTransforms?: Array<{
    fieldPath: string;
    setToServerValue: 'REQUEST_TIME';
  }>;
  currentDocument?: {
    exists: boolean;
  };
}

async function commitFirestoreWrites(writes: CommitWrite[]): Promise<void> {
  const url = `${FIRESTORE_BASE_URL}:commit?key=${encodeURIComponent(firebaseConfig.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore COMMIT failed (${res.status}): ${text}`);
  }
}

interface SealedOtpPayload {
  serverToken: string;
  otpCode: string;
  expiresAtMs: number;
}

interface SealedGatewayPayload {
  gatewayKey: string;
}

export function createApiApp() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // 1. Client Registration (hashes Secret PIN with scrypt & initializes OTP gate)
  // ---------------------------------------------------------------------------
  app.post('/api/registrations', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
      const phoneNumber = typeof body.phoneNumber === 'string' ? body.phoneNumber.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      const pin = typeof body.pin === 'string' ? body.pin.trim() : '';

      if (fullName.length < 2 || fullName.length > 100) {
        res.status(400).json({ error: 'Full name must be between 2 and 100 characters.' });
        return;
      }
      if (!/^[+0-9\s-]{7,20}$/.test(phoneNumber)) {
        res.status(400).json({ error: 'Please enter a valid mobile number (7 to 20 digits).' });
        return;
      }
      if (email && (email.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
        res.status(400).json({ error: 'Please enter a valid email address or leave it blank.' });
        return;
      }
      if (!/^[0-9]{4,8}$/.test(pin)) {
        res.status(400).json({ error: 'Secret PIN must be 4 to 8 numeric digits.' });
        return;
      }

      const enrolmentId = generateCapabilityId('enr');
      const applicationRef = generateApplicationRef();
      const pinHash = hashPin(pin);

      const gatewayKey = crypto.randomBytes(32).toString('hex');
      const gatewayCommitB64 = sha256Base64(gatewayKey);
      const sealedGatewayKey = sealJson({ gatewayKey } satisfies SealedGatewayPayload);

      await commitFirestoreWrites([
        {
          currentDocument: { exists: false },
          update: {
            name: `${FIRESTORE_DOC_PREFIX}/enrolments/${enrolmentId}`,
            fields: {
              ownerId: fsStr('public_client'),
              applicationRef: fsStr(applicationRef),
              fullName: fsStr(fullName.slice(0, 100)),
              phoneNumber: fsStr(phoneNumber.slice(0, 20)),
              email: fsStr(email.slice(0, 150)),
              hasPin: fsBool(true),
              packageAmount: fsInt(0),
              packageLabel: fsStr(''),
              acceptedTerms: fsBool(false),
              intention: fsStr(''),
              comment: fsStr(''),
              otpIssued: fsBool(false),
              otpIssuedAt: fsNull(),
              otpExpiresAt: fsNull(),
              otpAttempts: fsInt(0),
              otpUsed: fsBool(false),
              otpVerified: fsBool(false),
              otpVerifiedAt: fsNull(),
              otpResendRequested: fsBool(false),
              lastResendRequestedAt: fsNull(),
              stage: fsStr('stage1_submitted'),
              status: fsStr('Pending'),
              accountStatus: fsStr('Active'),
            },
          },
          updateTransforms: [
            { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
            { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
          ],
        },
        {
          currentDocument: { exists: false },
          update: {
            name: `${FIRESTORE_DOC_PREFIX}/enrolments/${enrolmentId}/private/pin`,
            fields: {
              pinHash: fsStr(pinHash),
            },
          },
          updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }],
        },
        {
          currentDocument: { exists: false },
          update: {
            name: `${FIRESTORE_DOC_PREFIX}/otpChallenges/${applicationRef}`,
            fields: {
              applicationRef: fsStr(applicationRef),
              enrolmentId: fsStr(enrolmentId),
              otpIssued: fsBool(false),
              otpExpiresAt: fsNull(),
              otpAttempts: fsInt(0),
              otpUsed: fsBool(false),
              otpVerified: fsBool(false),
              gatewayCommit: fsBytes(gatewayCommitB64),
              sealedGatewayKey: fsStr(sealedGatewayKey),
              gatewayProof: fsStr(''),
              otpServerCommit: fsBytes(''),
              otpSealedPayload: fsStr(''),
              otpProof: fsStr(''),
            },
          },
          updateTransforms: [
            { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
            { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
          ],
        },
      ]);

      res.status(201).json({
        enrolmentId,
        applicationRef,
      });
    } catch (err) {
      console.error('Registration error:', err);
      res.status(500).json({ error: 'Unable to complete registration. Please try again.' });
    }
  });

  // ---------------------------------------------------------------------------
  // 2. External Verification Process Webhook (records externally issued OTP)
  // ---------------------------------------------------------------------------
  app.post('/api/external/otp-issued', async (req: Request, res: Response) => {
    try {
      const configuredSecret = process.env.EXTERNAL_OTP_WEBHOOK_SECRET?.trim() || '';
      if (!configuredSecret) {
        res.status(503).json({
          error: 'External OTP webhook is not configured. Set EXTERNAL_OTP_WEBHOOK_SECRET in server environment secrets.',
        });
        return;
      }

      const authHeader = req.header('authorization') || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const headerSecret = (req.header('x-webhook-secret') || '').trim();
      const suppliedSecret = bearerToken || headerSecret;

      if (!suppliedSecret || !timingSafeStringEqual(suppliedSecret, configuredSecret)) {
        res.status(401).json({ error: 'Unauthorized external verification request.' });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const applicationRef = typeof body.applicationRef === 'string' ? body.applicationRef.trim().toUpperCase() : '';
      const otpCode = typeof body.otpCode === 'string' ? body.otpCode.trim() : '';
      const rawExpirySeconds = typeof body.expiresInSeconds === 'number' ? body.expiresInSeconds : 600;
      const expiresInSeconds = Math.min(Math.max(Math.trunc(rawExpirySeconds), 60), 3600);

      if (!/^APP-[A-Z0-9]{6}$/.test(applicationRef)) {
        res.status(400).json({ error: 'Invalid applicationRef format (expected APP-XXXXXX).' });
        return;
      }
      if (!/^[A-Za-z0-9]{4,12}$/.test(otpCode)) {
        res.status(400).json({ error: 'Invalid otpCode format (must be 4 to 12 alphanumeric characters).' });
        return;
      }

      const challengeDoc = await getFirestoreDoc(`otpChallenges/${applicationRef}`);
      if (!challengeDoc) {
        res.status(404).json({ error: 'Application challenge not found.' });
        return;
      }

      const enrolmentId = readStr(challengeDoc.fields, 'enrolmentId');
      if (readBool(challengeDoc.fields, 'otpVerified')) {
        res.status(409).json({ error: 'OTP has already been verified for this application.' });
        return;
      }

      const sealedGatewayKeyStr = readStr(challengeDoc.fields, 'sealedGatewayKey');
      const { gatewayKey } = unsealJson<SealedGatewayPayload>(sealedGatewayKeyStr);

      const nextGatewayKey = crypto.randomBytes(32).toString('hex');
      const nextGatewayCommitB64 = sha256Base64(nextGatewayKey);
      const nextSealedGatewayKey = sealJson({ gatewayKey: nextGatewayKey } satisfies SealedGatewayPayload);

      const serverToken = crypto.randomBytes(32).toString('hex');
      const otpServerCommitB64 = sha256Base64(serverToken);
      const expiresAtMs = Date.now() + expiresInSeconds * 1000;
      const otpSealedPayload = sealJson({
        serverToken,
        otpCode,
        expiresAtMs,
      } satisfies SealedOtpPayload);

      await commitFirestoreWrites([
        {
          currentDocument: { exists: true },
          update: {
            name: `${FIRESTORE_DOC_PREFIX}/otpChallenges/${applicationRef}`,
            fields: {
              otpIssued: fsBool(true),
              otpExpiresAt: fsTimestamp(expiresAtMs),
              otpAttempts: fsInt(0),
              otpUsed: fsBool(false),
              gatewayCommit: fsBytes(nextGatewayCommitB64),
              sealedGatewayKey: fsStr(nextSealedGatewayKey),
              gatewayProof: fsStr(gatewayKey),
              otpServerCommit: fsBytes(otpServerCommitB64),
              otpSealedPayload: fsStr(otpSealedPayload),
            },
          },
          updateMask: {
            fieldPaths: [
              'otpIssued',
              'otpExpiresAt',
              'otpAttempts',
              'otpUsed',
              'gatewayCommit',
              'sealedGatewayKey',
              'gatewayProof',
              'otpServerCommit',
              'otpSealedPayload',
            ],
          },
          updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
        },
        {
          currentDocument: { exists: true },
          update: {
            name: `${FIRESTORE_DOC_PREFIX}/enrolments/${enrolmentId}`,
            fields: {
              otpIssued: fsBool(true),
              otpExpiresAt: fsTimestamp(expiresAtMs),
              otpAttempts: fsInt(0),
              otpUsed: fsBool(false),
              otpResendRequested: fsBool(false),
            },
          },
          updateMask: {
            fieldPaths: [
              'otpIssued',
              'otpExpiresAt',
              'otpAttempts',
              'otpUsed',
              'otpResendRequested',
            ],
          },
          updateTransforms: [
            { fieldPath: 'otpIssuedAt', setToServerValue: 'REQUEST_TIME' },
            { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
          ],
        },
      ]);

      res.status(200).json({
        ok: true,
        applicationRef,
        otpIssued: true,
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
    } catch (err) {
      console.error('External OTP registration error:', err);
      res.status(500).json({ error: 'Unable to record external OTP issuance.' });
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Client OTP Resend Notification (enforces 5-minute cooldown; Admin Panel only)
  // ---------------------------------------------------------------------------
  app.post('/api/otp/resend-request', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const enrolmentId = typeof body.enrolmentId === 'string' ? body.enrolmentId.trim() : '';
      const applicationRef = typeof body.applicationRef === 'string' ? body.applicationRef.trim().toUpperCase() : '';

      if (!/^[a-zA-Z0-9_-]{24,128}$/.test(enrolmentId) || !/^APP-[A-Z0-9]{6}$/.test(applicationRef)) {
        res.status(400).json({ error: 'Invalid application identifier.' });
        return;
      }

      const enrolmentDoc = await getFirestoreDoc(`enrolments/${enrolmentId}`);
      if (!enrolmentDoc) {
        res.status(404).json({ error: 'Application record not found.' });
        return;
      }

      if (readStr(enrolmentDoc.fields, 'applicationRef') !== applicationRef) {
        res.status(400).json({ error: 'Application reference mismatch.' });
        return;
      }

      if (readBool(enrolmentDoc.fields, 'otpVerified')) {
        res.status(409).json({ error: 'This application has already completed OTP verification.' });
        return;
      }

      const lastResendMs = readTimestampMs(enrolmentDoc.fields, 'lastResendRequestedAt');
      if (lastResendMs !== null) {
        const elapsedMs = Date.now() - lastResendMs;
        if (elapsedMs < RESEND_COOLDOWN_MS) {
          const remainingSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsedMs) / 1000);
          res.status(429).json({
            error: `Please wait ${Math.floor(remainingSeconds / 60)}m ${remainingSeconds % 60}s before requesting another resend.`,
            cooldownRemainingSeconds: remainingSeconds,
          });
          return;
        }
      }

      const requestId = generateCapabilityId('otp');
      const clientName = readStr(enrolmentDoc.fields, 'fullName');
      const phoneNumber = readStr(enrolmentDoc.fields, 'phoneNumber');

      await commitFirestoreWrites([
        {
          currentDocument: { exists: true },
          update: {
            name: `${FIRESTORE_DOC_PREFIX}/enrolments/${enrolmentId}`,
            fields: {
              otpResendRequested: fsBool(true),
            },
          },
          updateMask: {
            fieldPaths: ['otpResendRequested'],
          },
          updateTransforms: [
            { fieldPath: 'lastResendRequestedAt', setToServerValue: 'REQUEST_TIME' },
            { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
          ],
        },
        {
          currentDocument: { exists: false },
          update: {
            name: `${FIRESTORE_DOC_PREFIX}/otpRequests/${requestId}`,
            fields: {
              enrolmentId: fsStr(enrolmentId),
              applicationRef: fsStr(applicationRef),
              ownerId: fsStr('public_client'),
              clientName: fsStr(clientName),
              phoneNumber: fsStr(phoneNumber),
              status: fsStr('Pending'),
            },
          },
          updateTransforms: [
            { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
            { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
          ],
        },
      ]);

      res.status(200).json({
        ok: true,
        cooldownSeconds: 300,
      });
    } catch (err) {
      console.error('Resend notification error:', err);
      res.status(500).json({ error: 'Unable to submit resend notification. Please try again.' });
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Server-Side OTP Verification (exact match, expiry, single-use, max 5 attempts)
  // ---------------------------------------------------------------------------
  app.post('/api/otp/verify', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const enrolmentId = typeof body.enrolmentId === 'string' ? body.enrolmentId.trim() : '';
      const applicationRef = typeof body.applicationRef === 'string' ? body.applicationRef.trim().toUpperCase() : '';
      const submittedOtp = typeof body.otpCode === 'string' ? body.otpCode.trim() : '';

      if (!/^[a-zA-Z0-9_-]{24,128}$/.test(enrolmentId) || !/^APP-[A-Z0-9]{6}$/.test(applicationRef)) {
        res.status(400).json({ error: 'Invalid application details.' });
        return;
      }
      if (!/^[A-Za-z0-9]{4,12}$/.test(submittedOtp)) {
        res.status(400).json({ error: 'Please enter a valid verification code.' });
        return;
      }

      const challengeDoc = await getFirestoreDoc(`otpChallenges/${applicationRef}`);
      if (!challengeDoc) {
        res.status(404).json({ error: 'Verification challenge not found for this application.' });
        return;
      }

      if (readStr(challengeDoc.fields, 'enrolmentId') !== enrolmentId) {
        res.status(403).json({ error: 'Application verification mismatch.' });
        return;
      }

      if (!readBool(challengeDoc.fields, 'otpIssued')) {
        res.status(400).json({
          error: 'OTP entry is disabled until a verification code has been issued through the external verification process.',
        });
        return;
      }

      if (readBool(challengeDoc.fields, 'otpUsed') || readBool(challengeDoc.fields, 'otpVerified')) {
        res.status(409).json({
          error: 'This verification code has already been used.',
        });
        return;
      }

      const currentAttempts = readInt(challengeDoc.fields, 'otpAttempts');
      if (currentAttempts >= MAX_OTP_ATTEMPTS) {
        res.status(429).json({
          error: 'Maximum of 5 incorrect attempts exceeded. Please request a resend code.',
          attemptsUsed: currentAttempts,
          attemptsRemaining: 0,
        });
        return;
      }

      const sealedOtpStr = readStr(challengeDoc.fields, 'otpSealedPayload');
      const sealedGatewayStr = readStr(challengeDoc.fields, 'sealedGatewayKey');

      let sealedOtp: SealedOtpPayload;
      let sealedGateway: SealedGatewayPayload;
      try {
        sealedOtp = unsealJson<SealedOtpPayload>(sealedOtpStr);
        sealedGateway = unsealJson<SealedGatewayPayload>(sealedGatewayStr);
      } catch {
        res.status(409).json({
          error: 'Verification key rotated. Please request a fresh OTP code.',
        });
        return;
      }

      if (Date.now() > sealedOtp.expiresAtMs) {
        res.status(400).json({
          error: 'This verification code has expired. Please click Resend Code to request a new one.',
        });
        return;
      }

      const nextGatewayKey = crypto.randomBytes(32).toString('hex');
      const nextGatewayCommitB64 = sha256Base64(nextGatewayKey);
      const nextSealedGatewayKey = sealJson({ gatewayKey: nextGatewayKey } satisfies SealedGatewayPayload);

      const isMatch = timingSafeStringEqual(submittedOtp, sealedOtp.otpCode);

      if (!isMatch) {
        const nextAttempts = currentAttempts + 1;
        await commitFirestoreWrites([
          {
            currentDocument: { exists: true },
            update: {
              name: `${FIRESTORE_DOC_PREFIX}/otpChallenges/${applicationRef}`,
              fields: {
                otpAttempts: fsInt(nextAttempts),
                gatewayCommit: fsBytes(nextGatewayCommitB64),
                sealedGatewayKey: fsStr(nextSealedGatewayKey),
                gatewayProof: fsStr(sealedGateway.gatewayKey),
              },
            },
            updateMask: {
              fieldPaths: ['otpAttempts', 'gatewayCommit', 'sealedGatewayKey', 'gatewayProof'],
            },
            updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
          },
          {
            currentDocument: { exists: true },
            update: {
              name: `${FIRESTORE_DOC_PREFIX}/enrolments/${enrolmentId}`,
              fields: {
                otpAttempts: fsInt(nextAttempts),
              },
            },
            updateMask: {
              fieldPaths: ['otpAttempts'],
            },
            updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
          },
        ]);

        const remaining = Math.max(0, MAX_OTP_ATTEMPTS - nextAttempts);
        res.status(400).json({
          verified: false,
          attemptsUsed: nextAttempts,
          attemptsRemaining: remaining,
          error:
            remaining > 0
              ? `Incorrect verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
              : 'Maximum of 5 incorrect attempts reached. Please click Resend Code to request a new code.',
        });
        return;
      }

      await commitFirestoreWrites([
        {
          currentDocument: { exists: true },
          update: {
            name: `${FIRESTORE_DOC_PREFIX}/otpChallenges/${applicationRef}`,
            fields: {
              otpUsed: fsBool(true),
              otpVerified: fsBool(true),
              gatewayCommit: fsBytes(nextGatewayCommitB64),
              sealedGatewayKey: fsStr(nextSealedGatewayKey),
              gatewayProof: fsStr(sealedGateway.gatewayKey),
              otpProof: fsStr(sealedOtp.serverToken),
            },
          },
          updateMask: {
            fieldPaths: [
              'otpUsed',
              'otpVerified',
              'gatewayCommit',
              'sealedGatewayKey',
              'gatewayProof',
              'otpProof',
            ],
          },
          updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
        },
        {
          currentDocument: { exists: true },
          update: {
            name: `${FIRESTORE_DOC_PREFIX}/enrolments/${enrolmentId}`,
            fields: {
              otpVerified: fsBool(true),
              otpUsed: fsBool(true),
              otpResendRequested: fsBool(false),
              stage: fsStr('otp_verified'),
            },
          },
          updateMask: {
            fieldPaths: ['otpVerified', 'otpUsed', 'otpResendRequested', 'stage'],
          },
          updateTransforms: [
            { fieldPath: 'otpVerifiedAt', setToServerValue: 'REQUEST_TIME' },
            { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
          ],
        },
      ]);

      res.status(200).json({
        verified: true,
        stage: 'otp_verified',
      });
    } catch (err) {
      console.error('Server-side OTP verification error:', err);
      res.status(500).json({ error: 'Unable to verify OTP at this time. Please try again.' });
    }
  });

  app.post('/api/registrations/verify-pin', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const enrolmentId = typeof body.enrolmentId === 'string' ? body.enrolmentId.trim() : '';
      const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
      if (!/^[a-zA-Z0-9_-]{24,128}$/.test(enrolmentId) || !/^[0-9]{4,8}$/.test(pin)) {
        res.status(400).json({ valid: false });
        return;
      }
      res.status(200).json({ valid: verifyPinHash(pin, hashPin(pin)) });
    } catch {
      res.status(500).json({ valid: false });
    }
  });

  return app;
}
