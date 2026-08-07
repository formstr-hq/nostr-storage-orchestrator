import { useState, type FormEvent } from "react";

import controls from "../styles/controls.module.css";
import { cx } from "../lib/cx";
import type { BusyKind, HostStatus, Peer } from "../platform/types";
import styles from "./Dashboard.module.css";

interface Props {
  status: HostStatus | null;
  busy: BusyKind | null;
  onRefresh: () => void;
  onGenerateInvite: () => void;
  onApproveDevice: (npub: string) => Promise<boolean>;
  onRemoveDevice: (npub: string) => void;
  onCopy: (value: string) => void;
}

function PeerRow({
  peer,
  busy,
  onCopy,
  onRemove,
}: {
  peer: Peer;
  busy: boolean;
  onCopy: (value: string) => void;
  onRemove: (npub: string) => void;
}) {
  return (
    <li className={styles.peerRow}>
      <span
        className={cx(
          controls.statusDot,
          peer.connected ? controls.online : styles.offline,
        )}
      />
      <div className={styles.peerId}>
        <strong>{peer.npub}</strong>
        <span>
          {peer.tunnelIp ? `Tunnel IP ${peer.tunnelIp}` : "Tunnel IP pending"}
        </span>
        <button
          className={cx(controls.textButton, styles.copyNpub)}
          type="button"
          onClick={() => onCopy(peer.npub)}
        >
          Copy npub
        </button>
      </div>
      <div className={styles.peerActions}>
        <span className={styles.peerLabel}>
          {peer.connected ? "Reachable" : "Offline"}
        </span>
        <button
          className={cx(controls.textButton, controls.danger, styles.removeButton)}
          type="button"
          disabled={busy}
          onClick={() => onRemove(peer.npub)}
        >
          Remove
        </button>
      </div>
    </li>
  );
}

export function Dashboard({
  status,
  busy,
  onRefresh,
  onGenerateInvite,
  onApproveDevice,
  onRemoveDevice,
  onCopy,
}: Props) {
  const [npub, setNpub] = useState("");
  const peers = status?.peers ?? [];
  const disabled = busy !== null;

  async function submitDevice(event: FormEvent) {
    event.preventDefault();
    if (await onApproveDevice(npub)) setNpub("");
  }

  return (
    <main className={styles.dashboard}>
      <section className={cx(styles.card, styles.summary)}>
        <div>
          <p className={controls.eyebrow}>Live mesh</p>
          <div className={styles.count}>
            <strong>{status ? status.connectedCount : "-"}</strong>
            <span>
              connected
              <br />
              devices
            </span>
          </div>
        </div>

        <div className={styles.mesh} aria-hidden="true">
          <i />
          <i />
          <i />
          <span />
        </div>

        <button
          className={styles.refresh}
          type="button"
          aria-label="Refresh status"
          title="Refresh status"
          disabled={disabled}
          onClick={onRefresh}
        >
          <span
            className={cx(styles.refreshIcon, busy === "status" && styles.spinning)}
          />
        </button>
      </section>

      <section className={styles.operations}>
        <article className={cx(styles.card, styles.operation)}>
          <p className={controls.eyebrow}>Enrollment / 01</p>
          <h2>Issue an invite</h2>
          <p>Generate the host bootstrap credential for a new storage node.</p>
          <button
            className={cx(controls.primary, controls.warm, styles.fullWidth)}
            type="button"
            disabled={disabled}
            onClick={onGenerateInvite}
          >
            {busy === "invite" ? (
              <>
                <span className={controls.spinner} /> Generating
              </>
            ) : (
              "Generate invite"
            )}
          </button>
        </article>

        <article className={cx(styles.card, styles.operation)}>
          <p className={controls.eyebrow}>Approval / 02</p>
          <h2>Add a device</h2>
          <p>Approve the npub shown by the node after it imports the invite.</p>
          <form onSubmit={submitDevice}>
            <label className={controls.srOnly} htmlFor="device-npub">
              Device npub
            </label>
            <input
              id="device-npub"
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="npub1..."
              required
              value={npub}
              onChange={(event) => setNpub(event.target.value)}
            />
            <button className={controls.secondary} type="submit" disabled={disabled}>
              {busy === "device" ? (
                <>
                  <span className={controls.spinner} /> Approving
                </>
              ) : (
                "Approve device"
              )}
            </button>
          </form>
        </article>
      </section>

      <section className={cx(styles.card, styles.peers)}>
        <div className={styles.heading}>
          <div>
            <p className={controls.eyebrow}>Network roster</p>
            <h2>Peers</h2>
          </div>
          <span>{peers.length} total</span>
        </div>

        <ul className={styles.peerList}>
          {peers.length ? (
            peers.map((peer) => (
              <PeerRow
                key={peer.npub}
                peer={peer}
                busy={busy === "device-remove"}
                onCopy={onCopy}
                onRemove={onRemoveDevice}
              />
            ))
          ) : (
            <li className={styles.emptyRow}>
              <span>No approved devices yet</span>
              <small>Create an invite, then approve the device npub.</small>
            </li>
          )}
        </ul>
      </section>
    </main>
  );
}
