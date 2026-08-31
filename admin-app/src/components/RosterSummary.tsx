import type { Roster } from "../platform/types";
import { formatBytes } from "../lib/storageFormat";
import { cx } from "../lib/cx";
import controls from "../styles/controls.module.css";
import styles from "./ControlPlane.module.css";

export function RosterSummary({ roster }: { roster: Roster | null }) {
  return (
    <section className={cx(styles.card, styles.roster)}>
      <p className={controls.eyebrow}>Roster overview</p>
      <div className={styles.statGrid}>
        <div className={styles.stat}>
          <strong>{roster?.members.authorized ?? "-"}</strong>
          <span>Authorized members</span>
          <small>{roster ? `${roster.members.admins} admins / ${roster.members.clients} clients / ${roster.members.revoked} revoked` : ""}</small>
        </div>
        <div className={cx(styles.stat, styles.statGreen)}>
          <strong>{roster?.storages.active ?? "-"}</strong>
          <span>Storages active</span>
          <small>{roster ? `${roster.storages.total} total` : ""}</small>
        </div>
        <div className={cx(styles.stat, styles.statWarm)}>
          <strong>{roster?.storages.pending ?? "-"}</strong>
          <span>Pending verification</span>
        </div>
        <div className={styles.stat}>
          <strong>{roster ? formatBytes(roster.storages.reportedFreeBytes) : "-"}</strong>
          <span>
            Reported free{roster ? ` of ${formatBytes(roster.storages.reportedTotalBytes)}` : ""}
          </span>
        </div>
      </div>
    </section>
  );
}
