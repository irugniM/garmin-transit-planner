import Toybox.Application;
import Toybox.Lang;
import Toybox.WatchUi;

class LTCTripApp extends Application.AppBase {
    function initialize() {
        AppBase.initialize();
    }

    function onStop(state as Dictionary?) as Void {
        Gps.stop();
    }

    function getInitialView() as [WatchUi.Views] or [WatchUi.Views, WatchUi.InputDelegates] {
        var v = new MenuView();
        return [v, new MenuDelegate(v)];
    }
}
