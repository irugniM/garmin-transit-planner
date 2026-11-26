import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Math;
import Toybox.System;
import Toybox.WatchUi;

// Text layout for any watch: every row stays inside the round lens (circle
// chord minus a small margin) and clear of the top-right circle: the
// Instinct's subscreen, or on other watches a virtual circle of the same
// role that holds the arrow. Positions were tuned on the Instinct's 176 px
// screen and scale with the screen height (s()).
module Layout {
    // On the Instinct the subscreen ring reaches below the box that
    // getSubscreen() reports, and its left edge sits inside the box's x.
    // In 176 px units; scaled with s().
    const RING = 6;
    const HGAP = 12;
    const EDGE = 3;

    // A position or size given for the 176 px Instinct, scaled to this screen.
    function s(dc as Graphics.Dc, v as Number) as Number {
        return v * dc.getHeight() / 176;
    }

    function sz(v as Number) as Number {
        return v * System.getDeviceSettings().screenHeight / 176;
    }

    // App name for the top row; the short form when space is tight.
    function title(dc as Graphics.Dc, font) as Void {
        drawLeft(dc, s(dc, 18), font, ["Transit Planner", "Transit"]);
    }

    // [left, right] pixels a text row at y..y+h can use.
    function span(dc as Graphics.Dc, y as Number, h as Number) as Array<Number> {
        var w = dc.getWidth();
        // 2 px on the Instinct (the round lens adds its own margin below);
        // rectangular screens get a margin that grows with the screen.
        var m = System.getDeviceSettings().screenShape == System.SCREEN_SHAPE_RECTANGLE ? s(dc, 6) : 2;
        var left = m;
        var right = w - m;
        if (System.getDeviceSettings().screenShape != System.SCREEN_SHAPE_RECTANGLE) {
            var r = w / 2.0;
            var cy = dc.getHeight() / 2.0;
            // Use the row edge farthest from the centre, not its middle.
            var dyTop = (y - cy).abs();
            var dyBot = ((y + h) - cy).abs();
            var dy = dyTop > dyBot ? dyTop : dyBot;
            if (dy < r) {
                var half = Math.sqrt(r * r - dy * dy);
                var l = (r - half).toNumber() + EDGE;
                var rr = (r + half).toNumber() - EDGE;
                if (l > left) {
                    left = l;
                }
                if (rr < right) {
                    right = rr;
                }
            } else {
                return [w / 2, w / 2];
            }
        }
        var b = subscreen();
        if (b != null and b.x > w / 2 and y < b.y + b.height + sz(RING) and y + h > b.y) {
            if (b.x - sz(HGAP) < right) {
                right = b.x - sz(HGAP);
            }
        }
        return [left, right];
    }

    // The top-right circle's box: the Instinct subscreen, or elsewhere a
    // virtual one (about a fifth of the screen wide, inside the round edge)
    // so every watch keeps the same layout and has room for the arrow.
    function subscreen() {
        if (WatchUi has :getSubscreen) {
            var b = WatchUi.getSubscreen();
            if (b != null) {
                return b;
            }
        }
        var ds = System.getDeviceSettings();
        var w = ds.screenWidth;
        var d = w * 22 / 100;
        return new Box(w * 62 / 100, ds.screenHeight * 10 / 100, d, d);
    }

    // True on watches with a real subscreen (the Instinct family).
    function realSub() as Boolean {
        return (WatchUi has :getSubscreen) && WatchUi.getSubscreen() != null;
    }

    // First y where a full-width row clears the top-right circle.
    function bodyTop() as Number {
        var b = subscreen();
        return b.y + b.height + sz(RING);
    }

    function str(text) as String {
        if (text instanceof String) {
            return text as String;
        }
        return WatchUi.loadResource(text) as String;
    }

    function fit(dc as Graphics.Dc, text as String, font, maxW as Number) as String {
        var t = text;
        while (t.length() > 1 && dc.getTextWidthInPixels(t, font) > maxW) {
            t = t.substring(0, t.length() - 1) as String;
        }
        return t;
    }

    // Left-justified at the span's left edge. text is a String/resource or an
    // Array of options (first that fits wins, else the last is trimmed).
    function drawLeft(dc as Graphics.Dc, y as Number, font, text) as Void {
        var sp = span(dc, y, dc.getFontHeight(font));
        var maxW = sp[1] - sp[0];
        var options = text instanceof Array ? text as Array : [text];
        var t = "";
        for (var i = 0; i < options.size(); i += 1) {
            t = str(options[i]);
            if (dc.getTextWidthInPixels(t, font) <= maxW) {
                break;
            }
        }
        dc.drawText(sp[0], y, font, fit(dc, t, font, maxW), Graphics.TEXT_JUSTIFY_LEFT);
    }

