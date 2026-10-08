import Toybox.Lang;
import Toybox.Math;
import Toybox.Position;
import Toybox.System;
import Toybox.Time;
import Toybox.WatchUi;

// Debug-only menu items: "Demo screens" fakes every screen state, and
// "Fake GPS" uses a fixed public spot (Western University, Natural Science
// stop) so the simulator can run a real request without a GPS track.
// Release builds (-r) get the empty versions at the bottom.
(:debug)
module Debug {
    var fake = false;
    const DEMO_COUNT = 24;
    // Arrow demos: fake compass heading (radians; null = none), and the
    // Arrow setting they show (On, except the "Arrow Off" demo).
    var arrowDemo = false;
    var head = null;
    var arrowSet = true;

    function fakePos() {
        return fake ? [43.0102d, -81.2732d] : null;
    }

    function heading(real) {
        return arrowDemo ? head : real;
    }

    function arrowOn(real as Boolean) as Boolean {
        return arrowDemo ? arrowSet : real;
    }

    function menuItems(base as Array) as Array {
        return base.addAll([["Demo screens", "Demo"], [fake ? "Fake GPS: on" : "Fake GPS: off", "Fake GPS"]]);
    }

    // i counts from the first debug item.
    function select(i as Number) {
        if (i == 0) {
            return new TripView(TripView.MODE_DEMO, "school");
        }
        fake = !fake;
        System.println("LTCTrip: fake GPS " + (fake ? "on" : "off"));
        return null;
    }

    function sampleReply(withAlert as Boolean, leaveIn as Number) as Dictionary {
        var t = Time.now().value();
        return {
            "v" => 1, "ok" => true, "leave" => t + leaveIn, "arr" => t + leaveIn + 1500,
            "rt" => false, "xfers" => 1,
            "lines" => ["Leave 08:01", "1 transfer", "Walk 1m to #1143", "Masonville Pl 4", "Bus 13A 08:02", "to White Oaks Mall",
                "Off #509 08:11", "Delaware Hall SB", "Walk 2m to #1173", "Talbot College", "Bus 27 08:15", "to Capulet Lane",
                "Off #1647 08:23", "Sarnia/Western WB", "Temp stop 130m W", "Walk 3m", "Arrive 08:26"],
            "alert" => withAlert ? "#1647 closed: temp stop 130m W" : null,
            "next" => "Next bus 08:14"
        };
    }

    // Natural Science stop (#1222) and the school stop: public places.
    const STOP = [43.01017d, -81.27317d];
    const SCHOOL = [43.00129d, -81.27883d];

    // Reply with `pts`; the first bus leaves in busIn seconds.
    function arrowReply(busIn as Number) as Dictionary {
        var t = Time.now().value();
        var r = sampleReply(false, busIn - 60);
        r["lines"] = ["Leave 08:01", "No transfer", "Walk 3m to #1222", "Natural Science", "Bus 27 08:04", "to Capulet Lane",
            "Off #1647 08:10", "Sarnia/Western WB", "Walk 3m", "Arrive 08:13"];
        r["pts"] = { "s" => [STOP[0], STOP[1]], "t" => t + busIn, "d" => [SCHOOL[0], SCHOOL[1]] };
        return r;
    }

    // Arrow demo i: [name, position, heading in degrees or null, bus in
    // secs, Arrow setting]. The arrow in the circle turns by bearing - heading.
    function arrowCase(i as Number) as Array {
        // 180 m due S of the stop: the stop is straight N.
        var s = [STOP[0] - 0.00162d, STOP[1]];
        // ~130 m S and ~125 m W of the stop: 180 m to the NE.
        var sw = [STOP[0] - 0.00117d, STOP[1] - 0.00153d];
        if (i == 0) {
            return ["circle arrow N: stop N, facing N", s, 0, 600, true];
        } else if (i == 1) {
            return ["circle arrow E: stop N, facing W", s, 270, 600, true];
        } else if (i == 2) {
            return ["circle arrow S: stop N, facing S", s, 180, 600, true];
        } else if (i == 3) {
            return ["circle arrow W: stop N, facing E", s, 90, 600, true];
        } else if (i == 4) {
            // ~850 m N and ~850 m E of the school, bus gone: dest to the SW.
            return ["circle arrow NE: 1.2km to dest after the bus left, facing S", [SCHOOL[0] + 0.0076d, SCHOOL[1] + 0.0105d], 180, -60, true];
        } else if (i == 5) {
            return ["circle letter: no heading", sw, null, 600, true];
        } else if (i == 6) {
            return ["circle dot: at stop", [STOP[0] + 0.0001d, STOP[1]], 0, 600, true];
        } else if (i == 7) {
            return ["Arrow Off: circle empty, no distance row", sw, 0, 600, false];
        }
        return ["circle arrow, 45m to stop, facing W, scrolled", [STOP[0] - 0.0004d, STOP[1]], 270, 600, true];
    }

