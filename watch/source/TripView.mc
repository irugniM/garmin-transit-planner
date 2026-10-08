import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Position;
import Toybox.System;
import Toybox.Time;
import Toybox.Time.Gregorian;
import Toybox.Timer;
import Toybox.WatchUi;

// Trip screen (and the connection test). Text only.
class TripView extends WatchUi.View {
    enum {
        MODE_TRIP,
        MODE_PING,
        MODE_DEMO
    }
    enum {
        S_GPS,
        S_LOAD,
        S_OK,
        S_ERR,
        S_PING_OK
    }

    var mode;
    var dest;
    var state = S_LOAD;
    var reply = null;    // Worker reply Dictionary
    var gotAt = 0;       // unix secs when reply arrived
    var err = null;      // error text
    var busy = false;
    var scroll = 0;
    var more = false;
    var pingMs = 0;
    var pingT = 0;
    var demo = 0;
    hidden var _alive = true;
    hidden var _started = false;
    hidden var _timer = null;
    hidden var _sentQ = 0;
    hidden var _sentPos = null;
    hidden var _refined = false;
    hidden var _resend = false;
    hidden var _t0 = 0;

    function initialize(m as Number, d as String) {
        View.initialize();
        mode = m;
        dest = d;
    }

    function onShow() as Void {
        if (_timer == null) {
            _timer = new Timer.Timer();
            _timer.start(method(:onTick), 20000, true);
        }
        if (!_started) {
            _started = true;
            begin();
        }
    }

    function onHide() as Void {
        if (_timer != null) {
            _timer.stop();
            _timer = null;
        }
    }

    function onTick() as Void {
        WatchUi.requestUpdate();
    }

    function close() as Void {
        _alive = false;
        Gps.stop();
        if (busy) {
            Net.cancel();
        }
    }

    function now() as Number {
        return Time.now().value();
    }

    // ---- flow ----------------------------------------------------------

    function begin() as Void {
        if (mode == MODE_DEMO) {
            Debug.apply(self);
            return;
        }
        if (mode == MODE_PING) {
            ping();
            return;
        }
        Gps.start(method(:onFix));
        if (Gps.pos != null) {
            send();
        } else {
            state = S_GPS;
            System.println("LTCTrip: waiting for GPS");
            WatchUi.requestUpdate();
        }
    }

    function onFix() as Void {
        if (!_alive || Gps.pos == null) {
            return;
        }
        if (state == S_GPS) {
            send();
            return;
        }
        // Re-query once when the fix gets notably better than the one sent.
        if (!_refined && _sentPos != null && _sentQ < Position.QUALITY_USABLE &&
            Gps.quality >= Position.QUALITY_USABLE && Gps.metres(_sentPos, Gps.pos) > 100) {
            _refined = true;
            if (busy) {
                _resend = true;
            } else {
                send();
            }
        }
    }

    // START
    function refresh() as Void {
        if (mode == MODE_DEMO) {
            demo += 1;
            Debug.apply(self);
            return;
        }
        if (busy) {
            return;
        }
        if (mode == MODE_PING) {
            ping();
        } else if (Gps.pos != null) {
            send();
        }
    }

    function send() as Void {
        if (busy) {
            return;
        }
        busy = true;
        _sentQ = Gps.quality;
        _sentPos = Gps.pos;
        if (reply == null) {
            state = S_LOAD;
        }
        System.println("LTCTrip: plan dest=" + dest + " " + Gps.label());
        Net.plan(Gps.pos[0], Gps.pos[1], dest, method(:onPlan));
        WatchUi.requestUpdate();
    }

    function onPlan(code as Number, data as Dictionary or String or Null) as Void {
        busy = false;
        if (!_alive) {
            return;
        }
        System.println("LTCTrip: plan reply code=" + code);
        if (code == 200 && data instanceof Dictionary) {
            if (data["ok"] == true && data["lines"] instanceof Array) {
                reply = data;
                gotAt = now();
                err = null;
                state = S_OK;
                scroll = 0;
                Store.save(dest, data, gotAt);
            } else {
                showErr(data["err"] instanceof String ? data["err"] as String : "Bad reply");
            }
        } else if (code == 200) {
            showErr("Bad reply");
        } else {
            showErr(Net.errText(code));
        }
        if (_resend) {
            _resend = false;
            send();
        }
        WatchUi.requestUpdate();
    }

    function showErr(text as String) as Void {
        err = text;
        if (reply == null) {
            var c = Store.load(dest);
            if (c != null) {
                reply = c[0];
                gotAt = c[1];
            }
        }
        state = S_ERR;
        scroll = 0;
        System.println("LTCTrip: error " + text + (reply != null ? " (showing saved)" : ""));
    }

    function ping() as Void {
        busy = true;
        err = null;
        state = S_LOAD;
        _t0 = System.getTimer();
        System.println("LTCTrip: ping " + Net.baseUrl());
        Net.ping(method(:onPing));
        WatchUi.requestUpdate();
    }

    function onPing(code as Number, data as Dictionary or String or Null) as Void {
        busy = false;
        if (!_alive) {
            return;
        }
        pingMs = System.getTimer() - _t0;
        if (code == 200 && data instanceof Dictionary && data["ok"] == true) {
            state = S_PING_OK;
            pingT = data["t"] instanceof Number ? data["t"] as Number : 0;
        } else {
            state = S_ERR;
            err = code == 200 ? "Bad reply" : Net.errText(code);
        }
        System.println("LTCTrip: ping code=" + code + " ms=" + pingMs + (err != null ? " " + err : " OK"));
        WatchUi.requestUpdate();
    }

