import Toybox.Application;
import Toybox.Application.Storage;
import Toybox.Lang;
import Toybox.WatchUi;

// Destinations besides School and Home, as TripView descriptors:
//   {"k" => reply cache key, "t" => [title options], "to" => plan body
//    fields, "e" => error text, "g" => settings slot still to geocode}
// Three sources, all on the watch only (the Worker stores nothing):
// - Phone settings: up to 5 name + address pairs (Connect IQ app settings).
//   Each address is geocoded once by the Worker (POST body) and its lat/lon
//   cached in Storage "g<i>" = {"a" => address, "lat", "lon"} or {"a", "e"}.
// - Saved places: "Save this place" stores a GPS fix, Storage "sv" =
//   [{"i" => id, "n" => name, "lat", "lon"}], at most 5.
// - Private list: names and ids from the Worker's PLACES secret, Storage
//   "pl" = [{"id", "n"}]; the Worker looks the coordinates up by id.
module Places {
    const SLOTS = 5;
    const MAX_SAVED = 5;
    const MAX_NAME = 16;
    const PRESETS = ["Work", "Gym", "Library", "Mall", "Downtown", "Park", "Pool", "Friend", "Doctor", "Shop", "Station", "Church"];

    var ver = 0;           // bumps on every change, so the menu rebuilds
    var geoBusy = false;
    var geoSlot = 0;
    var geoAddr = "";
    var geoFail = {};      // slot -> error text (no reply); retried on demand
    var geoDone = null;    // Method() called after each lookup
    var plBusy = false;

    function school() as Dictionary {
        return { "k" => "school", "t" => ["To School", "School"], "to" => { "dest" => "school" } };
    }

    function home() as Dictionary {
        return { "k" => "home", "t" => ["To Home", "Home"], "to" => { "dest" => "home" } };
    }

    function changed() as Void {
        ver += 1;
        WatchUi.requestUpdate();
    }

    function trim(s as String) as String {
        while (s.length() > 0 && s.substring(0, 1).equals(" ")) {
            s = s.substring(1, s.length()) as String;
        }
        while (s.length() > 0 && s.substring(s.length() - 1, s.length()).equals(" ")) {
            s = s.substring(0, s.length() - 1) as String;
        }
        return s;
    }

    function cut(s as String, n as Number) as String {
        s = trim(s);
        return s.length() > n ? trim(s.substring(0, n) as String) : s;
    }

    function prop(key as String) as String {
        var v = null;
        try {
            v = Application.Properties.getValue(key);
        } catch (e) {
            v = null;
        }
        return v instanceof String ? trim(v) : "";
    }

    function named(n as String, k as String, to) as Dictionary {
        return { "k" => k, "t" => ["To " + n, n], "to" => to };
    }

    // ---- phone settings ------------------------------------------------

    // Descriptor for settings slot i (1..5), or null when it has no address.
    function setting(i as Number) {
        var a = prop("a" + i);
        if (a.length() == 0) {
            return null;
        }
        var n = cut(prop("n" + i), MAX_NAME);
        if (n.length() == 0) {
            n = "Address " + i;
        }
        var d = named(n, "a" + i, null);
        var g = Storage.getValue("g" + i);
        if (g instanceof Dictionary && a.equals(g["a"])) {
            if (g["lat"] != null) {
                d["to"] = { "tlat" => g["lat"], "tlon" => g["lon"] };
            } else {
                d["e"] = g["e"] instanceof String ? g["e"] : "Address not found";
            }
        } else {
            d["g"] = i;
            if (geoFail[i] != null) {
                d["e"] = geoFail[i];
            }
        }
        return d;
    }

    function settingsChanged() as Void {
        geoFail = {};
        geoNext();
        changed();
    }

    // Geocode the next slot whose address has no cached result.
    function geoNext() as Void {
        if (geoBusy) {
            return;
        }
        for (var i = 1; i <= SLOTS; i += 1) {
            var a = prop("a" + i);
            var g = Storage.getValue("g" + i);
            if (a.length() == 0) {
                if (g != null) {
                    Storage.deleteValue("g" + i);
                    Storage.deleteValue("c_a" + i);
                }
                continue;
            }
            if (g instanceof Dictionary && a.equals(g["a"])) {
                continue;
            }
            if (geoFail[i] != null) {
                continue;
            }
            geoBusy = true;
            geoSlot = i;
            geoAddr = a;
            Net.geocode(a, new Lang.Method(Places, :onGeo));
            return;
        }
    }

