---
version: 2026-10-01
---

# Privacy Policy

## 1. What we store

Your public key (npub), the blobs you upload and their sha256 hashes, the byte size and upload time of each blob, your plan entitlement dates, and a record of which notifications were sent to you. We do not store payment amounts, invoices, or payment hashes — those live only in our billing system.

## 2. Why we store it

To serve your blobs, enforce your storage allowance and plan duration, notify you before expiry or purge, and satisfy legal obligations. The lawful basis is contract performance.

## 3. Sharing

Blobs are served to anyone who knows their hash, by the nature of the protocol. Blob metadata (hash, size, owner npub) is visible to operators. We do not sell data. Notifications are delivered over Nostr DMs and email through our mail service.

## 4. Retention

After your plan expires we follow a published lifecycle: a grace period, then uploads are blocked, then reads are blocked, and finally your blobs are purged. You can delete blobs at any time from your dashboard.

## 5. Your choices

You can delete any blob at any time, stop using the service, or request closure. Because blobs are content-addressed, a deleted blob cannot be recovered.
