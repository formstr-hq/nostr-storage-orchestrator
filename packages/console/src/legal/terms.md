---
version: 2026-10-01
---

# Terms & Conditions

> **Formstr Storage is a beta, experimental service. Data can be lost. Keep independent backups. We are not responsible for data loss.**

## 1. Beta and experimental service

Formstr Storage ("the Service") is a beta, experimental storage service. It is under active development. Features, limits, prices, availability, and the underlying infrastructure may change or be withdrawn without notice. Outages, failed uploads, failed downloads, corrupted data, and permanent data loss are possible.

Do not use the Service as the only copy of anything you cannot afford to lose. Keep independent backups.

We are not responsible for data loss. To the maximum extent permitted by law, we accept no liability for any loss, corruption, deletion, or unavailability of your data, whether caused by a bug, an outage, a storage provider failure, operator error, a security incident, or any other cause. This applies even if we were told that the data was important. Sections 11 and 12 contain further limits on our liability.

## 2. The Service

Formstr Storage provides content-addressed blob storage over the Blossom HTTP protocol. You can upload blobs, read them by their sha256 hash, list and delete the blobs you own, and buy storage plans. The Service is aimed at Nostr clients and applications that speak Blossom.

Uploads are stored on storage providers that participate in the storage network. A blob may be copied to more than one provider. Anyone who knows a blob's hash can read it while at least one owner of that blob still has read access. There is no private-blob mode.

There is no free tier. You need a paid or granted storage entitlement before you can upload.

## 3. Eligibility

You must be at least 18 years old, or the age of majority where you live, to use the Service. You must be able to enter into a binding contract. If you use the Service for an organization, you confirm that you have authority to bind it to these terms.

## 4. Plans, payment, and refunds

Plans are sold in bitcoin sats over Lightning. The current plans, prices, storage allowances, and durations are shown on the pricing page. We may change plans, prices, allowances, and durations at any time. A change does not affect a plan you have already paid for.

You need a Nostr key to buy a plan. The plan is tied to that key. Anyone who controls the key controls the plan and the blobs owned by that key. We do not require your name, email address, or KYC information to buy a plan. If you add an email address to your Formstr account, we may use it for storage notices.

An invoice must be paid before it expires. A plan is granted after the payment is confirmed. We may limit or pause new purchases when our storage is full. Existing customers may still be allowed to renew or upgrade.

Except where the law requires otherwise, payments are non-refundable. We do not give refunds or credits for unused time, unused storage, outages, features you did not use, or data loss. If you think you were charged in error, contact hello@formstr.app and we will look into it.

## 5. Renewal, upgrades, and downgrades

Buying the same plan again adds its duration to your existing expiry. Upgrading to a higher tier applies the larger allowance immediately and adds the purchased days to your remaining time.

A lower-tier plan can only be bought after your current plan expires. If your usage is above the new allowance, the account enters a grace period. Uploads are blocked until you delete enough blobs or buy a larger plan.

## 6. Storage allowance and lifecycle

A plan grants a total storage allowance and a duration. It does not grant a per-file limit, but we may cap the size of a single upload for operational reasons. When your used bytes reach the allowance, uploads are blocked until you delete blobs or upgrade.

After your plan expires, your data goes through these stages:

1. Grace period: reads and deletes work, uploads are blocked.
2. Write blocked: reads and deletes still work, uploads stay blocked.
3. Read blocked: reads are blocked, deletes still work.
4. Closed: the data is eligible for purge.

The current periods are 7 days of grace, 30 days of uploads blocked, and 30 days of reads blocked. We may change these periods. The published lifecycle configuration is the authoritative source for the current timings.

Purge is a separate operator action. It may be delayed, disabled, or fail. We do not guarantee that your data will be kept for any period or deleted at any particular time. You must renew before the end of the read-blocked period if you want to keep your data. Even then, no copy is guaranteed to survive.

Deleting a blob is permanent. Because blobs are content-addressed, a deleted blob cannot be recovered, and if no other account owns the same content the bytes are removed from the storage providers. If another account has uploaded the same content, that account keeps its own copy and its own access.

## 7. Your content and license

You keep ownership of the blobs you upload. You grant us a worldwide, non-exclusive, royalty-free license to store, copy, replicate, transmit, and serve your blobs as needed to run the Service and enforce your plan. This includes copying blobs to storage providers and delivering them to anyone who requests them by hash. The license ends when you delete a blob, except for copies that another account owns and copies that remain in backups or provider systems for a limited time.

