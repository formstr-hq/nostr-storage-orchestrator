import { useEffect, useState, type FormEvent } from "react";

import { client } from "#platform";
import { cx } from "../lib/cx";
import {
  bytesToGbInput,
  formatBytes,
  gbToBytes,
  percent,
  relativeTime,
  sumBytes,
} from "../lib/storageFormat";
import type { BusyKind, Storage } from "../platform/types";
import controls from "../styles/controls.module.css";
import { ConfirmationDialog } from "./ConfirmationDialog";
import styles from "./ControlPlane.module.css";

function storageState(storage: Storage) {
  if (storage.lifecycle === "removed") return { label: "Removed", chip: controls.unreachable, dot: controls.off };
  if (storage.liveness === "active") return { label: "Active", chip: controls.active, dot: controls.online };
  if (storage.liveness === "pending") return { label: "Pending verification", chip: controls.pending, dot: controls.warn };
  return { label: "Unreachable", chip: controls.unreachable, dot: controls.off };
}

function StorageRow({
  storage,
  busy,
  onCapacity,
  onRemove,
}: {
  storage: Storage;
  busy: BusyKind | null;
  onCapacity: (npub: string, bytes: string) => Promise<boolean>;
  onRemove: (storage: Storage) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [capacity, setCapacity] = useState(bytesToGbInput(storage.declaredCapacityBytes));
  const exactBytes = gbToBytes(capacity);
  const state = storageState(storage);
  const freePct = percent(storage.reportedFreeBytes, storage.declaredCapacityBytes ?? storage.reportedTotalBytes);

  useEffect(() => {
    setCapacity(bytesToGbInput(storage.declaredCapacityBytes));
  }, [storage.declaredCapacityBytes]);

  async function save() {
    if (exactBytes && await onCapacity(storage.npub, exactBytes)) setEditing(false);
  }

  const meta = storage.lastPingAt
    ? [
        storage.tunnelIp,
        storage.blossomPort === null ? null : `blossom :${storage.blossomPort}`,
        storage.relayPort === null ? null : `relay :${storage.relayPort}`,
        `pinged ${relativeTime(storage.lastPingAt)}`,
      ].filter(Boolean).join(" / ")
    : `linked ${relativeTime(storage.createdAt)} / no ping received yet - is storage-agent running?`;

  return (
    <li className={styles.storageRow}>
      <span className={cx(controls.statusDot, state.dot)} />
      <div className={styles.rowId}><strong>{storage.npub}</strong><span>{meta}</span></div>
      <div className={styles.capacity}>
        {editing ? (
          <div className={styles.capEdit}>
            <input aria-label="Declared capacity in GB" type="text" inputMode="decimal" value={capacity} onChange={(event) => setCapacity(event.target.value)} />
            <span>GB</span>
            <button className={cx(controls.secondary, controls.small)} type="button" disabled={!exactBytes || busy !== null} onClick={() => void save()}>
              {busy === "storage-capacity" ? <span className={controls.spinner} /> : "Save"}
            </button>
          </div>
        ) : (
          <>
            <strong>{formatBytes(storage.reportedFreeBytes)} free</strong>
            <div className={styles.barTrack}><div className={cx(styles.barFill, freePct < 15 && styles.warn)} style={{ width: `${freePct}%` }} /></div>
            <small>cap {formatBytes(storage.declaredCapacityBytes)} / disk {formatBytes(storage.reportedTotalBytes)}</small>
            {storage.lifecycle === "linked" && <button className={cx(controls.textButton, controls.edit)} type="button" disabled={busy !== null} onClick={() => setEditing(true)}>Edit cap</button>}
          </>
        )}
      </div>
      <div className={styles.rowActions}>
        <span className={cx(controls.chip, state.chip)}>{state.label}</span>
        {storage.lifecycle === "linked" && (
          <button className={cx(controls.textButton, controls.danger, styles.removeButton)} type="button" disabled={busy !== null} onClick={() => onRemove(storage)}>Remove</button>
        )}
      </div>
    </li>
  );
}

interface Props {
  storages: Storage[];
  busy: BusyKind | null;
  onRequestInvite: () => void;
  onLink: (npub: string) => Promise<boolean>;
  onCapacity: (npub: string, bytes: string) => Promise<boolean>;
  onRemove: (npub: string) => Promise<boolean>;
}

export function ClientStorage({ storages, busy, onRequestInvite, onLink, onCapacity, onRemove }: Props) {
  const [npub, setNpub] = useState("");
  const [canonical, setCanonical] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Storage | null>(null);

  useEffect(() => {
    let current = true;
    setCanonical(null);
    if (!npub.trim()) return () => { current = false; };
    void client.canonicalNpub(npub).then(
      (value) => { if (current) setCanonical(value); },
      () => { if (current) setCanonical(null); },
    );
    return () => { current = false; };
  }, [npub]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (canonical && await onLink(canonical)) setNpub("");
  }

  async function confirmRemove() {
    if (removing && await onRemove(removing.npub)) setRemoving(null);
  }

  const linked = storages.filter((storage) => storage.lifecycle === "linked");
  const declared = sumBytes(linked.map((storage) => storage.declaredCapacityBytes));
  const total = sumBytes(linked.map((storage) => storage.reportedTotalBytes));
  const free = sumBytes(linked.map((storage) => storage.reportedFreeBytes));
  const used = total > free ? total - free : 0n;
  const latestPing = linked.reduce<string | null>((latest, storage) => {
    if (!storage.lastPingAt) return latest;
    return !latest || storage.lastPingAt > latest ? storage.lastPingAt : latest;
  }, null);
  const aggregateState = linked.some((storage) => storage.liveness === "active")
    ? { label: "Active", chip: controls.active }
    : linked.some((storage) => storage.liveness === "pending")
      ? { label: "Pending verification", chip: controls.pending }
      : { label: linked.length ? "Unreachable" : "No nodes", chip: controls.unreachable };

  return (
    <>
      <main className={styles.dashboard}>
        <section className={cx(styles.card, styles.myStorage)}>
          <div className={styles.msTop}>
            <div className={styles.msTitle}>
              <p className={controls.eyebrow}>My storage</p>
              <strong>{formatBytes(declared)}</strong>
              <p>{linked.length} storage node{linked.length === 1 ? "" : "s"} / reporting every 5 minutes</p>
            </div>
            <span className={cx(controls.chip, aggregateState.chip)}>{aggregateState.label}</span>
          </div>
          <div className={styles.gauge}>
            <div className={styles.gaugeLabels}><span>Reported in use <strong>{formatBytes(used)}</strong></span><span>Reported free <strong>{formatBytes(free)}</strong></span></div>
            <div className={styles.gaugeTrack}><div className={styles.gaugeFill} style={{ width: `${percent(used, total)}%` }} /></div>
            <div className={styles.gaugeMeta}><span>Declared cap {formatBytes(declared)}</span><span>Last reported {relativeTime(latestPing)}</span></div>
          </div>
        </section>

        <section className={styles.row2}>
          <article className={cx(styles.card, styles.operation)}>
            <p className={controls.eyebrow}>Enrollment / step 1</p>
            <h2>Request invite</h2>
            <p>Generate a self-sufficient bootstrap credential for a new storage machine. Take the invite to that machine and run its join script; no separate host metadata is required. The script prints that machine&apos;s own npub.</p>
            <button className={cx(controls.primary, controls.warm, styles.fullWidth)} type="button" disabled={busy !== null} onClick={onRequestInvite}>
              {busy === "invite" ? <><span className={controls.spinner} /> Requesting</> : "Request invite"}
            </button>
          </article>

          <article className={cx(styles.card, styles.operation)}>
            <p className={controls.eyebrow}>Enrollment / step 2</p>
            <h2>Link a storage</h2>
            <p>Paste the npub printed by your storage machine. This action approves it on the mesh and links it to your roster; the invite alone does not.</p>
            <form onSubmit={(event) => void submit(event)}>
              <label htmlFor="link-storage-npub">Storage npub</label>
              <div className={styles.formRow}>
                <input id="link-storage-npub" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="npub1..." value={npub} onChange={(event) => setNpub(event.target.value)} />
                <button className={controls.secondary} type="submit" disabled={!canonical || busy !== null}>
                  {busy === "storage-link" ? <><span className={controls.spinner} /> Linking</> : "Link"}
                </button>
              </div>
            </form>
          </article>
        </section>

        <section className={cx(styles.card, styles.list)}>
          <div className={styles.heading}><div><p className={controls.eyebrow}>Your nodes</p><h2>Storage</h2></div><span>{storages.length} total</span></div>
          <ul className={styles.rows}>
            {storages.length ? storages.map((storage) => <StorageRow key={storage.npub} storage={storage} busy={busy} onCapacity={onCapacity} onRemove={setRemoving} />) : (
              <li className={styles.emptyRow}><span>No storage linked yet</span><small>Request an invite, bootstrap a machine, then link its npub.</small></li>
            )}
          </ul>
        </section>
      </main>

      {removing && (
        <ConfirmationDialog id="owner-remove-title" eyebrow="Your storage" title="Remove this storage?" busy={busy === "storage-remove"} action="Remove my storage" busyAction="Removing" onConfirm={() => void confirmRemove()} onClose={() => setRemoving(null)}>
          <p className={styles.dialogText}><code>{removing.npub}</code> will be unlinked from your account.</p>
          <div className={styles.note}><strong>This node is removed from the mesh.</strong><span>Proxies stop routing to it, and replicas that exist only on this node may become unreachable. You can link this storage identity again later.</span></div>
        </ConfirmationDialog>
      )}
    </>
  );
}
