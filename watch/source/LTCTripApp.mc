import Toybox.Application;
import Toybox.Lang;
import Toybox.WatchUi;

class LTCTripApp extends Application.AppBase {
    function initialize() {
        AppBase.initialize();
    }

    // Fetch the private list and geocode new phone-settings addresses in
    // the background; the menu updates when they arrive.
    function onStart(state as Dictionary?) as Void {
        Places.fetchPrivate();
        Places.geoNext();
    }

    function onStop(state as Dictionary?) as Void {
        Gps.stop();
    }

    // Phone settings changed: look up the new addresses.
    function onSettingsChanged() as Void {
        Places.settingsChanged();
    }

    function getInitialView() as [WatchUi.Views] or [WatchUi.Views, WatchUi.InputDelegates] {
        var v = new MenuView();
        return [v, new MenuDelegate(v)];
    }
}