You confirm that you own or have the rights to everything you upload, and that uploading it and granting this license does not violate anyone's rights or the law.

## 8. Acceptable use

You must not upload, store, or share:

- content that is illegal where you live or where the Service is operated;
- child sexual abuse material, or any sexual content involving a minor or a person who appears to be a minor, including drawn, animated, or AI-generated material;
- non-consensual intimate images;
- malware, phishing pages, or code intended to harm or gain unauthorized access to systems;
- material that infringes copyright, trademark, or other rights;
- content that is defamatory, fraudulent, or part of a scam;
- spam or content whose main purpose is to abuse the Service.

You must not:

- try to bypass the storage allowance, authentication, rate limits, or lifecycle enforcement;
- use the Service to build a content delivery network for another site;
- resell or sublease storage without our written permission;
- probe, scan, overload, or disrupt the Service or another user's access;
- upload data you do not have the right to store.

We may remove content, block uploads, suspend access, or close the account if we believe these rules were broken. We may also report illegal content to the relevant authorities.

## 9. Moderation and copyright

We do not review every upload. We may review, scan, or remove content when we receive a report, detect abuse, or are required by law. When we remove a blob, we log the action and try to notify the owner with the reason. Notification is best-effort and may fail.

If you find content that breaks these terms, report it to hello@formstr.app with the hash and a short explanation.

If you believe your copyright has been infringed, send a notice to hello@formstr.app with the following: your contact details, identification of the work, the hash or exact location of the material, a statement that you have a good-faith belief the use is unauthorized, a statement that the information is accurate, and your signature. We may remove the material and notify the uploader. Accounts that repeatedly infringe may be terminated.

We may preserve and disclose content and related records when the law requires it, including for child-safety reports.

## 10. Availability and changes

The Service is provided on an as-is, as-available basis. We do not offer an SLA. We may perform maintenance, change the storage providers, change the lifecycle timings, or stop offering the Service at any time. We do not guarantee that any blob will be available, complete, or readable. This is a beta service; treat availability as best-effort.

We may change these terms. See section 14.

## 11. Disclaimer of warranties

To the maximum extent permitted by law, the Service is provided without warranties of any kind, whether express or implied, including warranties of merchantability, fitness for a particular purpose, title, non-infringement, accuracy, and uninterrupted or error-free operation. We do not warrant that the Service will be secure, that data will not be lost or corrupted, or that any defect will be fixed.

We are not liable for data loss. You are responsible for keeping independent copies of your data. This is a beta service and you use it at your own risk.

## 12. Limitation of liability

To the maximum extent permitted by law, we are not liable for indirect, incidental, special, consequential, or punitive damages, or for lost profits, revenue, goodwill, business, or data, even if we were advised that such damages were possible.

Our total liability for all claims relating to the Service is limited to the amount you paid us for the Service in the 12 months before the event giving rise to the claim. If the law does not allow part of this limit, our liability is limited to the smallest amount the law allows.

Nothing in these terms excludes liability that cannot be excluded by law.

## 13. Indemnity

You agree to defend and indemnify us, our operators, and our service providers against any claim, loss, liability, or cost, including reasonable legal fees, arising from your content, your use of the Service, your breach of these terms, or your violation of someone else's rights or the law.

## 14. Suspension, termination, and changes to these terms

We may suspend or terminate your access, remove blobs, or refuse service at any time if you break these terms, if your use creates a legal or security risk, if we discontinue the Service, or if we are required to do so by law. We may act without prior notice where necessary.

If your access ends, your data may be deleted under the lifecycle in section 6, or it may remain inaccessible for longer. We do not guarantee any recovery period. Payments are not refunded on termination except where the law requires it.

These terms are versioned. The version you accepted is recorded with your purchase. We may update the terms when the Service or the law changes. The current version is always published on this page. Continued use after a version change means you accept the new version. If you do not agree, stop using the Service and do not make further purchases.

## 15. Privacy

Our privacy policy explains what we store and how we use it. It forms part of these terms.

## 16. General

These terms are the entire agreement between you and us about the Service. If a provision is found unenforceable, the rest remains in effect. A failure to enforce a provision is not a waiver. You may not transfer your rights under these terms. We may transfer our rights and obligations as part of a reorganization, merger, or sale of the Service.

These terms are governed by the laws that apply to the operator of Formstr Storage. Before filing a claim, contact hello@formstr.app and give us 30 days to try to resolve the issue.

## 17. Contact

Questions, reports, and legal notices: hello@formstr.app.

By using the Service, you confirm that you have read and agree to these terms.
