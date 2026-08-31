import { useState } from "react";

import { cx } from "../lib/cx";
import { shortDate } from "../lib/storageFormat";
import type { BusyKind, Member, MemberRole } from "../platform/types";
import controls from "../styles/controls.module.css";
import { ConfirmationDialog } from "./ConfirmationDialog";
import styles from "./ControlPlane.module.css";

type Pending = { kind: "promote" | "reauthorize" | "revoke"; member: Member } | null;

interface Props {
  members: Member[];
  selfNpub: string;
  busy: BusyKind | null;
  onAuthorize: (npub: string, role: MemberRole) => Promise<boolean>;
  onRevoke: (npub: string) => Promise<boolean>;
}

export function MemberList({ members, selfNpub, busy, onAuthorize, onRevoke }: Props) {
  const [pending, setPending] = useState<Pending>(null);

  async function confirm() {
    if (!pending) return;
    const ok = pending.kind === "revoke"
      ? await onRevoke(pending.member.npub)
      : await onAuthorize(
          pending.member.npub,
          pending.kind === "promote" ? "admin" : pending.member.role,
        );
    if (ok) setPending(null);
  }

  return (
    <>
      <section className={cx(styles.card, styles.list)}>
        <div className={styles.heading}>
          <div>
            <p className={controls.eyebrow}>Membership / admins and clients</p>
            <h2>Members</h2>
          </div>
          <span>{members.length} total</span>
        </div>
        <ul className={styles.rows}>
          {members.length ? members.map((member) => {
            const self = member.npub === selfNpub;
            const active = member.status === "active";
            return (
              <li className={styles.memberRow} key={member.npub}>
                <span className={cx(controls.statusDot, active ? controls.online : controls.off)} />
                <div className={styles.rowId}>
                  <strong>{member.npub}{self ? " (you)" : ""}</strong>
                  <span>
                    {active ? member.role === "admin" ? "Admin" : "Client" : "Revoked"} since {shortDate(member.createdAt)} / {member.storageCount} storage{member.storageCount === 1 ? "" : "s"}
                    {member.addedByNpub ? ` / authorized by ${member.addedByNpub === selfNpub ? "you" : member.addedByNpub}` : ""}
                  </span>
                </div>
                <div className={styles.rowActions}>
                  <span className={cx(controls.chip, controls.role)}>{member.role}</span>
                  <span className={cx(controls.chip, active ? controls.active : controls.unreachable)}>{member.status}</span>
                  {active && member.role === "client" && (
                    <button className={cx(controls.textButton, controls.edit)} type="button" disabled={busy !== null} onClick={() => setPending({ kind: "promote", member })}>
                      Promote to admin
                    </button>
                  )}
                  {active && !self && (
                    <button className={cx(controls.textButton, controls.danger, styles.removeButton)} type="button" disabled={busy !== null} onClick={() => setPending({ kind: "revoke", member })}>
                      Revoke
                    </button>
                  )}
                  {!active && (
                    <button className={cx(controls.textButton, controls.edit)} type="button" disabled={busy !== null} onClick={() => setPending({ kind: "reauthorize", member })}>
                      Re-authorize
                    </button>
                  )}
                </div>
              </li>
            );
          }) : (
            <li className={styles.emptyRow}><span>No members returned</span></li>
          )}
        </ul>
      </section>

      {pending && (
        <ConfirmationDialog
          id="member-action-title"
          eyebrow="Member roster"
          title={pending.kind === "revoke" ? `Revoke this ${pending.member.role}?` : pending.kind === "promote" ? "Promote this client?" : `Re-authorize this ${pending.member.role}?`}
          busy={busy === (pending.kind === "revoke" ? "member-revoke" : "member-authorize")}
          action={pending.kind === "revoke" ? "Revoke member" : pending.kind === "promote" ? "Promote to admin" : `Re-authorize ${pending.member.role}`}
          busyAction={pending.kind === "revoke" ? "Revoking" : "Authorizing"}
          onConfirm={() => void confirm()}
          onClose={() => setPending(null)}
        >
          <p className={styles.dialogText}><code>{pending.member.npub}</code></p>
          {pending.kind === "revoke" ? (
            <div className={styles.note}>
              <strong>Their {pending.member.storageCount} storage{pending.member.storageCount === 1 ? " is" : "s are"} removed from the mesh too.</strong>
              <span>Each storage is marked removed and dropped from the NVPN roster. Proxies stop routing to those nodes, and blobs whose only replicas live there become unreachable. Re-authorizing this member later does not restore their storage; they must link it again themselves.</span>
            </div>
          ) : (
            <div className={styles.note}>
              <strong>{pending.kind === "promote" ? "Admin access includes roster management." : "This restores membership only."}</strong>
              <span>{pending.kind === "promote" ? "This does not grant NVPN mesh co-admin rights and does not change storage ownership." : "Removed storage is not restored automatically. They can link their own storage again from My storage."}</span>
            </div>
          )}
        </ConfirmationDialog>
      )}
    </>
  );
}
