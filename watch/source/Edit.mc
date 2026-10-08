import Toybox.Lang;
import Toybox.WatchUi;

// "Edit places": rename or delete saved places (Menu2 lists). Rename offers
// the keyboard (WatchUi.TextPicker, where the watch has one) and a list of
// preset names.
module Edit {
    function open() as Void {
        var m = new WatchUi.Menu2({ :title => "Edit places" });
        var s = Places.saved();
        for (var i = 0; i < s.size(); i += 1) {
            m.addItem(new WatchUi.MenuItem(s[i]["n"], null, s[i]["i"], null));
        }
        WatchUi.pushView(m, new ListDelegate(m), WatchUi.SLIDE_LEFT);
    }
}

class ListDelegate extends WatchUi.Menu2InputDelegate {
    var list;

    function initialize(m as WatchUi.Menu2) {
        Menu2InputDelegate.initialize();
        list = m;
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        var id = item.getId() as Number;
        var m = new WatchUi.Menu2({ :title => Places.savedName(id) });
        if (WatchUi has :TextPicker) {
            m.addItem(new WatchUi.MenuItem("Type a name", null, :type, null));
        }
        m.addItem(new WatchUi.MenuItem("Pick a name", null, :pick, null));
        m.addItem(new WatchUi.MenuItem("Delete", null, :del, null));
        WatchUi.pushView(m, new ActionDelegate(list, m, id), WatchUi.SLIDE_LEFT);
    }
}

class ActionDelegate extends WatchUi.Menu2InputDelegate {
    var list;
    var menu;
    var id;

    function initialize(l as WatchUi.Menu2, m as WatchUi.Menu2, i as Number) {
        Menu2InputDelegate.initialize();
        list = l;
        menu = m;
        id = i;
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        var a = item.getId();
        if (a == :type) {
            WatchUi.pushView(new WatchUi.TextPicker(Places.savedName(id)), new NameDelegate(list, menu, id), WatchUi.SLIDE_LEFT);
        } else if (a == :pick) {
            var m = new WatchUi.Menu2({ :title => "Pick a name" });
            for (var i = 0; i < Places.PRESETS.size(); i += 1) {
                m.addItem(new WatchUi.MenuItem(Places.PRESETS[i], null, i, null));
            }
            WatchUi.pushView(m, new PickDelegate(list, id), WatchUi.SLIDE_LEFT);
        } else {
            var m = new WatchUi.Menu2({ :title => "Delete " + Places.savedName(id) + "?" });
            m.addItem(new WatchUi.MenuItem("No", null, :no, null));
            m.addItem(new WatchUi.MenuItem("Yes, delete", null, :yes, null));
            WatchUi.pushView(m, new DeleteDelegate(list, id), WatchUi.SLIDE_LEFT);
        }
    }
}

// Shows a new name in the saved-places list.
function relabel(list as WatchUi.Menu2, id as Number, name) as Void {
    if (name == null) {
        return;
    }
    var i = list.findItemById(id);
    if (i >= 0) {
        var it = list.getItem(i);
        if (it != null) {
            it.setLabel(name);
            list.updateItem(it, i);
        }
    }
}

class PickDelegate extends WatchUi.Menu2InputDelegate {
    var list;
    var id;

    function initialize(l as WatchUi.Menu2, i as Number) {
        Menu2InputDelegate.initialize();
        list = l;
        id = i;
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        relabel(list, id, Places.rename(id, Places.PRESETS[item.getId() as Number]));
        // Back to the list: this menu and the place's actions.
        WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
        WatchUi.popView(WatchUi.SLIDE_RIGHT);
    }
}

// The keyboard closes itself and leaves the place's actions showing; their
// title gets the new name too.
class NameDelegate extends WatchUi.TextPickerDelegate {
    var list;
    var menu;
    var id;

    function initialize(l as WatchUi.Menu2, m as WatchUi.Menu2, i as Number) {
        TextPickerDelegate.initialize();
        list = l;
        menu = m;
        id = i;
    }

    function onTextEntered(text as String, changed as Boolean) as Boolean {
        var n = Places.rename(id, text);
        relabel(list, id, n);
        if (n != null) {
            menu.setTitle(n);
        }
        return true;
    }

    function onCancel() as Boolean {
        return true;
    }
}

class DeleteDelegate extends WatchUi.Menu2InputDelegate {
    var list;
    var id;

    function initialize(l as WatchUi.Menu2, i as Number) {
        Menu2InputDelegate.initialize();
        list = l;
        id = i;
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        if (item.getId() == :yes) {
            Places.remove(id);
            var i = list.findItemById(id);
            if (i >= 0) {
                list.deleteItem(i);
            }
            WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
            WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
            if (Places.saved().size() == 0) {
                WatchUi.popView(WatchUi.SLIDE_RIGHT);  // nothing left to edit
            }
        } else {
            WatchUi.popView(WatchUi.SLIDE_RIGHT);
        }
    }
}
