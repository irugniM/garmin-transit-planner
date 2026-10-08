import Toybox.Graphics;
import Toybox.Lang;
import Toybox.WatchUi;

// Start screen: To School, To Home, phone-settings places, saved places,
// private-list places, Save this place (+ Edit places once one is saved),
// Arrow: On/Off, Test connection (+ debug-only items).
// Each item: [label options, action, argument].
class MenuView extends WatchUi.View {
    enum {
        A_TRIP,
        A_SAVE,
        A_EDIT,
        A_ARROW,
        A_TEST,
        A_DEBUG
    }

    var sel = 0;
    hidden var _items = null;
    hidden var _ver = -1;

    function initialize() {
        View.initialize();
    }

    function build() as Array {
        var list = [[["To School", "School"], A_TRIP, Places.school()], [["To Home", "Home"], A_TRIP, Places.home()]];
        for (var i = 1; i <= Places.SLOTS; i += 1) {
            var d = Places.setting(i);
            if (d != null) {
                list.add([d["t"], A_TRIP, d]);
            }
        }
        var sv = Places.saved();
        for (var i = 0; i < sv.size(); i += 1) {
            var d = Places.savedDest(sv[i]);
            list.add([d["t"], A_TRIP, d]);
        }
        var pl = Places.privates();
        for (var i = 0; i < pl.size(); i += 1) {
            var d = Places.privateDest(pl[i]);
            list.add([d["t"], A_TRIP, d]);
        }
        list.add([["Save this place", "Save place"], A_SAVE, null]);
        if (sv.size() > 0) {
            list.add([["Edit places", "Edit"], A_EDIT, null]);
        }
        list.add([Store.arrowOn() ? ["Arrow: On", "Arrow On"] : ["Arrow: Off", "Arrow Off"], A_ARROW, null]);
        list.add([["Test connection", "Test conn.", "Test"], A_TEST, null]);
        return Debug.menuItems(list);
    }

    // Rebuilt only after a change (Places.ver), not on every redraw.
    function items() as Array {
        if (_items == null || _ver != Places.ver) {
            _ver = Places.ver;
            _items = build();
            if (sel >= _items.size()) {
                sel = _items.size() - 1;
            }
        }
        return _items;
    }

    function current() as Array {
        return items()[sel];
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
            Layout.drawItem(dc, top + i * pitch, f, list[first + i][0], first + i == sel);
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
        var it = view.current();
        var act = it[1];
        var v = null;
        if (act == MenuView.A_TRIP) {
            v = new TripView(TripView.MODE_TRIP, it[2]);
        } else if (act == MenuView.A_SAVE) {
            var sv = new SaveView();
            WatchUi.pushView(sv, new SaveDelegate(sv), WatchUi.SLIDE_LEFT);
            return true;
        } else if (act == MenuView.A_EDIT) {
            Edit.open();
            return true;
        } else if (act == MenuView.A_ARROW) {
            Store.setArrow(!Store.arrowOn());
            Places.changed();
        } else if (act == MenuView.A_TEST) {
            v = new TripView(TripView.MODE_PING, null);
        } else {
            v = Debug.select(it[2]);
        }
        if (v != null) {
            WatchUi.pushView(v, new TripDelegate(v), WatchUi.SLIDE_LEFT);
        } else {
            WatchUi.requestUpdate();
        }
        return true;
    }
}
