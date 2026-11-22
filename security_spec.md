# Security Specification & Hardened Rules Plan

## 1. Data Invariants
1. Every `UserProfile` document at `/users/{userId}` can only be read by its owner (`request.auth.uid == userId`) or an active verified staff member/admin, and never exposes PII to unauthenticated or unrelated users.
2. Every `Enrolment` document at `/enrolments/{enrolmentId}` must bind `ownerId == request.auth.uid` on creation, start in `stage == 'stage1_submitted'` with `status == 'Pending'`, `otpVerified == false`, and `accountStatus == 'Active'`.
3. Clients cannot self-verify (`status: 'Verified'`) or alter `ownerId`, `createdAt`, or `accountStatus`. Clients may only transition their own enrolment from `stage1_submitted` -> `awaiting_otp` (selecting package, accepting terms, setting intention/comment) and `awaiting_otp` -> `final_submitted` (verifying OTP or requesting OTP resend).
4. Once an enrolment reaches `status == 'Verified'` or `status == 'Rejected'`, client updates are locked; only verified staff/admins can modify admin-controlled statuses or delete records.
5. `OtpRequest` documents must reference an existing `Enrolment` belonging to `request.auth.uid`, start with `status == 'Pending'`, and can only be fulfilled (`status == 'Sent'`) by verified staff/admins.
6. `StaffMember` documents in `/staffAccess/{staffEmail}` can only be created, updated, or deleted by a verified `super_admin` or the bootstrapped owner (`joehennry33@gmail.com`). Users can read only their own staff entry to check portal access.

## 2. Dirty Dozen Attack Payloads (Expected: PERMISSION_DENIED)
1. **Unauthenticated Enrolment Create**: `create /enrolments/e1` without `request.auth`.
2. **Unverified Email Write**: `create /enrolments/e1` with `request.auth.token.email_verified == false`.
3. **Identity Spoofing on Enrolment**: `create /enrolments/e1` with `ownerId: "victim_uid"` != `request.auth.uid`.
4. **Client Self-Verification**: `create` or `update /enrolments/e1` as client setting `status: "Verified"`.
5. **Shadow / Ghost Field Injection**: `create /enrolments/e1` adding `{ isAdmin: true }` outside allowed keys.
6. **ID Poisoning**: `create /enrolments/invalid$id*with>128chars...` failing `isValidId()`.
7. **PII Blanket List Scraping**: `list /enrolments` as a regular client without `where('ownerId', '==', uid)`.
8. **Cross-Client Read**: `get /users/other_uid` or `get /enrolments/other_enrolment` as non-owner client.
9. **Terminal State Tampering**: Client attempting `update /enrolments/e1` after admin marked `status: "Verified"`.
10. **Timestamp Spoofing**: `create /enrolments/e1` with client-forged `createdAt` != `request.time`.
11. **Privilege Escalation**: Regular client attempting `create /staffAccess/attacker@example.com` with `role: "super_admin"`.
12. **Orphaned OTP Request**: Client creating `/otpRequests/r1` referencing a non-existent or someone else's `enrolmentId`.
