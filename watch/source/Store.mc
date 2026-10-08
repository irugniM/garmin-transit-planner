import Toybox.Application.Storage;
import Toybox.Lang;
import Toybox.Time;

// Last good Worker reply per destination (key from the descriptor: school,
// home, a<slot>, s<id>, p_<id>_<name>), with the time it arrived, and the
// Arrow on/off setting.
module Store {
    function save(dest as String, reply as Dictionary, at as Number) as Void {
        var clean = {};
        var keys = reply.keys();
        for (var i = 0; i < keys.size(); i += 1) {
            var v = reply[keys[i]];
            if (v != null) {
                clean[keys[i]] = v;
            }
        }
        Storage.setValue("c_" + dest, { "r" => clean, "at" => at });
    }

    // [reply, at] or null.
    function load(dest as String) {
        var c = Storage.getValue("c_" + dest);
        if (c instanceof Dictionary && c["r"] instanceof Dictionary && c["at"] != null) {
            return [c["r"], c["at"]];
        }
        return null;
    }

    // Arrow on TripView (menu toggle). Default Off.
    function arrowOn() as Boolean {
        return Storage.getValue("arrow") == true;
    }

    function setArrow(on as Boolean) as Void {
        Storage.setValue("arrow", on);
    }
}