    function apply(v as TripView) as Void {
        var i = v.demo % DEMO_COUNT;
        arrowDemo = false;
        v.busy = false;
        v.err = null;
        v.reply = null;
        v.scroll = 0;
        v.mode = TripView.MODE_DEMO;
        v.dest = "school";
        var name = "";
        if (i == 0) {
            name = "waiting for GPS";
            v.state = TripView.S_GPS;
        } else if (i == 1) {
            name = "loading";
            Gps.quality = Position.QUALITY_LAST_KNOWN;
            v.state = TripView.S_LOAD;
        } else if (i == 2) {
            name = "result with alert";
            v.reply = sampleReply(true, 12 * 60 + 30);
            v.gotAt = Time.now().value();
            v.state = TripView.S_OK;
        } else if (i == 3) {
            name = "result scrolled to end";
            v.reply = sampleReply(true, 12 * 60 + 30);
            v.gotAt = Time.now().value();
            v.state = TripView.S_OK;
            v.scroll = 9;
        } else if (i == 4) {
            name = "result, leave now, no alert, home";
            v.dest = "home";
            v.reply = sampleReply(false, 20);
            v.gotAt = Time.now().value();
            v.state = TripView.S_OK;
        } else if (i == 5) {
            name = "saved result + error";
            v.reply = sampleReply(true, -5 * 60);
            v.gotAt = Time.now().value() - 12 * 60;
            v.err = Net.errText(-104);
            v.state = TripView.S_ERR;
        } else if (i >= 6 && i <= 12) {
            var codes = [-104, -300, -402, -403, -1001, -101, 404];
            v.err = Net.errText(codes[i - 6]);
            name = "error " + codes[i - 6];
            v.state = TripView.S_ERR;
        } else if (i == 13) {
            name = "worker err";
            v.err = "No trips found";
            v.state = TripView.S_ERR;
        } else if (i >= 15) {
            var c = arrowCase(i - 15);
            name = c[0];
            arrowDemo = true;
            Gps.pos = c[1];
            Gps.quality = Position.QUALITY_GOOD;
            head = c[2] == null ? null : (c[2] as Number) * Math.PI / 180.0;
            arrowSet = c[4] as Boolean;
            v.reply = arrowReply(c[3] as Number);
            v.gotAt = Time.now().value();
            v.state = TripView.S_OK;
            v.scroll = i == 23 ? 3 : 0;
        } else {
            name = "ping OK";
            v.mode = TripView.MODE_PING;
            v.pingMs = 1400;
            v.pingT = Time.now().value();
            v.state = TripView.S_PING_OK;
        }
        var st = v.arrowWanted() ? Arrow.state(v.reply, Time.now().value()) : null;
        System.println("LTCTrip demo " + i + ": " + name + " | " + (st != null ? "arrow " + st[:text] + " angle " + st[:angle] + " letter " + st[:letter] + " dot " + st[:dot] + " | " : "") + v.bodyLines().toString());
        WatchUi.requestUpdate();
    }
}

(:release)
module Debug {
    function fakePos() {
        return null;
    }

    function heading(real) {
        return real;
    }

    function arrowOn(real as Boolean) as Boolean {
        return real;
    }

    function menuItems(base as Array) as Array {
        return base;
    }

    function select(i as Number) {
        return null;
    }

    function apply(v) as Void {
    }
}
