import controls from "../styles/controls.module.css";
import { cx } from "../lib/cx";
import type { HostProfile } from "../hooks/useProfiles";
import styles from "./TopBar.module.css";

interface Props {
  profile: HostProfile | null;
  unlocked: boolean;
  onOpenProfiles: () => void;
  onLock: () => void;
}

export function TopBar({ profile, unlocked, onOpenProfiles, onLock }: Props) {
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

      <div className={styles.controls}>
        {profile ? (
          <button
            className={styles.hostPill}
            type="button"
            onClick={onOpenProfiles}
          >
            <span className={cx(controls.statusDot, unlocked && controls.online)} />
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
          <button className={styles.lockButton} type="button" onClick={onLock}>
            Lock
          </button>
        )}
      </div>
    </header>
  );
}
