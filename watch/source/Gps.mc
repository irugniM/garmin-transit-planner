import Toybox.Lang;
import Toybox.Math;
import Toybox.Position;
import Toybox.System;

// Position: last known first, then a continuous fix until accuracy is
// USABLE or better. The arrow (follow mode) keeps location events on while
// TripView is open. The watch only sends its live position; the destination
// it points at comes back in the Worker's reply.
module Gps {
    var pos = null;      // [lat, lon] in degrees, or null
    var quality = 0;     // Position.QUALITY_*
    var heading = null;  // GPS heading in radians (direction of travel), or null
    var speed = 0.0;     // m/s
    var on = false;
    var want = false;    // still looking for a USABLE fix
    var follow = false;  // arrow: keep events on
    var listener = null; // Method() called after each new fix
    var watcher = null;  // Method() called after every fix while following

    function start(cb) as Void {
        listener = cb;
        var fake = Debug.fakePos();
        if (fake != null) {
            pos = fake;
            quality = Position.QUALITY_GOOD;
            return;
        }
        take(Position.getInfo());
        want = quality < Position.QUALITY_USABLE;
        sync();
    }

    function stop() as Void {
        listener = null;
        watcher = null;
        want = false;
        follow = false;
        sync();
    }

    // Arrow: keep continuous location events on (cb after each fix), or not.
    function setFollow(f as Boolean, cb) as Void {
        follow = f;
        watcher = f ? cb : null;
        if (f && Debug.fakePos() == null) {
            take(Position.getInfo());
        }
        sync();
    }

    // Location events on exactly while someone needs them.
    function sync() as Void {
        var need = (want || follow) && Debug.fakePos() == null;
        if (need && !on) {
            Position.enableLocationEvents(Position.LOCATION_CONTINUOUS, new Lang.Method(Gps, :onPosition));
            on = true;
            System.println("LTCTrip: location events on" + (follow ? " (arrow)" : ""));
        } else if (!need && on) {
            Position.enableLocationEvents(Position.LOCATION_DISABLE, null);
            on = false;
            System.println("LTCTrip: location events off");
        }
    }

    // Returns true when info held a usable coordinate.
    function take(info) as Boolean {
        if (info == null || info.position == null) {
            return false;
        }
        var q = info.accuracy;
        if (q == null || q == Position.QUALITY_NOT_AVAILABLE) {
            return false;
        }
        var d = info.position.toDegrees();
        var lat = d[0].toDouble();
        var lon = d[1].toDouble();
        if (lat.abs() > 90 || lon.abs() > 180 || (lat == 0.0d && lon == 0.0d)) {
            return false;
        }
        pos = [lat, lon];
        quality = q;
        speed = info.speed != null ? info.speed.toFloat() : 0.0;
        heading = info.heading;
        return true;
    }

    function onPosition(info as Position.Info) as Void {
        if (!take(info)) {
            return;
        }
        if (quality >= Position.QUALITY_USABLE && want) {
            want = false;
            sync();
        }
        if (listener != null) {
            listener.invoke();
        }
        if (watcher != null) {
            watcher.invoke();
        }
    }

    // Metres between two [lat, lon] points (equirectangular is plenty here).
    function metres(a, b) as Float {
        var k = Math.PI / 180.0;
        var x = (b[1] - a[1]) * k * Math.cos((a[0] + b[0]) * k / 2.0);
        var y = (b[0] - a[0]) * k;
        return (Math.sqrt(x * x + y * y) * 6371000.0).toFloat();
    }

    // Initial great-circle bearing from a to b, degrees 0..360 (0 = north).
    function bearing(a, b) as Float {
        var k = Math.PI / 180.0;
        var la1 = a[0] * k;
        var la2 = b[0] * k;
        var dl = (b[1] - a[1]) * k;
        var y = Math.sin(dl) * Math.cos(la2);
        var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl);
        var deg = Math.atan2(y, x) / k;
        if (deg < 0) {
            deg += 360.0;
        }
        return deg.toFloat();
    }

    function label() as String {
        if (quality >= Position.QUALITY_GOOD) {
            return "GPS good";
        }
        if (quality == Position.QUALITY_USABLE) {
            return "GPS usable";
        }
        if (quality == Position.QUALITY_POOR) {
            return "GPS poor";
        }
        if (quality == Position.QUALITY_LAST_KNOWN) {
            return "GPS last known";
        }
        return "No GPS";
    }
}
