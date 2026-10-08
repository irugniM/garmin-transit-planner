import Toybox.Lang;
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
    const DEMO_COUNT = 15;

    function fakePos() {
        return fake ? [43.0102d, -81.2732d] : null;
    }

    function menuItems(base as Array) as Array {
        return base.addAll([["Demo screens", "Demo"], [fake ? "Fake GPS: on" : "Fake GPS: off", "Fake GPS"]]);
    }

    function select(i as Number) {
        if (i == 3) {
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
            "lines" => ["Leave 08:01", "Walk 1m to #1143", "Bus 13A 08:02", "to White Oaks Mall", "Off #509 08:11",
                "Walk 2m to #1173", "Bus 27 08:15", "to Capulet Lane", "Off #1647 08:23", "Arrive 08:26"],
            "alert" => withAlert ? "#1647 closed: temp stop 130m W" : null,
            "next" => "Next: 08:10"
        };
    }

    function apply(v as TripView) as Void {
        var i = v.demo % DEMO_COUNT;
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
        } else {
            name = "ping OK";
            v.mode = TripView.MODE_PING;
            v.pingMs = 1400;
            v.pingT = Time.now().value();
            v.state = TripView.S_PING_OK;
        }
        System.println("LTCTrip demo " + i + ": " + name + " | " + v.bodyLines().toString());
        WatchUi.requestUpdate();
    }
}

(:release)
module Debug {
    function fakePos() {
        return null;
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
