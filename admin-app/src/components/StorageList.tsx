import { useState } from "react";

import { cx } from "../lib/cx";
import { formatBytes, percent, relativeTime } from "../lib/storageFormat";
import type { BusyKind, Storage } from "../platform/types";
import controls from "../styles/controls.module.css";
import { ConfirmationDialog } from "./ConfirmationDialog";
import styles from "./ControlPlane.module.css";

function presentation(storage: Storage) {
  if (storage.lifecycle === "removed") {
    return { label: "Removed", chip: controls.unreachable, dot: controls.off };
  }
  if (storage.liveness === "active") {
    return { label: "Active", chip: controls.active, dot: controls.online };
  }
  if (storage.liveness === "pending") {
    return { label: "Pending verification", chip: controls.pending, dot: controls.warn };
  }
  return { label: "Unreachable", chip: controls.unreachable, dot: controls.off };
}

function networkMeta(storage: Storage): string {
  if (storage.lastPingAt === null) return `linked ${relativeTime(storage.createdAt)} / no ping received yet`;
  const network = [
    storage.tunnelIp,
    storage.blossomPort === null ? null : `blossom :${storage.blossomPort}`,
    storage.relayPort === null ? null : `relay :${storage.relayPort}`,
  ].filter(Boolean).join(" / ");
  return `${network}${network ? " / " : ""}last reported ${relativeTime(storage.lastPingAt)}`;
}

interface Props {
  storages: Storage[];
  busy: BusyKind | null;
  onRemove: (npub: string) => Promise<boolean>;
}

export function StorageList({ storages, busy, onRemove }: Props) {
  const [removing, setRemoving] = useState<Storage | null>(null);

  async function confirmRemove() {
    if (removing && await onRemove(removing.npub)) setRemoving(null);
  }

  return (
    <>
      <section className={cx(styles.card, styles.list)}>
        <div className={styles.heading}>
          <div><p className={controls.eyebrow}>Storage roster / all members</p><h2>Storages</h2></div>
          <span>{storages.length} total</span>
        </div>
        <ul className={styles.rows}>
          {storages.length ? storages.map((storage) => {
            const state = presentation(storage);
            const freePct = percent(storage.reportedFreeBytes, storage.declaredCapacityBytes ?? storage.reportedTotalBytes);
            return (
              <li className={styles.storageRow} key={storage.npub}>
                <span className={cx(controls.statusDot, state.dot)} />
                <div className={styles.rowId}>
                  <strong>{storage.npub}</strong>
                  <span>owner {storage.ownerNpub} / {networkMeta(storage)}</span>
                </div>
                <div className={styles.capacity}>
                  <strong>{formatBytes(storage.reportedFreeBytes)} free</strong>
                  <div className={styles.barTrack}><div className={cx(styles.barFill, freePct < 15 && styles.warn)} style={{ width: `${freePct}%` }} /></div>
                  <small>cap {formatBytes(storage.declaredCapacityBytes)} / disk {formatBytes(storage.reportedTotalBytes)}</small>
                </div>
                <div className={styles.rowActions}>
                  <span className={cx(controls.chip, state.chip)}>{state.label}</span>
                  {storage.lifecycle === "linked" && (
                    <button className={cx(controls.textButton, controls.danger, styles.removeButton)} type="button" disabled={busy !== null} onClick={() => setRemoving(storage)}>
                      Remove
                    </button>
                  )}
                </div>
              </li>
            );
          }) : (
            <li className={styles.emptyRow}><span>No storage has been linked</span></li>
          )}
        </ul>
      </section>

      {removing && (
        <ConfirmationDialog
          id="remove-storage-title"
          eyebrow="Storage roster"
          title="Remove this storage?"
          busy={busy === "storage-remove"}
          action="Remove storage"
          busyAction="Removing"
          onConfirm={() => void confirmRemove()}
          onClose={() => setRemoving(null)}
        >
          <p className={styles.dialogText}><code>{removing.npub}</code> is owned by <code>{removing.ownerNpub}</code>.</p>
          <div className={styles.note}>
            <strong>This node is removed from the mesh immediately.</strong>
            <span>It is marked removed and dropped from the NVPN roster. Proxies stop routing to it, and replicas that exist only on this node become unreachable. Storage cannot be reassigned to another member.</span>
          </div>
        </ConfirmationDialog>
      )}
    </>
  );
}
