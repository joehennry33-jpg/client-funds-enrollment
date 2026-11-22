# Security Specification & Hardened Rules Plan

## 1. Data Invariants
1. Every `UserProfile` document at `/users/{userId}` can only be read by its owner (`request.auth.uid == userId`) or an active verified staff member/admin.
2. Every `Enrolment` document at `/enrolments/{enrolmentId}` must use a high-entropy capability ID (`size() >= 24`), start in `stage == 'stage1_submitted'` with `status == 'Pending'`, `accountStatus == 'Active'`, `hasPin == true`, `otpIssued == false`, `otpUsed == false`, `otpVerified == false`, `otpAttempts == 0`.
3. Client-created Secret PIN hashes are stored strictly in `/enrolments/{enrolmentId}/private/pin` with `allow read: if false;` so neither clients nor administrators can ever view or retrieve PINs or PIN hashes.
4. OTP challenge state and encrypted verification payloads live in `/otpChallenges/{applicationRef}` with `allow list: if false;` and rotating SHA-256 `gatewayCommit` / `otpServerCommit` commitments.
5. `otpIssued`, `otpAttempts`, `otpUsed`, `otpVerified`, and transition to `stage == 'otp_verified'` can ONLY occur via an atomic Firestore batch that proves knowledge of the rotating `gatewayProof` (matching `hashing.sha256(...) == existing().gatewayCommit`) and `otpProof` (matching `hashing.sha256(...) == existing().otpServerCommit`).
6. Clients cannot enter or submit the Second Form (`stage == 'final_submitted'`) unless `existing().stage == 'otp_verified' && existing().otpVerified == true && existing().otpUsed == true`.
7. Once an enrolment reaches `status == 'Verified'` or `status == 'Rejected'`, client updates are locked; only verified staff/admins can modify admin-controlled statuses or delete records.
8. `OtpRequest` documents in `/otpRequests/{requestId}` include `clientName`, `phoneNumber`, `applicationRef`, and `createdAt`, must reference an existing `Enrolment`, and are strictly bounded by a 5-minute (`duration.value(5, 'm')`) resend cooldown on `/enrolments/{enrolmentId}.lastResendRequestedAt`. Admin staff may only acknowledge resend notifications (`status: 'Acknowledged'`) and cannot generate, issue, or send OTPs.
9. `StaffMember` documents in `/staffAccess/{staffEmail}` can only be created, updated, or deleted by a verified `super_admin` or bootstrap owner.

## 2. Dirty Dozen Attack Payloads (Expected: PERMISSION_DENIED)
1. **Direct OTP Self-Verification**: Client calling `update /enrolments/{id}` setting `otpVerified: true, stage: 'otp_verified'` without atomic `/otpChallenges/{appRef}` `gatewayProof` + `otpProof`.
2. **Final Form State Shortcutting**: Client calling `update /enrolments/{id}` setting `stage: 'final_submitted'` while `otpVerified == false` or `stage == 'stage1_submitted'`.
3. **PIN Hash Enumeration**: Admin or client calling `get /enrolments/{id}/private/pin`.
4. **Attempt Counter Reset**: Client attempting `update /otpChallenges/{appRef}` to reset `otpAttempts` from `4` back to `0`.
5. **Brute-Force Beyond 5 Attempts**: Attempting `update /otpChallenges/{appRef}` when `existing().otpAttempts >= 5`.
6. **OTP Replay Attack**: Attempting `update /otpChallenges/{appRef}` when `existing().otpUsed == true` or `existing().otpVerified == true`.
7. **5-Minute Cooldown Bypass**: Client calling `update /enrolments/{id}` with `otpResendRequested: true` when `request.time < existing().lastResendRequestedAt + duration.value(5, 'm')`.
8. **Shadow / Ghost Field Injection**: Creating `/enrolments/{id}` with `{ isAdmin: true, pin: "1234" }` outside allowed keys.
9. **ID Poisoning**: Creating `/enrolments/short_id` or malformed characters failing `isCapabilityId()`.
10. **PII Blanket List Scraping**: Unauthenticated or non-admin client calling `list /enrolments` or `list /otpRequests` or `list /otpChallenges`.
11. **Timestamp Spoofing**: Creating `/enrolments/{id}` or `/otpRequests/{id}` with forged `createdAt != request.time`.
12. **Privilege Escalation**: Non-admin user creating `/staffAccess/attacker@example.com` with `role: 'super_admin'`.
