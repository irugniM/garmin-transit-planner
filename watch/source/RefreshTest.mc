import Toybox.Lang;
import Toybox.Test;

// Unit tests for Refresh (monkeyc --unit-test, monkeydo -t). Made-up times
// and public coordinates only.
(:test)
module RefreshTest {
    const T = 1791460000;
    const STOP_A = [43.01017d, -81.27317d];
    const STOP_B = [43.00900d, -81.27000d];

    function trip(k, s, busAt as Number, arr as Number) as Dictionary {
        var pts = { "d" => [43.00129d, -81.27883d] };
        if (k != null) {
            pts["k"] = k;
            pts["s"] = s;
            pts["t"] = busAt;
        }
        return { "ok" => true, "arr" => arr, "lines" => ["x"], "pts" => pts };
    }
}

(:test)
function refreshSameTripTakesNewTimes(logger as Logger) as Boolean {
    var cur = RefreshTest.trip("13A@1791460600", RefreshTest.STOP_A, RefreshTest.T + 600, RefreshTest.T + 1500);
    // Same bus, 4 min late: arrival later, still replaces (delay shown).
    var fresh = RefreshTest.trip("13A@1791460600", RefreshTest.STOP_A, RefreshTest.T + 840, RefreshTest.T + 1740);
    return !Refresh.keep(cur, fresh, RefreshTest.T);
}

(:test)
function refreshOtherStopNeedsTwoMinutes(logger as Logger) as Boolean {
    var cur = RefreshTest.trip("13A@1791460600", RefreshTest.STOP_A, RefreshTest.T + 600, RefreshTest.T + 1500);
    var b90 = RefreshTest.trip("27@1791460500", RefreshTest.STOP_B, RefreshTest.T + 500, RefreshTest.T + 1410);
    var b120 = RefreshTest.trip("27@1791460500", RefreshTest.STOP_B, RefreshTest.T + 500, RefreshTest.T + 1380);
    var later = RefreshTest.trip("27@1791460500", RefreshTest.STOP_B, RefreshTest.T + 500, RefreshTest.T + 1600);
    return Refresh.keep(cur, b90, RefreshTest.T) && !Refresh.keep(cur, b120, RefreshTest.T) && Refresh.keep(cur, later, RefreshTest.T);
}

(:test)
function refreshSameBusOtherStopIsDifferent(logger as Logger) as Boolean {
    var cur = RefreshTest.trip("13A@1791460600", RefreshTest.STOP_A, RefreshTest.T + 600, RefreshTest.T + 1500);
    var fresh = RefreshTest.trip("13A@1791460600", RefreshTest.STOP_B, RefreshTest.T + 660, RefreshTest.T + 1500);
    return Refresh.keep(cur, fresh, RefreshTest.T);
}

(:test)
function refreshBusGoneSwitches(logger as Logger) as Boolean {
    var cur = RefreshTest.trip("13A@1791460600", RefreshTest.STOP_A, RefreshTest.T + 600, RefreshTest.T + 1500);
    var next = RefreshTest.trip("13A@1791461800", RefreshTest.STOP_A, RefreshTest.T + 1800, RefreshTest.T + 2700);
    // Before the shown bus leaves: kept. After: the next one wins. Leaving
    // the stop and coming back changes nothing (no "on the bus" guess).
    return Refresh.keep(cur, next, RefreshTest.T + 300) && !Refresh.keep(cur, next, RefreshTest.T + 601);
}

(:test)
function refreshWalkAndHere(logger as Logger) as Boolean {
    var bus = RefreshTest.trip("13A@1791460600", RefreshTest.STOP_A, RefreshTest.T + 600, RefreshTest.T + 1500);
    var walk = RefreshTest.trip(null, null, 0, RefreshTest.T + 1450);
    var walkFast = RefreshTest.trip(null, null, 0, RefreshTest.T + 1300);
    var here = RefreshTest.trip(null, null, 0, RefreshTest.T);
    var walk2 = RefreshTest.trip(null, null, 0, RefreshTest.T + 1500);
    return Refresh.keep(bus, walk, RefreshTest.T) && !Refresh.keep(bus, walkFast, RefreshTest.T) &&
        !Refresh.keep(bus, here, RefreshTest.T) && !Refresh.keep(walk, walk2, RefreshTest.T) &&
        !Refresh.keep(null, bus, RefreshTest.T);
}

(:test)
function refreshRate(logger as Logger) as Boolean {
    var t = RefreshTest.T;
    return !Refresh.free(t + 19, t, false) && Refresh.free(t + 20, t, false) && !Refresh.free(t + 60, t, true) &&
        !Refresh.due(t + 59, t, false) && Refresh.due(t + 60, t, false) &&
        !Refresh.movedFar(50.0) && Refresh.movedFar(60.0) &&
        !Refresh.badOrigin(25.0) && Refresh.badOrigin(30.0);
}
