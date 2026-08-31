import controls from "../styles/controls.module.css";
import type { HostProfile } from "../hooks/useProfiles";
import styles from "./ControlPlane.module.css";

export function Unauthorized({ profile }: { profile: HostProfile | null }) {
  const host = profile?.url.replace(/^https:\/\//, "") ?? "this host";
  return (
    <section className={styles.unauthorized}>
      <div className={styles.emptyMark} />
      <p className={controls.eyebrow}>Session locked out</p>
      <h1>Not authorized on this host.</h1>
      <p>
        This key is not on {host}&apos;s roster. Ask an admin to authorize your
        npub, or switch to a host profile you already have access to.
      </p>
    </section>
  );
}
