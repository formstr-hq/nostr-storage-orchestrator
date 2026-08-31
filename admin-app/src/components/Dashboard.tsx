import { useState, type FormEvent } from "react";

import { client } from "#platform";
import { cx } from "../lib/cx";
import type {
  BusyKind,
  HostStatus,
  Member,
  MemberRole,
  Roster,
  Storage,
} from "../platform/types";
import controls from "../styles/controls.module.css";
import { Dialog, dialogStyles } from "./Dialog";
import { MemberList } from "./MemberList";
import { RosterSummary } from "./RosterSummary";
import { StorageList } from "./StorageList";
import styles from "./ControlPlane.module.css";

interface Props {
  selfNpub: string;
  roster: Roster | null;
  members: Member[];
  storages: Storage[];
  status: HostStatus | null;
  busy: BusyKind | null;
  onAuthorize: (npub: string, role: MemberRole) => Promise<boolean>;
  onRevoke: (npub: string) => Promise<boolean>;
  onRemoveStorage: (npub: string) => Promise<boolean>;
  onValidationError: (message: string) => void;
}

export function Dashboard({
  selfNpub,
  roster,
  members,
  storages,
  status,
  busy,
  onAuthorize,
  onRevoke,
  onRemoveStorage,
  onValidationError,
}: Props) {
  const [npub, setNpub] = useState("");
  const [authorizing, setAuthorizing] = useState<string | null>(null);
  const [role, setRole] = useState<MemberRole>("client");

  async function openAuthorize(event: FormEvent) {
    event.preventDefault();
    try {
      setAuthorizing(await client.canonicalNpub(npub));
      setRole("client");
    } catch (error) {
      onValidationError(error instanceof Error ? error.message : "Enter a valid Nostr npub");
    }
  }

  async function authorize() {
    if (!authorizing) return;
    if (await onAuthorize(authorizing, role)) {
      setAuthorizing(null);
      setNpub("");
    }
  }

  const peerStorages = new Map(storages.map((storage) => [storage.npub, storage]));
  const active = roster?.storages.active ?? 0;
  const required = roster?.replicaCountRequired ?? 0;
  const available = roster
    ? Math.max(required, roster.storages.active + roster.storages.pending + roster.storages.unreachable)
    : 0;
  const headroomWidth = available ? Math.min(100, Math.round(active / available * 100)) : 0;

  return (
    <>
      <main className={styles.dashboard}>
        <RosterSummary roster={roster} />

        <section className={styles.row2}>
          <article className={cx(styles.card, styles.operation)}>
            <p className={controls.eyebrow}>Membership</p>
            <h2>Authorize a client</h2>
            <p>Grant an npub membership on this host. Requesting an invite, bootstrapping a machine, and linking its storage are then entirely theirs to do.</p>
            <form onSubmit={(event) => void openAuthorize(event)}>
              <label htmlFor="authorize-npub">Member npub</label>
              <div className={styles.formRow}>
                <input id="authorize-npub" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="npub1..." value={npub} onChange={(event) => setNpub(event.target.value)} />
                <button className={controls.secondary} type="submit" disabled={!npub.trim() || busy !== null}>Authorize</button>
              </div>
            </form>
          </article>

          <article className={cx(styles.card, styles.operation)}>
            <p className={controls.eyebrow}>Capacity health</p>
            <h2>Replica headroom</h2>
            <p>{active} active storage{active === 1 ? "" : "s"} against a largest plan replica count of {required}. Uploads fail rather than under-replicate when active storage falls below that minimum.</p>
            <div className={styles.gauge}>
              <div className={styles.gaugeLabels}><span>Active <strong>{active}</strong></span><span>Minimum <strong>{required}</strong></span></div>
              <div className={styles.gaugeTrack}><div className={cx(styles.gaugeFill, roster?.replicaShortfall && styles.warn)} style={{ width: `${headroomWidth}%` }} /></div>
              <div className={styles.gaugeMeta}><span>{roster?.storages.pending ?? 0} pending verification</span><span>{roster?.storages.unreachable ?? 0} unreachable</span></div>
            </div>
          </article>
        </section>

        <MemberList members={members} selfNpub={selfNpub} busy={busy} onAuthorize={onAuthorize} onRevoke={onRevoke} />
        <StorageList storages={storages} busy={busy} onRemove={onRemoveStorage} />

        <section className={cx(styles.card, styles.list)}>
          <div className={styles.heading}><div><p className={controls.eyebrow}>Network roster / read-only</p><h2>Peers</h2></div><span>{status?.peers.length ?? 0} total</span></div>
          <ul className={styles.rows}>
            {status?.peers.length ? status.peers.map((peer) => {
              const linked = peerStorages.get(peer.npub);
              return (
                <li className={styles.memberRow} key={peer.npub}>
                  <span className={cx(controls.statusDot, peer.connected ? controls.online : controls.off)} />
                  <div className={styles.rowId}>
                    <strong>{peer.npub}</strong>
                    <span>{peer.tunnelIp ? `Tunnel IP ${peer.tunnelIp}` : "Tunnel IP pending"} / {linked ? `linked storage owned by ${linked.ownerNpub}` : "no matching storage row - removable only at the host CLI"}</span>
                  </div>
                  <span className={cx(controls.chip, peer.connected ? controls.active : controls.unreachable)}>{peer.connected ? "Reachable" : "Offline"}</span>
                </li>
              );
            }) : <li className={styles.emptyRow}><span>No mesh peers returned</span></li>}
          </ul>
        </section>
      </main>

      {authorizing && (
        <Dialog labelledBy="authorize-title" onClose={busy === "member-authorize" ? undefined : () => setAuthorizing(null)}>
          <div className={dialogStyles.heading}>
            <div><p className={controls.eyebrow}>Member roster</p><h2 id="authorize-title">Authorize a member</h2></div>
            <button className={dialogStyles.close} type="button" disabled={busy === "member-authorize"} onClick={() => setAuthorizing(null)} aria-label="Close">&times;</button>
          </div>
          <div className={styles.dialogForm}>
            <label>Member npub<input type="text" readOnly value={authorizing} /></label>
            <div className={styles.roleSwitch} role="group" aria-label="Role">
              <button type="button" className={role === "client" ? styles.active : undefined} onClick={() => setRole("client")}>Client</button>
              <button type="button" className={role === "admin" ? styles.active : undefined} onClick={() => setRole("admin")}>Admin</button>
            </div>
            <div className={styles.note}><strong>This grants membership only - nothing about storage.</strong><span>Once authorized, they request their own invite, bootstrap a storage machine, and link that machine&apos;s npub themselves. Admin membership does not grant NVPN mesh co-admin rights.</span></div>
            <button className={controls.primary} type="button" disabled={busy !== null} onClick={() => void authorize()}>
              {busy === "member-authorize" ? <><span className={controls.spinner} /> Authorizing</> : `Authorize ${role}`}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
