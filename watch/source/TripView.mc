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
    var dest;            // descriptor from Places (null for the ping)
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
    var isDemo = false;  // demo screens (some of them switch mode to PING)
    hidden var _alive = true;
    hidden var _started = false;
    hidden var _timer = null;
    hidden var _sentQ = 0;
    hidden var _sentPos = null;
    hidden var _resend = false;
    hidden var _lastSend = 0;    // unix secs of the last plan request
    hidden var _lastGood = null; // last position with a USABLE+ fix
    hidden var _auto = false;    // the request in flight is an auto-refresh
    hidden var _t0 = 0;
    hidden var _fast = false;  // 1 s redraws + location events (arrow)

    function initialize(m as Number, d) {
        View.initialize();
        mode = m;
        dest = d;
        isDemo = m == MODE_DEMO;
    }

    // The arrow redraws every second (compass) and keeps GPS events on, but
    // only once a trip is showing; otherwise (and without the arrow) a
    // redraw every 20 s for the countdown is enough.
    function arrowWanted() as Boolean {
        return mode != MODE_PING && Debug.arrowOn(Store.arrowOn());
    }

    function showingTrip() as Boolean {
        return reply != null && (state == S_OK || state == S_ERR);
    }

    // Timer at the right speed, location events on exactly when needed.
    function pace() as Void {
        if (_timer == null) {
            return;
        }
        var fast = arrowWanted() && mode == MODE_TRIP && _alive && showingTrip();
        if (fast != _fast) {
            _fast = fast;
            _timer.stop();
            _timer.start(method(:onTick), fast ? 1000 : 20000, true);
            Gps.setFollow(fast, fast ? method(:onTick) : null);
        }
    }

    function onShow() as Void {
        if (_timer == null) {
            _timer = new Timer.Timer();
            _fast = false;
            _timer.start(method(:onTick), 20000, true);
        }
        if (!_started) {
            _started = true;
            begin();
        }
        pace();
    }

    // Leaving the view (or the app): no timer, no location events.
    function onHide() as Void {
        if (_timer != null) {
            _timer.stop();
            _timer = null;
        }
        if (busy && mode == MODE_TRIP) {
            Net.cancel();
            Places.cancelled();
            busy = false;
            _auto = false;
        }
        if (_fast) {
            _fast = false;
            Gps.setFollow(false, null);
        }
    }

    function onTick() as Void {
        WatchUi.requestUpdate();
        autoTick();
    }

    // Auto-refresh every Refresh.PERIOD s while a trip is showing. Arrow On
    // (continuous GPS): only from a USABLE+ fix, else skip this tick. Arrow
    // Off: no GPS is started for this; the last USABLE+ position (else the
    // one first sent) is reused, which still refreshes the bus times.
    function autoTick() as Void {
        if (mode != MODE_TRIP || !_alive || !showingTrip() || dest["to"] == null ||
            !Refresh.due(now(), _lastSend, busy)) {
            return;
        }
        var p = null;
        if (_fast) {
            if (Gps.quality >= Position.QUALITY_USABLE) {
                p = Gps.pos;
            }
        } else {
            p = _lastGood != null ? _lastGood : _sentPos;
        }
        if (p != null) {
            System.println("LTCTrip: auto re-plan (timer)");
            send(p, true);
        }
    }

    function close() as Void {
        _alive = false;
        Places.geoDone = null;
        Gps.stop();
        if (busy) {
            Net.cancel();
            Places.cancelled();
        }
    }

    function now() as Number {
        return Time.now().value();
    }

    // ---- flow ----------------------------------------------------------

    function begin() as Void {
        if (isDemo) {
            Debug.apply(self);
            return;
        }
        if (mode == MODE_PING) {
            ping();
            return;
        }
        // Phone-settings place: its address may still need a lookup.
        if (dest["to"] == null) {
            if (dest["g"] != null && dest["e"] == null) {
                state = S_LOAD;
                busy = true;
                Places.geoDone = method(:onGeo);
                Places.geoNext();
                if (!Places.geoBusy) {
                    onGeo();
                }
            } else {
                showErr(dest["e"] != null ? dest["e"] : "Address not found");
            }
            WatchUi.requestUpdate();
            return;
        }
        Gps.start(method(:onFix));
        if (Gps.pos != null) {
            send(Gps.pos, false);
        } else {
            state = S_GPS;
            System.println("LTCTrip: waiting for GPS");
            WatchUi.requestUpdate();
        }
    }

    // A settings address lookup finished (maybe another slot's).
    function onGeo() as Void {
        if (!_alive || Places.geoBusy && Places.geoSlot == dest["g"]) {
            return;
        }
        var d = Places.setting(dest["g"]);
        if (d != null && d["to"] == null && d["e"] == null) {
            return;  // still queued behind another slot
        }
        busy = false;
        Places.geoDone = null;
        if (d == null) {
            showErr("Address removed");
        } else {
            dest = d;
            begin();
        }
        WatchUi.requestUpdate();
    }

    function onFix() as Void {
        if (!_alive || Gps.pos == null) {
            return;
        }
        if (Gps.quality >= Position.QUALITY_USABLE) {
            _lastGood = Gps.pos;
        }
        if (state == S_GPS) {
            send(Gps.pos, false);
            return;
        }
        if (_sentPos == null || Gps.quality < Position.QUALITY_USABLE) {
            return;
        }
        var m = Gps.metres(_sentPos, Gps.pos);
        // The shown plan came from a position below USABLE (often a stale
        // last-known one): re-plan as soon as a USABLE fix is over 25 m from
        // it, every time this happens, and take the answer as is (the old
        // origin was wrong, so no hysteresis).
        if (_sentQ < Position.QUALITY_USABLE && Refresh.badOrigin(m)) {
            System.println("LTCTrip: re-plan (first usable fix)");
            if (busy) {
                _resend = true;
            } else {
                send(Gps.pos, false);
            }
            return;
        }
        // Moved over 50 m from where the shown plan was asked: re-plan now,
        // at most once per Refresh.MIN_GAP s.
        if (showingTrip() && Refresh.movedFar(m) && Refresh.free(now(), _lastSend, busy)) {
            System.println("LTCTrip: auto re-plan (moved)");
            send(Gps.pos, true);
        }
    }

    // START
    function refresh() as Void {
        if (isDemo) {
            demo += 1;
            Debug.apply(self);
            return;
        }
        if (busy) {
            return;
        }
        if (mode == MODE_PING) {
            ping();
        } else if (dest["to"] == null) {
            // Failed address: look it up again if it never got an answer
            // (a Worker "Address not found" stays until the phone setting
            // changes).
            var slot = (dest["k"] as String).substring(1, 2).toNumber();
            if (dest["g"] != null) {
                Places.retry(slot);
            }
            var d = Places.setting(slot);
            if (d == null) {
                showErr("Address removed");
                WatchUi.requestUpdate();
                return;
            }
            dest = d;
            reply = null;
            err = null;
            begin();
        } else if (Gps.pos != null) {
            // START: re-plan right away (no rate limit, no hysteresis).
            send(Gps.pos, false);
        }
    }

    // auto: an automatic re-plan, whose answer goes through Refresh.keep().
    function send(p as Array, auto as Boolean) as Void {
        if (busy) {
            return;
        }
        busy = true;
        _auto = auto;
        _lastSend = now();
        _sentQ = Gps.quality;
        _sentPos = p;
        if (reply == null) {
            state = S_LOAD;
        }
        System.println("LTCTrip: plan " + dest["k"] + " " + Gps.label());
        Net.plan(p[0], p[1], dest["to"], method(:onPlan));
        WatchUi.requestUpdate();
    }

    function onPlan(code as Number, data as Dictionary or String or Null) as Void {
        busy = false;
        if (!_alive) {
            return;
        }
        System.println("LTCTrip: plan reply code=" + code);
        var auto = _auto;
        _auto = false;
        if (code == 200 && data instanceof Dictionary) {
            if (data["ok"] == true && data["lines"] instanceof Array && auto && reply != null &&
                Refresh.keep(reply, data, now())) {
                // A different stop/bus that isn't 2 min better: keep the shown
                // plan (no flipping between stops).
                System.println("LTCTrip: auto re-plan: kept the shown trip");
                if (state == S_ERR) {
                    state = S_OK;
                    err = null;
                }
            } else if (data["ok"] == true && data["lines"] instanceof Array) {
                reply = data;
                gotAt = now();
                err = null;
                state = S_OK;
                scroll = 0;
                Store.save(dest["k"], data, gotAt);
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
            send(Gps.pos, false);
        }
        pace();
        WatchUi.requestUpdate();
    }

    function showErr(text as String) as Void {
        err = text;
        if (reply == null) {
            var c = Store.load(dest["k"]);
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
        return dest["t"];
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
            if (dest["to"] == null) {
                return ["Finding address..."];
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
            // Error with nothing saved. A phone-settings address the Worker
            // couldn't find only changes in the phone app.
            if (mode == MODE_TRIP && dest["to"] == null && dest["g"] == null) {
                return [err != null ? err : "Error", "Fix it in the", "phone app settings"];
            }
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
        var barTop = top;
        var list = reply != null && (state == S_OK || state == S_ERR);
        var pitch = dc.getFontHeight(f) - 3;
        // Arrow On: the arrow in the subscreen circle, the distance pinned
        // above the scrolling lines. Off: neither (and no compass reads).
        if (list && arrowWanted()) {
            var st = Arrow.state(reply, now());
            Arrow.drawCircle(dc, st);
            if (Arrow.drawRow(dc, top, f, 8, st)) {
                top += pitch;
            }
        }
        more = Layout.flow(dc, top, f, pitch, shown, !list, list ? 8 : 0);
        if (list && (more || scroll > 0)) {
            var rows = (dc.getHeight() - top) / pitch;
            Layout.scrollbar(dc, barTop + 4, barTop + 54, scroll, rows, lines.size());
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