    // Centred in the span; the first option that fits wins, else the last is trimmed.
    function drawCenter(dc as Graphics.Dc, y as Number, font, options as Array) as Void {
        var sp = span(dc, y, dc.getFontHeight(font));
        var maxW = sp[1] - sp[0];
        var text = "";
        for (var i = 0; i < options.size(); i += 1) {
            text = str(options[i]);
            if (dc.getTextWidthInPixels(text, font) <= maxW) {
                break;
            }
        }
        dc.drawText((sp[0] + sp[1]) / 2, y, font, fit(dc, text, font, maxW), Graphics.TEXT_JUSTIFY_CENTER);
    }

    // Longest prefix of text (split at a space when possible) that fits maxW.
    function wrapCut(dc as Graphics.Dc, text as String, font, maxW as Number) as Number {
        if (dc.getTextWidthInPixels(text, font) <= maxW) {
            return text.length();
        }
        var n = fit(dc, text, font, maxW).length();
        var chars = text.toCharArray();
        for (var i = n; i > n / 2; i -= 1) {
            if (i < chars.size() && chars[i] == ' ') {
                return i;
            }
        }
        return n;
    }

    // Flow logical lines into rows from y0 down, word-wrapping each line to
    // the width each row really has. Returns true when some text did not fit.
    // center: centre each row (status screens) instead of left-justifying.
    // indent: extra left margin for left-justified rows (room for a scrollbar).
    // A line that would fit a wider row is never split just because the
    // current (lower, narrower) row is short; it waits for the next scroll.
    function flow(dc as Graphics.Dc, y0 as Number, font, pitch as Number, lines as Array, center as Boolean, indent as Number) as Boolean {
        var h = dc.getFontHeight(font);
        var full = dc.getWidth() - 2 * s(dc, EDGE) - indent;
        var y = y0;
        for (var i = 0; i < lines.size(); i += 1) {
            var rest = str(lines[i]);
            var first = true;
            while (rest.length() > 0) {
                var sp = span(dc, y, h);
                if (!center) {
                    sp[0] += indent;
                }
                var maxW = sp[1] - sp[0];
                if (y + h > dc.getHeight() - 2 || maxW < 40) {
                    return true;
                }
                var tw = dc.getTextWidthInPixels(rest, font);
                if (first && y > y0 && tw > maxW && tw <= full) {
                    return true;
                }
                first = false;
                var n = wrapCut(dc, rest, font, maxW);
                var piece = rest.substring(0, n) as String;
                if (center) {
                    dc.drawText((sp[0] + sp[1]) / 2, y, font, piece, Graphics.TEXT_JUSTIFY_CENTER);
                } else {
                    dc.drawText(sp[0], y, font, piece, Graphics.TEXT_JUSTIFY_LEFT);
                }
                rest = rest.substring(n, rest.length()) as String;
                while (rest.length() > 0 && rest.substring(0, 1).equals(" ")) {
                    rest = rest.substring(1, rest.length()) as String;
                }
                y += pitch;
            }
        }
        return false;
    }

    // One centred row; selected rows are drawn black on a white bar that
    // stays inside the row's span.
    function drawItem(dc as Graphics.Dc, y as Number, font, options as Array, selected as Boolean) as Void {
        var h = dc.getFontHeight(font);
        var sp = span(dc, y, h);
        if (selected) {
            dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_WHITE);
            dc.fillRoundedRectangle(sp[0], y + 2, sp[1] - sp[0], h - 3, 5);
            dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_TRANSPARENT);
        }
        drawCenter(dc, y, font, options);
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
    }

    // Thin scrollbar at the left edge of the body area: a dotted track and a
    // solid thumb for the visible part. first/total are logical line counts.
    function scrollbar(dc as Graphics.Dc, y0 as Number, y1 as Number, first as Number, shown as Number, total as Number) as Void {
        if (total <= 0) {
            return;
        }
        var x = span(dc, y0, y1 - y0)[0];
        for (var y = y0; y < y1; y += 4) {
            dc.drawPoint(x, y);
        }
        var len = y1 - y0;
        var a = y0 + len * first / total;
        var b = y0 + len * (first + shown) / total;
        if (b - a < 6) {
            b = a + 6;
        }
        if (b > y1) {
            b = y1;
        }
        dc.fillRectangle(x - 1, a, 3, b - a);
    }

    // Small up/down markers for scrollable lists.
    function arrowDown(dc as Graphics.Dc) as Void {
        var cx = dc.getWidth() / 2;
        var y = dc.getHeight() - s(dc, 7);
        var a = s(dc, 5);
        dc.fillPolygon([[cx - a, y - a * 4 / 5], [cx + a, y - a * 4 / 5], [cx, y + a / 5]]);
    }

    function arrowUp(dc as Graphics.Dc, y as Number) as Void {
        var cx = dc.getWidth() / 2 - s(dc, 20);
        var a = s(dc, 5);
        dc.fillPolygon([[cx - a, y + a / 5], [cx + a, y + a / 5], [cx, y - a * 4 / 5]]);
    }
}

// Same fields as the Instinct's subscreen box, for the virtual circle.
class Box {
    var x as Number;
    var y as Number;
    var width as Number;
    var height as Number;

    function initialize(x0 as Number, y0 as Number, w as Number, h as Number) {
        x = x0;
        y = y0;
        width = w;
        height = h;
    }
}
