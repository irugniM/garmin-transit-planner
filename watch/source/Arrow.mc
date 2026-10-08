import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Math;
import Toybox.Position;
import Toybox.Sensor;
import Toybox.Time;

// Compass arrow for TripView: points from the current position to the first
// boarding stop (until its bus leaves or you're within 30 m of it), then to
// the destination. Both come from the reply's `pts`:
//   {"s": [lat, lon], "t": first bus departure (unix secs), "d": [lat, lon]}
// The arrow sits in the top-right subscreen circle, rotated by the compass
// heading (else the GPS heading while moving); with neither, the circle shows
// the bearing as a compass letter, and within 30 m a dot. The distance is a
// text row above the trip lines. Below a USABLE fix (none, last known, poor;
// e.g. the first fix after GPS start) the distance gets a "~", the arrow is
// only outlined, and there's no "at stop" dot.
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

    // { :text => distance row (none at the destination), :angle => degrees
    // to rotate the arrow in the circle, :letter => compass letter (no
    // heading), :dot => true when within 30 m (USABLE fix or better only),
    // :rough => true below USABLE ("~" distance, outlined arrow) }, or null
    // when there's nothing to show.
    function state(reply, now as Number) {
        if (!hasPts(reply)) {
            return null;
        }
        var p = reply["pts"] as Dictionary;
        if (Gps.pos == null) {
            return { :text => "no GPS" };
        }
        var s = point(p["s"]);
        var d = point(p["d"]);
        var t = p["t"] instanceof Number ? p["t"] as Number : 0;
        var target = d;
        var label = "dest";
        if (s != null && (t == 0 || now < t)) {
            target = s;
            label = "stop";
        }
        if (target == null) {
            return null;
        }
        // Below USABLE (no fix, last known, poor) the position can be off by
        // 100 m or more: "~" before the distance, an outlined arrow, and no
        // 30 m "at stop" dot.
        var rough = Gps.quality < Position.QUALITY_USABLE;
        var m = Gps.metres(Gps.pos, target);
        if (m <= NEAR && !rough) {
            // At the destination the reply already says "You're here".
            return label.equals("stop") ? { :text => Debug.qualityTag("at stop"), :dot => true } : { :dot => true };
        }
        var b = Gps.bearing(Gps.pos, target);
        var text = Debug.qualityTag((rough ? "~" : "") + dist(m) + " to " + label);
        var h = heading();
        if (h == null) {
            return { :text => text, :letter => compass(b), :rough => rough };
        }
        return { :text => text, :angle => b - h, :rough => rough };
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
        var d = deg;
        while (d < 0) {
            d += 360.0;
        }
        var i = (((d + 22.5) / 45.0).toNumber()) % 8;
        return names[i];
    }

    // Arrow with every vertex within a of (cx, cy), rotated clockwise by deg
    // (0 = straight up = ahead).
    function draw(dc as Graphics.Dc, cx as Float, cy as Float, a as Float, deg as Float, outline as Boolean) as Void {
        var rad = deg * Math.PI / 180.0;
        var c = Math.cos(rad);
        var sn = Math.sin(rad);
        // Tip, right wing, notch, left wing; wings at +-140 deg from the tip.
        var shape = [[0.0, -a], [0.643 * a, 0.766 * a], [0.0, 0.36 * a], [-0.643 * a, 0.766 * a]];
        var pts = [];
        for (var i = 0; i < shape.size(); i += 1) {
            var x = shape[i][0];
            var y = shape[i][1];
            pts.add([Math.round(cx + x * c - y * sn).toNumber(), Math.round(cy + x * sn + y * c).toNumber()]);
        }
        if (!outline) {
            dc.fillPolygon(pts);
            return;
        }
        // Rough fix: outline only (2 px), so it reads as "not sure".
        dc.setPenWidth(2);
        for (var i = 0; i < pts.size(); i += 1) {
            var p = pts[i];
            var q = pts[(i + 1) % pts.size()];
            dc.drawLine(p[0], p[1], q[0], q[1]);
        }
        dc.setPenWidth(1);
    }

    // The subscreen circle: [cx, cy, radius] or null. getSubscreen() gives
    // its bounding box; the visible window is the inscribed circle.
    function circle() {
        var b = Layout.subscreen();
        if (b == null || b.width < 20 || b.height < 20) {
            return null;
        }
        var w = b.width < b.height ? b.width : b.height;
        return [b.x + b.width / 2.0, b.y + b.height / 2.0, w / 2.0];
    }

    // Arrow / compass letter / dot centred in the subscreen circle, kept
    // MARGIN px inside its edge.
    const MARGIN = 3;

    function drawCircle(dc as Graphics.Dc, st) as Void {
        var c = circle();
        if (st == null || c == null) {
            return;
        }
        var cx = c[0] as Float;
        var cy = c[1] as Float;
        // One more px for the polygon's rounding to whole pixels.
        var a = (c[2] as Float) - MARGIN - 1;
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        if (st[:angle] != null) {
            draw(dc, cx, cy, a, st[:angle] as Float, st[:rough] == true);
        } else if (st[:letter] != null) {
            dc.drawText(cx.toNumber(), cy.toNumber(), Graphics.FONT_MEDIUM, st[:letter] as String,
                Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
        } else if (st[:dot] == true) {
            dc.fillCircle(cx.toNumber(), cy.toNumber(), (a / 3).toNumber());
        }
    }

    // Distance row at y, left-aligned in the row's span. True when drawn.
    function drawRow(dc as Graphics.Dc, y as Number, font, indent as Number, st) as Boolean {
        if (st == null || st[:text] == null) {
            return false;
        }
        var h = dc.getFontHeight(font);
        var sp = Layout.span(dc, y, h);
        var x = sp[0] + indent;
        dc.drawText(x, y, font, Layout.fit(dc, st[:text] as String, font, sp[1] - x), Graphics.TEXT_JUSTIFY_LEFT);
        return true;
    }
}
