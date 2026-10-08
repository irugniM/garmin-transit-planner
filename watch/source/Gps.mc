import Toybox.Lang;
import Toybox.Math;
import Toybox.Position;

// Position: last known first, then a continuous fix until accuracy is
// USABLE or better. The watch never knows where home is; it only sends its
// live position.
module Gps {
    var pos = null;      // [lat, lon] in degrees, or null
    var quality = 0;     // Position.QUALITY_*
    var on = false;
    var listener = null; // Method() called after each new fix

    function start(cb) as Void {
        listener = cb;
        var fake = Debug.fakePos();
        if (fake != null) {
            pos = fake;
            quality = Position.QUALITY_GOOD;
            return;
        }
        take(Position.getInfo());
        if (!on && quality < Position.QUALITY_USABLE) {
            Position.enableLocationEvents(Position.LOCATION_CONTINUOUS, new Lang.Method(Gps, :onPosition));
            on = true;
        }
    }

    function stop() as Void {
        listener = null;
        if (on) {
            Position.enableLocationEvents(Position.LOCATION_DISABLE, null);
            on = false;
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
        return true;
    }

    function onPosition(info as Position.Info) as Void {
        if (!take(info)) {
            return;
        }
        if (quality >= Position.QUALITY_USABLE && on) {
            Position.enableLocationEvents(Position.LOCATION_DISABLE, null);
            on = false;
        }
        if (listener != null) {
            listener.invoke();
        }
    }

    // Metres between two [lat, lon] points (equirectangular is plenty here).
    function metres(a, b) as Float {
        var k = Math.PI / 180.0;
        var x = (b[1] - a[1]) * k * Math.cos((a[0] + b[0]) * k / 2.0);
        var y = (b[0] - a[0]) * k;
        return (Math.sqrt(x * x + y * y) * 6371000.0).toFloat();
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
