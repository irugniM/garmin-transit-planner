import Toybox.Lang;

// Auto-refresh rules for an open trip screen (pure helpers, unit-tested in
// RefreshTest.mc):
// - re-plan as soon as the first USABLE fix is over ORIGIN_M from a plan
//   asked from a worse (e.g. stale last-known) position;
// - re-plan every PERIOD s; immediately when a USABLE fix is over MOVE_M from
//   where the shown plan was asked; never more often than every MIN_GAP s and
//   never with a request already in flight;
// - a fresh plan for the same bus (pts.k: route + scheduled departure) just
//   replaces the old one (new times, delays); a plan with a different
//   boarding stop or bus only wins if it arrives BETTER s earlier, or the shown
//   bus has already left. No "on the bus" state is ever assumed.
module Refresh {
    const PERIOD = 60;
    const MIN_GAP = 20;
    const MOVE_M = 50.0;
    const BETTER = 120;
    const ORIGIN_M = 25.0;

    function key(r) {
        if (r instanceof Dictionary && r["pts"] instanceof Dictionary) {
            var k = (r["pts"] as Dictionary)["k"];
            return k instanceof String ? k : null;
        }
        return null;
    }

    function stop(r) {
        if (r instanceof Dictionary && r["pts"] instanceof Dictionary) {
            var s = (r["pts"] as Dictionary)["s"];
            if (s instanceof Array && s.size() == 2) {
                return s;
            }
        }
        return null;
    }

    function sameStop(a, b) as Boolean {
        if (a == null || b == null) {
            return a == null && b == null;
        }
        return a[0].toDouble() == b[0].toDouble() && a[1].toDouble() == b[1].toDouble();
    }

    // True: keep showing cur and ignore fresh (an automatic re-plan only).
    function keep(cur, fresh, now as Number) as Boolean {
        if (!(cur instanceof Dictionary) || !(fresh instanceof Dictionary)) {
            return false;
        }
        var ck = key(cur);
        var fk = key(fresh);
        if (ck == null && fk == null) {
            return false;  // walk-only / "You're here" both: take the new one
        }
        if (ck != null && fk != null && ck.equals(fk) && sameStop(stop(cur), stop(fresh))) {
            return false;  // same bus from the same stop: new times
        }
        // The shown bus has left: it can't be caught any more.
        var pts = cur["pts"];
        if (ck != null && pts instanceof Dictionary && pts["t"] instanceof Number && (pts["t"] as Number) < now) {
            return false;
        }
        var ca = cur["arr"];
        var fa = fresh["arr"];
        if (!(ca instanceof Number) || !(fa instanceof Number)) {
            return false;
        }
        return fa > ca - BETTER;
    }

    // May an automatic request go out now?
    function free(now as Number, lastSend as Number, busy as Boolean) as Boolean {
        return !busy && now - lastSend >= MIN_GAP;
    }

    function due(now as Number, lastSend as Number, busy as Boolean) as Boolean {
        return !busy && now - lastSend >= PERIOD;
    }

    function movedFar(metres as Float) as Boolean {
        return metres > MOVE_M;
    }

    // A plan asked from a below-USABLE position vs the first USABLE fix.
    function badOrigin(metres as Float) as Boolean {
        return metres > ORIGIN_M;
    }
}
