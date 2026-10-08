import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Position;
import Toybox.System;
import Toybox.WatchUi;

// "Save this place": one GPS fix of USABLE quality or better (a last-known
// position may be old, so it isn't used), saved as "Place N" on the watch.
class SaveView extends WatchUi.View {
    enum {
        W_GPS,
        W_SAVED,
        W_FULL
    }

    var state = W_GPS;
    var name = "";
    hidden var _started = false;

    function initialize() {
        View.initialize();
    }

    function onShow() as Void {
        if (_started) {
            return;
        }
        _started = true;
        if (Places.saved().size() >= Places.MAX_SAVED) {
            state = W_FULL;
            return;
        }
        Gps.start(method(:onFix));
        onFix();
    }

    function onFix() as Void {
        if (state != W_GPS || Gps.pos == null) {
            WatchUi.requestUpdate();
            return;
        }
        if (Gps.quality < Position.QUALITY_USABLE) {
            WatchUi.requestUpdate();
            return;
        }
        var n = Places.saveHere(Gps.pos);
        Gps.stop();
        if (n == null) {
            state = W_FULL;
        } else {
            name = n;
            state = W_SAVED;
            System.println("LTCTrip: saved " + n);
        }
        WatchUi.requestUpdate();
    }

    function close() as Void {
        Gps.stop();
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        var f = Graphics.FONT_XTINY;
        Layout.drawLeft(dc, 18, f, "LTC Trip");
        Layout.drawLeft(dc, 40, f, ["Save this place", "Save place"]);
        var lines;
        if (state == W_GPS) {
            lines = ["Getting a GPS fix", Gps.pos != null ? Gps.label() : "Go outside or wait", "BACK: cancel"];
        } else if (state == W_SAVED) {
            lines = ["Saved as", name, "Rename it in", "Edit places"];
        } else {
            lines = [Places.MAX_SAVED + " places saved", "Delete one in", "Edit places"];
        }
        Layout.flow(dc, Layout.bodyTop(), f, dc.getFontHeight(f) - 3, lines, true, 0);
    }
}

class SaveDelegate extends WatchUi.BehaviorDelegate {
    var view;

    function initialize(v as SaveView) {
        BehaviorDelegate.initialize();
        view = v;
    }

    function onSelect() as Boolean {
        if (view.state != SaveView.W_GPS) {
            return onBack();
        }
        return true;
    }

    function onBack() as Boolean {
        view.close();
        WatchUi.popView(WatchUi.SLIDE_RIGHT);
        return true;
    }
}
