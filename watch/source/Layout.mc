import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Math;
import Toybox.System;
import Toybox.WatchUi;

// Text layout for the Instinct 3: every row stays inside the round lens
// (circle chord minus a 3 px margin) and clear of the subscreen ring in the
// top-right corner. Same approach as the WalkFeed app's Layout.mc.
module Layout {
    // On the real watch the subscreen ring reaches below the box that
    // getSubscreen() reports, and its left edge sits inside the box's x.
    const RING = 6;
    const HGAP = 12;
    const EDGE = 3;

    // [left, right] pixels a text row at y..y+h can use.
    function span(dc as Graphics.Dc, y as Number, h as Number) as Array<Number> {
        var w = dc.getWidth();
        var left = 2;
        var right = w - 2;
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
        if (b != null and b.x > w / 2 and y < b.y + b.height + RING and y + h > b.y) {
            if (b.x - HGAP < right) {
                right = b.x - HGAP;
            }
        }
        return [left, right];
    }

    function subscreen() {
        if (WatchUi has :getSubscreen) {
            return WatchUi.getSubscreen();
        }
        return null;
    }

    // First y where a full-width row clears the subscreen ring.
    function bodyTop() as Number {
        var b = subscreen();
        if (b != null) {
            return b.y + b.height + RING;
        }
        return 4;
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
        var full = dc.getWidth() - 2 * EDGE - indent;
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
        var y = dc.getHeight() - 7;
        dc.fillPolygon([[cx - 5, y - 4], [cx + 5, y - 4], [cx, y + 1]]);
    }

    function arrowUp(dc as Graphics.Dc, y as Number) as Void {
        var cx = dc.getWidth() / 2 - 20;
        dc.fillPolygon([[cx - 5, y + 1], [cx + 5, y + 1], [cx, y - 4]]);
    }
}
