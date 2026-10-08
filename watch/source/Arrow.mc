import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Math;
import Toybox.Sensor;
import Toybox.Time;

// Compass arrow for TripView: points from the current position to the first
// boarding stop (until its bus leaves or you're within 30 m of it), then to
// the destination. Both come from the reply's `pts`:
//   {"s": [lat, lon], "t": first bus departure (unix secs), "d": [lat, lon]}
// Rotated by the compass heading (else the GPS heading while moving); with
// neither, the bearing is shown as a compass letter instead.
module Arrow {
    const NEAR = 30.0;          // metres: "at stop"
    const MIN_GPS_SPEED = 1.0;  // m/s: below this the GPS heading is noise

    function point(v) {
        if (v instanceof Array && v.size() == 2 && v[0] != null && v[1] != null) {
            return [v[0].toDouble(), v[1].toDouble()];
        }
        return null;
    }

    function hasPts(reply) as Boolean {
        if (!(reply instanceof Dictionary)) {
            return false;
        }
        var p = reply["pts"];
        return p instanceof Dictionary && (point(p["s"]) != null || point(p["d"]) != null);
    }

    // Heading in degrees (true north), or null.
    function heading() {
        var h = null;
        if (Toybox has :Sensor) {
            var si = Sensor.getInfo();
            if (si != null && si.heading != null) {
                h = si.heading;
            }
        }
        if (h == null && Gps.heading != null && Gps.speed >= MIN_GPS_SPEED) {
            h = Gps.heading;
        }
        h = Debug.heading(h);
        if (h == null) {
            return null;
        }
        var deg = h.toFloat() * 180.0 / Math.PI;
        while (deg < 0) {
            deg += 360.0;
        }
        while (deg >= 360.0) {
            deg -= 360.0;
        }
        return deg;
    }

    // { :text => String, :angle => degrees to rotate the arrow (or null for
    // no arrow) }, or null when there's nothing to show.
    function state(reply, now as Number) {
        if (!hasPts(reply)) {
            return null;
        }
        var p = reply["pts"] as Dictionary;
        if (Gps.pos == null) {
            return { :text => "Arrow: no GPS", :angle => null };
        }
        var s = point(p["s"]);
        var d = point(p["d"]);
        var t = p["t"] instanceof Number ? p["t"] as Number : 0;
        var target = d;
        var label = "dest";
        if (s != null && (t == 0 || now < t)) {
            if (Gps.metres(Gps.pos, s) <= NEAR) {
                return { :text => "at stop", :angle => null };
            }
            target = s;
            label = "stop";
        }
        if (target == null) {
            return null;
        }
        var m = Gps.metres(Gps.pos, target);
        if (m <= NEAR) {
            return { :text => label.equals("stop") ? "at stop" : "here", :angle => null };
        }
        var b = Gps.bearing(Gps.pos, target);
        var h = heading();
        if (h == null) {
            return { :text => compass(b) + " " + dist(m) + " to " + label, :angle => null };
        }
        return { :text => dist(m) + " to " + label, :angle => b - h };
    }

    // "45m", "180m", "1.2km", "12km".
    function dist(m as Float) as String {
        if (m < 995) {
            var r = m < 100 ? 5 : 10;
            return (((m / r) + 0.5).toNumber() * r).toString() + "m";
        }
        if (m < 9950) {
            return (m / 1000.0).format("%.1f") + "km";
        }
        return ((m / 1000.0) + 0.5).toNumber().toString() + "km";
    }

    function compass(deg as Float) as String {
        var names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
        var i = (((deg + 22.5) / 45.0).toNumber()) % 8;
        return names[i];
    }

    // Arrow of radius ~r centred at (cx, cy), rotated clockwise by deg
    // (0 = straight up = ahead).
    function draw(dc as Graphics.Dc, cx as Number, cy as Number, r as Number, deg as Float) as Void {
        var a = deg * Math.PI / 180.0;
        var c = Math.cos(a);
        var sn = Math.sin(a);
        var shape = [[0, -r], [r * 3 / 4, r], [0, r / 2], [-r * 3 / 4, r]];
        var pts = [];
        for (var i = 0; i < shape.size(); i += 1) {
            var x = shape[i][0];
            var y = shape[i][1];
            pts.add([(cx + x * c - y * sn + 0.5).toNumber(), (cy + x * sn + y * c + 0.5).toNumber()]);
        }
        dc.fillPolygon(pts);
    }

    // One row at y: [arrow] text, left-aligned in the row's span.
    // Returns true when something was drawn.
    function drawRow(dc as Graphics.Dc, y as Number, font, indent as Number, reply, now as Number) as Boolean {
        var st = state(reply, now);
        if (st == null) {
            return false;
        }
        var h = dc.getFontHeight(font);
        var sp = Layout.span(dc, y, h);
        var x = sp[0] + indent;
        var maxW = sp[1] - x;
        var text = st[:text] as String;
        if (st[:angle] != null) {
            var r = 7;
            draw(dc, x + r, y + h / 2, r, st[:angle] as Float);
            x += 2 * r + 5;
            maxW -= 2 * r + 5;
        }
        dc.drawText(x, y, font, Layout.fit(dc, text, font, maxW), Graphics.TEXT_JUSTIFY_LEFT);
        return true;
    }
}
