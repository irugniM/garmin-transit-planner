# LTC Trip

A personal, text-only Garmin Connect IQ watch app that tells you when to leave
for the London Transit Commission (LTC) bus in London, Ontario, plus the small
Cloudflare Worker it talks to.

- `watch/`: Connect IQ device app for the Instinct 3 Solar 45mm (`instinct3solar45mm`).
- `worker/`: Cloudflare Worker. It asks [Transitous](https://transitous.org/) for a
  trip, trims the answer to about 200–500 bytes of display-ready text and adds
  LTC stop-closure alerts.

```
watch --makeWebRequest (HTTPS, via Garmin Connect on the phone)--> Worker
Worker --> https://api.transitous.org/api/v5/plan      (trip plan)
Worker --> http://gtfs.ltconline.ca/Alert/Alerts.json  (stop closures, cached 60 s)
```

## Data and attribution

- Trip plans come from **Transitous**, a free, volunteer-run public transport
  routing service. Data sources and their licences (including OpenStreetMap):
  https://transitous.org/sources/ . Transitous asks API users to be open source,
  non-commercial and to send an identifying User-Agent; this Worker sends
  `LTCTrip/0.1 (+https://github.com/irugniM)`.
- Stop-closure alerts come from the **London Transit Commission open data** GTFS-RT
  feed (https://www.londontransit.ca/open-data/), used under the LTC Open Data
  Terms of Use. Thanks, LTC.

## Worker

### API

`GET /v1/ping` → `{"v":1,"ok":true,"t":<unix secs>}`. No token. Use it to check
that the watch can reach the Worker at all.

`GET /v1/plan?lat=<lat>&lon=<lon>&dest=home|school&mode=depart|arrive&t=<unix secs>&k=<token>`

- `lat`, `lon`: where you are now (the watch's GPS).
- `dest`: `school` (Sarnia Rd at Western Rd, LTC stops #1646 EB / #1647 WB) or
  `home` (read from the `HOME_LATLON` secret; never stored in this repo).
- `mode`: `depart` (default; `t` defaults to now) or `arrive` (arrive by `t`, required).
- `k`: must equal the `TOKEN` secret.

Reply (times are America/Toronto, lines are at most 18 characters):

```json
{"v":1,"ok":true,"leave":1791460860,"arr":1791462360,"rt":false,"xfers":1,
 "lines":["Leave 08:01","1 transfer","Walk 1m to #1143","Bus 13A 08:02","to White Oaks Mall",
          "Off #509 08:11","Walk 2m to #1173","Bus 27 08:15","to Capulet Lane",
          "Off #1647 08:23","Walk 3m","Arrive 08:26"],
 "alert":"#1647 closed: temp stop 130m W","next":"Next: 08:10"}
```

- Which trip: the earliest arrival, except that a trip with fewer transfers wins
  if it arrives at most 10 min later (arrive-by: leaves at most 10 min earlier
  than the latest-leaving trip). Ties go to the earlier arrival, then less
  walking. A trip is never picked if another gets there no later (arrive-by:
  leaves no earlier) with over 10 min less walking.
- Line 2 (after `Leave`) is the transfer count: `No transfer`, `1 transfer`,
  `2 transfers` (not on walk-only or `You're here` replies).
- If the trip has transfers and Transitous also found a single-bus trip (that
  arrives over 10 min later or walks over 10 min more), two optional lines
  follow `Arrive`: `Direct 9 05:58`, `arr 06:16` (`arr 16:44 walk 22m` when
  walking ruled it out).
- Every bus has a line naming where to board just before it (`Walk 1m to #1143`,
  or `Board at #1143` when there is no walk), except a transfer at the same stop
  the previous bus left you at (its `Off #1234` line names it). Every bus has its
  `Off` line, and a trip ends with the final walk and `Arrive`. There is no line
  limit; if a reply would pass 600 bytes, the single-bus alternative, then
  headsign lines (middle legs first), then `Leave` are dropped, never the
  transfer count, Board, Bus, Off, the last walk or Arrive.
- If a stop you board at or get off at is closed for that route (LTC alerts
  feed), a line right under its `Walk .. to #X` / `Board at #X` / `Off #X`
  line says where to go: `Temp stop 130m W`, `Temp 2 poles S`,
  `Use Althouse` (alternative stop named), or `Closed: see alert`. Never
  dropped.
- Within 150 m of the destination the reply is `"lines":["You're here"]`
  (no Transitous call).
- Walking: Transitous returns walk-only routes in `direct` (the Worker asks
  for `directModes=WALK` and `maxDirectTime=5400`, i.e. walks up to 90 min;
  MOTIS' default is 30 min). It also allows up to 30 min of walking to the
  first stop (`maxPreTransitTime=1800`; default 15 min). A walk of up to
  20 min wins when it gets there no later than the chosen bus (arrive-by:
  lets you leave no earlier). A longer walk wins only if it gets there at
  least 15 min earlier (arrive-by: leave 15 min later) or no bus gets there
  within 90 min (e.g. at night). When the walk wins,
  the reply is
  `"lines":["Walk 12 min","Arrive 08:12"]`, `xfers` 0, with the bus as
  `"next":"Bus: arr 08:26"` (arrive-by: `Bus: leave 07:58`). When the bus wins,
  a walk over 20 min replaces `Next:` as `"next":"Walk 27m arr 08:27"`
  (arrive-by: `Walk 27m lv 07:33`); a shorter one only fills an empty `next`.

Errors are `{"v":1,"ok":false,"err":"..."}` with HTTP 200 so the watch can show
the text: `Bad token`, `Token not set`, `Bad params`, `Home not set`,
`Transitous down`, `No trips found`.

Alerts: the Worker reads LTC's `Alerts.json` (plain http; https on that host is
broken), keeps a compact stop map for 60 s (Cache API plus an in-memory copy,
because the Cache API may do nothing on `workers.dev`), and if a stop where you
board or get off has an active alert for that route it sets `alert`, for
example `#1647 closed: temp stop 130m W`, falling back to `#1647 closed - check LTC`.
If the feed is unreachable the plan is still returned with `alert: null`, and
the feed is skipped for 30 s.

### Secrets

| Name | Value |
| --- | --- |
| `TOKEN` | Any long random string. The watch sends it as `k`. |
| `HOME_LATLON` | `"<lat>,<lon>"` of home, e.g. `"43.0000,-81.0000"` (placeholder). |

They are set with `wrangler secret put` and never committed. For local
`wrangler dev`, put them in `worker/.dev.vars` (git-ignored):

```
TOKEN=dev-token
HOME_LATLON=43.0000,-81.0000
```

### Develop and test

Node 20.3+ (wrangler is pinned to 4.86.0, the last release that runs on Node 20).

```sh
cd worker
npm install
npm test                 # node:test, uses the fixtures in test/fixtures
npx wrangler dev --local # http://127.0.0.1:8787
curl 'http://127.0.0.1:8787/v1/plan?lat=43.0102&lon=-81.2732&dest=school&k=dev-token'
```

`test/fixtures/*.json` are real Transitous replies between public places
(Masonville Place, Western University, White Oaks Mall, Sarnia & Western),
captured with `npm run fixtures` and stripped of geometry. The alert fixtures
are hand-made in the LTC feed's format.

### Deploy

```sh
cd worker
npx wrangler login              # once, opens a browser
npx wrangler secret put TOKEN
npx wrangler secret put HOME_LATLON
npx wrangler deploy             # prints https://ltctrip.<account>.workers.dev
curl https://ltctrip.<account>.workers.dev/v1/ping
```

## Watch app

### Screens and buttons

- Menu: **To School**, **To Home**, **Test connection**. UP/DOWN move, START opens.
- Trip: the top shows `Leave in N min` (from the reply's `leave`), then the alert
  line (if any), the steps, and `Next: hh:mm`. UP/DOWN scroll, START refreshes,
  BACK returns to the menu.
- Position: uses the last known position right away, keeps a GPS fix running
  until accuracy is USABLE or better, and re-asks once if the better fix is more
  than 100 m from the one first sent. With no position at all: `Waiting for GPS`.
- Errors in plain words: `Phone not connected` (-104), `Request timed out` (-300),
  `Reply too large` (-402), `Reply too big for memory` (-403), `Needs HTTPS`
  (-1001), `Phone busy, retry` (-101), otherwise `Error <code>`, or the Worker's
  own `err` text. The last good trip for each destination is kept in Storage and
  shown with `Saved Nm ago` when a request fails.
- Test connection calls `/v1/ping` and shows `Connection OK` with the round trip
  time, or the error.
- Debug builds only: **Demo screens** (START cycles through every screen state
  with fake data) and **Fake GPS** (a fixed public spot at Western University, for
  the simulator).

Depart-now only in v1; the Worker already supports `mode=arrive`.

### Worker URL and token

They are compiled into the app from string resources:

- `watch/resources-secret-example/secret.xml`: committed placeholders
  (`https://ltctrip.example.workers.dev`, `change-me`).
- `watch/resources-secret/secret.xml`: your real values, git-ignored.

`monkey.jungle` lists `resources;resources-secret-example;resources-secret`.
Later paths win and a missing folder is skipped, so a fresh clone builds with the
placeholders, and your local copy overrides them:

```sh
cd watch
mkdir -p resources-secret
cp resources-secret-example/secret.xml resources-secret/secret.xml
# edit resources-secret/secret.xml: BaseUrl = https://ltctrip.<account>.workers.dev, Token = your TOKEN
```

A `.prg` built this way contains the token, so don't publish built files.

### Build

Connect IQ SDK 9.2.0 and a developer key:

```sh
cd watch
monkeyc -f monkey.jungle -o bin/LTCTrip-debug.prg   -y /path/to/developer_key.der -d instinct3solar45mm -w
monkeyc -f monkey.jungle -o bin/LTCTrip-release.prg -y /path/to/developer_key.der -d instinct3solar45mm -w -r
monkeydo bin/LTCTrip-debug.prg instinct3solar45mm    # simulator
```

Sideload: copy the release `.prg` to `GARMIN/APPS/` on the watch over USB.

In the simulator `makeWebRequest` goes straight to the network, so a
`resources-secret/secret.xml` with `BaseUrl` = `http://127.0.0.1:8787` works
against `wrangler dev`. On the real watch the URL must be HTTPS.

### Layout notes (Instinct 3)

176×176, 1-bit, round lens, buttons only. All text rows are clipped to the lens
circle with a 3 px margin, and rows beside the top-right subscreen stay at least
12 px left of it; full-width rows start 6 px below it. See `watch/source/Layout.mc`.