    // UP/DOWN
    function scrollBy(d as Number) as Void {
        if (d > 0 && !more) {
            return;
        }
        scroll += d;
        if (scroll < 0) {
            scroll = 0;
        }
        WatchUi.requestUpdate();
    }

    // ---- drawing -------------------------------------------------------

    function title() as Array {
        if (mode == MODE_PING) {
            return ["Test", "Test"];
        }
        if (dest.equals("home")) {
            return ["To Home", "Home"];
        }
        return ["To School", "School"];
    }

    static function clock(t as Number) as String {
        var i = Gregorian.info(new Time.Moment(t), Time.FORMAT_SHORT);
        return i.hour.format("%02d") + ":" + i.min.format("%02d");
    }

    static function age(secs as Number) as String {
        var m = secs / 60;
        if (m < 1) {
            return "just now";
        }
        if (m < 60) {
            return m.toString() + "m ago";
        }
        if (m < 48 * 60) {
            return (m / 60).toString() + "h ago";
        }
        return (m / 1440).toString() + "d ago";
    }

    // [small top row, big second row] for the leave countdown.
    function leaveText() as Array {
        var leave = reply["leave"];
        if (!(leave instanceof Number)) {
            return ["Leave", "?"];
        }
        var d = leave - now();
        if (d >= 60) {
            var m = d / 60;
            if (m >= 60) {
                return ["Leave in", (m / 60).toString() + "h " + (m % 60).format("%02d") + "m"];
            }
            return ["Leave in", m.toString() + " min"];
        }
        if (d > -60) {
            return ["Leave", "now"];
        }
        var late = -d / 60;
        if (late >= 60) {
            return ["Late by", (late / 60).toString() + "h " + (late % 60).format("%02d") + "m"];
        }
        return ["Late by", late.toString() + " min"];
    }

    function bodyLines() as Array {
        var out = [];
        if (state == S_GPS) {
            return ["Waiting for GPS", "Go outside or wait", "BACK: menu"];
        }
        if (state == S_LOAD) {
            if (mode == MODE_PING) {
                return ["Calling Worker..."];
            }
            return ["Getting trip...", Gps.label()];
        }
        if (state == S_PING_OK) {
            out = ["Connection OK", "Round trip " + (pingMs < 1000 ? pingMs.toString() + " ms" : (pingMs / 1000.0).format("%.1f") + " s")];
            if (pingT > 0) {
                out.add("Worker " + clock(pingT));
            }
            out.add("START: again");
            return out;
        }
        if (reply == null) {
            // Error with nothing saved.
            return [err != null ? err : "Error", "START: retry"];
        }
        if (state == S_ERR) {
            out.add(err);
            out.add("Saved " + age(now() - gotAt));
        } else if (busy) {
            out.add("Updating...");
        }
        var a = reply["alert"];
        if (a instanceof String && a.length() > 0) {
            out.add("! " + a);
        }
        var lines = reply["lines"];
        if (lines instanceof Array) {
            for (var i = 0; i < lines.size(); i += 1) {
                if (lines[i] instanceof String) {
                    out.add(lines[i]);
                }
            }
        }
        var n = reply["next"];
        if (n instanceof String && n.length() > 0) {
            out.add(n);
        }
        return out;
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        var f = Graphics.FONT_XTINY;
        var big = Graphics.FONT_MEDIUM;

        if (reply != null && (state == S_OK || state == S_ERR)) {
            var lt = leaveText();
            Layout.drawLeft(dc, 18, f, lt[0]);
            Layout.drawLeft(dc, 38, big, lt[1]);
        } else {
            var t = title();
            Layout.drawLeft(dc, 18, f, "LTC Trip");
            Layout.drawLeft(dc, 40, f, t);
        }

        var lines = bodyLines();
        if (scroll > lines.size() - 1) {
            scroll = lines.size() - 1;
        }
        if (scroll < 0) {
            scroll = 0;
        }
        var shown = lines.slice(scroll, null);
        var top = Layout.bodyTop();
        var list = reply != null && (state == S_OK || state == S_ERR);
        var pitch = dc.getFontHeight(f) - 3;
        more = Layout.flow(dc, top, f, pitch, shown, !list, list ? 8 : 0);
        if (list && (more || scroll > 0)) {
            var rows = (dc.getHeight() - top) / pitch;
            Layout.scrollbar(dc, top + 4, top + 54, scroll, rows, lines.size());
        }
    }
}

class TripDelegate extends WatchUi.BehaviorDelegate {
    var view;

    function initialize(v as TripView) {
        BehaviorDelegate.initialize();
        view = v;
    }

    function onSelect() as Boolean {
        view.refresh();
        return true;
    }

    function onNextPage() as Boolean {
        view.scrollBy(1);
        return true;
    }

    function onPreviousPage() as Boolean {
        view.scrollBy(-1);
        return true;
    }

    function onBack() as Boolean {
        view.close();
        WatchUi.popView(WatchUi.SLIDE_RIGHT);
        return true;
    }
}
