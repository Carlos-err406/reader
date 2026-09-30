import { PULL_THRESHOLD } from "./usePullToSync";

interface Props {
  /** Current damped pull distance. */
  pull: number;
  /** A sync started by the pull is running. */
  syncing: boolean;
  top: string;
}

const RADIUS = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Material-style disc: the ring fills while pulling, then spins while the sync runs. */
export function PullIndicator({ pull, syncing, top }: Props) {
  const progress = Math.min(pull / PULL_THRESHOLD, 1);
  const armed = progress >= 1;
  const label = syncing ? "Syncing" : armed ? "Release to sync" : "Pull to sync";
  return (
    <div
      className={`pull ${syncing ? "syncing" : ""} ${armed ? "armed" : ""}`}
      style={{ top, opacity: syncing ? 1 : 0.35 + progress * 0.65 }}
      role="status"
      aria-label={label}
    >
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <circle
          className="pull-ring"
          cx="12"
          cy="12"
          r={RADIUS}
          strokeDasharray={syncing ? `${CIRCUMFERENCE * 0.3} ${CIRCUMFERENCE}` : `${CIRCUMFERENCE * progress * 0.85} ${CIRCUMFERENCE}`}
          style={syncing ? undefined : { transform: `rotate(${-90 + progress * 270}deg)` }}
        />
      </svg>
    </div>
  );
}
