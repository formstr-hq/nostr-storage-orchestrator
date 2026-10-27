---
version: 2026-10-01
---

# Privacy Policy

> **Formstr Storage is a beta, experimental service. Data can be lost. Keep independent backups. We are not responsible for data loss.**

This policy explains what we collect and store when you use Formstr Storage, why we use it, and the choices you have. It forms part of our Terms & Conditions. The limits in those terms apply, including the exclusion of liability for data loss.

## 1. Scope

This policy covers the Formstr Storage console, the Blossom API, and the storage service behind them. It does not cover the Nostr network, the relays you use, other Blossom servers, or third-party apps and clients that connect to us. Those have their own privacy practices.

## 2. What we store

**Your Nostr identity.** We identify your account by your public key (npub). We do not ask for your name, address, phone number, or identity documents. We do not require an email address to buy or use a storage plan. If you have added an email address to your Formstr account, our mail service stores it and uses it to send storage notices.

**Your blobs.** We store the bytes you upload, their sha256 hash, their size, when they were uploaded, which storage providers hold copies, and which npub owns each copy. Blobs are content-addressed. If two accounts upload the same bytes, the bytes are stored once and each account gets its own ownership record and storage charge.

**Your plan.** We store the expiry date, storage allowance, and used bytes for your npub. We also keep a record of payment hashes for completed purchases so the same payment cannot be credited twice. The plan name, price, invoice, amount, payment status, and the terms version you accepted are kept by our billing system, which is separate from the storage database.

**Notifications.** We keep a log of storage notices we sent you: the npub, the type of notice, the related reference, the channel, and the time. This is used to avoid sending the same notice twice. Notices are sent as Nostr direct messages through public relays and, if you have an email address on your Formstr account, by email.

**Moderation records.** If a blob is removed for breaking our terms, we keep the blob hash, the owner's npub, the admin's npub, the reason, and the time. This record is kept as an audit trail.

**Technical logs.** Our proxy writes request logs containing a request id, method, path, status code, and duration. These logs do not include the npub. Rate limiting uses your IP address in memory; it is not written to the database. Our reverse proxy and hosting providers may keep standard access logs that include your IP address, user agent, and the time of the request. We use this data for security, abuse prevention, and troubleshooting.

**Cookies and local storage.** The console does not use advertising or cross-site tracking cookies. It uses browser local storage for functional settings, such as whether you have connected a signer and which theme you selected. A NIP-07 extension handles your keys; we never receive your private key.

## 3. Why we use it

We use this data to:

- store, replicate, and serve your blobs and enforce your storage allowance;
- apply the plan lifecycle, including grace periods and blocking;
- send expiry, quota, moderation, and purchase notices;
- keep billing and payment records consistent;
- detect and prevent abuse, fraud, and attacks;
- investigate failures and improve the Service;
- comply with legal obligations and respond to lawful requests.

The lawful basis is performance of our contract with you, our legitimate interest in running and protecting the Service, compliance with legal obligations, and your consent where the law requires it.

## 4. What we do not do

We do not sell your data. We do not use your blobs for advertising. We do not build profiles of you across other sites.

## 5. Sharing

We share data only as needed to run the Service:

- **Storage providers.** Blobs and their metadata are stored on providers in our storage network. A blob may be copied to more than one provider, and some providers may be operated by third parties. Those providers process the data on our behalf.
- **Billing and mail service.** Our billing system processes invoices, payment status, plan data, terms acceptance, and email addresses. It sends storage notices if you have an email address on file.
- **Nostr relays.** Direct-message notifications are sent through public relays. Those relays are run by third parties and may store the messages.
- **Infrastructure providers.** We use hosting, networking, and database providers to run the Service. Some of these providers may process data in other countries. Where required, we use appropriate safeguards for those transfers.
- **Legal and safety.** We may disclose data if the law requires it, if we receive a valid legal request, to report child sexual abuse material or other illegal content, or to protect the rights and safety of users or the public.
- **A successor.** If the Service is transferred to another operator, data may be transferred as part of that transaction under this policy.

## 6. Public nature of content-addressed storage

Blossom is a public-read protocol. Anyone who knows a blob's sha256 hash can download it while at least one owner still has read access. Do not upload anything you need to keep private. The hash itself may be shared, indexed, or guessed by others. Deleting your copy does not remove another account's copy of the same content. If you delete a blob and no other account owns the same content, the bytes are removed from the storage providers.

## 7. Retention and deletion

We keep account and blob records while your plan is active. After your plan expires, the published lifecycle applies: a grace period, then uploads are blocked, then reads are blocked, and then the data is eligible for purge. The current periods are 7 days, 30 days, and 30 days. We may change these periods.

Purge is an operator action and may be delayed, disabled, or fail. We do not guarantee that data will be deleted at any particular time, or that it will be kept for any particular period. This is a beta service and data may be lost before or after the lifecycle ends.

You can delete blobs at any time from your dashboard. Deletion is permanent and cannot be undone. If you want us to delete your account records, contact hello@formstr.app. We may ask you to prove that you control the npub before we act. Some records, such as payment records, moderation records, and access logs, may be kept for longer where the law requires it or to resolve disputes.

Copies may remain for a limited time in backups, caches, or storage provider systems after deletion. We do not control when those copies expire.

## 8. Security

We use access controls, signed requests, and encryption in transit. No system is completely secure. We cannot guarantee that data will not be accessed, changed, or lost. You are responsible for your Nostr keys. Anyone who has your key can act as you and access your plan and blobs.

## 9. Your choices and rights

Depending on where you live, you may have the right to access, correct, delete, or receive a copy of your personal data, to object to or restrict some processing, and to withdraw consent. You can do much of this yourself in the dashboard. For anything else, contact hello@formstr.app. We may need to verify control of the npub first.

If you are in the EEA or the UK, you have the rights in the GDPR, including the right to complain to your local supervisory authority. If you are in California, you have the rights in the CCPA/CPRA, including the right to know, delete, and correct personal information and not to be discriminated against for exercising those rights. We do not sell or share personal information for cross-context behavioral advertising.

## 10. Children

The Service is for adults. You must be at least 18, or the age of majority where you live. We do not knowingly collect data from children. If you believe a child has given us data, contact us and we will remove it.

## 11. Changes

We may update this policy when the Service or the law changes. The current version is always on this page. If the change is material, we will try to notify you through the console or a storage notice. Continued use after a change means you accept the updated policy.

## 12. Contact

Questions about this policy or your data: hello@formstr.app.
