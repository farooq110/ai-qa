/** Proportional pass / fail / running / queued bar for a run. */
export function SegBar({ passed, failed, total, running = 0 }: { passed: number; failed: number; total: number; running?: number }) {
  const rest = Math.max(0, total - passed - failed - running);
  if (!total) return <span className="segbar" aria-hidden><span className="s-skip" style={{ flexGrow: 1 }} /></span>;
  return (
    <span className="segbar" role="img" aria-label={`${passed} passed, ${failed} failed of ${total}`}>
      {passed > 0 && <span className="s-pass" style={{ flexGrow: passed }} />}
      {failed > 0 && <span className="s-fail" style={{ flexGrow: failed }} />}
      {running > 0 && <span className="s-run" style={{ flexGrow: running }} />}
      {rest > 0 && <span className="s-queue" style={{ flexGrow: rest }} />}
    </span>
  );
}