    // TripView's START on a slot whose lookup failed: try it again.
    function retry(i as Number) as Void {
        geoFail.remove(i);
        geoNext();
    }

    function onGeo(code as Number, data as Dictionary or String or Null) as Void {
        geoBusy = false;
        var i = geoSlot;
        if (code == 200 && data instanceof Dictionary) {
            if (data["ok"] == true && data["lat"] != null && data["lon"] != null) {
                Storage.setValue("g" + i, { "a" => geoAddr, "lat" => data["lat"].toDouble().format("%.5f"), "lon" => data["lon"].toDouble().format("%.5f") });
            } else {
                Storage.setValue("g" + i, { "a" => geoAddr, "e" => data["err"] instanceof String ? data["err"] : "Address not found" });
            }
            Storage.deleteValue("c_a" + i);
        } else {
            geoFail[i] = code == 200 ? "Bad reply" : Net.errText(code);
        }
        changed();
        if (geoDone != null) {
            geoDone.invoke();
        }
        geoNext();
    }

    // ---- saved places --------------------------------------------------

    function saved() as Array {
        var s = Storage.getValue("sv");
        return s instanceof Array ? s : [];
    }

    function savedDest(e as Dictionary) as Dictionary {
        return named(e["n"], "s" + e["i"], { "tlat" => e["lat"], "tlon" => e["lon"] });
    }

    // Saves [lat, lon] under the first free "Place N"; the name, or null
    // when 5 are saved already.
    function saveHere(pos as Array) {
        var s = saved();
        if (s.size() >= MAX_SAVED) {
            return null;
        }
        var n = "";
        for (var k = 1; k <= MAX_SAVED + 1; k += 1) {
            n = "Place " + k;
            if (find(s, n) < 0) {
                break;
            }
        }
        var id = Storage.getValue("svn");
        id = id instanceof Number ? id + 1 : 1;
        Storage.setValue("svn", id);
        s.add({ "i" => id, "n" => n, "lat" => pos[0].format("%.5f"), "lon" => pos[1].format("%.5f") });
        Storage.setValue("sv", s);
        changed();
        return n;
    }

    function find(s as Array, n as String) as Number {
        for (var j = 0; j < s.size(); j += 1) {
            if (n.equals(s[j]["n"])) {
                return j;
            }
        }
        return -1;
    }

    function indexOf(s as Array, id as Number) as Number {
        for (var j = 0; j < s.size(); j += 1) {
            if (s[j]["i"] == id) {
                return j;
            }
        }
        return -1;
    }

    function savedName(id as Number) as String {
        var s = saved();
        var j = indexOf(s, id);
        return j < 0 ? "" : s[j]["n"];
    }

    // The new name, or null when it was empty.
    function rename(id as Number, name as String) {
        name = cut(name, MAX_NAME);
        var s = saved();
        var j = indexOf(s, id);
        if (name.length() == 0 || j < 0) {
            return null;
        }
        s[j]["n"] = name;
        Storage.setValue("sv", s);
        changed();
        return name;
    }

    function remove(id as Number) as Void {
        var s = saved();
        var j = indexOf(s, id);
        if (j >= 0) {
            s.remove(s[j]);
            Storage.setValue("sv", s);
            Storage.deleteValue("c_s" + id);
            changed();
        }
    }

    // ---- private list --------------------------------------------------

    function privates() as Array {
        var p = Storage.getValue("pl");
        return p instanceof Array ? p : [];
    }

    function privateDest(e as Dictionary) as Dictionary {
        return named(e["n"], "p_" + e["id"] + "_" + e["n"], { "place" => e["id"] });
    }

    function fetchPrivate() as Void {
        if (plBusy) {
            return;
        }
        plBusy = true;
        Net.places(new Lang.Method(Places, :onPrivate));
    }

    function onPrivate(code as Number, data as Dictionary or String or Null) as Void {
        plBusy = false;
        if (code != 200 || !(data instanceof Dictionary) || data["ok"] != true || !(data["places"] instanceof Array)) {
            return;  // keep the cached list
        }
        var src = data["places"] as Array;
        var out = [];
        for (var j = 0; j < src.size() && out.size() < 20; j += 1) {
            var e = src[j];
            if (e instanceof Dictionary && e["id"] instanceof String && e["n"] instanceof String) {
                out.add({ "id" => e["id"], "n" => cut(e["n"], MAX_NAME) });
            }
        }
        Storage.setValue("pl", out);
        changed();
    }

    // Requests cancelled (TripView closed): their callbacks may never come.
    function cancelled() as Void {
        geoBusy = false;
        plBusy = false;
    }
}
