import Toybox.Graphics;
import Toybox.Lang;
import Toybox.WatchUi;

// Start screen: To School, To Home, Test connection (+ debug-only items).
class MenuView extends WatchUi.View {
    var sel = 0;

    function initialize() {
        View.initialize();
    }

    function items() as Array {
        return Debug.menuItems([["To School", "School"], ["To Home", "Home"], ["Test connection", "Test conn.", "Test"]]);
    }

    function move(d as Number) as Void {
        var n = items().size();
        sel = (sel + d + n) % n;
        WatchUi.requestUpdate();
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        var f = Graphics.FONT_XTINY;
        var list = items();
        var pitch = 22;
        var top = Layout.bodyTop();
        var rows = 4;
        var first = sel - (rows - 1);
        if (first < 0) {
            first = 0;
        }
        Layout.drawLeft(dc, 18, f, "LTC Trip");
        if (first == 0) {
            Layout.drawLeft(dc, 40, f, "Depart now");
        }
        for (var i = 0; i < rows && first + i < list.size(); i += 1) {
            Layout.drawItem(dc, top + i * pitch, f, list[first + i], first + i == sel);
        }
        if (first + rows < list.size()) {
            Layout.arrowDown(dc);
        }
        if (first > 0) {
            Layout.arrowUp(dc, top - 3);
        }
    }
}

class MenuDelegate extends WatchUi.BehaviorDelegate {
    var view;

    function initialize(v as MenuView) {
        BehaviorDelegate.initialize();
        view = v;
    }

    function onNextPage() as Boolean {
        view.move(1);
        return true;
    }

    function onPreviousPage() as Boolean {
        view.move(-1);
        return true;
    }

    function onSelect() as Boolean {
        var s = view.sel;
        var v = null;
        if (s == 0) {
            v = new TripView(TripView.MODE_TRIP, "school");
        } else if (s == 1) {
            v = new TripView(TripView.MODE_TRIP, "home");
        } else if (s == 2) {
            v = new TripView(TripView.MODE_PING, "");
        } else {
            v = Debug.select(s);
        }
        if (v != null) {
            WatchUi.pushView(v, new TripDelegate(v), WatchUi.SLIDE_LEFT);
        } else {
            WatchUi.requestUpdate();
        }
        return true;
    }
}
