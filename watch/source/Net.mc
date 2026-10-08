import Toybox.Communications;
import Toybox.Lang;
import Toybox.WatchUi;

// Worker calls. Base URL and token come from string resources that live in
// the git-ignored resources-secret/ folder (placeholders otherwise).
module Net {
    function baseUrl() as String {
        var u = WatchUi.loadResource(Rez.Strings.BaseUrl) as String;
        while (u.length() > 0 && u.substring(u.length() - 1, u.length()).equals("/")) {
            u = u.substring(0, u.length() - 1) as String;
        }
        return u;
    }

    function options() as Dictionary {
        return {
            :method => Communications.HTTP_REQUEST_METHOD_GET,
            :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON
        };
    }

    function plan(lat as Double, lon as Double, dest as String, cb) as Void {
        var params = {
            "lat" => lat.format("%.5f"),
            "lon" => lon.format("%.5f"),
            "dest" => dest,
            "mode" => "depart",
            "k" => WatchUi.loadResource(Rez.Strings.Token) as String
        };
        Communications.makeWebRequest(baseUrl() + "/v1/plan", params, options(), cb);
    }

    function ping(cb) as Void {
        Communications.makeWebRequest(baseUrl() + "/v1/ping", null, options(), cb);
    }

    function cancel() as Void {
        Communications.cancelAllRequests();
    }

    // Plain words for makeWebRequest response codes.
    function errText(code as Number) as String {
        if (code == -104) {
            return "Phone not connected";
        }
        if (code == -300) {
            return "Request timed out";
        }
        if (code == -402) {
            return "Reply too large";
        }
        if (code == -403) {
            return "Reply too big for memory";
        }
        if (code == -1001) {
            return "Needs HTTPS";
        }
        if (code == -101) {
            return "Phone busy, retry";
        }
        return "Error " + code.toString();
    }
}
