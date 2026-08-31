import controls from "../styles/controls.module.css";
import { cx } from "../lib/cx";
import type { HostProfile } from "../hooks/useProfiles";
import type { Role } from "../platform/types";
import styles from "./TopBar.module.css";

interface Props {
  profile: HostProfile | null;
  unlocked: boolean;
  role: Role | null;
  view: "admin" | "storage";
  onViewChange: (view: "admin" | "storage") => void;
  refreshing: boolean;
  refreshDisabled: boolean;
  onRefresh: () => void;
  onOpenProfiles: () => void;
  onLock: () => void;
}

export function TopBar({ profile, unlocked, role, view, onViewChange, refreshing, refreshDisabled, onRefresh, onOpenProfiles, onLock }: Props) {
  return (
    <header className={styles.topbar}>
      <div className={styles.brand}>
        <span className={styles.cube}>
          <i />
        </span>
        <div className={styles.brandText}>
          <strong>FORMSTR</strong>
          <small>Storage control</small>
        </div>
      </div>

      {unlocked && role === "admin" && (
        <div className={styles.viewTabs} role="group" aria-label="View">
          <button type="button" className={view === "admin" ? styles.active : undefined} onClick={() => onViewChange("admin")}>Admin</button>
          <button type="button" className={view === "storage" ? styles.active : undefined} onClick={() => onViewChange("storage")}>My storage</button>
        </div>
      )}

      <div className={styles.controls}>
        {profile ? (
          <button
            className={styles.hostPill}
            type="button"
            onClick={onOpenProfiles}
          >
            <span className={cx(controls.statusDot, unlocked && role !== "none" && controls.online, role === "none" && controls.off)} />
            <span className={styles.hostLabel}>
              <strong>{profile.name}</strong>
              <small>{profile.url.replace(/^https:\/\//, "")}</small>
            </span>
            <i className={styles.chevron} />
          </button>
        ) : (
          <button
            className={cx(styles.hostPill, styles.empty)}
            type="button"
            onClick={onOpenProfiles}
          >
            Add host
          </button>
        )}

        {unlocked && (
          <>
            <button className={styles.lockButton} type="button" disabled={refreshDisabled} onClick={onRefresh}>{refreshing ? "Refreshing" : "Refresh"}</button>
            <button className={styles.lockButton} type="button" onClick={onLock}>Lock</button>
          </>
        )}
      </div>
    </header>
  );
}
